import asyncio
import signal
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import TypeAlias, TypeVar

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.worker_config import ArtifactWorkerSettings
from app.services.artifact_jobs import (
    ArtifactJobLease,
    claim_due_job,
    finish_job,
    heartbeat_job,
    retry_job,
)

DEFAULT_LEASE_SECONDS = 60
DEFAULT_HEARTBEAT_SECONDS = 20
DEFAULT_POLL_SECONDS = 1

ArtifactProcessor: TypeAlias = Callable[[ArtifactJobLease], Awaitable[None]]
ArtifactProcessorResolver: TypeAlias = Callable[[], ArtifactProcessor]
_TaskResult = TypeVar("_TaskResult")


def _resolve_processor() -> ArtifactProcessor:
    from app.services.artifact_processing import process_artifact_job

    return process_artifact_job


async def _wait_for_stop(stop_event: asyncio.Event, timeout: float) -> bool:
    if stop_event.is_set():
        return True
    if timeout <= 0:
        await asyncio.sleep(0)
        return stop_event.is_set()
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=timeout)
    except TimeoutError:
        return False
    return True


async def _heartbeat_lease(
    sessions: async_sessionmaker[AsyncSession],
    lease: ArtifactJobLease,
    *,
    stop_event: asyncio.Event,
    heartbeat_seconds: float,
    lease_seconds: float,
) -> bool:
    while not await _wait_for_stop(stop_event, heartbeat_seconds):
        async with sessions() as session:
            async with session.begin():
                owned = await heartbeat_job(
                    session,
                    lease,
                    now=datetime.now(UTC),
                    lease_seconds=lease_seconds,
                )
        if not owned:
            return False
    return True


async def _retry_owned_lease(
    sessions: async_sessionmaker[AsyncSession],
    lease: ArtifactJobLease,
    failure_code: str,
) -> None:
    async with sessions() as session:
        async with session.begin():
            await retry_job(
                session,
                lease,
                now=datetime.now(UTC),
                failure_code=failure_code,
            )


async def _await_task_quiescence(task: asyncio.Task[_TaskResult]) -> None:
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            continue
        except Exception:
            break
    await asyncio.gather(task, return_exceptions=True)


async def _process_lease(
    sessions: async_sessionmaker[AsyncSession],
    lease: ArtifactJobLease,
    *,
    processor: ArtifactProcessor | None,
    processor_resolver: ArtifactProcessorResolver,
    heartbeat_seconds: float,
    lease_seconds: float,
) -> None:
    if processor is None:
        try:
            processor = processor_resolver()
        except ModuleNotFoundError:
            await _retry_owned_lease(sessions, lease, "processor-unavailable")
            return
        except Exception:
            await _retry_owned_lease(sessions, lease, "processor-error")
            return

    heartbeat_stop = asyncio.Event()
    processor_task = asyncio.create_task(processor(lease))
    heartbeat_task = asyncio.create_task(
        _heartbeat_lease(
            sessions,
            lease,
            stop_event=heartbeat_stop,
            heartbeat_seconds=heartbeat_seconds,
            lease_seconds=lease_seconds,
        )
    )
    try:
        completed, _pending = await asyncio.wait(
            (processor_task, heartbeat_task),
            return_when=asyncio.FIRST_COMPLETED,
        )
        if heartbeat_task in completed:
            still_owned = await heartbeat_task
            if not still_owned:
                await _await_task_quiescence(processor_task)
                return

        heartbeat_stop.set()
        still_owned = await heartbeat_task
        if not still_owned:
            await _await_task_quiescence(processor_task)
            return

        try:
            await processor_task
        except asyncio.CancelledError:
            raise
        except Exception:
            await _retry_owned_lease(sessions, lease, "processor-error")
            return

        async with sessions() as session:
            async with session.begin():
                await finish_job(session, lease, now=datetime.now(UTC))
    except BaseException:
        heartbeat_stop.set()
        await _await_task_quiescence(heartbeat_task)
        await _await_task_quiescence(processor_task)
        raise


async def _run_worker_loop(
    sessions: async_sessionmaker[AsyncSession],
    *,
    once: bool = False,
    processor: ArtifactProcessor | None = None,
    processor_resolver: ArtifactProcessorResolver | None = None,
    stop_event: asyncio.Event | None = None,
    lease_seconds: float = DEFAULT_LEASE_SECONDS,
    heartbeat_seconds: float = DEFAULT_HEARTBEAT_SECONDS,
    poll_seconds: float = DEFAULT_POLL_SECONDS,
) -> None:
    """Claim and process jobs without holding a transaction during processing."""

    if heartbeat_seconds <= 0 or heartbeat_seconds >= lease_seconds:
        raise ValueError("worker heartbeat must be positive and shorter than its lease")
    if poll_seconds < 0:
        raise ValueError("worker poll interval cannot be negative")
    if processor is not None and processor_resolver is not None:
        raise ValueError("provide either a processor or a processor resolver")

    resolved_stop_event = stop_event or asyncio.Event()
    resolved_processor = processor_resolver or _resolve_processor
    while not resolved_stop_event.is_set():
        async with sessions() as session:
            async with session.begin():
                lease = await claim_due_job(
                    session,
                    now=datetime.now(UTC),
                    lease_seconds=lease_seconds,
                )
        if lease is None:
            if once:
                return
            await _wait_for_stop(resolved_stop_event, poll_seconds)
            continue
        await _process_lease(
            sessions,
            lease,
            processor=processor,
            processor_resolver=resolved_processor,
            heartbeat_seconds=heartbeat_seconds,
            lease_seconds=lease_seconds,
        )


async def run_worker(*, once: bool = False) -> None:
    """Run the artifact worker with its isolated database engine until stopped."""

    settings = ArtifactWorkerSettings()
    engine = create_async_engine(settings.DATABASE_WORKER_URL, pool_pre_ping=True)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    installed_signals: list[signal.Signals] = []
    for shutdown_signal in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(shutdown_signal, stop_event.set)
        except (NotImplementedError, RuntimeError):
            continue
        installed_signals.append(shutdown_signal)
    try:
        await _run_worker_loop(sessions, once=once, stop_event=stop_event)
    finally:
        for shutdown_signal in installed_signals:
            loop.remove_signal_handler(shutdown_signal)
        await engine.dispose()
