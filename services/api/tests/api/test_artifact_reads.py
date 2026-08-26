from datetime import UTC, datetime
from urllib.parse import parse_qs, unquote, urlencode, urlsplit, urlunsplit
from uuid import UUID, uuid4

import anyio
import pytest
from argon2 import PasswordHasher
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import ClientDisconnect

from app.api.routes.internal_artifacts import artifact_content_route
from app.models.artifact import Artifact, ArtifactVersion
from app.services import artifacts as artifact_service
from app.storage.minio_gateway import MinioGateway

SERVICE_TOKEN = "xagent-test-service-token-00000001"
PASSWORD = "correct horse battery staple"


def _headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "X-XAgent-Service-Token": SERVICE_TOKEN,
    }


async def _login(client, engine, account, email: str) -> str:
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO xagent_account_credentials "
                    "(account_id, password_hash, password_changed_at) "
                    "VALUES (:account_id, :password_hash, CURRENT_TIMESTAMP)"
                ),
                {
                    "account_id": account.id,
                    "password_hash": PasswordHasher().hash(PASSWORD),
                },
            )
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": PASSWORD},
    )
    assert response.status_code == 200
    return response.json()["access_token"]


class ReadGateway:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int, str, str]] = []
        self.stream_calls: list[str] = []

    def create_read_url(
        self,
        key: str,
        *,
        expires_seconds: int,
        disposition: str,
        filename: str,
    ) -> str:
        self.calls.append((key, expires_seconds, disposition, filename))
        return f"https://storage.test/private-bucket/{key}"

    def stream(self, key: str):
        self.stream_calls.append(key)
        yield b"safe-content"


def _clean_version(
    artifact: Artifact,
    uploader_id: UUID,
    *,
    filename: str,
    content_type: str,
) -> ArtifactVersion:
    version_id = uuid4()
    return ArtifactVersion(
        id=version_id,
        artifact_id=artifact.id,
        owner_id=artifact.owner_id,
        project_id=artifact.project_id,
        version_number=1,
        original_filename=filename,
        uploaded_by_id=uploader_id,
        declared_size=12,
        actual_size=12,
        detected_content_type=content_type,
        scan_status="clean",
        object_key=f"artifacts/{artifact.id}/{version_id}",
        size=12,
        content_type=content_type,
        sha256="a" * 64,
        created_at=datetime.now(UTC),
    )


@pytest.mark.anyio
async def test_preview_signs_only_inline_clean_content_for_at_most_sixty_seconds(
    client,
    seeded_database,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    alice_token = await _login(
        client, seeded_database, alice, "alice@example.test"
    )
    gateway = ReadGateway()
    monkeypatch.setattr("app.services.artifacts._runtime_gateway", lambda: gateway)
    text_artifact = Artifact(
        id=uuid4(), filename="preview.txt", created_by_id=alice.id, owner_id=alice.id
    )
    office_artifact = Artifact(
        id=uuid4(), filename="office.docx", created_by_id=alice.id, owner_id=alice.id
    )
    pending_artifact = Artifact(
        id=uuid4(), filename="pending.txt", created_by_id=alice.id, owner_id=alice.id
    )
    text_version = _clean_version(
        text_artifact,
        alice.id,
        filename="preview.txt",
        content_type="text/plain",
    )
    office_version = _clean_version(
        office_artifact,
        alice.id,
        filename="office.docx",
        content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    pending_version = _clean_version(
        pending_artifact,
        alice.id,
        filename="pending.txt",
        content_type="text/plain",
    )
    pending_version.scan_status = "pending"
    pending_version.object_key = None
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add_all((text_artifact, office_artifact, pending_artifact))
            await session.flush()
            session.add_all((text_version, office_version, pending_version))

    preview = await client.post(
        f"/internal/xagent/artifact-versions/{text_version.id}/preview",
        headers=_headers(alice_token),
        json={},
    )
    office = await client.post(
        f"/internal/xagent/artifact-versions/{office_version.id}/preview",
        headers=_headers(alice_token),
        json={},
    )
    pending = await client.post(
        f"/internal/xagent/artifact-versions/{pending_version.id}/preview",
        headers=_headers(alice_token),
        json={},
    )

    assert preview.status_code == 200
    assert set(preview.json()) == {"url"}
    preview_url = preview.json()["url"]
    assert text_version.object_key not in unquote(preview_url)
    assert "private-bucket" not in unquote(preview_url)
    content = await client.get(preview_url)
    assert content.status_code == 200
    assert content.content == b"safe-content"
    assert content.headers["content-type"].startswith("text/plain")
    assert content.headers["content-disposition"].startswith("inline;")
    ranged = await client.get(preview_url, headers={"Range": "bytes=0-3"})
    assert ranged.status_code == 200
    assert ranged.content == b"safe-content"
    assert "content-range" not in ranged.headers
    assert gateway.stream_calls == [text_version.object_key, text_version.object_key]
    assert office.status_code == 403
    assert office.json() == {"detail": {"code": "forbidden"}}
    assert pending.status_code == 404
    assert pending.json() == {"detail": {"code": "not-found"}}


@pytest.mark.anyio
async def test_download_sanitizes_filename_and_forces_active_content_to_attachment(
    client,
    seeded_database,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    alice_token = await _login(
        client, seeded_database, alice, "alice@example.test"
    )
    gateway = ReadGateway()
    monkeypatch.setattr("app.services.artifacts._runtime_gateway", lambda: gateway)
    artifact = Artifact(
        id=uuid4(), filename="active.svg", created_by_id=alice.id, owner_id=alice.id
    )
    version = _clean_version(
        artifact,
        alice.id,
        filename='..\\bad/\r\nname\x01".svg',
        content_type="image/svg+xml",
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(artifact)
            await session.flush()
            session.add(version)

    response = await client.post(
        f"/internal/xagent/artifact-versions/{version.id}/download",
        headers=_headers(alice_token),
        json={},
    )

    assert response.status_code == 200
    assert set(response.json()) == {"url"}
    read_url = response.json()["url"]
    assert version.object_key not in unquote(read_url)
    content = await client.get(read_url)
    assert content.status_code == 200
    assert content.content == b"safe-content"
    disposition = content.headers["content-disposition"]
    assert disposition.startswith('attachment; filename=".._bad___name__.svg"')
    assert "filename*=UTF-8''.._bad___name__.svg" in disposition
    assert gateway.stream_calls == [version.object_key]
    assert "\r" not in response.text and "\n" not in response.text and "\x01" not in response.text


@pytest.mark.anyio
async def test_invisible_and_missing_reads_are_identical_and_do_not_call_storage(
    client,
    seeded_database,
    alice,
    bob,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    alice_token = await _login(
        client, seeded_database, alice, "alice@example.test"
    )
    gateway = ReadGateway()
    monkeypatch.setattr("app.services.artifacts._runtime_gateway", lambda: gateway)
    artifact = Artifact(
        id=uuid4(), filename="foreign.txt", created_by_id=bob.id, owner_id=bob.id
    )
    version = _clean_version(
        artifact,
        bob.id,
        filename="foreign.txt",
        content_type="text/plain",
    )
    pending_artifact = Artifact(
        id=uuid4(), filename="pending.txt", created_by_id=alice.id, owner_id=alice.id
    )
    pending_version = _clean_version(
        pending_artifact,
        alice.id,
        filename="pending.txt",
        content_type="text/plain",
    )
    pending_version.scan_status = "pending"
    pending_version.object_key = None
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add_all((artifact, pending_artifact))
            await session.flush()
            session.add_all((version, pending_version))

    invisible = await client.post(
        f"/internal/xagent/artifact-versions/{version.id}/download",
        headers=_headers(alice_token),
        json={},
    )
    missing = await client.post(
        f"/internal/xagent/artifact-versions/{uuid4()}/download",
        headers=_headers(alice_token),
        json={},
    )

    assert (invisible.status_code, invisible.json()) == (
        missing.status_code,
        missing.json(),
    ) == (404, {"detail": {"code": "not-found"}})
    assert gateway.calls == []


@pytest.mark.anyio
async def test_opaque_read_url_rejects_tampering_expiry_and_non_clean_state(
    client,
    seeded_database,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    gateway = ReadGateway()
    monkeypatch.setattr("app.services.artifacts._runtime_gateway", lambda: gateway)
    artifact = Artifact(
        id=uuid4(), filename="signed.txt", created_by_id=alice.id, owner_id=alice.id
    )
    version = _clean_version(
        artifact,
        alice.id,
        filename="signed.txt",
        content_type="text/plain",
    )
    pending_artifact = Artifact(
        id=uuid4(), filename="pending.txt", created_by_id=alice.id, owner_id=alice.id
    )
    pending_version = _clean_version(
        pending_artifact,
        alice.id,
        filename="pending.txt",
        content_type="text/plain",
    )
    pending_version.scan_status = "pending"
    pending_version.object_key = None
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add_all((artifact, pending_artifact))
            await session.flush()
            session.add_all((version, pending_version))

    issued = await client.post(
        f"/internal/xagent/artifact-versions/{version.id}/preview",
        headers=_headers(token),
        json={},
    )
    assert issued.status_code == 200
    parts = urlsplit(issued.json()["url"])
    query = parse_qs(parts.query)
    signature = query["signature"][0]
    query["signature"] = [signature[:-1] + ("0" if signature[-1] != "0" else "1")]
    tampered_url = urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(query, doseq=True), parts.fragment)
    )
    tampered = await client.get(tampered_url)
    assert tampered.status_code == 403
    assert tampered.json() == {"detail": {"code": "forbidden"}}

    expired_at = int(datetime.now(UTC).timestamp()) - 1
    expired_signature = artifact_service._sign_read_request(
        version.id,
        expired_at,
        "inline",
    )
    expired = await client.get(
        f"/api/v1/xagent/artifact-content/{version.id}",
        params={
            "expires": expired_at,
            "mode": "inline",
            "signature": expired_signature,
        },
    )
    assert expired.status_code == 403

    active_expires = int(query["expires"][0])
    non_clean = await client.get(
        f"/api/v1/xagent/artifact-content/{pending_version.id}",
        params={
            "expires": active_expires,
            "mode": "inline",
            "signature": artifact_service._sign_read_request(
                pending_version.id,
                active_expires,
                "inline",
            ),
        },
    )
    assert non_clean.status_code == 404
    assert non_clean.json() == {"detail": {"code": "not-found"}}


@pytest.mark.anyio
async def test_content_stream_closes_the_storage_response_after_client_disconnect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    closed: list[bool] = []

    class DisconnectGateway:
        def stream(self, _key: str):
            try:
                yield b"first"
                yield b"second"
            finally:
                closed.append(True)

    async def resolve(*_args, **_kwargs):
        return "internal-object-key", "text/plain", 'inline; filename="safe.txt"'

    monkeypatch.setattr("app.services.artifacts._runtime_gateway", DisconnectGateway)
    monkeypatch.setattr("app.services.artifacts.resolve_read_content", resolve)
    response = await artifact_content_route(
        uuid4(),
        expires=1,
        mode="inline",
        signature="0" * 64,
        session=object(),
    )

    async def disconnected_send(message: dict[str, object]) -> None:
        if message["type"] == "http.response.body":
            raise OSError("client disconnected")

    with pytest.raises(ClientDisconnect):
        await response(
            {"type": "http", "asgi": {"spec_version": "2.4"}},
            lambda: None,
            disconnected_send,
        )
    assert closed == [True]


@pytest.mark.anyio
@pytest.mark.parametrize("close_raises", (False, True))
async def test_asgi_23_disconnect_releases_the_minio_connection_before_returning(
    close_raises: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    sent: list[dict[str, object]] = []
    first_chunk_sent = anyio.Event()

    class StorageResponse:
        def stream(self, _chunk_size: int):
            yield b"first"
            yield b"second"

        def close(self) -> None:
            events.append("close")
            if close_raises:
                raise RuntimeError("close failed for internal-object-key")

        def release_conn(self) -> None:
            events.append("release_conn")

    class StorageClient:
        def get_object(self, _bucket: str, _key: str) -> StorageResponse:
            events.append("get_object")
            return StorageResponse()

    gateway = MinioGateway(StorageClient(), bucket="private-bucket")

    async def resolve(*_args, **_kwargs):
        return "internal-object-key", "text/plain", 'inline; filename="safe.txt"'

    monkeypatch.setattr("app.services.artifacts._runtime_gateway", lambda: gateway)
    monkeypatch.setattr("app.services.artifacts.resolve_read_content", resolve)
    response = await artifact_content_route(
        uuid4(),
        expires=1,
        mode="inline",
        signature="0" * 64,
        session=object(),
    )

    async def receive() -> dict[str, object]:
        await first_chunk_sent.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict[str, object]) -> None:
        sent.append(message)
        if message["type"] == "http.response.body":
            first_chunk_sent.set()
            await anyio.sleep_forever()

    await response(
        {"type": "http", "asgi": {"spec_version": "2.3"}},
        receive,
        send,
    )

    assert events == ["get_object", "close", "release_conn"]
    assert "internal-object-key" not in repr(sent)
    assert "close failed" not in repr(sent)


@pytest.mark.anyio
async def test_content_stream_does_not_swallow_non_disconnect_read_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []

    class FailingStorageResponse:
        def stream(self, _chunk_size: int):
            yield b"first"
            raise RuntimeError("upstream read failed")

        def close(self) -> None:
            events.append("close")

        def release_conn(self) -> None:
            events.append("release_conn")

    class StorageClient:
        def get_object(self, _bucket: str, _key: str) -> FailingStorageResponse:
            events.append("get_object")
            return FailingStorageResponse()

    gateway = MinioGateway(StorageClient(), bucket="private-bucket")

    async def resolve(*_args, **_kwargs):
        return "internal-object-key", "text/plain", 'inline; filename="safe.txt"'

    monkeypatch.setattr("app.services.artifacts._runtime_gateway", lambda: gateway)
    monkeypatch.setattr("app.services.artifacts.resolve_read_content", resolve)
    response = await artifact_content_route(
        uuid4(),
        expires=1,
        mode="inline",
        signature="0" * 64,
        session=object(),
    )

    async def send(_message: dict[str, object]) -> None:
        return None

    with pytest.raises(RuntimeError, match="upstream read failed"):
        await response(
            {"type": "http", "asgi": {"spec_version": "2.4"}},
            lambda: None,
            send,
        )
    assert events == ["get_object", "close", "release_conn"]
