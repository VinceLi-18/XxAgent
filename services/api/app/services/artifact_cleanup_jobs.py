from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import and_, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.artifact import ArtifactObjectCleanupJob

MAX_CLEANUP_ATTEMPTS = 5
_INITIAL_RETRY_SECONDS = 5


@dataclass(frozen=True)
class ArtifactCleanupLease:
    """Time-limited authority to remove one exact object version."""

    job_id: UUID
    object_key: str
    version_id: str
    lease_token: UUID
    attempt: int


async def enqueue_cleanup(
    session: AsyncSession,
    *,
    object_key: str,
    version_id: str,
    now: datetime,
) -> None:
    """Persist exact object-version ownership idempotently."""

    await session.execute(
        insert(ArtifactObjectCleanupJob)
        .values(
            id=uuid4(),
            object_key=object_key,
            version_id=version_id,
            status="ready",
            attempts=0,
            next_attempt_at=now,
            updated_at=now,
        )
        .on_conflict_do_nothing(index_elements=["object_key", "version_id"])
    )


def _owned_live_cleanup(lease: ArtifactCleanupLease, *, now: datetime):
    return (
        ArtifactObjectCleanupJob.id == lease.job_id,
        ArtifactObjectCleanupJob.status == "leased",
        ArtifactObjectCleanupJob.lease_token == lease.lease_token,
        ArtifactObjectCleanupJob.lease_expires_at > now,
    )


async def claim_due_cleanup(
    session: AsyncSession,
    *,
    now: datetime,
    lease_seconds: float,
) -> ArtifactCleanupLease | None:
    """Claim one due cleanup row without blocking another worker."""

    while True:
        row = (
            await session.execute(
                select(
                    ArtifactObjectCleanupJob.id,
                    ArtifactObjectCleanupJob.object_key,
                    ArtifactObjectCleanupJob.version_id,
                    ArtifactObjectCleanupJob.attempts,
                )
                .where(
                    or_(
                        and_(
                            ArtifactObjectCleanupJob.status == "ready",
                            ArtifactObjectCleanupJob.next_attempt_at <= now,
                        ),
                        and_(
                            ArtifactObjectCleanupJob.status == "leased",
                            ArtifactObjectCleanupJob.lease_expires_at <= now,
                        ),
                    )
                )
                .order_by(
                    ArtifactObjectCleanupJob.next_attempt_at,
                    ArtifactObjectCleanupJob.id,
                )
                .with_for_update(skip_locked=True)
                .limit(1)
            )
        ).one_or_none()
        if row is None:
            return None
        job_id, object_key, version_id, prior_attempts = row
        if prior_attempts < MAX_CLEANUP_ATTEMPTS:
            break
        await session.execute(
            update(ArtifactObjectCleanupJob)
            .where(ArtifactObjectCleanupJob.id == job_id)
            .values(
                status="dead",
                lease_token=None,
                lease_expires_at=None,
                failure_code="lease-expired",
                updated_at=now,
            )
        )

    token = uuid4()
    attempt = prior_attempts + 1
    await session.execute(
        update(ArtifactObjectCleanupJob)
        .where(ArtifactObjectCleanupJob.id == job_id)
        .values(
            status="leased",
            attempts=attempt,
            lease_token=token,
            lease_expires_at=now + timedelta(seconds=lease_seconds),
            failure_code=None,
            updated_at=now,
        )
    )
    return ArtifactCleanupLease(
        job_id=job_id,
        object_key=object_key,
        version_id=version_id,
        lease_token=token,
        attempt=attempt,
    )


async def heartbeat_cleanup(
    session: AsyncSession,
    lease: ArtifactCleanupLease,
    *,
    now: datetime,
    lease_seconds: float,
) -> bool:
    """Extend only this token's live cleanup lease."""

    result = await session.execute(
        update(ArtifactObjectCleanupJob)
        .where(*_owned_live_cleanup(lease, now=now))
        .values(
            lease_expires_at=now + timedelta(seconds=lease_seconds),
            updated_at=now,
        )
    )
    return result.rowcount == 1


async def finish_cleanup(
    session: AsyncSession,
    lease: ArtifactCleanupLease,
    *,
    now: datetime,
) -> bool:
    """Close only this token's live cleanup lease after exact deletion."""

    result = await session.execute(
        update(ArtifactObjectCleanupJob)
        .where(*_owned_live_cleanup(lease, now=now))
        .values(
            status="succeeded",
            lease_token=None,
            lease_expires_at=None,
            failure_code=None,
            updated_at=now,
        )
    )
    return result.rowcount == 1


async def retry_cleanup(
    session: AsyncSession,
    lease: ArtifactCleanupLease,
    *,
    now: datetime,
    failure_code: str,
) -> bool:
    """Release cleanup for bounded retry or retain its identity as dead."""

    terminal = lease.attempt >= MAX_CLEANUP_ATTEMPTS
    result = await session.execute(
        update(ArtifactObjectCleanupJob)
        .where(*_owned_live_cleanup(lease, now=now))
        .values(
            status="dead" if terminal else "ready",
            next_attempt_at=(
                now
                if terminal
                else now
                + timedelta(seconds=_INITIAL_RETRY_SECONDS * 2 ** (lease.attempt - 1))
            ),
            lease_token=None,
            lease_expires_at=None,
            failure_code=failure_code,
            updated_at=now,
        )
    )
    return result.rowcount == 1
