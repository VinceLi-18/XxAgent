import hashlib
import os
import subprocess
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


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
_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
_STALE_WORKER = "xagent-stale-worker"
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


def _docker(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["docker", *args],
        cwd=_REPOSITORY,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    if check and result.returncode != 0:
        raise AssertionError(
            f"docker {' '.join(args)} failed ({result.returncode})\n"
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


@dataclass(frozen=True)
class RecoverySession:
    client: httpx.Client
    headers: dict[str, str]
    actor_id: UUID
    permission_revision: int
    session_id: UUID


def _delegation(session: RecoverySession, *, tool_call_id: str) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "iss": "xagent-host",
            "aud": "xagent-api",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(seconds=30)).timestamp()),
            "actor_id": str(session.actor_id),
            "project_id": None,
            "session_id": str(session.session_id),
            "tool_call_id": tool_call_id,
            "tool_name": "search_artifacts",
            "permission_revision": session.permission_revision,
            "nonce": f"recovery-search-{uuid4()}",
        },
        _PRIVATE_KEY,
        algorithm="EdDSA",
    )


def _search(session: RecoverySession, query: str) -> dict[str, object]:
    tool_call_id = f"recovery-{uuid4()}"
    response = session.client.post(
        "/internal/xagent/retrieval/search",
        headers={
            **session.headers,
            "X-XAgent-Delegation": _delegation(
                session,
                tool_call_id=tool_call_id,
            ),
        },
        json={
            "schema_version": 1,
            "session_id": str(session.session_id),
            "tool_call_id": tool_call_id,
            "permission_revision": session.permission_revision,
            "query": query,
            "include_private": True,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(scope="module")
def authenticated_api() -> RecoverySession:
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
    principal = client.post("/internal/xagent/auth/introspect", headers=headers)
    assert principal.status_code == 200, principal.text
    created = client.post(
        "/internal/xagent/sessions",
        headers=headers,
        json={
            "schema_version": 1,
            "title": "Retrieval recovery",
            "idempotency_key": f"recovery-session-{uuid4()}",
        },
    )
    assert created.status_code == 201, created.text
    yield RecoverySession(
        client=client,
        headers=headers,
        actor_id=UUID(principal.json()["actor_id"]),
        permission_revision=principal.json()["permission_revision"],
        session_id=UUID(created.json()["session"]["id"]),
    )
    client.close()


def _upload(
    api: RecoverySession,
    filename: str,
    content: bytes,
    *,
    artifact_id: str | None = None,
) -> Upload:
    request_id = str(uuid4())
    endpoint = (
        f"/internal/xagent/artifacts/{artifact_id}/uploads"
        if artifact_id is not None
        else "/internal/xagent/artifacts/uploads"
    )
    created = api.client.post(
        endpoint,
        headers=api.headers,
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
    completed = api.client.post(
        f"/internal/xagent/artifacts/uploads/{upload['upload_id']}/complete",
        headers=api.headers,
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


def test_active_replacement_supersedes_older_generation_and_fences_stale_owner(
    authenticated_api: RecoverySession,
) -> None:
    first = _upload(
        authenticated_api,
        "active-v1.txt",
        b"active-replacement-alpha remains searchable during rebuild\n",
    )
    first_ready = (
        "SELECT i.status || ':' || j.status || ':' || "
        "(h.version_id = i.version_id)::text FROM artifact_text_indexes i "
        "JOIN artifact_index_jobs j ON j.index_id = i.id "
        "LEFT JOIN artifact_search_heads h ON h.index_id = i.id "
        f"WHERE i.version_id = '{first.version_id}';\n"
    )
    assert _wait_for_value(first_ready, {"ready:succeeded:true"}) == "ready:succeeded:true"

    stale_created = False
    stale_paused = False
    embedding_paused = False
    _compose("stop", "worker")
    try:
        _compose("pause", "embedding")
        embedding_paused = True
        superseded = _upload(
            authenticated_api,
            "active-v2.txt",
            b"superseded-generation-beta must never replace the newer head\n",
            artifact_id=first.artifact_id,
        )
        _compose(
            "run",
            "--detach",
            "--name",
            _STALE_WORKER,
            "--no-deps",
            "worker",
            "xagent-api",
            "worker",
            "--once",
            "--lease-seconds",
            "30",
            "--heartbeat-seconds",
            "5",
            "--poll-seconds",
            "0.2",
        )
        stale_created = True
        leased_query = (
            "SELECT j.status || ':' || j.attempts::text FROM artifact_index_jobs j "
            "JOIN artifact_text_indexes i ON i.id = j.index_id "
            f"WHERE i.version_id = '{superseded.version_id}';\n"
        )
        _wait_for_value(leased_query, {"leased:1"})
        _docker("pause", _STALE_WORKER)
        stale_paused = True
        _compose("unpause", "embedding")
        embedding_paused = False
        _wait_for_service_health("embedding")

        active = _search(authenticated_api, "active-replacement-alpha")
        assert active["citations"][0]["version_id"] == first.version_id
        newest = _upload(
            authenticated_api,
            "active-v3.txt",
            b"newest-generation-gamma is the only searchable replacement\n",
            artifact_id=first.artifact_id,
        )
        _compose("start", "worker")
        newest_ready = (
            "SELECT i.status || ':' || j.status || ':' || "
            "(h.version_id = i.version_id)::text FROM artifact_text_indexes i "
            "JOIN artifact_index_jobs j ON j.index_id = i.id "
            "LEFT JOIN artifact_search_heads h ON h.index_id = i.id "
            f"WHERE i.version_id = '{newest.version_id}';\n"
        )
        assert _wait_for_value(newest_ready, {"ready:succeeded:true"}, seconds=90)
        superseded_done = (
            "SELECT i.status || ':' || j.status || ':' || j.attempts::text FROM "
            "artifact_text_indexes i JOIN artifact_index_jobs j ON j.index_id = i.id "
            f"WHERE i.version_id = '{superseded.version_id}';\n"
        )
        assert _wait_for_value(
            superseded_done,
            {"ready:succeeded:2"},
            seconds=60,
        ) == "ready:succeeded:2"
        assert _head_count(newest) == "1"
        assert _head_count(superseded) == "0"

        _docker("unpause", _STALE_WORKER)
        stale_paused = False
        stale_owner_resumed = _docker("wait", _STALE_WORKER).stdout.strip()
        assert stale_owner_resumed == "0", "stale-owner-resumed"
        assert _head_count(newest) == "1"
        assert _head_count(superseded) == "0"
        after = _search(authenticated_api, "superseded-generation-beta")
        assert all(
            citation["version_id"] != superseded.version_id
            for citation in after["citations"]
        )
    finally:
        if embedding_paused:
            _compose("unpause", "embedding")
            _wait_for_service_health("embedding")
        if stale_paused:
            _docker("unpause", _STALE_WORKER, check=False)
        if stale_created:
            _docker("rm", "--force", _STALE_WORKER, check=False)
        _compose("start", "worker")


def test_invalid_utf8_unsupported_and_quarantined_inputs_never_publish_heads(
    authenticated_api: RecoverySession,
) -> None:
    uploads = {
        "invalid_utf8": _upload(
            authenticated_api,
            "invalid-utf8.txt",
            (b"plain retrieval text repeated for mime classification\n" * 256)
            + b"\xc3(",
        ),
        "unsupported": _upload(
            authenticated_api,
            "unsupported.html",
            b"<!doctype html><title>not indexed</title>",
        ),
        "quarantined": _upload(authenticated_api, "quarantined.txt", _EICAR),
    }
    for kind, upload in uploads.items():
        status_query = (
            "SELECT scan_status FROM artifact_versions "
            f"WHERE id = '{upload.version_id}';\n"
        )
        expected = {"quarantined"} if kind == "quarantined" else {"clean"}
        _wait_for_value(status_query, expected)
        if kind == "invalid_utf8":
            index_state = _wait_for_value(
                "SELECT v.detected_content_type || ':' || i.status || ':' || "
                "COALESCE(i.failure_code, '') || ':' || j.status || ':' || "
                "COALESCE(j.failure_code, '') FROM artifact_versions v "
                "JOIN artifact_text_indexes i ON i.version_id = v.id "
                "JOIN artifact_index_jobs j ON j.index_id = i.id "
                f"WHERE i.version_id = '{upload.version_id}';\n",
                {"text/plain:failed:invalid-utf8:dead:invalid-utf8"},
            )
            assert index_state == "text/plain:failed:invalid-utf8:dead:invalid-utf8"
            absent = _search(authenticated_api, "plain retrieval text repeated")
            assert all(
                citation["artifact_id"] != upload.artifact_id
                for citation in absent["citations"]
            )
        else:
            assert _psql(
                "SELECT count(*) FROM artifact_text_indexes "
                f"WHERE version_id = '{upload.version_id}';\n"
            ) == "0"
        assert _head_count(upload) == "0"
        detail = authenticated_api.client.post(
            f"/internal/xagent/artifacts/{upload.artifact_id}",
            headers=authenticated_api.headers,
            json={},
        )
        assert detail.status_code == 200, detail.text
        assert detail.json()["versions"][0]["status"] in expected
