import asyncio
import os
import subprocess
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

import app.worker as artifact_worker
from app.core.config import ArtifactWorkerSettings, Settings
from app.models.artifact import (
    ArtifactObjectCleanupJob,
    ArtifactProcessingJob,
    ArtifactVersion,
)
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
                "uploaded_by_id, declared_size, actual_size, scan_status, staging_key, "
                "staging_etag, staging_expires_at, object_key, size, sha256) "
                "VALUES (:id, :artifact_id, :actor_id, 1, 'worker-loop.txt', :actor_id, "
                "4, 4, 'pending', :staging_key, 'worker-etag', :staging_expires_at, "
                "NULL, 4, :sha256)"
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


async def _seed_cleanup(engine: AsyncEngine, *, now: datetime) -> ArtifactObjectCleanupJob:
    cleanup = ArtifactObjectCleanupJob(
        id=uuid4(),
        object_key=f"artifacts/{uuid4()}/{uuid4()}",
        version_id=f"target-version-{uuid4()}",
        status="ready",
        attempts=0,
        next_attempt_at=now,
    )
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifact_object_cleanup_jobs "
                "(id, object_key, version_id, status, attempts, next_attempt_at) "
                "VALUES (:id, :key, :version_id, 'ready', 0, :now)"
            ),
            {
                "id": cleanup.id,
                "key": cleanup.object_key,
                "version_id": cleanup.version_id,
                "now": now,
            },
        )
    return cleanup


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


def _worker_only_environment(worker_role: str) -> dict[str, str]:
    return {
        "PATH": os.environ["PATH"],
        "DATABASE_WORKER_URL": _worker_url(os.environ["JX_TEST_DATABASE_URL"], worker_role),
        "MINIO_ENDPOINT": "127.0.0.1:1",
        "MINIO_ACCESS_KEY": "worker-access",
        "MINIO_SECRET_KEY": "worker-secret",
        "MINIO_SECURE": "false",
        "MINIO_BUCKET": "worker-private",
        "MINIO_TIMEOUT": "0.05",
        "CLAMAV_HOST": "127.0.0.1",
        "CLAMAV_PORT": "1",
        "CLAMAV_TIMEOUT": "0.05",
    }


def _run_shipping_worker_once(
    worker_role: str,
    *,
    configured: bool = False,
) -> subprocess.CompletedProcess[str]:
    env = {
        "PATH": os.environ["PATH"],
        "DATABASE_WORKER_URL": _worker_url(os.environ["JX_TEST_DATABASE_URL"], worker_role),
    }
    if configured:
        env = _worker_only_environment(worker_role)
    return subprocess.run(
        ["uv", "run", "--project", "services/api", "xagent-api", "worker", "--once"],
        cwd=Path(__file__).resolve().parents[3],
        env=env,
        text=True,
        capture_output=True,
        check=False,
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
    completed = _run_shipping_worker_once(worker_role)

    assert completed.returncode == 0
    assert completed.stdout == ""
    assert completed.stderr == ""


@pytest.mark.anyio
async def test_shipping_worker_once_enters_processor_with_only_worker_configuration(
    seeded_database: AsyncEngine,
    worker_role: str,
    alice,
) -> None:
    started_at = datetime.now(UTC)
    seeded = await _seed_job(seeded_database, actor_id=alice.id, now=started_at)

    completed = _run_shipping_worker_once(worker_role, configured=True)

    async with AsyncSession(seeded_database) as session:
        job = await session.get(ArtifactProcessingJob, seeded.id)
        version = await session.get(ArtifactVersion, seeded.version_id)
    assert completed.returncode == 0
    assert completed.stdout == ""
    assert completed.stderr == ""
    assert job is not None
    assert (job.status, job.attempts, job.failure_code) == (
        "ready",
        1,
        "inspection-unavailable",
    )
    assert job.lease_token is None and job.lease_expires_at is None
    assert job.next_attempt_at > started_at
    assert version is not None and version.scan_status == "scanning"


def test_processor_resolves_without_api_only_configuration(worker_role: str) -> None:
    completed = subprocess.run(
        [
            "uv",
            "run",
            "--project",
            "services/api",
            "python",
            "-c",
            "from app.worker import _resolve_processor; assert callable(_resolve_processor())",
        ],
        cwd=Path(__file__).resolve().parents[3],
        env=_worker_only_environment(worker_role),
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0
    assert completed.stdout == ""
    assert completed.stderr == ""


@pytest.mark.anyio
async def test_shipping_worker_once_retries_due_cleanup_with_only_worker_configuration(
    seeded_database: AsyncEngine,
    worker_role: str,
) -> None:
    started_at = datetime.now(UTC)
    seeded = await _seed_cleanup(seeded_database, now=started_at)

    completed = _run_shipping_worker_once(worker_role, configured=True)

    async with AsyncSession(seeded_database) as session:
        cleanup = await session.get(ArtifactObjectCleanupJob, seeded.id)
    assert completed.returncode == 0
    assert completed.stdout == "" and completed.stderr == ""
    assert cleanup is not None
    assert (cleanup.status, cleanup.attempts, cleanup.failure_code) == (
        "ready",
        1,
        "remove-failed",
    )
    assert cleanup.next_attempt_at > started_at


@pytest.mark.anyio
async def test_worker_once_processes_one_body_job_and_one_cleanup_without_starvation(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    now = datetime.now(UTC)
    body = await _seed_job(seeded_database, actor_id=alice.id, now=now)
    cleanup = await _seed_cleanup(seeded_database, now=now)
    handled: list[str] = []

    async def processor(lease) -> None:
        handled.append(f"body:{lease.job_id}")

    async def cleanup_processor(lease) -> None:
        handled.append(f"cleanup:{lease.job_id}")

    await _run_worker_loop(
        _sessions(worker_engine),
        once=True,
        processor=processor,
        cleanup_processor=cleanup_processor,
        lease_seconds=60,
        heartbeat_seconds=20,
        poll_seconds=0,
    )

    async with AsyncSession(seeded_database) as session:
        body_row = await session.get(ArtifactProcessingJob, body.id)
        cleanup_row = await session.get(ArtifactObjectCleanupJob, cleanup.id)
    assert handled == [f"body:{body.id}", f"cleanup:{cleanup.id}"]
    assert body_row is not None and body_row.status == "succeeded"
    assert cleanup_row is not None and cleanup_row.status == "succeeded"


@pytest.mark.anyio
async def test_cleanup_cancellation_waits_for_blocking_remove_to_stop(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
) -> None:
    seeded = await _seed_cleanup(seeded_database, now=datetime.now(UTC))
    started = threading.Event()
    release = threading.Event()
    stopped = threading.Event()

    def blocking_remove() -> None:
        started.set()
        try:
            assert release.wait(timeout=2)
        finally:
            stopped.set()

    async def cleanup_processor(_lease) -> None:
        await asyncio.to_thread(blocking_remove)

    worker_task = asyncio.create_task(
        _run_worker_loop(
            _sessions(worker_engine),
            once=True,
            cleanup_processor=cleanup_processor,
            lease_seconds=60,
            heartbeat_seconds=20,
            poll_seconds=0,
        )
    )
    assert await asyncio.to_thread(started.wait, 1)
    worker_task.cancel()
    try:
        await asyncio.sleep(0.05)
        assert not worker_task.done()
    finally:
        release.set()
        result = await asyncio.gather(worker_task, return_exceptions=True)

    async with AsyncSession(seeded_database) as session:
        cleanup = await session.get(ArtifactObjectCleanupJob, seeded.id)
    assert isinstance(result[0], asyncio.CancelledError)
    assert stopped.is_set()
    assert cleanup is not None and cleanup.status == "leased"


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
    thread_started = threading.Event()
    release_thread = threading.Event()
    thread_stopped = threading.Event()
    replacement_token = uuid4()

    def blocking_processor() -> None:
        thread_started.set()
        try:
            assert release_thread.wait(timeout=2)
        finally:
            thread_stopped.set()

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
        await asyncio.to_thread(blocking_processor)

    worker_task = asyncio.create_task(
        _run_worker_loop(
            _sessions(worker_engine),
            once=True,
            processor=processor,
            lease_seconds=0.1,
            heartbeat_seconds=0.01,
            poll_seconds=0,
        )
    )
    assert await asyncio.to_thread(thread_started.wait, 1)
    try:
        await asyncio.sleep(0.05)
        assert not worker_task.done()
    finally:
        release_thread.set()
        await asyncio.gather(worker_task, return_exceptions=True)

    async with AsyncSession(seeded_database) as session:
        job = await session.get(ArtifactProcessingJob, seeded.id)
    assert thread_stopped.is_set()
    assert job is not None and job.status == "leased"
    assert job.lease_token == replacement_token
    assert job.failure_code is None


@pytest.mark.anyio
async def test_cancel_during_lost_lease_cleanup_propagates_after_processor_stops(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(UTC)
    lost_job = await _seed_job(
        seeded_database,
        actor_id=alice.id,
        now=now - timedelta(seconds=1),
    )
    untouched_job = await _seed_job(seeded_database, actor_id=alice.id, now=now)
    thread_started = threading.Event()
    release_thread = threading.Event()
    thread_stopped = threading.Event()
    entered_quiescence = asyncio.Event()
    replacement_token = uuid4()
    original_await_task_quiescence = artifact_worker._await_task_quiescence

    async def observed_await_task_quiescence(task):
        entered_quiescence.set()
        return await original_await_task_quiescence(task)

    monkeypatch.setattr(
        artifact_worker,
        "_await_task_quiescence",
        observed_await_task_quiescence,
    )

    def blocking_processor() -> None:
        thread_started.set()
        try:
            assert release_thread.wait(timeout=2)
        finally:
            thread_stopped.set()

    async def processor(lease) -> None:
        if lease.job_id != lost_job.id:
            raise AssertionError("worker claimed another job after cancellation")
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
        await asyncio.to_thread(blocking_processor)

    worker_task = asyncio.create_task(
        _run_worker_loop(
            _sessions(worker_engine),
            once=True,
            processor=processor,
            lease_seconds=0.1,
            heartbeat_seconds=0.01,
            poll_seconds=0,
        )
    )
    assert await asyncio.to_thread(thread_started.wait, 1)
    await asyncio.wait_for(entered_quiescence.wait(), timeout=1)
    worker_task.cancel()
    try:
        await asyncio.sleep(0.05)
        assert not worker_task.done()
    finally:
        release_thread.set()
        result = await asyncio.gather(worker_task, return_exceptions=True)

    async with AsyncSession(seeded_database) as session:
        lost = await session.get(ArtifactProcessingJob, lost_job.id)
        untouched = await session.get(ArtifactProcessingJob, untouched_job.id)
    assert isinstance(result[0], asyncio.CancelledError)
    assert thread_stopped.is_set()
    assert lost is not None and lost.status == "leased"
    assert lost.lease_token == replacement_token
    assert lost.failure_code is None
    assert untouched is not None and untouched.status == "ready"
    assert untouched.attempts == 0


@pytest.mark.anyio
async def test_outer_worker_cancellation_waits_for_blocking_processor(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    seeded = await _seed_job(seeded_database, actor_id=alice.id, now=datetime.now(UTC))
    thread_started = threading.Event()
    release_thread = threading.Event()
    thread_stopped = threading.Event()

    def blocking_processor() -> None:
        thread_started.set()
        try:
            assert release_thread.wait(timeout=2)
        finally:
            thread_stopped.set()

    async def processor(_lease) -> None:
        await asyncio.to_thread(blocking_processor)

    worker_task = asyncio.create_task(
        _run_worker_loop(
            _sessions(worker_engine),
            once=True,
            processor=processor,
            lease_seconds=60,
            heartbeat_seconds=20,
            poll_seconds=0,
        )
    )
    assert await asyncio.to_thread(thread_started.wait, 1)
    worker_task.cancel()
    try:
        await asyncio.sleep(0.05)
        assert not worker_task.done()
    finally:
        release_thread.set()
        result = await asyncio.gather(worker_task, return_exceptions=True)

    async with AsyncSession(seeded_database) as session:
        job = await session.get(ArtifactProcessingJob, seeded.id)
    assert isinstance(result[0], asyncio.CancelledError)
    assert thread_stopped.is_set()
    assert job is not None and job.status == "leased"
    assert job.failure_code is None


@pytest.mark.anyio
async def test_repeated_cancellation_waits_for_all_worker_tasks(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seeded = await _seed_job(seeded_database, actor_id=alice.id, now=datetime.now(UTC))
    thread_started = threading.Event()
    release_thread = threading.Event()
    thread_stopped = threading.Event()
    heartbeat_started = asyncio.Event()
    heartbeat_cleanup_started = asyncio.Event()
    release_heartbeat = asyncio.Event()
    heartbeat_stopped = asyncio.Event()

    def blocking_processor() -> None:
        thread_started.set()
        try:
            assert release_thread.wait(timeout=2)
        finally:
            thread_stopped.set()

    async def processor(_lease) -> None:
        await asyncio.to_thread(blocking_processor)

    async def controlled_heartbeat(
        _sessions,
        _lease,
        *,
        stop_event: asyncio.Event,
        heartbeat_seconds: float,
        lease_seconds: float,
    ) -> bool:
        del heartbeat_seconds, lease_seconds
        heartbeat_started.set()
        await stop_event.wait()
        heartbeat_cleanup_started.set()
        await release_heartbeat.wait()
        heartbeat_stopped.set()
        return True

    monkeypatch.setattr(artifact_worker, "_heartbeat_lease", controlled_heartbeat)
    worker_task = asyncio.create_task(
        _run_worker_loop(
            _sessions(worker_engine),
            once=True,
            processor=processor,
            lease_seconds=60,
            heartbeat_seconds=20,
            poll_seconds=0,
        )
    )
    assert await asyncio.to_thread(thread_started.wait, 1)
    await asyncio.wait_for(heartbeat_started.wait(), timeout=1)
    worker_task.cancel()
    await asyncio.wait_for(heartbeat_cleanup_started.wait(), timeout=1)
    worker_task.cancel()
    try:
        release_heartbeat.set()
        await asyncio.wait_for(heartbeat_stopped.wait(), timeout=1)
        await asyncio.sleep(0.05)
        assert not worker_task.done()
        assert not thread_stopped.is_set()
    finally:
        release_thread.set()
        assert await asyncio.to_thread(thread_stopped.wait, 1)
        result = await asyncio.gather(worker_task, return_exceptions=True)

    async with AsyncSession(seeded_database) as session:
        job = await session.get(ArtifactProcessingJob, seeded.id)
    assert isinstance(result[0], asyncio.CancelledError)
    assert job is not None and job.status == "leased"
    assert job.failure_code is None


@pytest.mark.anyio
async def test_cancel_while_harvesting_done_heartbeat_waits_for_processor(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime.now(UTC)
    active_job = await _seed_job(
        seeded_database,
        actor_id=alice.id,
        now=now - timedelta(seconds=1),
    )
    untouched_job = await _seed_job(seeded_database, actor_id=alice.id, now=now)
    release_thread = threading.Event()
    thread_stopped = threading.Event()
    processor_thread_started = asyncio.Event()
    cancellation_dispatched = asyncio.Event()
    loop = asyncio.get_running_loop()
    original_await_task_quiescence = artifact_worker._await_task_quiescence
    worker_task: asyncio.Task[None] | None = None
    cancellation_scheduled = False

    def cancel_worker() -> None:
        assert worker_task is not None
        worker_task.cancel()
        loop.call_soon(cancellation_dispatched.set)

    async def observed_await_task_quiescence(task):
        nonlocal cancellation_scheduled
        if task.done() and not cancellation_scheduled:
            cancellation_scheduled = True
            loop.call_soon(cancel_worker)
        return await original_await_task_quiescence(task)

    monkeypatch.setattr(
        artifact_worker,
        "_await_task_quiescence",
        observed_await_task_quiescence,
    )

    def blocking_processor() -> None:
        loop.call_soon_threadsafe(processor_thread_started.set)
        try:
            assert release_thread.wait(timeout=2)
        finally:
            thread_stopped.set()

    async def processor(lease) -> None:
        if lease.job_id != active_job.id:
            raise AssertionError("worker claimed another job during cleanup")
        await asyncio.to_thread(blocking_processor)

    async def failing_heartbeat(
        _sessions,
        _lease,
        *,
        stop_event: asyncio.Event,
        heartbeat_seconds: float,
        lease_seconds: float,
    ) -> bool:
        del stop_event, heartbeat_seconds, lease_seconds
        await processor_thread_started.wait()
        raise RuntimeError("heartbeat failed")

    monkeypatch.setattr(artifact_worker, "_heartbeat_lease", failing_heartbeat)
    worker_task = asyncio.create_task(
        _run_worker_loop(
            _sessions(worker_engine),
            once=True,
            processor=processor,
            lease_seconds=60,
            heartbeat_seconds=20,
            poll_seconds=0,
        )
    )
    await asyncio.wait_for(cancellation_dispatched.wait(), timeout=1)
    try:
        assert not worker_task.done()
        assert not thread_stopped.is_set()
    finally:
        release_thread.set()
        assert await asyncio.to_thread(thread_stopped.wait, 1)
        result = await asyncio.gather(worker_task, return_exceptions=True)

    async with AsyncSession(seeded_database) as session:
        active = await session.get(ArtifactProcessingJob, active_job.id)
        untouched = await session.get(ArtifactProcessingJob, untouched_job.id)
    assert isinstance(result[0], asyncio.CancelledError)
    assert active is not None and active.status == "leased"
    assert active.failure_code is None
    assert untouched is not None and untouched.status == "ready"
    assert untouched.attempts == 0


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
