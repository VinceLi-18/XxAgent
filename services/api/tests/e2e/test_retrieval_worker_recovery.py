import hashlib
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import httpx
import pytest


if os.environ.get("XAGENT_RETRIEVAL_E2E") != "1":
    pytest.skip(
        "set XAGENT_RETRIEVAL_E2E=1 to run retrieval worker recovery",
        allow_module_level=True,
    )

_BASE_URL = os.environ.get("XAGENT_RETRIEVAL_E2E_URL", "http://127.0.0.1:58000")
_SERVICE_TOKEN = os.environ.get(
    "XAGENT_RETRIEVAL_E2E_SERVICE_TOKEN",
    "xagent-e2e-service-token-test-only-0001",
)
_REPOSITORY = Path(__file__).resolve().parents[4]
_COMPOSE_FILE = _REPOSITORY / "services/api/compose.test.yml"
_PASSWORD = f"retrieval-recovery-{uuid4()}"
_EICAR = (
    b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
)


def _compose(*args: str, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["docker", "compose", "-f", str(_COMPOSE_FILE), *args],
        cwd=_REPOSITORY,
        input=input_text,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"docker compose {' '.join(args)} failed ({result.returncode})\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def _psql(statement: str) -> str:
    return _compose(
        "exec", "-T", "postgres", "psql", "--set=ON_ERROR_STOP=1",
        "--tuples-only", "--no-align", "--username", "postgres",
        "--dbname", "xagent_api_test", input_text=statement,
    ).stdout.strip()


def _diagnostics() -> str:
    return _compose(
        "logs", "--no-color", "--tail", "180", "worker", "embedding", "api"
    ).stdout


def _wait_for_service_health(service: str, *, seconds: float = 60) -> None:
    deadline = time.monotonic() + seconds
    last = ""
    while time.monotonic() < deadline:
        last = _compose("ps", "--format", "{{.Health}}", service).stdout.strip()
        if last == "healthy":
            return
        time.sleep(1)
    pytest.fail(
        f"{service} did not become healthy within {seconds}s; "
        f"last={last}\n{_diagnostics()}"
    )


@dataclass(frozen=True)
class Upload:
    artifact_id: str
    version_id: str


@pytest.fixture(scope="module")
def authenticated_api() -> tuple[httpx.Client, dict[str, str]]:
    email = f"retrieval-recovery-{uuid4()}@example.test"
    _compose(
        "exec", "-T", "api", "xagent-api", "account", "create",
        "--email", email, "--role", "specialist",
    )
    _compose(
        "exec", "-T", "api", "xagent-api", "account", "set-password",
        "--email", email, input_text=f"{_PASSWORD}\n{_PASSWORD}\n",
    )
    client = httpx.Client(base_url=_BASE_URL, timeout=30)
    login = client.post("/api/v1/auth/login", json={"email": email, "password": _PASSWORD})
    assert login.status_code == 200, login.text
    headers = {
        "Authorization": f"Bearer {login.json()['access_token']}",
        "X-XAgent-Service-Token": _SERVICE_TOKEN,
    }
    yield client, headers
    client.close()


def _upload(
    api: tuple[httpx.Client, dict[str, str]],
    filename: str,
    content: bytes,
) -> Upload:
    client, headers = api
    request_id = str(uuid4())
    created = client.post(
        "/internal/xagent/artifacts/uploads",
        headers=headers,
        json={
            "filename": filename,
            "size": len(content),
            "idempotency_key": f"create-{request_id}",
        },
    )
    assert created.status_code == 201, created.text
    upload = created.json()
    put = httpx.put(upload["put_url"], content=content, timeout=30)
    assert put.status_code == 200, put.text
    completed = client.post(
        f"/internal/xagent/artifacts/uploads/{upload['upload_id']}/complete",
        headers=headers,
        json={
            "actual_size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "idempotency_key": f"complete-{request_id}",
        },
    )
    assert completed.status_code == 201, completed.text
    detail = completed.json()
    return Upload(detail["id"], detail["versions"][0]["id"])


def _wait_for_value(statement: str, expected: set[str], *, seconds: float = 180) -> str:
    deadline = time.monotonic() + seconds
    last = ""
    while time.monotonic() < deadline:
        last = _psql(statement)
        if last in expected:
            return last
        time.sleep(0.2)
    pytest.fail(
        f"database value did not reach {sorted(expected)} within {seconds}s; "
        f"last={last}\n{_diagnostics()}"
    )


def _head_count(upload: Upload) -> str:
    return _psql(
        "SELECT count(*) FROM artifact_search_heads "
        f"WHERE artifact_id = '{upload.artifact_id}' "
        f"AND version_id = '{upload.version_id}';\n"
    )


def test_killed_worker_reclaims_the_real_index_lease_without_stale_publication(
    authenticated_api: tuple[httpx.Client, dict[str, str]],
) -> None:
    content = (
        "lease recovery keeps the unpublished generation private.\n"
        "租约恢复必须等待旧租约过期后重新领取。\n"
    ).encode() * 8
    _compose("pause", "embedding")
    try:
        upload = _upload(authenticated_api, "lease-recovery.txt", content)
        leased_query = (
            "SELECT j.status || ':' || j.attempts::text FROM artifact_index_jobs j "
            "JOIN artifact_text_indexes i ON i.id = j.index_id "
            f"WHERE i.version_id = '{upload.version_id}';\n"
        )
        _wait_for_value(leased_query, {"leased:1"})
        _compose("kill", "-s", "KILL", "worker")
    finally:
        _compose("unpause", "embedding")
        _wait_for_service_health("embedding")
    try:
        assert _head_count(upload) == "0"
        _compose("start", "worker")
        result = _wait_for_value(leased_query, {"succeeded:2"}, seconds=60)
        assert result == "succeeded:2"
        assert _head_count(upload) == "1"
    finally:
        _compose("start", "worker")


def test_non_text_quarantined_and_invalid_utf8_inputs_never_publish_heads(
    authenticated_api: tuple[httpx.Client, dict[str, str]],
) -> None:
    uploads = {
        "binary": _upload(
            authenticated_api,
            "invalid-utf8.txt",
            (b"plain prefix for mime detection\n" * 64) + b"\xff\xfe\x80",
        ),
        "unsupported": _upload(
            authenticated_api,
            "unsupported.html",
            b"<!doctype html><title>not indexed</title>",
        ),
        "quarantined": _upload(authenticated_api, "quarantined.txt", _EICAR),
    }
    client, headers = authenticated_api
    for kind, upload in uploads.items():
        status_query = (
            "SELECT scan_status FROM artifact_versions "
            f"WHERE id = '{upload.version_id}';\n"
        )
        expected = {"quarantined"} if kind == "quarantined" else {"clean"}
        _wait_for_value(status_query, expected)
        if kind == "binary":
            index_state = _wait_for_value(
                "SELECT COALESCE(max(i.status || ':' || COALESCE(i.failure_code, '')), 'none') "
                "FROM artifact_text_indexes i "
                f"WHERE i.version_id = '{upload.version_id}';\n",
                {"failed:invalid-utf8", "none"},
            )
            assert index_state in {"failed:invalid-utf8", "none"}
        else:
            assert _psql(
                "SELECT count(*) FROM artifact_text_indexes "
                f"WHERE version_id = '{upload.version_id}';\n"
            ) == "0"
        assert _head_count(upload) == "0"
        detail = client.post(
            f"/internal/xagent/artifacts/{upload.artifact_id}", headers=headers, json={}
        )
        assert detail.status_code == 200, detail.text
        assert detail.json()["versions"][0]["status"] in expected
