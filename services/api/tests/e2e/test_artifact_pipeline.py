import hashlib
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urljoin
from uuid import uuid4

import httpx
import pytest


_BASE_URL = os.environ.get("XAGENT_ARTIFACT_E2E_URL")
if _BASE_URL is None:
    pytest.skip(
        "set XAGENT_ARTIFACT_E2E_URL to run the Docker artifact pipeline",
        allow_module_level=True,
    )

_SERVICE_TOKEN = os.environ["XAGENT_ARTIFACT_E2E_SERVICE_TOKEN"]
_REPOSITORY = Path(__file__).resolve().parents[4]
_COMPOSE_FILE = Path(
    os.environ.get(
        "XAGENT_ARTIFACT_E2E_COMPOSE_FILE",
        _REPOSITORY / "services/api/compose.test.yml",
    )
)
_PASSWORD = f"artifact-e2e-{uuid4()}"
_EICAR = (
    b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
)
_TERMINAL_STATUSES = {"clean", "quarantined", "failed"}


def _docker_compose(*args: str, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["docker", "compose", "-f", str(_COMPOSE_FILE), *args],
        cwd=_REPOSITORY,
        input=input_text,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"docker compose {' '.join(args)} failed ({result.returncode})\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def _diagnostics() -> str:
    commands = (
        ("ps", "--all"),
        ("logs", "--no-color", "--tail", "120", "api", "worker", "minio", "clamav"),
    )
    sections: list[str] = []
    for command in commands:
        result = subprocess.run(
            ["docker", "compose", "-f", str(_COMPOSE_FILE), *command],
            cwd=_REPOSITORY,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        sections.append(
            f"$ docker compose {' '.join(command)}\n{result.stdout}{result.stderr}"
        )
    return "\n".join(sections)


@dataclass(frozen=True)
class ArtifactUpload:
    artifact_id: str
    version_id: str


@dataclass(frozen=True)
class AuthenticatedApi:
    client: httpx.Client
    headers: dict[str, str]
    principal: dict[str, object]
    bootstrap: dict[str, object]


class ArtifactE2eSession:
    def __init__(self) -> None:
        self._api: AuthenticatedApi | None = None

    def authenticate(self) -> AuthenticatedApi:
        if self._api is not None:
            return self._api
        email = f"artifact-e2e-{uuid4()}@example.test"
        _docker_compose(
            "exec",
            "-T",
            "api",
            "xagent-api",
            "account",
            "create",
            "--email",
            email,
            "--role",
            "specialist",
        )
        _docker_compose(
            "exec",
            "-T",
            "api",
            "xagent-api",
            "account",
            "set-password",
            "--email",
            email,
            input_text=f"{_PASSWORD}\n{_PASSWORD}\n",
        )

        client = httpx.Client(base_url=_BASE_URL, timeout=20)
        login = client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": _PASSWORD},
        )
        assert login.status_code == 200, login.text
        token = login.json()["access_token"]
        headers = {
            "Authorization": f"Bearer {token}",
            "X-XAgent-Service-Token": _SERVICE_TOKEN,
        }
        principal_response = client.post("/internal/xagent/auth/introspect", headers=headers)
        assert principal_response.status_code == 200, principal_response.text
        bootstrap_response = client.post(
            "/internal/xagent/workbench/bootstrap",
            headers=headers,
            json={"schema_version": 1},
        )
        assert bootstrap_response.status_code == 200, bootstrap_response.text
        self._api = AuthenticatedApi(
            client=client,
            headers=headers,
            principal=principal_response.json(),
            bootstrap=bootstrap_response.json(),
        )
        return self._api

    def close(self) -> None:
        if self._api is not None:
            self._api.client.close()


@pytest.fixture(scope="module")
def e2e_session() -> ArtifactE2eSession:
    session = ArtifactE2eSession()
    yield session
    session.close()


def _upload(api: AuthenticatedApi, filename: str, content: bytes) -> ArtifactUpload:
    request_id = str(uuid4())
    created = api.client.post(
        "/internal/xagent/artifacts/uploads",
        headers=api.headers,
        json={
            "filename": filename,
            "size": len(content),
            "idempotency_key": f"create-{request_id}",
        },
    )
    assert created.status_code == 201, created.text
    upload = created.json()
    put = httpx.put(upload["put_url"], content=content, timeout=20)
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
    return ArtifactUpload(
        artifact_id=detail["id"],
        version_id=detail["versions"][0]["id"],
    )


def _wait_for_status(
    api: AuthenticatedApi,
    upload: ArtifactUpload,
    expected: str,
    *,
    deadline_seconds: float = 90,
) -> dict[str, object]:
    deadline = time.monotonic() + deadline_seconds
    last_response = "no response"
    while time.monotonic() < deadline:
        response = api.client.post(
            f"/internal/xagent/artifacts/{upload.artifact_id}",
            headers=api.headers,
            json={},
        )
        last_response = f"{response.status_code} {response.text}"
        if response.status_code == 200:
            detail = response.json()
            status = detail["versions"][0]["status"]
            if status == expected:
                return detail
            if status in _TERMINAL_STATUSES:
                pytest.fail(
                    f"artifact reached {status}, expected {expected}\n{_diagnostics()}"
                )
        time.sleep(0.5)
    pytest.fail(
        f"artifact did not reach {expected} within {deadline_seconds}s; "
        f"last response: {last_response}\n{_diagnostics()}"
    )


def test_authenticated_principal_bootstraps_private_workbench(
    e2e_session: ArtifactE2eSession,
) -> None:
    authenticated_api = e2e_session.authenticate()
    assert authenticated_api.principal["actor_id"] == authenticated_api.bootstrap["account"]["id"]
    assert authenticated_api.bootstrap["context"] == {
        "kind": "workbench",
        "project_id": None,
    }


def test_plain_text_reaches_clean_and_reads_through_the_opaque_api_url(
    e2e_session: ArtifactE2eSession,
) -> None:
    authenticated_api = e2e_session.authenticate()
    content = b"real artifact pipeline\n"
    upload = _upload(authenticated_api, "pipeline.txt", content)
    detail = _wait_for_status(authenticated_api, upload, "clean")
    assert detail["versions"][0]["sha256"] == hashlib.sha256(content).hexdigest()

    preview = authenticated_api.client.post(
        f"/internal/xagent/artifact-versions/{upload.version_id}/preview",
        headers=authenticated_api.headers,
        json={},
    )
    assert preview.status_code == 200, preview.text
    read_url = preview.json()["url"]
    decoded_url = unquote(read_url)
    assert "xagent-private" not in decoded_url
    assert "staging/" not in decoded_url
    assert "artifacts/" not in decoded_url
    assert "minio" not in decoded_url
    content_response = authenticated_api.client.get(urljoin(str(_BASE_URL), read_url))
    assert content_response.status_code == 200, content_response.text
    assert content_response.content == content
    assert content_response.headers["content-disposition"].startswith("inline;")


def test_eicar_reaches_quarantine_and_has_no_readable_content(
    e2e_session: ArtifactE2eSession,
) -> None:
    authenticated_api = e2e_session.authenticate()
    upload = _upload(authenticated_api, "eicar.txt", _EICAR)
    _wait_for_status(authenticated_api, upload, "quarantined")

    download = authenticated_api.client.post(
        f"/internal/xagent/artifact-versions/{upload.version_id}/download",
        headers=authenticated_api.headers,
        json={},
    )
    assert download.status_code == 404
    assert download.json() == {"detail": {"code": "not-found"}}


def test_restarted_worker_reclaims_an_expired_lease(
    e2e_session: ArtifactE2eSession,
) -> None:
    authenticated_api = e2e_session.authenticate()
    _docker_compose("stop", "worker")
    content = b"lease recovery through the formal worker\n"
    upload = _upload(authenticated_api, "lease-recovery.txt", content)
    lease_token = str(uuid4())
    _docker_compose(
        "exec",
        "-T",
        "postgres",
        "psql",
        "--set=ON_ERROR_STOP=1",
        "--username",
        "postgres",
        "--dbname",
        "xagent_api_test",
        "--command",
        (
            "BEGIN; "
            f"UPDATE artifact_versions SET scan_status = 'scanning' WHERE id = '{upload.version_id}'; "
            "UPDATE artifact_processing_jobs "
            f"SET status = 'leased', attempts = 1, lease_token = '{lease_token}', "
            "lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second', "
            "next_attempt_at = CURRENT_TIMESTAMP - INTERVAL '1 second' "
            f"WHERE version_id = '{upload.version_id}'; "
            "COMMIT;"
        ),
    )
    _docker_compose("start", "worker")
    detail = _wait_for_status(authenticated_api, upload, "clean")
    assert detail["versions"][0]["sha256"] == hashlib.sha256(content).hexdigest()
