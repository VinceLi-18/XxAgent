from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.models.artifact import ArtifactProcessingJob, ArtifactVersion
from app.services.artifact_jobs import (
    claim_due_job,
    finish_job,
    heartbeat_job,
    retry_job,
)


@dataclass(frozen=True)
class SeededJob:
    job_id: UUID
    version_id: UUID


async def _seed_job(
    engine: AsyncEngine,
    *,
    actor_id: UUID,
    now: datetime,
    attempts: int = 0,
    status: str = "ready",
    lease_token: UUID | None = None,
    lease_expires_at: datetime | None = None,
) -> SeededJob:
    artifact_id = uuid4()
    version_id = uuid4()
    job_id = uuid4()
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                "VALUES (:id, 'lease-test.txt', :actor_id, :actor_id)"
            ),
            {"id": artifact_id, "actor_id": actor_id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, "
                "uploaded_by_id, declared_size, scan_status, staging_key, "
                "staging_expires_at, object_key, size, sha256) "
                "VALUES (:id, :artifact_id, :actor_id, 1, 'lease-test.txt', :actor_id, "
                "4, :scan_status, :staging_key, :staging_expires_at, NULL, 4, :sha256)"
            ),
            {
                "id": version_id,
                "artifact_id": artifact_id,
                "actor_id": actor_id,
                "scan_status": "scanning" if status == "leased" else "pending",
                "staging_key": f"staging/{uuid4()}",
                "staging_expires_at": now + timedelta(days=1),
                "sha256": "0" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_processing_jobs "
                "(id, version_id, status, attempts, next_attempt_at, lease_token, "
                "lease_expires_at) VALUES "
                "(:id, :version_id, :status, :attempts, :now, :lease_token, "
                ":lease_expires_at)"
            ),
            {
                "id": job_id,
                "version_id": version_id,
                "status": status,
                "attempts": attempts,
                "now": now,
                "lease_token": lease_token,
                "lease_expires_at": lease_expires_at,
            },
        )
    return SeededJob(job_id=job_id, version_id=version_id)


def _worker_sessions(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def _claim(
    sessions: async_sessionmaker[AsyncSession],
    *,
    now: datetime,
    lease_seconds: int = 60,
):
    async with sessions() as session:
        async with session.begin():
            return await claim_due_job(session, now=now, lease_seconds=lease_seconds)


@pytest.mark.anyio
async def test_claim_uses_skip_locked_to_select_a_different_due_job(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    now = datetime(2026, 8, 25, 10, 0, tzinfo=UTC)
    jobs = {
        (await _seed_job(seeded_database, actor_id=alice.id, now=now)).job_id,
        (await _seed_job(seeded_database, actor_id=alice.id, now=now)).job_id,
    }
    sessions = _worker_sessions(worker_engine)

    async with sessions() as first_session, sessions() as second_session:
        async with first_session.begin():
            first = await claim_due_job(first_session, now=now, lease_seconds=60)
            async with second_session.begin():
                second = await claim_due_job(second_session, now=now, lease_seconds=60)

    assert first is not None
    assert second is not None
    assert {first.job_id, second.job_id} == jobs


@pytest.mark.anyio
async def test_two_workers_cannot_hold_the_same_job(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    now = datetime(2026, 8, 25, 10, 0, tzinfo=UTC)
    seeded = await _seed_job(seeded_database, actor_id=alice.id, now=now)
    sessions = _worker_sessions(worker_engine)

    async with sessions() as first_session, sessions() as second_session:
        async with first_session.begin():
            first = await claim_due_job(first_session, now=now, lease_seconds=60)
            async with second_session.begin():
                second = await claim_due_job(second_session, now=now, lease_seconds=60)

    assert first is not None and first.job_id == seeded.job_id
    assert second is None


@pytest.mark.anyio
async def test_first_claim_increments_attempts_and_starts_scanning(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    now = datetime(2026, 8, 25, 10, 0, tzinfo=UTC)
    seeded = await _seed_job(seeded_database, actor_id=alice.id, now=now)

    lease = await _claim(_worker_sessions(worker_engine), now=now)

    assert lease is not None
    assert lease.job_id == seeded.job_id
    assert lease.version_id == seeded.version_id
    assert lease.attempt == 1
    async with AsyncSession(seeded_database) as session:
        job = await session.get(ArtifactProcessingJob, seeded.job_id)
        version = await session.get(ArtifactVersion, seeded.version_id)
    assert job is not None and job.status == "leased" and job.attempts == 1
    assert version is not None and version.scan_status == "scanning"


@pytest.mark.anyio
async def test_heartbeat_extends_only_a_live_lease(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    claimed_at = datetime(2026, 8, 25, 10, 0, tzinfo=UTC)
    seeded = await _seed_job(seeded_database, actor_id=alice.id, now=claimed_at)
    sessions = _worker_sessions(worker_engine)
    lease = await _claim(sessions, now=claimed_at)
    assert lease is not None

    heartbeat_at = claimed_at + timedelta(seconds=20)
    async with sessions() as session:
        async with session.begin():
            extended = await heartbeat_job(
                session,
                lease,
                now=heartbeat_at,
                lease_seconds=60,
            )
    async with AsyncSession(seeded_database) as session:
        job = await session.get(ArtifactProcessingJob, seeded.job_id)

    assert extended
    assert job is not None and job.lease_expires_at == heartbeat_at + timedelta(seconds=60)

    async with sessions() as session:
        async with session.begin():
            expired = await heartbeat_job(
                session,
                lease,
                now=heartbeat_at + timedelta(seconds=60),
                lease_seconds=60,
            )
    assert not expired


@pytest.mark.anyio
async def test_expired_lease_is_reclaimed_and_old_token_cannot_mutate_it(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    first_claim_at = datetime(2026, 8, 25, 10, 0, tzinfo=UTC)
    seeded = await _seed_job(seeded_database, actor_id=alice.id, now=first_claim_at)
    sessions = _worker_sessions(worker_engine)
    old_lease = await _claim(sessions, now=first_claim_at)
    assert old_lease is not None

    reclaimed_at = first_claim_at + timedelta(seconds=60)
    new_lease = await _claim(sessions, now=reclaimed_at)
    assert new_lease is not None
    assert new_lease.job_id == old_lease.job_id
    assert new_lease.lease_token != old_lease.lease_token
    assert new_lease.attempt == 2

    async with sessions() as session:
        async with session.begin():
            old_heartbeat = await heartbeat_job(
                session,
                old_lease,
                now=reclaimed_at,
                lease_seconds=60,
            )
            old_finish = await finish_job(session, old_lease, now=reclaimed_at)
            old_retry = await retry_job(
                session,
                old_lease,
                now=reclaimed_at,
                failure_code="stale-worker",
            )

    async with AsyncSession(seeded_database) as session:
        job = await session.get(ArtifactProcessingJob, seeded.job_id)
        version = await session.get(ArtifactVersion, seeded.version_id)
    assert not old_heartbeat and not old_finish and not old_retry
    assert job is not None and job.status == "leased"
    assert job.lease_token == new_lease.lease_token
    assert job.failure_code is None
    assert version is not None and version.scan_status == "scanning"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("prior_attempts", "expected_delay"),
    ((0, 5), (1, 10), (2, 20), (3, 40)),
)
async def test_retry_uses_finite_exponential_backoff(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
    prior_attempts: int,
    expected_delay: int,
) -> None:
    claimed_at = datetime(2026, 8, 25, 10, 0, tzinfo=UTC)
    seeded = await _seed_job(
        seeded_database,
        actor_id=alice.id,
        now=claimed_at,
        attempts=prior_attempts,
    )
    sessions = _worker_sessions(worker_engine)
    lease = await _claim(sessions, now=claimed_at)
    assert lease is not None
    failed_at = claimed_at + timedelta(seconds=1)

    async with sessions() as session:
        async with session.begin():
            retried = await retry_job(
                session,
                lease,
                now=failed_at,
                failure_code="processor-error",
            )

    async with AsyncSession(seeded_database) as session:
        job = await session.get(ArtifactProcessingJob, seeded.job_id)
        version = await session.get(ArtifactVersion, seeded.version_id)
    assert retried
    assert job is not None and job.status == "ready"
    assert job.attempts == prior_attempts + 1
    assert job.next_attempt_at == failed_at + timedelta(seconds=expected_delay)
    assert job.lease_token is None and job.lease_expires_at is None
    assert job.failure_code == "processor-error"
    assert version is not None and version.scan_status == "scanning"


@pytest.mark.anyio
async def test_fifth_failure_closes_job_and_marks_version_failed(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    claimed_at = datetime(2026, 8, 25, 10, 0, tzinfo=UTC)
    seeded = await _seed_job(
        seeded_database,
        actor_id=alice.id,
        now=claimed_at,
        attempts=4,
    )
    sessions = _worker_sessions(worker_engine)
    lease = await _claim(sessions, now=claimed_at)
    assert lease is not None and lease.attempt == 5

    async with sessions() as session:
        async with session.begin():
            closed = await retry_job(
                session,
                lease,
                now=claimed_at + timedelta(seconds=1),
                failure_code="processor-error",
            )

    async with AsyncSession(seeded_database) as session:
        job = await session.get(ArtifactProcessingJob, seeded.job_id)
        version = await session.get(ArtifactVersion, seeded.version_id)
    assert closed
    assert job is not None and job.status == "dead" and job.attempts == 5
    assert job.lease_token is None and job.lease_expires_at is None
    assert version is not None and version.scan_status == "failed"


@pytest.mark.anyio
async def test_finish_requires_live_lease_ownership(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    claimed_at = datetime(2026, 8, 25, 10, 0, tzinfo=UTC)
    seeded = await _seed_job(seeded_database, actor_id=alice.id, now=claimed_at)
    sessions = _worker_sessions(worker_engine)
    lease = await _claim(sessions, now=claimed_at)
    assert lease is not None

    async with sessions() as session:
        async with session.begin():
            finished = await finish_job(
                session,
                lease,
                now=claimed_at + timedelta(seconds=1),
            )

    async with AsyncSession(seeded_database) as session:
        job = await session.scalar(
            select(ArtifactProcessingJob).where(ArtifactProcessingJob.id == seeded.job_id)
        )
    assert finished
    assert job is not None and job.status == "succeeded"
    assert job.lease_token is None and job.lease_expires_at is None
