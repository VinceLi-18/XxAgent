import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.models.artifact import Artifact, ArtifactVersion
from app.models.audit import AuditEvent
from app.models.retrieval import ArtifactIndexJob, ArtifactTextIndex
from app.services.artifact_index_jobs import (
    MAX_INDEX_ATTEMPTS,
    claim_due_index_job,
    enqueue_index_job,
    retry_index_job,
)


async def _seed_clean_version(
    engine: AsyncEngine,
    *,
    actor_id: UUID,
    content_type: str = "text/plain",
    size: int = 12,
    artifact_id: UUID | None = None,
    version_number: int = 1,
) -> ArtifactVersion:
    resolved_artifact_id = artifact_id or uuid4()
    version = ArtifactVersion(
        id=uuid4(),
        artifact_id=resolved_artifact_id,
        owner_id=actor_id,
        version_number=version_number,
        original_filename="index.txt",
        uploaded_by_id=actor_id,
        declared_size=size,
        actual_size=size,
        detected_content_type=content_type,
        scan_status="clean",
        object_key=f"artifacts/{resolved_artifact_id}/{uuid4()}",
        size=size,
        sha256="a" * 64,
    )
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            if artifact_id is None:
                session.add(
                    Artifact(
                        id=resolved_artifact_id,
                        filename="index.txt",
                        created_by_id=actor_id,
                        owner_id=actor_id,
                    )
                )
            session.add(version)
    return version


@pytest.mark.anyio
async def test_clean_supported_version_enqueues_one_immutable_generation(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice
) -> None:
    version = await _seed_clean_version(seeded_database, actor_id=alice.id)
    now = datetime(2026, 8, 28, 10, 0, tzinfo=UTC)
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)

    async with sessions() as session:
        async with session.begin():
            first = await enqueue_index_job(session, version, now=now)
            second = await enqueue_index_job(session, version, now=now)

    async with AsyncSession(seeded_database) as session:
        indexes = list(
            (await session.scalars(select(ArtifactTextIndex).where(ArtifactTextIndex.version_id == version.id))).all()
        )
        jobs = list((await session.scalars(select(ArtifactIndexJob))).all())
    assert first is not None and second == first
    assert len(indexes) == len(jobs) == 1
    assert indexes[0].id == first and indexes[0].generation == 1
    assert indexes[0].status == "building" and jobs[0].status == "ready"
    async with AsyncSession(seeded_database) as session:
        audit = await session.scalar(
            select(AuditEvent).where(AuditEvent.request_id == jobs[0].id)
        )
    assert audit is not None
    assert (audit.action, audit.result) == ("artifact.index.created", "created")
    assert audit.resource_id == version.id
    assert audit.artifact_id == version.artifact_id
    assert audit.version_id == version.id
    assert audit.index_id == first
    assert audit.index_generation == 1


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("content_type", "size"),
    (("application/pdf", 10), ("text/plain", 10 * 1024 * 1024 + 1)),
)
async def test_clean_non_indexable_version_remains_without_a_job(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
    content_type: str,
    size: int,
) -> None:
    version = await _seed_clean_version(
        seeded_database, actor_id=alice.id, content_type=content_type, size=size
    )
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)
    async with sessions() as session:
        async with session.begin():
            assert await enqueue_index_job(session, version, now=datetime.now(UTC)) is None

    async with AsyncSession(seeded_database) as session:
        assert await session.scalar(select(func.count()).select_from(ArtifactTextIndex)) == 0
        assert (await session.get(ArtifactVersion, version.id)).scan_status == "clean"


@pytest.mark.anyio
async def test_claim_reclaims_expired_lease_and_rejects_old_token(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice
) -> None:
    version = await _seed_clean_version(seeded_database, actor_id=alice.id)
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)
    claimed_at = datetime(2026, 8, 28, 10, 0, tzinfo=UTC)
    async with sessions() as session:
        async with session.begin():
            await enqueue_index_job(session, version, now=claimed_at)
            old = await claim_due_index_job(session, now=claimed_at, lease_seconds=30)
    assert old is not None

    reclaimed_at = claimed_at + timedelta(seconds=31)
    async with sessions() as session:
        async with session.begin():
            new = await claim_due_index_job(session, now=reclaimed_at, lease_seconds=30)
    assert new is not None and new.generation_id == old.generation_id
    assert new.lease_token != old.lease_token and new.attempt == 2

    async with sessions() as session:
        async with session.begin():
            assert not await retry_index_job(
                session, old, now=reclaimed_at, failure_code="retrieval-unavailable"
            )


@pytest.mark.anyio
async def test_retry_is_bounded_and_terminal_failure_preserves_clean_version(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice
) -> None:
    version = await _seed_clean_version(seeded_database, actor_id=alice.id)
    now = datetime(2026, 8, 28, 10, 0, tzinfo=UTC)
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)
    async with sessions() as session:
        async with session.begin():
            index_id = await enqueue_index_job(session, version, now=now)
    assert index_id is not None
    async with seeded_database.begin() as connection:
        await connection.execute(
            text("UPDATE artifact_index_jobs SET attempts = :attempts WHERE index_id = :index_id"),
            {"attempts": MAX_INDEX_ATTEMPTS - 1, "index_id": index_id},
        )
    async with sessions() as session:
        async with session.begin():
            lease = await claim_due_index_job(session, now=now, lease_seconds=60)
    assert lease is not None and lease.attempt == MAX_INDEX_ATTEMPTS
    async with sessions() as session:
        async with session.begin():
            assert await retry_index_job(
                session, lease, now=now + timedelta(seconds=1), failure_code="indexing-failed"
            )

    async with AsyncSession(seeded_database) as session:
        job = await session.scalar(select(ArtifactIndexJob).where(ArtifactIndexJob.index_id == index_id))
        index = await session.get(ArtifactTextIndex, index_id)
        stored_version = await session.get(ArtifactVersion, version.id)
    assert job is not None and job.status == "dead" and job.failure_code == "indexing-failed"
    assert index is not None and index.status == "failed" and index.failure_code == "indexing-failed"
    assert stored_version is not None and stored_version.scan_status == "clean"
    async with AsyncSession(seeded_database) as session:
        outcomes = list(
            await session.scalars(
                select(AuditEvent.result)
                .where(AuditEvent.request_id == job.id)
                .order_by(AuditEvent.created_at, AuditEvent.id)
            )
        )
    assert outcomes == ["created", "dead"]


@pytest.mark.anyio
async def test_concurrent_versions_allocate_distinct_monotonic_generations(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice
) -> None:
    first = await _seed_clean_version(seeded_database, actor_id=alice.id)
    second = await _seed_clean_version(
        seeded_database,
        actor_id=alice.id,
        artifact_id=first.artifact_id,
        version_number=2,
    )
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)

    async def enqueue(version: ArtifactVersion) -> UUID | None:
        async with sessions() as session:
            async with session.begin():
                return await enqueue_index_job(session, version, now=datetime.now(UTC))

    index_ids = await asyncio.gather(enqueue(first), enqueue(second))

    assert all(index_id is not None for index_id in index_ids)
    async with AsyncSession(seeded_database) as session:
        generations = list(
            await session.scalars(
                select(ArtifactTextIndex.generation).where(
                    ArtifactTextIndex.artifact_id == first.artifact_id
                )
            )
        )
    assert sorted(generations) == [1, 2]
