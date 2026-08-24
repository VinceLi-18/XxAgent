from datetime import UTC, datetime, timedelta
from hashlib import sha256
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.audit import AuditEvent
from app.models.identity import Role


class MemoryGateway:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.copied_keys: list[str] = []
        self.removed_keys: list[str] = []

    def stat(self, key: str):
        content, content_type = self.objects[key]
        return SimpleNamespace(size=len(content), content_type=content_type, etag=sha256(content).hexdigest())

    def stream(self, key: str):
        yield self.objects[key][0]

    def copy(self, source: str, target: str, etag: str | None = None) -> None:
        if etag != sha256(self.objects[source][0]).hexdigest():
            raise ValueError("staging object changed")
        self.objects[target] = self.objects[source]
        self.copied_keys.append(target)

    def remove(self, key: str) -> None:
        self.objects.pop(key, None)
        self.removed_keys.append(key)

    def create_staging_put_url(self, key: str, _expires) -> str:
        return f"https://storage.test/staging-put/{key}"


class CleanScanner:
    def __init__(self, clean: bool = True) -> None:
        self.clean = clean

    def scan_stream(self, chunks):
        list(chunks)
        return SimpleNamespace(clean=self.clean)


@pytest.fixture
def artifact_gateway(monkeypatch: pytest.MonkeyPatch) -> MemoryGateway:
    from app.services.artifacts import ArtifactService, UploadRejectedError

    gateway = MemoryGateway()
    monkeypatch.setattr(
        "app.services.artifacts._runtime_service",
        lambda: ArtifactService(gateway, CleanScanner()),
    )
    return gateway


@pytest.fixture
async def private_artifact(seeded_database, alice, artifact_gateway: MemoryGateway):
    from app.models.artifact import Artifact, ArtifactVersion

    artifact = Artifact(id=uuid4(), filename="private.txt", owner_id=alice.id)
    version = ArtifactVersion(
        artifact_id=artifact.id,
        owner_id=alice.id,
        object_key=f"artifacts/{artifact.id}/version",
        size=len(b"private-content"),
        content_type="text/plain",
        sha256=sha256(b"private-content").hexdigest(),
    )
    artifact_gateway.objects[version.object_key] = (b"private-content", "text/plain")
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add_all((artifact, version))
    return artifact


@pytest.fixture
async def shared_artifact(seeded_database, alice, bob, artifact_gateway: MemoryGateway):
    from app.models.artifact import Artifact, ArtifactVersion
    from app.models.project import Project, ProjectMembership

    project = Project(id=uuid4(), name="Artifact project", owner_id=bob.id)
    artifact = Artifact(id=uuid4(), filename="shared.txt", project_id=project.id)
    version = ArtifactVersion(
        artifact_id=artifact.id,
        project_id=project.id,
        object_key=f"artifacts/{artifact.id}/version",
        size=len(b"private-content"),
        content_type="text/plain",
        sha256=sha256(b"private-content").hexdigest(),
    )
    membership = ProjectMembership(project_id=project.id, account_id=alice.id)
    artifact_gateway.objects[version.object_key] = (b"private-content", "text/plain")
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(project)
            await session.flush()
            session.add_all((artifact, version, membership))
    return artifact, project


def declared(content: bytes = b"private", **overrides):
    values = {
        "size": len(content),
        "content_type": "text/plain",
        "sha256": sha256(content).hexdigest(),
    }
    values.update(overrides)
    return values


@pytest.mark.anyio
async def test_expired_or_foreign_staging_upload_is_hidden(seeded_database, actor_session, alice, bob):
    from app.models.artifact import StagingUpload
    from app.services.artifacts import ArtifactService

    service = ArtifactService(MemoryGateway(), CleanScanner())
    upload = StagingUpload(
        created_by_id=alice.id,
        filename="memo.txt",
        owner_id=alice.id,
        staging_key="staging/expired-upload",
        expires_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as admin_session:
        async with admin_session.begin():
            admin_session.add(upload)

    await set_actor_context(actor_session, Actor(id=bob.id, role=Role.SPECIALIST))
    assert await service.complete(actor_session, Actor(id=bob.id, role=Role.SPECIALIST), upload.id, declared()) is None
    assert await actor_session.scalar(select(StagingUpload).where(StagingUpload.id == upload.id)) is None


@pytest.mark.anyio
async def test_hash_mismatch_or_scan_failure_never_creates_version(actor_session, alice):
    from app.models.artifact import ArtifactVersion
    from app.services.artifacts import ArtifactService, UploadRejectedError

    gateway = MemoryGateway()
    service = ArtifactService(gateway, CleanScanner())
    actor = Actor(id=alice.id, role=Role.SPECIALIST)
    await set_actor_context(actor_session, actor)
    upload = await service.create(actor_session, actor, {"filename": "memo.txt"})
    gateway.objects[upload.staging_key] = (b"private", "text/plain")

    with pytest.raises(UploadRejectedError):
        await service.complete(actor_session, actor, upload.id, declared(sha256="wrong"))
    assert gateway.copied_keys == []
    assert await actor_session.scalar(select(ArtifactVersion)) is None

    rejected = ArtifactService(gateway, CleanScanner(clean=False))
    with pytest.raises(UploadRejectedError):
        await rejected.complete(actor_session, actor, upload.id, declared())
    assert gateway.copied_keys == []
    assert await actor_session.scalar(select(ArtifactVersion)) is None


@pytest.mark.anyio
async def test_completion_copies_only_verified_content_and_keeps_server_generated_key(actor_session, alice):
    from app.services.artifacts import ArtifactService

    gateway = MemoryGateway()
    service = ArtifactService(gateway, CleanScanner())
    actor = Actor(id=alice.id, role=Role.SPECIALIST)
    await set_actor_context(actor_session, actor)
    upload = await service.create(actor_session, actor, {"filename": "memo.txt", "object_key": "artifacts/attacker"})
    gateway.objects[upload.staging_key] = (b"private", "text/plain")

    version = await service.complete(actor_session, actor, upload.id, declared())

    assert version is not None
    assert upload.staging_key.startswith("staging/")
    assert version.object_key.startswith(f"artifacts/{version.artifact_id}/")
    assert version.object_key != "artifacts/attacker"
    assert gateway.copied_keys == [version.object_key]
    assert upload.staging_key in gateway.objects


@pytest.mark.anyio
async def test_completion_rejects_a_staging_object_replaced_after_scanning(actor_session, alice):
    from app.services.artifacts import ArtifactService, UploadRejectedError

    gateway = MemoryGateway()
    actor = Actor(id=alice.id, role=Role.SPECIALIST)
    await set_actor_context(actor_session, actor)
    service = ArtifactService(gateway, CleanScanner())
    upload = await service.create(actor_session, actor, {"filename": "memo.txt"})
    gateway.objects[upload.staging_key] = (b"private", "text/plain")

    class ReplacingScanner(CleanScanner):
        def scan_stream(self, chunks):
            result = super().scan_stream(chunks)
            gateway.objects[upload.staging_key] = (b"attacker-content", "text/plain")
            return result

    service.scanner = ReplacingScanner()
    with pytest.raises(UploadRejectedError):
        await service.complete(actor_session, actor, upload.id, declared())

    assert gateway.copied_keys == []


@pytest.mark.anyio
async def test_completion_cleans_copied_object_when_database_flush_fails(actor_session, alice, monkeypatch):
    from app.services.artifacts import ArtifactService

    gateway = MemoryGateway()
    service = ArtifactService(gateway, CleanScanner())
    actor = Actor(id=alice.id, role=Role.SPECIALIST)
    await set_actor_context(actor_session, actor)
    upload = await service.create(actor_session, actor, {"filename": "memo.txt"})
    gateway.objects[upload.staging_key] = (b"private", "text/plain")

    async def failed_flush():
        raise IntegrityError("insert", {}, Exception("forced"))

    monkeypatch.setattr(actor_session, "flush", failed_flush)

    with pytest.raises(IntegrityError):
        await service.complete(actor_session, actor, upload.id, declared())

    assert gateway.copied_keys == gateway.removed_keys


@pytest.mark.anyio
async def test_commit_failure_removes_copied_object_but_preserves_staging(seeded_database, alice, monkeypatch):
    from app.services.artifacts import ArtifactService

    gateway = MemoryGateway()
    service = ArtifactService(gateway, CleanScanner())
    actor = Actor(id=alice.id, role=Role.SPECIALIST)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        await set_actor_context(session, actor)
        upload = await service.create(session, actor, {"filename": "memo.txt"})
        gateway.objects[upload.staging_key] = (b"private", "text/plain")
        version = await service.complete(session, actor, upload.id, declared())

        async def failed_commit():
            await session.rollback()
            raise IntegrityError("commit", {}, Exception("forced"))

        monkeypatch.setattr(session, "commit", failed_commit)
        with pytest.raises(IntegrityError):
            await session.commit()

    assert version is not None
    assert version.object_key not in gateway.objects
    assert upload.staging_key in gateway.objects
    assert gateway.removed_keys == [version.object_key]


@pytest.mark.anyio
async def test_cleanup_failure_does_not_fail_a_committed_promotion(seeded_database, alice):
    from app.services.artifacts import ArtifactService

    class FailingRemoveGateway(MemoryGateway):
        def remove(self, key: str) -> None:
            raise OSError("temporary object-store failure")

    gateway = FailingRemoveGateway()
    service = ArtifactService(gateway, CleanScanner())
    actor = Actor(id=alice.id, role=Role.SPECIALIST)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        await set_actor_context(session, actor)
        upload = await service.create(session, actor, {"filename": "memo.txt"})
        gateway.objects[upload.staging_key] = (b"private", "text/plain")
        version = await service.complete(session, actor, upload.id, declared())
        await session.commit()

    assert version is not None


@pytest.mark.anyio
async def test_savepoint_commit_defers_promotion_cleanup_until_outer_rollback(seeded_database, alice):
    from app.services.artifacts import ArtifactService

    gateway = MemoryGateway()
    service = ArtifactService(gateway, CleanScanner())
    actor = Actor(id=alice.id, role=Role.SPECIALIST)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        await set_actor_context(session, actor)
        upload = await service.create(session, actor, {"filename": "memo.txt"})
        gateway.objects[upload.staging_key] = (b"private", "text/plain")
        async with session.begin_nested():
            version = await service.complete(session, actor, upload.id, declared())

        assert version is not None
        assert version.object_key in gateway.objects
        assert upload.staging_key in gateway.objects
        await session.rollback()

    assert version.object_key not in gateway.objects
    assert upload.staging_key in gateway.objects


@pytest.mark.anyio
async def test_savepoint_rollback_defers_promotion_cleanup_until_outer_commit(seeded_database, alice):
    from app.services.artifacts import ArtifactService

    gateway = MemoryGateway()
    service = ArtifactService(gateway, CleanScanner())
    actor = Actor(id=alice.id, role=Role.SPECIALIST)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        await set_actor_context(session, actor)
        upload = await service.create(session, actor, {"filename": "memo.txt"})
        gateway.objects[upload.staging_key] = (b"private", "text/plain")
        async with session.begin_nested() as savepoint:
            version = await service.complete(session, actor, upload.id, declared())
            await savepoint.rollback()

        assert version is not None
        assert version.object_key in gateway.objects
        assert upload.staging_key in gateway.objects
        await session.commit()

    assert version.object_key not in gateway.objects
    assert upload.staging_key in gateway.objects


@pytest.mark.anyio
async def test_runtime_role_cannot_insert_staging_for_other_private_or_project_scope(
    seeded_database,
    actor_session,
    alice,
    bob,
):
    from app.models.artifact import StagingUpload
    from app.models.project import Project

    project = Project(name="Bob project", owner_id=bob.id)
    async with AsyncSession(seeded_database, expire_on_commit=False) as admin_session:
        async with admin_session.begin():
            admin_session.add(project)

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    for upload in (
        StagingUpload(
            created_by_id=alice.id,
            filename="private.txt",
            owner_id=bob.id,
            staging_key="staging/other-private",
            expires_at=datetime.now(UTC) + timedelta(minutes=10),
        ),
        StagingUpload(
            created_by_id=alice.id,
            filename="project.txt",
            project_id=project.id,
            staging_key="staging/other-project",
            expires_at=datetime.now(UTC) + timedelta(minutes=10),
        ),
    ):
        with pytest.raises(DBAPIError):
            async with actor_session.begin_nested():
                actor_session.add(upload)
                await actor_session.flush()


@pytest.mark.anyio
async def test_scope_constraints_and_runtime_role_permissions(seeded_database, actor_session, alice, application_role):
    from app.models.artifact import Artifact

    async with seeded_database.begin() as connection:
        has_artifact_read = await connection.scalar(
            text("SELECT has_table_privilege(:role, 'artifacts', 'SELECT')"),
            {"role": application_role},
        )
        has_artifact_delete = await connection.scalar(
            text("SELECT has_table_privilege(:role, 'artifacts', 'DELETE')"),
            {"role": application_role},
        )
    assert (has_artifact_read, has_artifact_delete) == (True, False)

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    invalid = Artifact(filename="bad.txt", owner_id=alice.id, project_id=None)
    invalid.owner_id = None
    actor_session.add(invalid)
    with pytest.raises((IntegrityError, DBAPIError)):
        await actor_session.flush()


@pytest.mark.anyio
async def test_authorized_read_streams_bytes_without_exposing_object_key_or_get_url(
    api_client,
    alice_token,
    private_artifact,
    artifact_gateway,
    audit_session,
):
    response = await api_client.get(
        f"/api/v1/artifacts/{private_artifact.id}/content",
        headers={"Authorization": f"Bearer {alice_token}"},
    )

    assert response.status_code == 200
    assert response.content == b"private-content"
    assert "object_key" not in response.text
    assert "http" not in response.text.lower()
    event = await audit_session.scalar(
        select(AuditEvent).where(
            AuditEvent.action == "artifact.read",
            AuditEvent.resource_id == private_artifact.id,
            AuditEvent.result == "allowed",
        )
    )
    assert (event.action, event.resource_type, event.resource_id, event.result) == (
        "artifact.read",
        "artifact",
        private_artifact.id,
        "allowed",
    )


@pytest.mark.anyio
async def test_staging_upload_response_exposes_only_id_and_put_url(
    api_client,
    alice_token,
    artifact_gateway,
    audit_session,
):
    response = await api_client.post(
        "/api/v1/artifacts/staging-uploads",
        headers={"Authorization": f"Bearer {alice_token}"},
        json={"filename": "memo.txt"},
    )

    assert response.status_code == 201
    assert set(response.json()) == {"id", "put_url"}
    assert response.json()["put_url"].startswith("https://")
    assert "object_key" not in response.text

    upload_id = response.json()["id"]
    staging_key = next(iter(artifact_gateway.objects), f"staging/{upload_id}")
    artifact_gateway.objects[staging_key] = (b"private-content", "text/plain")
    complete = await api_client.post(
        f"/api/v1/artifacts/staging-uploads/{upload_id}/complete",
        headers={"Authorization": f"Bearer {alice_token}"},
        json=declared(b"private-content"),
    )

    assert complete.status_code == 201
    assert set(complete.json()) == {"artifact_id", "version_id"}
    assert "object_key" not in complete.text
    event = await audit_session.scalar(select(AuditEvent).order_by(AuditEvent.created_at.desc()))
    assert (event.action, event.result) == ("artifact.upload.complete", "allowed")


@pytest.mark.anyio
async def test_unknown_artifact_read_is_indistinguishable_from_denied_read(
    api_client,
    alice_token,
    artifact_gateway,
):
    response = await api_client.get(
        f"/api/v1/artifacts/{uuid4()}/content",
        headers={"Authorization": f"Bearer {alice_token}"},
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Not found"}


@pytest.mark.anyio
async def test_unknown_completion_writes_a_denied_audit_event(
    api_client,
    alice_token,
    artifact_gateway,
    audit_session,
):
    upload_id = uuid4()
    response = await api_client.post(
        f"/api/v1/artifacts/staging-uploads/{upload_id}/complete",
        headers={"Authorization": f"Bearer {alice_token}"},
        json=declared(b"private-content"),
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Not found"}
    event = await audit_session.scalar(
        select(AuditEvent).where(
            AuditEvent.action == "artifact.upload.complete",
            AuditEvent.resource_id == upload_id,
            AuditEvent.result == "denied",
        )
    )
    assert event is not None


@pytest.mark.anyio
async def test_invalid_completion_returns_422_and_writes_denied_audit(
    api_client,
    alice_token,
    artifact_gateway,
    audit_session,
):
    created = await api_client.post(
        "/api/v1/artifacts/staging-uploads",
        headers={"Authorization": f"Bearer {alice_token}"},
        json={"filename": "memo.txt"},
    )
    upload_id = created.json()["id"]
    artifact_gateway.objects[f"staging/{upload_id}"] = (b"private-content", "text/plain")

    response = await api_client.post(
        f"/api/v1/artifacts/staging-uploads/{upload_id}/complete",
        headers={"Authorization": f"Bearer {alice_token}"},
        json=declared(b"other-content"),
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Upload rejected"}
    assert await audit_session.scalar(
        select(AuditEvent).where(
            AuditEvent.action == "artifact.upload.complete",
            AuditEvent.resource_id == UUID(upload_id),
            AuditEvent.result == "denied",
        )
    ) is not None


@pytest.mark.anyio
async def test_revoked_member_cannot_download_on_next_request(
    api_client,
    alice,
    alice_token,
    shared_artifact,
    artifact_gateway,
    seeded_database,
    audit_session,
):
    artifact, project = shared_artifact
    allowed = await api_client.get(
        f"/api/v1/artifacts/{artifact.id}/content",
        headers={"Authorization": f"Bearer {alice_token}"},
    )
    assert allowed.status_code == 200

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "DELETE FROM project_memberships "
                    "WHERE project_id = :project_id AND account_id = :account_id"
                ),
                {"project_id": project.id, "account_id": alice.id},
            )

    denied = await api_client.get(
        f"/api/v1/artifacts/{artifact.id}/content",
        headers={"Authorization": f"Bearer {alice_token}"},
    )

    assert denied.status_code == 404
    assert denied.json() == {"detail": "Not found"}
    assert "http" not in denied.text.lower()
    event = await audit_session.scalar(
        select(AuditEvent).where(
            AuditEvent.action == "artifact.read",
            AuditEvent.resource_id == artifact.id,
            AuditEvent.result == "denied",
        )
    )
    assert (event.action, event.resource_id, event.result) == (
        "artifact.read",
        artifact.id,
        "denied",
    )
