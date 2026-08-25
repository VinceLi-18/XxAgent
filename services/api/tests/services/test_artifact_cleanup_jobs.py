from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.models.artifact import ArtifactObjectCleanupJob
from app.services.artifact_cleanup_jobs import (
    claim_due_cleanup,
    enqueue_cleanup,
    finish_cleanup,
    heartbeat_cleanup,
    retry_cleanup,
)


def _sessions(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def _enqueue(
    sessions: async_sessionmaker[AsyncSession],
    key: str,
    version_id: str,
    now: datetime,
) -> None:
    async with sessions() as session:
        async with session.begin():
            await enqueue_cleanup(
                session,
                object_key=key,
                version_id=version_id,
                now=now,
            )


@pytest.mark.anyio
async def test_cleanup_identity_is_nonempty_and_unique(
    seeded_database: AsyncEngine,
) -> None:
    now = datetime(2026, 8, 26, 10, 0, tzinfo=UTC)
    key = f"artifacts/{uuid4()}/{uuid4()}"
    valid = {
        "id": uuid4(),
        "object_key": key,
        "version_id": "minio-version-1",
        "now": now,
    }
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifact_object_cleanup_jobs "
                "(id, object_key, version_id, status, attempts, next_attempt_at) "
                "VALUES (:id, :object_key, :version_id, 'ready', 0, :now)"
            ),
            valid,
        )

    for overrides in (
        {"id": uuid4()},
        {"id": uuid4(), "object_key": ""},
        {"id": uuid4(), "version_id": ""},
    ):
        with pytest.raises(IntegrityError):
            async with seeded_database.begin() as connection:
                await connection.execute(
                    text(
                        "INSERT INTO artifact_object_cleanup_jobs "
                        "(id, object_key, version_id, status, attempts, next_attempt_at) "
                        "VALUES (:id, :object_key, :version_id, 'ready', 0, :now)"
                    ),
                    {**valid, **overrides},
                )


@pytest.mark.anyio
async def test_enqueue_cleanup_is_idempotent(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
) -> None:
    sessions = _sessions(worker_engine)
    now = datetime(2026, 8, 26, 10, 0, tzinfo=UTC)

    key = f"artifacts/{uuid4()}/{uuid4()}"
    await _enqueue(sessions, key, "minio-version-1", now)
    await _enqueue(sessions, key, "minio-version-1", now)

    async with AsyncSession(seeded_database) as session:
        rows = (await session.scalars(select(ArtifactObjectCleanupJob))).all()
    assert len(rows) == 1
    assert rows[0].object_key == key
    assert rows[0].version_id == "minio-version-1"


@pytest.mark.anyio
async def test_cleanup_claim_uses_skip_locked(worker_engine: AsyncEngine) -> None:
    sessions = _sessions(worker_engine)
    now = datetime(2026, 8, 26, 10, 0, tzinfo=UTC)
    first_key = f"artifacts/{uuid4()}/{uuid4()}"
    second_key = f"artifacts/{uuid4()}/{uuid4()}"
    await _enqueue(sessions, first_key, "version-1", now)
    await _enqueue(sessions, second_key, "version-2", now)

    async with sessions() as first, sessions() as second:
        async with first.begin():
            first_lease = await claim_due_cleanup(first, now=now, lease_seconds=60)
            async with second.begin():
                second_lease = await claim_due_cleanup(second, now=now, lease_seconds=60)

    assert first_lease is not None and second_lease is not None
    assert {first_lease.object_key, second_lease.object_key} == {
        first_key,
        second_key,
    }


@pytest.mark.anyio
async def test_cleanup_stale_token_cannot_close_reclaimed_lease(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
) -> None:
    sessions = _sessions(worker_engine)
    first_at = datetime(2026, 8, 26, 10, 0, tzinfo=UTC)
    await _enqueue(
        sessions,
        f"artifacts/{uuid4()}/{uuid4()}",
        "version-1",
        first_at,
    )
    async with sessions() as session:
        async with session.begin():
            old = await claim_due_cleanup(session, now=first_at, lease_seconds=60)
    assert old is not None
    reclaimed_at = first_at + timedelta(seconds=60)
    async with sessions() as session:
        async with session.begin():
            new = await claim_due_cleanup(session, now=reclaimed_at, lease_seconds=60)
    assert new is not None and new.lease_token != old.lease_token

    async with sessions() as session:
        async with session.begin():
            assert not await heartbeat_cleanup(
                session, old, now=reclaimed_at, lease_seconds=60
            )
            assert not await finish_cleanup(session, old, now=reclaimed_at)
            assert not await retry_cleanup(
                session,
                old,
                now=reclaimed_at,
                failure_code="remove-failed",
            )

    async with AsyncSession(seeded_database) as session:
        row = await session.get(ArtifactObjectCleanupJob, new.job_id)
    assert row is not None and row.status == "leased"
    assert row.lease_token == new.lease_token


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("prior_attempts", "expected_status", "expected_delay"),
    ((0, "ready", 5), (1, "ready", 10), (2, "ready", 20), (3, "ready", 40), (4, "dead", 0)),
)
async def test_cleanup_retry_is_bounded_and_preserves_identity(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    prior_attempts: int,
    expected_status: str,
    expected_delay: int,
) -> None:
    sessions = _sessions(worker_engine)
    claimed_at = datetime(2026, 8, 26, 10, 0, tzinfo=UTC)
    key = f"artifacts/{uuid4()}/{uuid4()}"
    version_id = f"version-{prior_attempts}"
    await _enqueue(sessions, key, version_id, claimed_at)
    async with AsyncSession(seeded_database) as session:
        async with session.begin():
            await session.execute(
                text(
                    "UPDATE artifact_object_cleanup_jobs SET attempts = :attempts "
                    "WHERE object_key = :key AND version_id = :version_id"
                ),
                {"attempts": prior_attempts, "key": key, "version_id": version_id},
            )
    async with sessions() as session:
        async with session.begin():
            lease = await claim_due_cleanup(session, now=claimed_at, lease_seconds=60)
    assert lease is not None
    failed_at = claimed_at + timedelta(seconds=1)
    async with sessions() as session:
        async with session.begin():
            assert await retry_cleanup(
                session,
                lease,
                now=failed_at,
                failure_code="remove-failed",
            )

    async with AsyncSession(seeded_database) as session:
        row = await session.get(ArtifactObjectCleanupJob, lease.job_id)
    assert row is not None and row.status == expected_status
    assert row.attempts == prior_attempts + 1
    assert row.next_attempt_at == failed_at + timedelta(seconds=expected_delay)
    assert row.object_key == key and row.version_id == version_id
    assert row.lease_token is None and row.lease_expires_at is None


@pytest.mark.anyio
async def test_expired_fifth_cleanup_lease_closes_before_claiming_next_due_job(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
) -> None:
    now = datetime(2026, 8, 26, 10, 0, tzinfo=UTC)
    exhausted_key = f"artifacts/{uuid4()}/{uuid4()}"
    exhausted_version = "exhausted-object-version"
    next_key = f"artifacts/{uuid4()}/{uuid4()}"
    next_version = "next-object-version"
    exhausted_id = uuid4()
    next_id = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifact_object_cleanup_jobs "
                "(id, object_key, version_id, status, attempts, next_attempt_at, "
                "lease_token, lease_expires_at) VALUES "
                "(:exhausted_id, :exhausted_key, :exhausted_version, 'leased', 5, "
                ":exhausted_due, :token, :expired_at), "
                "(:next_id, :next_key, :next_version, 'ready', 0, :next_due, NULL, NULL)"
            ),
            {
                "exhausted_id": exhausted_id,
                "exhausted_key": exhausted_key,
                "exhausted_version": exhausted_version,
                "exhausted_due": now - timedelta(minutes=2),
                "token": uuid4(),
                "expired_at": now - timedelta(seconds=1),
                "next_id": next_id,
                "next_key": next_key,
                "next_version": next_version,
                "next_due": now - timedelta(minutes=1),
            },
        )

    sessions = _sessions(worker_engine)
    async with sessions() as session:
        async with session.begin():
            lease = await claim_due_cleanup(session, now=now, lease_seconds=60)

    async with AsyncSession(seeded_database) as session:
        exhausted = await session.get(ArtifactObjectCleanupJob, exhausted_id)
    assert lease is not None and lease.job_id == next_id and lease.attempt == 1
    assert exhausted is not None and exhausted.status == "dead"
    assert exhausted.attempts == 5
    assert exhausted.failure_code == "lease-expired"
    assert exhausted.lease_token is None and exhausted.lease_expires_at is None
    assert exhausted.object_key == exhausted_key
    assert exhausted.version_id == exhausted_version
