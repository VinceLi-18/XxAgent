from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.artifact import ArtifactProcessingJob, ArtifactVersion

MAX_ATTEMPTS = 5
_INITIAL_RETRY_SECONDS = 5


@dataclass(frozen=True)
class ArtifactJobLease:
    """A worker's time-limited authority to process one artifact version."""

    job_id: UUID
    version_id: UUID
    lease_token: UUID
    attempt: int


async def claim_due_job(
    session: AsyncSession,
    *,
    now: datetime,
    lease_seconds: int,
) -> ArtifactJobLease | None:
    """Lock and claim one due or expired artifact job in the caller's transaction."""

    while True:
        job = await session.scalar(
            select(ArtifactProcessingJob)
            .where(
                or_(
                    and_(
                        ArtifactProcessingJob.status == "ready",
                        ArtifactProcessingJob.next_attempt_at <= now,
                    ),
                    and_(
                        ArtifactProcessingJob.status == "leased",
                        ArtifactProcessingJob.lease_expires_at <= now,
                    ),
                )
            )
            .order_by(ArtifactProcessingJob.next_attempt_at, ArtifactProcessingJob.id)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if job is None:
            return None
        if job.attempts < MAX_ATTEMPTS:
            break

        await session.execute(
            update(ArtifactProcessingJob)
            .where(ArtifactProcessingJob.id == job.id)
            .values(
                status="dead",
                lease_token=None,
                lease_expires_at=None,
                failure_code="lease-expired",
                updated_at=now,
            )
        )
        await session.execute(
            update(ArtifactVersion)
            .where(
                ArtifactVersion.id == job.version_id,
                ArtifactVersion.scan_status == "scanning",
            )
            .values(scan_status="failed")
        )

    lease_token = uuid4()
    lease_expires_at = now + timedelta(seconds=lease_seconds)
    attempts = job.attempts + 1
    await session.execute(
        update(ArtifactProcessingJob)
        .where(ArtifactProcessingJob.id == job.id)
        .values(
            status="leased",
            attempts=attempts,
            lease_token=lease_token,
            lease_expires_at=lease_expires_at,
            failure_code=None,
            updated_at=now,
        )
    )
    await session.execute(
        update(ArtifactVersion)
        .where(
            ArtifactVersion.id == job.version_id,
            ArtifactVersion.scan_status == "pending",
        )
        .values(scan_status="scanning")
    )
    return ArtifactJobLease(
        job_id=job.id,
        version_id=job.version_id,
        lease_token=lease_token,
        attempt=attempts,
    )


def _owned_live_lease(lease: ArtifactJobLease, *, now: datetime):
    return (
        ArtifactProcessingJob.id == lease.job_id,
        ArtifactProcessingJob.version_id == lease.version_id,
        ArtifactProcessingJob.status == "leased",
        ArtifactProcessingJob.lease_token == lease.lease_token,
        ArtifactProcessingJob.lease_expires_at > now,
    )


async def heartbeat_job(
    session: AsyncSession,
    lease: ArtifactJobLease,
    *,
    now: datetime,
    lease_seconds: int,
) -> bool:
    """Extend a live lease when this worker still owns it."""

    result = await session.execute(
        update(ArtifactProcessingJob)
        .where(*_owned_live_lease(lease, now=now))
        .values(
            lease_expires_at=now + timedelta(seconds=lease_seconds),
            updated_at=now,
        )
    )
    return result.rowcount == 1


async def retry_job(
    session: AsyncSession,
    lease: ArtifactJobLease,
    *,
    now: datetime,
    failure_code: str,
) -> bool:
    """Release a failed attempt for bounded retry or close its version permanently."""

    terminal = lease.attempt >= MAX_ATTEMPTS
    values = {
        "status": "dead" if terminal else "ready",
        "next_attempt_at": (
            now
            if terminal
            else now
            + timedelta(
                seconds=_INITIAL_RETRY_SECONDS * 2 ** (lease.attempt - 1)
            )
        ),
        "lease_token": None,
        "lease_expires_at": None,
        "failure_code": failure_code,
        "updated_at": now,
    }
    result = await session.execute(
        update(ArtifactProcessingJob)
        .where(*_owned_live_lease(lease, now=now))
        .values(**values)
    )
    if result.rowcount != 1:
        return False
    if terminal:
        await session.execute(
            update(ArtifactVersion)
            .where(
                ArtifactVersion.id == lease.version_id,
                ArtifactVersion.scan_status == "scanning",
            )
            .values(scan_status="failed")
        )
    return True


async def finish_job(
    session: AsyncSession,
    lease: ArtifactJobLease,
    *,
    now: datetime,
) -> bool:
    """Close a job only while this worker still owns its live lease."""

    result = await session.execute(
        update(ArtifactProcessingJob)
        .where(*_owned_live_lease(lease, now=now))
        .values(
            status="succeeded",
            lease_token=None,
            lease_expires_at=None,
            failure_code=None,
            updated_at=now,
        )
    )
    return result.rowcount == 1


async def fail_job(
    session: AsyncSession,
    lease: ArtifactJobLease,
    *,
    now: datetime,
    failure_code: str,
) -> bool:
    """Close an unrecoverable inspection failure while the lease is live."""

    result = await session.execute(
        update(ArtifactProcessingJob)
        .where(*_owned_live_lease(lease, now=now))
        .values(
            status="dead",
            lease_token=None,
            lease_expires_at=None,
            failure_code=failure_code,
            updated_at=now,
        )
    )
    if result.rowcount != 1:
        return False
    version = await session.execute(
        update(ArtifactVersion)
        .where(
            ArtifactVersion.id == lease.version_id,
            ArtifactVersion.scan_status == "scanning",
        )
        .values(scan_status="failed")
    )
    if version.rowcount != 1:
        raise RuntimeError("leased artifact version cannot enter failed state")
    return True


async def quarantine_job(
    session: AsyncSession,
    lease: ArtifactJobLease,
    *,
    now: datetime,
    actual_size: int,
    sha256: str,
    content_type: str,
) -> bool:
    """Atomically quarantine an infected version and close its live job."""

    result = await session.execute(
        update(ArtifactProcessingJob)
        .where(*_owned_live_lease(lease, now=now))
        .values(
            status="succeeded",
            lease_token=None,
            lease_expires_at=None,
            failure_code=None,
            updated_at=now,
        )
    )
    if result.rowcount != 1:
        return False
    version = await session.execute(
        update(ArtifactVersion)
        .where(
            ArtifactVersion.id == lease.version_id,
            ArtifactVersion.scan_status == "scanning",
        )
        .values(
            scan_status="quarantined",
            actual_size=actual_size,
            sha256=sha256,
            detected_content_type=content_type,
        )
    )
    if version.rowcount != 1:
        raise RuntimeError("leased artifact version cannot enter quarantine")
    return True


async def publish_clean_job(
    session: AsyncSession,
    lease: ArtifactJobLease,
    *,
    now: datetime,
    object_key: str,
    actual_size: int,
    sha256: str,
    content_type: str,
) -> bool:
    """Atomically publish clean metadata and close the live job."""

    result = await session.execute(
        update(ArtifactProcessingJob)
        .where(*_owned_live_lease(lease, now=now))
        .values(
            status="succeeded",
            lease_token=None,
            lease_expires_at=None,
            failure_code=None,
            updated_at=now,
        )
    )
    if result.rowcount != 1:
        return False
    version = await session.execute(
        update(ArtifactVersion)
        .where(
            ArtifactVersion.id == lease.version_id,
            ArtifactVersion.scan_status == "scanning",
        )
        .values(
            scan_status="clean",
            object_key=object_key,
            actual_size=actual_size,
            sha256=sha256,
            detected_content_type=content_type,
        )
    )
    if version.rowcount != 1:
        raise RuntimeError("leased artifact version cannot enter clean state")
    return True
