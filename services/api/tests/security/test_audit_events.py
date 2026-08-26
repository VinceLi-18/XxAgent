from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from argon2 import PasswordHasher
from sqlalchemy import func, select, text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.artifact import (
    Artifact,
    ArtifactProcessingJob,
    ArtifactVersion,
    StagingUpload,
)
from app.models.audit import AuditEvent
from app.models.identity import Role
from app.models.xagent_session import XAgentIdempotencyKey, XAgentSessionEvent
from app.services.artifact_jobs import (
    claim_due_job,
    fail_job,
    publish_clean_job,
    quarantine_job,
)
from app.services.audit import write_audit_event
from app.storage.minio_gateway import ObjectMetadata

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


class AuditGateway:
    def __init__(self) -> None:
        self.objects: dict[str, ObjectMetadata] = {}

    def create_staging_put_url(self, key: str, expires: timedelta) -> str:
        return f"https://storage.test/put?upload={key.rsplit('/', 1)[-1]}"

    def stat(self, key: str) -> ObjectMetadata:
        return self.objects[key]

    def create_read_url(
        self,
        key: str,
        *,
        expires_seconds: int,
        disposition: str,
        filename: str,
    ) -> str:
        return f"https://storage.test/read?ttl={expires_seconds}&mode={disposition}"


@pytest.mark.anyio
async def test_session_event_can_reference_the_current_actors_audit_event(
    actor_session,
    alice,
    alice_private_xagent_session,
) -> None:
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    audit_event = await write_audit_event(
        actor_session,
        alice.id,
        "session.append",
        "xagent_session",
        alice_private_xagent_session.id,
        uuid4(),
        "allowed",
    )
    session_event = XAgentSessionEvent(
        session_id=alice_private_xagent_session.id,
        sequence=0,
        event_type="message/user",
        schema_version=1,
        payload={"text": "hello"},
        actor_id=alice.id,
        audit_id=audit_event.id,
    )
    actor_session.add(session_event)
    await actor_session.flush()

    stored_event = await actor_session.scalar(
        select(XAgentSessionEvent).where(
            XAgentSessionEvent.session_id == alice_private_xagent_session.id,
            XAgentSessionEvent.sequence == 0,
        )
    )

    assert stored_event is not None
    assert stored_event.audit_id == audit_event.id


@pytest.mark.anyio
async def test_actor_cannot_read_another_actors_session_audit_event(
    actor_session,
    audit_session,
    alice,
    bob,
    bob_private_xagent_session,
) -> None:
    event = AuditEvent(
        actor_id=bob.id,
        action="session.open",
        resource_type="xagent_session",
        resource_id=bob_private_xagent_session.id,
        request_id=uuid4(),
        result="allowed",
    )
    async with audit_session.begin():
        audit_session.add(event)

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    stored_event = await actor_session.scalar(
        select(AuditEvent).where(AuditEvent.id == event.id)
    )

    assert stored_event is None


@pytest.mark.anyio
async def test_application_role_cannot_update_or_delete_audit_events(
    actor_session,
    alice,
    alice_private_xagent_session,
) -> None:
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    await write_audit_event(
        actor_session,
        alice.id,
        "session.open",
        "xagent_session",
        alice_private_xagent_session.id,
        uuid4(),
        "allowed",
    )

    for statement in (
        "UPDATE audit_events SET result = 'denied'",
        "DELETE FROM audit_events",
    ):
        with pytest.raises(ProgrammingError, match="permission denied"):
            async with actor_session.begin_nested():
                await actor_session.execute(text(statement))


@pytest.mark.anyio
async def test_upload_create_complete_new_version_and_rejection_write_account_audits(
    client,
    seeded_database,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    gateway = AuditGateway()
    monkeypatch.setattr("app.services.artifacts._runtime_gateway", lambda: gateway)

    created = await client.post(
        "/internal/xagent/artifacts/uploads",
        headers=_headers(token),
        json={"filename": "audit.txt", "size": 5, "idempotency_key": "create"},
    )
    assert created.status_code == 201
    upload_id = UUID(created.json()["upload_id"])
    gateway.objects[f"staging/{upload_id}"] = ObjectMetadata(
        size=5,
        content_type="text/plain",
        etag="etag-audit",
    )
    completed = await client.post(
        f"/internal/xagent/artifacts/uploads/{upload_id}/complete",
        headers=_headers(token),
        json={
            "actual_size": 5,
            "sha256": "a" * 64,
            "idempotency_key": "complete",
        },
    )
    assert completed.status_code == 201
    artifact_id = UUID(completed.json()["id"])
    new_version = await client.post(
        f"/internal/xagent/artifacts/{artifact_id}/uploads",
        headers=_headers(token),
        json={"filename": "audit-v2.txt", "size": 6, "idempotency_key": "version"},
    )
    rejected_id = uuid4()
    rejected = await client.post(
        f"/internal/xagent/artifacts/{rejected_id}/uploads",
        headers=_headers(token),
        json={"filename": "hidden.txt", "size": 1, "idempotency_key": "reject"},
    )

    assert new_version.status_code == 201
    assert rejected.status_code == 404
    assert rejected.json() == {"detail": {"code": "not-found"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        events = list(
            (
                await session.scalars(
                    select(AuditEvent)
                    .where(AuditEvent.actor_id == alice.id)
                    .order_by(AuditEvent.created_at, AuditEvent.id)
                )
            ).all()
        )
    assert [(event.action, event.result) for event in events] == [
        ("artifact.upload.create", "allowed"),
        ("artifact.upload.complete", "allowed"),
        ("artifact.version.upload.create", "allowed"),
        ("artifact.version.upload.create", "not-found"),
    ]
    assert all(event.executor_kind == "account" for event in events)
    assert events[-1].resource_id == rejected_id


@pytest.mark.anyio
async def test_query_and_read_successes_and_not_found_rejections_commit_account_audits(
    client,
    seeded_database,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    gateway = AuditGateway()
    monkeypatch.setattr("app.services.artifacts._runtime_gateway", lambda: gateway)
    artifact = Artifact(
        id=uuid4(),
        filename="read-audit.txt",
        created_by_id=alice.id,
        owner_id=alice.id,
    )
    version = ArtifactVersion(
        id=uuid4(),
        artifact_id=artifact.id,
        owner_id=alice.id,
        version_number=1,
        original_filename="read-audit.txt",
        uploaded_by_id=alice.id,
        declared_size=4,
        actual_size=4,
        detected_content_type="text/plain",
        scan_status="clean",
        object_key=f"artifacts/{artifact.id}/{uuid4()}",
        size=4,
        content_type="text/plain",
        sha256="b" * 64,
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add_all((artifact, version))

    missing_id = uuid4()
    responses = (
        await client.post(
            "/internal/xagent/artifacts/list", headers=_headers(token), json={}
        ),
        await client.post(
            f"/internal/xagent/artifacts/{artifact.id}",
            headers=_headers(token),
            json={},
        ),
        await client.post(
            f"/internal/xagent/artifact-versions/{version.id}/preview",
            headers=_headers(token),
            json={},
        ),
        await client.post(
            f"/internal/xagent/artifact-versions/{version.id}/download",
            headers=_headers(token),
            json={},
        ),
        await client.post(
            f"/internal/xagent/artifacts/{missing_id}",
            headers=_headers(token),
            json={},
        ),
    )
    assert [response.status_code for response in responses] == [200, 200, 200, 200, 404]
    assert responses[-1].json() == {"detail": {"code": "not-found"}}

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        events = list(
            (
                await session.scalars(
                    select(AuditEvent)
                    .where(AuditEvent.actor_id == alice.id)
                    .order_by(AuditEvent.created_at, AuditEvent.id)
                )
            ).all()
        )
    assert {(event.action, event.result) for event in events} == {
        ("artifact.list", "allowed"),
        ("artifact.detail", "allowed"),
        ("artifact.preview", "allowed"),
        ("artifact.download", "allowed"),
        ("artifact.detail", "not-found"),
    }
    assert all(event.executor_kind == "account" for event in events)
    assert not any(
        forbidden in str(vars(event))
        for event in events
        for forbidden in ("object_key", "staging_key", "https://", "etag")
    )


@pytest.mark.parametrize("terminal", ("clean", "quarantined", "failed"))
@pytest.mark.anyio
async def test_worker_scan_transitions_use_uploader_actor_and_worker_executor(
    seeded_database,
    worker_engine,
    alice,
    terminal: str,
) -> None:
    now = datetime.now(UTC)
    artifact_id = uuid4()
    version_id = uuid4()
    job_id = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                "VALUES (:id, 'worker-audit.txt', :actor_id, :actor_id)"
            ),
            {"id": artifact_id, "actor_id": alice.id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, "
                "uploaded_by_id, declared_size, actual_size, scan_status, staging_key, "
                "staging_etag, staging_expires_at, size, sha256) VALUES "
                "(:id, :artifact_id, :actor_id, 1, 'worker-audit.txt', :actor_id, "
                "4, 4, 'pending', :staging_key, 'etag', :expires_at, 4, :sha256)"
            ),
            {
                "id": version_id,
                "artifact_id": artifact_id,
                "actor_id": alice.id,
                "staging_key": f"staging/{uuid4()}",
                "expires_at": now + timedelta(hours=1),
                "sha256": "c" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_processing_jobs "
                "(id, version_id, status, attempts, next_attempt_at) "
                "VALUES (:id, :version_id, 'ready', 0, :now)"
            ),
            {"id": job_id, "version_id": version_id, "now": now},
        )
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)
    async with sessions() as session:
        async with session.begin():
            lease = await claim_due_job(session, now=now, lease_seconds=60)
    assert lease is not None
    async with sessions() as session:
        async with session.begin():
            if terminal == "clean":
                changed = await publish_clean_job(
                    session,
                    lease,
                    now=now + timedelta(seconds=1),
                    object_key=f"artifacts/{artifact_id}/{version_id}",
                    actual_size=4,
                    sha256="c" * 64,
                    content_type="text/plain",
                )
            elif terminal == "quarantined":
                changed = await quarantine_job(
                    session,
                    lease,
                    now=now + timedelta(seconds=1),
                    actual_size=4,
                    sha256="c" * 64,
                    content_type="text/plain",
                )
            else:
                changed = await fail_job(
                    session,
                    lease,
                    now=now + timedelta(seconds=1),
                    failure_code="identity-mismatch",
                )
    assert changed is True

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        events = list(
            (
                await session.scalars(
                    select(AuditEvent)
                    .where(AuditEvent.resource_id == version_id)
                    .order_by(AuditEvent.created_at, AuditEvent.id)
                )
            ).all()
        )
    assert [(event.action, event.result) for event in events] == [
        ("artifact.scan.start", "allowed"),
        (f"artifact.scan.{terminal}", "allowed"),
    ]
    assert all(event.actor_id == alice.id for event in events)
    assert all(event.executor_kind == "artifact_worker" for event in events)


@pytest.mark.anyio
async def test_account_audit_failure_rolls_back_successful_upload_creation(
    client,
    seeded_database,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    gateway = AuditGateway()
    monkeypatch.setattr("app.services.artifacts._runtime_gateway", lambda: gateway)

    async def reject_audit(*_args, **_kwargs):
        raise RuntimeError("audit unavailable")

    monkeypatch.setattr(
        "app.api.routes.internal_artifacts.write_audit_event",
        reject_audit,
    )

    with pytest.raises(RuntimeError, match="audit unavailable"):
        await client.post(
            "/internal/xagent/artifacts/uploads",
            headers=_headers(token),
            json={
                "filename": "must-rollback.txt",
                "size": 5,
                "idempotency_key": "audit-rollback",
            },
        )

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        staging_count = await session.scalar(
            select(func.count()).select_from(StagingUpload)
        )
        idempotency_count = await session.scalar(
            select(func.count())
            .select_from(XAgentIdempotencyKey)
            .where(XAgentIdempotencyKey.operation == "artifact.upload.create")
        )
    assert (staging_count, idempotency_count) == (0, 0)


@pytest.mark.anyio
async def test_upload_signing_failure_returns_stable_error_and_commits_rejection_audit(
    client,
    seeded_database,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")

    class UnavailableGateway:
        def create_staging_put_url(self, _key: str, _expires: timedelta) -> str:
            raise RuntimeError("storage details must remain internal")

    monkeypatch.setattr(
        "app.services.artifacts._runtime_gateway",
        lambda: UnavailableGateway(),
    )

    response = await client.post(
        "/internal/xagent/artifacts/uploads",
        headers=_headers(token),
        json={
            "filename": "unavailable.txt",
            "size": 5,
            "idempotency_key": "storage-unavailable",
        },
    )

    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "service-unavailable"}}
    assert "storage details" not in response.text
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        event = await session.scalar(
            select(AuditEvent).where(
                AuditEvent.actor_id == alice.id,
                AuditEvent.action == "artifact.upload.create",
            )
        )
        staging_count = await session.scalar(
            select(func.count()).select_from(StagingUpload)
        )
    assert event is not None and event.result == "service-unavailable"
    assert staging_count == 0


@pytest.mark.anyio
async def test_worker_audit_failure_rolls_back_scan_start(
    seeded_database,
    worker_engine,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(UTC)
    artifact_id = uuid4()
    version_id = uuid4()
    job_id = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                "VALUES (:id, 'worker-rollback.txt', :actor_id, :actor_id)"
            ),
            {"id": artifact_id, "actor_id": alice.id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, "
                "uploaded_by_id, declared_size, actual_size, scan_status, staging_key, "
                "staging_etag, staging_expires_at, size, sha256) VALUES "
                "(:id, :artifact_id, :actor_id, 1, 'worker-rollback.txt', :actor_id, "
                "4, 4, 'pending', :staging_key, 'etag', :expires_at, 4, :sha256)"
            ),
            {
                "id": version_id,
                "artifact_id": artifact_id,
                "actor_id": alice.id,
                "staging_key": f"staging/{uuid4()}",
                "expires_at": now + timedelta(hours=1),
                "sha256": "d" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_processing_jobs "
                "(id, version_id, status, attempts, next_attempt_at) "
                "VALUES (:id, :version_id, 'ready', 0, :now)"
            ),
            {"id": job_id, "version_id": version_id, "now": now},
        )

    async def reject_audit(*_args, **_kwargs):
        raise RuntimeError("worker audit unavailable")

    monkeypatch.setattr(
        "app.services.artifact_jobs.write_audit_event",
        reject_audit,
    )
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)
    with pytest.raises(RuntimeError, match="worker audit unavailable"):
        async with sessions() as session:
            async with session.begin():
                await claim_due_job(session, now=now, lease_seconds=60)

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        job = await session.get(ArtifactProcessingJob, job_id)
        version = await session.get(ArtifactVersion, version_id)
    assert job is not None
    assert (job.status, job.attempts, job.lease_token) == ("ready", 0, None)
    assert version is not None and version.scan_status == "pending"
