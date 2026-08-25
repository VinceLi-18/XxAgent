import asyncio
import os
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.core.config import ArtifactWorkerSettings, Settings
from app.models.artifact import ArtifactProcessingJob
from app.worker import _run_worker_loop


async def _seed_job(engine: AsyncEngine, *, actor_id, now: datetime) -> ArtifactProcessingJob:
    artifact_id = uuid4()
    version_id = uuid4()
    job = ArtifactProcessingJob(
        id=uuid4(),
        version_id=version_id,
        status="ready",
        attempts=0,
        next_attempt_at=now,
    )
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                "VALUES (:id, 'worker-loop.txt', :actor_id, :actor_id)"
            ),
            {"id": artifact_id, "actor_id": actor_id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, "
                "uploaded_by_id, declared_size, scan_status, staging_key, "
                "staging_expires_at, object_key, size, sha256) "
                "VALUES (:id, :artifact_id, :actor_id, 1, 'worker-loop.txt', :actor_id, "
                "4, 'pending', :staging_key, :staging_expires_at, NULL, 4, :sha256)"
            ),
            {
                "id": version_id,
                "artifact_id": artifact_id,
                "actor_id": actor_id,
                "staging_key": f"staging/{uuid4()}",
                "staging_expires_at": now + timedelta(days=1),
                "sha256": "0" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_processing_jobs "
                "(id, version_id, status, attempts, next_attempt_at) "
                "VALUES (:id, :version_id, 'ready', 0, :now)"
            ),
            {"id": job.id, "version_id": version_id, "now": now},
        )
    return job


def _sessions(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


def _worker_url(test_database_url: str, worker_role: str) -> str:
    return (
        make_url(test_database_url)
        .set(
            username=worker_role,
            password=os.environ["POSTGRES_WORKER_PASSWORD"],
        )
        .render_as_string(hide_password=False)
    )


def test_api_and_worker_database_settings_are_disjoint() -> None:
    api_settings = Settings()
    worker_settings = ArtifactWorkerSettings(
        _env_file=None,
        DATABASE_WORKER_URL="postgresql+asyncpg://worker:secret@database/xagent",
    )

    assert "DATABASE_WORKER_URL" not in api_settings.model_dump()
    assert worker_settings.model_dump() == {
        "DATABASE_WORKER_URL": "postgresql+asyncpg://worker:secret@database/xagent"
    }


@pytest.mark.anyio
async def test_worker_once_needs_only_worker_database_configuration(
    seeded_database: AsyncEngine,
    worker_role: str,
) -> None:
    del seeded_database
    env = {
        "PATH": os.environ["PATH"],
        "DATABASE_WORKER_URL": _worker_url(os.environ["JX_TEST_DATABASE_URL"], worker_role),
    }
    completed = subprocess.run(
        ["uv", "run", "--project", "services/api", "xagent-api", "worker", "--once"],
        cwd=Path(__file__).resolve().parents[3],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0
    assert completed.stdout == ""
    assert completed.stderr == ""


@pytest.mark.anyio
async def test_worker_commits_claim_before_processing_and_finishes_owned_job(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    now = datetime.now(UTC)
    seeded = await _seed_job(seeded_database, actor_id=alice.id, now=now)

    async def processor(lease) -> None:
        async with seeded_database.begin() as connection:
            locked_id = await connection.scalar(
                text(
                    "SELECT id FROM artifact_processing_jobs "
                    "WHERE id = :job_id FOR UPDATE NOWAIT"
                ),
                {"job_id": lease.job_id},
            )
        assert locked_id == lease.job_id

    await _run_worker_loop(
        _sessions(worker_engine),
        once=True,
        processor=processor,
        lease_seconds=60,
        heartbeat_seconds=20,
        poll_seconds=0,
    )

    async with AsyncSession(seeded_database) as session:
        job = await session.get(ArtifactProcessingJob, seeded.id)
    assert job is not None and job.status == "succeeded" and job.attempts == 1


@pytest.mark.anyio
async def test_processor_exception_retries_instead_of_finishing(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    seeded = await _seed_job(seeded_database, actor_id=alice.id, now=datetime.now(UTC))

    async def processor(_lease) -> None:
        raise RuntimeError("external processor failed")

    await _run_worker_loop(
        _sessions(worker_engine),
        once=True,
        processor=processor,
        lease_seconds=60,
        heartbeat_seconds=20,
        poll_seconds=0,
    )

    async with AsyncSession(seeded_database) as session:
        job = await session.get(ArtifactProcessingJob, seeded.id)
    assert job is not None and job.status == "ready" and job.attempts == 1
    assert job.failure_code == "processor-error"
    assert job.next_attempt_at > datetime.now(UTC)


@pytest.mark.anyio
async def test_missing_late_bound_processor_retries_safely(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    seeded = await _seed_job(seeded_database, actor_id=alice.id, now=datetime.now(UTC))

    def missing_processor():
        raise ModuleNotFoundError("app.services.artifact_processing")

    await _run_worker_loop(
        _sessions(worker_engine),
        once=True,
        processor_resolver=missing_processor,
        lease_seconds=60,
        heartbeat_seconds=20,
        poll_seconds=0,
    )

    async with AsyncSession(seeded_database) as session:
        job = await session.get(ArtifactProcessingJob, seeded.id)
    assert job is not None and job.status == "ready" and job.attempts == 1
    assert job.failure_code == "processor-unavailable"


@pytest.mark.anyio
async def test_lost_heartbeat_cancels_publication_and_waits_for_processor_cleanup(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    seeded = await _seed_job(seeded_database, actor_id=alice.id, now=datetime.now(UTC))
    processor_stopped = asyncio.Event()
    replacement_token = uuid4()

    async def processor(lease) -> None:
        async with AsyncSession(seeded_database) as session:
            async with session.begin():
                await session.execute(
                    update(ArtifactProcessingJob)
                    .where(ArtifactProcessingJob.id == lease.job_id)
                    .values(
                        lease_token=replacement_token,
                        lease_expires_at=datetime.now(UTC) + timedelta(seconds=60),
                    )
                )
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0)
            processor_stopped.set()

    await _run_worker_loop(
        _sessions(worker_engine),
        once=True,
        processor=processor,
        lease_seconds=0.1,
        heartbeat_seconds=0.01,
        poll_seconds=0,
    )

    async with AsyncSession(seeded_database) as session:
        job = await session.get(ArtifactProcessingJob, seeded.id)
    assert processor_stopped.is_set()
    assert job is not None and job.status == "leased"
    assert job.lease_token == replacement_token
    assert job.failure_code is None


@pytest.mark.anyio
async def test_stop_request_prevents_another_claim_after_processor_settles(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    now = datetime.now(UTC)
    first = await _seed_job(seeded_database, actor_id=alice.id, now=now)
    second = await _seed_job(seeded_database, actor_id=alice.id, now=now)
    stop = asyncio.Event()

    async def processor(_lease) -> None:
        stop.set()
        await asyncio.sleep(0)

    await _run_worker_loop(
        _sessions(worker_engine),
        once=False,
        processor=processor,
        stop_event=stop,
        lease_seconds=60,
        heartbeat_seconds=20,
        poll_seconds=0,
    )

    async with AsyncSession(seeded_database) as session:
        statuses = dict(
            (
                await session.execute(
                    select(ArtifactProcessingJob.id, ArtifactProcessingJob.status).where(
                        ArtifactProcessingJob.id.in_((first.id, second.id))
                    )
                )
            ).all()
        )
    assert sorted(statuses.values()) == ["ready", "succeeded"]
