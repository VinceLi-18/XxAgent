from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from argon2 import PasswordHasher
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.artifact import Artifact, ArtifactProcessingJob, ArtifactVersion
from app.models.audit import AuditEvent
from app.models.workbench import XAgentWorkbenchPreference
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


def _version(
    artifact: Artifact,
    uploader_id: UUID,
    *,
    number: int,
    status: str,
    filename: str | None = None,
) -> ArtifactVersion:
    clean = status == "clean"
    version_id = uuid4()
    return ArtifactVersion(
        id=version_id,
        artifact_id=artifact.id,
        owner_id=artifact.owner_id,
        project_id=artifact.project_id,
        version_number=number,
        original_filename=filename or artifact.filename,
        uploaded_by_id=uploader_id,
        declared_size=number * 10,
        actual_size=number * 10,
        detected_content_type="text/plain" if status != "pending" else None,
        scan_status=status,
        staging_key=None if clean else f"staging/{uuid4()}",
        staging_etag=None if clean else f"etag-{number}",
        staging_expires_at=(
            None if clean else datetime.now(UTC) + timedelta(hours=1)
        ),
        object_key=(
            f"artifacts/{artifact.id}/{version_id}" if clean else None
        ),
        size=number * 10,
        content_type="text/plain" if clean else None,
        sha256=f"{number:x}" * 64,
    )


@pytest.mark.anyio
async def test_list_uses_only_the_server_selected_workbench_scope_and_projects_five_states(
    client,
    seeded_database,
    alice,
    bob,
    alice_project,
    bob_project,
) -> None:
    alice_token = await _login(
        client, seeded_database, alice, "alice@example.test"
    )
    statuses = ("pending", "scanning", "clean", "quarantined", "failed")
    private_artifacts = [
        Artifact(
            id=uuid4(),
            filename=f"private-{status}.txt",
            created_by_id=alice.id,
            owner_id=alice.id,
        )
        for status in statuses
    ]
    project_artifact = Artifact(
        id=uuid4(),
        filename="project-only.txt",
        created_by_id=alice.id,
        project_id=alice_project.id,
    )
    foreign_artifact = Artifact(
        id=uuid4(),
        filename="foreign.txt",
        created_by_id=bob.id,
        owner_id=bob.id,
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add_all((*private_artifacts, project_artifact, foreign_artifact))
            await session.flush()
            for artifact, status in zip(private_artifacts, statuses, strict=True):
                session.add(_version(artifact, alice.id, number=1, status=status))
            session.add(_version(project_artifact, alice.id, number=1, status="clean"))
            session.add(_version(foreign_artifact, bob.id, number=1, status="clean"))

    response = await client.post(
        "/internal/xagent/artifacts/list",
        headers=_headers(alice_token),
        json={},
    )

    assert response.status_code == 200
    payload = response.json()
    assert len(payload) == 5
    assert {item["latest_status"] for item in payload} == set(statuses)
    assert {item["display_name"] for item in payload} == {
        artifact.filename for artifact in private_artifacts
    }
    for item in payload:
        assert set(item) in (
            {"id", "display_name", "scope", "latest_version", "latest_status"},
            {
                "id",
                "display_name",
                "scope",
                "latest_version",
                "latest_status",
                "latest_clean_version",
            },
        )
        assert item["scope"] == {"kind": "private"}

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            preference = await session.get(XAgentWorkbenchPreference, alice.id)
            assert preference is not None
            preference.context_kind = "project"
            preference.project_id = alice_project.id
            preference.updated_at = datetime.now(UTC)
    project_response = await client.post(
        "/internal/xagent/artifacts/list",
        headers=_headers(alice_token),
        json={},
    )
    assert project_response.status_code == 200
    assert project_response.json() == [
        {
            "id": str(project_artifact.id),
            "display_name": "project-only.txt",
            "scope": {"kind": "project", "project_id": str(alice_project.id)},
            "latest_version": 1,
            "latest_status": "clean",
            "latest_clean_version": 1,
        }
    ]


@pytest.mark.anyio
async def test_detail_keeps_latest_failed_distinct_from_clean_fallback_and_orders_history_descending(
    client,
    seeded_database,
    alice,
) -> None:
    alice_token = await _login(
        client, seeded_database, alice, "alice@example.test"
    )
    artifact = Artifact(
        id=uuid4(),
        filename="history.txt",
        created_by_id=alice.id,
        owner_id=alice.id,
    )
    clean = _version(artifact, alice.id, number=1, status="clean", filename="safe.txt")
    failed = _version(artifact, alice.id, number=2, status="failed", filename="new.txt")
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(artifact)
            await session.flush()
            session.add_all((clean, failed))

    response = await client.post(
        f"/internal/xagent/artifacts/{artifact.id}",
        headers=_headers(alice_token),
        json={},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["latest_version"] == 2
    assert payload["latest_status"] == "failed"
    assert payload["latest_clean_version"] == 1
    assert payload["can_edit"] is True
    assert [version["version"] for version in payload["versions"]] == [2, 1]
    assert [version["id"] for version in payload["versions"]] == [
        str(failed.id),
        str(clean.id),
    ]
    serialized = response.text
    for forbidden in (
        "object_key",
        "staging_key",
        "staging_etag",
        "lease_token",
        "failure_code",
    ):
        assert forbidden not in serialized


@pytest.mark.anyio
async def test_retry_resets_one_failed_job_idempotently_and_rejects_quarantine_or_expired_staging(
    client,
    seeded_database,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    alice_token = await _login(
        client, seeded_database, alice, "alice@example.test"
    )
    now = datetime.now(UTC)
    artifacts = [
        Artifact(id=uuid4(), filename=name, created_by_id=alice.id, owner_id=alice.id)
        for name in ("retry.txt", "quarantine.txt", "expired.txt")
    ]
    retryable = _version(artifacts[0], alice.id, number=1, status="failed")
    quarantined = _version(artifacts[1], alice.id, number=1, status="quarantined")
    expired = _version(artifacts[2], alice.id, number=1, status="failed")
    expired.staging_expires_at = now - timedelta(seconds=1)
    job = ArtifactProcessingJob(
        version_id=retryable.id,
        status="dead",
        attempts=5,
        next_attempt_at=now,
        failure_code="inspection-unavailable",
    )

    class RetryGateway:
        def stat(self, key: str) -> ObjectMetadata:
            assert key == retryable.staging_key
            return ObjectMetadata(
                size=retryable.actual_size or 0,
                content_type=None,
                etag=retryable.staging_etag,
            )

    monkeypatch.setattr(
        "app.services.artifacts._runtime_gateway",
        lambda: RetryGateway(),
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add_all(artifacts)
            await session.flush()
            session.add_all((retryable, quarantined, expired))
            await session.flush()
            session.add(job)

    body = {"idempotency_key": "retry-once"}
    first = await client.post(
        f"/internal/xagent/artifact-versions/{retryable.id}/retry",
        headers=_headers(alice_token),
        json=body,
    )
    replay = await client.post(
        f"/internal/xagent/artifact-versions/{retryable.id}/retry",
        headers=_headers(alice_token),
        json=body,
    )
    quarantine_response = await client.post(
        f"/internal/xagent/artifact-versions/{quarantined.id}/retry",
        headers=_headers(alice_token),
        json={"idempotency_key": "quarantine"},
    )
    expired_response = await client.post(
        f"/internal/xagent/artifact-versions/{expired.id}/retry",
        headers=_headers(alice_token),
        json={"idempotency_key": "expired"},
    )

    assert first.status_code == replay.status_code == 200
    assert replay.json() == first.json()
    assert first.json()["latest_status"] == "pending"
    assert quarantine_response.status_code == 404
    assert quarantine_response.json() == {"detail": {"code": "not-found"}}
    assert expired_response.status_code == 410
    assert expired_response.json() == {"detail": {"code": "upload-expired"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        stored_job = await session.get(ArtifactProcessingJob, job.id)
        audits = list(
            (
                await session.scalars(
                    select(AuditEvent)
                    .where(
                        AuditEvent.actor_id == alice.id,
                        AuditEvent.action == "artifact.scan.retry",
                    )
                    .order_by(AuditEvent.created_at, AuditEvent.id)
                )
            ).all()
        )
    assert stored_job is not None
    assert (
        stored_job.status,
        stored_job.attempts,
        stored_job.lease_token,
        stored_job.lease_expires_at,
        stored_job.failure_code,
    ) == ("ready", 0, None, None, None)
    assert [event.result for event in audits] == [
        "allowed",
        "allowed",
        "not-found",
        "upload-expired",
    ]
    assert all(event.executor_kind == "account" for event in audits)
