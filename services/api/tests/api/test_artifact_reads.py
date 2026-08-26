from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid4

import pytest
from argon2 import PasswordHasher
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.artifact import Artifact, ArtifactVersion

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

    def create_read_url(
        self,
        key: str,
        *,
        expires_seconds: int,
        disposition: str,
        filename: str,
    ) -> str:
        self.calls.append((key, expires_seconds, disposition, filename))
        return (
            "https://storage.test/read?"
            f"ttl={expires_seconds}&disposition={disposition}&filename={filename}"
        )


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
    assert gateway.calls == [
        (text_version.object_key, 60, "inline", "preview.txt")
    ]
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
    assert len(gateway.calls) == 1
    key, ttl, disposition, filename = gateway.calls[0]
    assert key == version.object_key
    assert ttl == 60
    assert disposition == "attachment"
    assert filename == ".._bad___name__.svg"
    query = parse_qs(urlsplit(response.json()["url"]).query)
    assert query["disposition"] == ["attachment"]
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
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(artifact)
            await session.flush()
            session.add(version)

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
