"""Durable leases for one immutable artifact text-index generation."""

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.artifact import ArtifactVersion
from app.models.retrieval import ArtifactIndexJob, ArtifactTextIndex
from app.retrieval.chunking import (
    CHUNK_OVERLAP_TOKENS,
    MAX_CHUNK_BYTES,
    MAX_CHUNK_TOKENS,
    MAX_PAYLOAD_BYTES,
    SUPPORTED_CONTENT_TYPES,
)
from app.retrieval.embedding_client import EMBEDDING_DIMENSION, MODEL_ID, MODEL_REVISION
from app.services.audit import write_audit_event

MAX_INDEX_ATTEMPTS = 5
_INITIAL_RETRY_SECONDS = 5
PARSER_REVISION = "xagent-text-v1"
_CONFIGURATION = {
    "chunk_bytes": MAX_CHUNK_BYTES,
    "chunk_overlap_tokens": CHUNK_OVERLAP_TOKENS,
    "chunk_tokens": MAX_CHUNK_TOKENS,
    "embedding_dimension": EMBEDDING_DIMENSION,
    "embedding_model": MODEL_ID,
    "embedding_revision": MODEL_REVISION,
    "parser_revision": PARSER_REVISION,
}
CONFIGURATION_FINGERPRINT = hashlib.sha256(
    json.dumps(_CONFIGURATION, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()


@dataclass(frozen=True)
class ArtifactIndexLease:
    """A worker's time-limited authority over one index generation."""

    job_id: UUID
    version_id: UUID
    generation_id: UUID
    lease_token: UUID
    attempt: int


def is_indexable(content_type: str | None, actual_size: int | None) -> bool:
    """Return whether clean metadata is eligible for the Phase 4A text index."""

    if content_type is None or actual_size is None or actual_size > MAX_PAYLOAD_BYTES:
        return False
    normalized = content_type.split(";", 1)[0].strip().lower()
    return normalized in SUPPORTED_CONTENT_TYPES


async def _audit_index_transition(
    session: AsyncSession,
    lease: ArtifactIndexLease,
    action: str,
    result: str,
) -> None:
    identity = (
        await session.execute(
            select(
                ArtifactVersion.uploaded_by_id,
                ArtifactTextIndex.artifact_id,
                ArtifactTextIndex.generation,
            )
            .join(ArtifactTextIndex, ArtifactTextIndex.version_id == ArtifactVersion.id)
            .where(
                ArtifactVersion.id == lease.version_id,
                ArtifactTextIndex.id == lease.generation_id,
            )
        )
    ).one_or_none()
    if identity is None:
        raise RuntimeError("artifact index identity is required for index audit")
    actor_id, artifact_id, index_generation = identity
    await write_audit_event(
        session,
        actor_id,
        action,
        "artifact_version",
        lease.version_id,
        lease.job_id,
        result,
        executor_kind="artifact_worker",
        artifact_id=artifact_id,
        version_id=lease.version_id,
        index_id=lease.generation_id,
        index_generation=index_generation,
    )


async def enqueue_index_job(
    session: AsyncSession,
    version: ArtifactVersion,
    *,
    now: datetime,
) -> UUID | None:
    """Create one building generation and job for an eligible clean Version.

    @param session Worker transaction that publishes the Version as clean.
    @param version Clean immutable Version metadata.
    @param now Durable job eligibility time.
    @returns The existing or newly allocated Index ID, or `None` when unsupported.
    """

    if version.scan_status != "clean" or not is_indexable(
        version.detected_content_type, version.actual_size
    ):
        return None
    existing = await session.scalar(
        select(ArtifactTextIndex.id)
        .join(ArtifactIndexJob, ArtifactIndexJob.index_id == ArtifactTextIndex.id)
        .where(
            ArtifactTextIndex.version_id == version.id,
            ArtifactTextIndex.configuration_fingerprint == CONFIGURATION_FINGERPRINT,
        )
        .limit(1)
    )
    if existing is not None:
        return existing

    # Different clean Versions of one Artifact can finish scanning concurrently.
    # This transaction-scoped lock serializes their monotonic generation allocation.
    await session.execute(
        text(
            "SELECT pg_advisory_xact_lock("
            "hashtextextended(CAST(:artifact_id AS text), 0))"
        ),
        {"artifact_id": str(version.artifact_id)},
    )
    existing = await session.scalar(
        select(ArtifactTextIndex.id)
        .join(ArtifactIndexJob, ArtifactIndexJob.index_id == ArtifactTextIndex.id)
        .where(
            ArtifactTextIndex.version_id == version.id,
            ArtifactTextIndex.configuration_fingerprint == CONFIGURATION_FINGERPRINT,
        )
        .limit(1)
    )
    if existing is not None:
        return existing
    generation = await session.scalar(
        select(func.coalesce(func.max(ArtifactTextIndex.generation), 0) + 1).where(
            ArtifactTextIndex.artifact_id == version.artifact_id
        )
    )
    index_id = uuid4()
    index = ArtifactTextIndex(
        id=index_id,
        artifact_id=version.artifact_id,
        version_id=version.id,
        generation=generation,
        content_sha256=version.sha256,
        parser_revision=PARSER_REVISION,
        embedding_model=MODEL_ID,
        embedding_revision=MODEL_REVISION,
        vector_dimensions=EMBEDDING_DIMENSION,
        configuration_fingerprint=CONFIGURATION_FINGERPRINT,
        status="building",
    )
    session.add(index)
    await session.flush()
    job_id = uuid4()
    session.add(
        ArtifactIndexJob(
            id=job_id,
            index_id=index_id,
            status="ready",
            attempts=0,
            next_attempt_at=now,
        )
    )
    await session.flush()
    await _audit_index_transition(
        session,
        ArtifactIndexLease(job_id, version.id, index_id, uuid4(), 0),
        "artifact.index.created",
        "created",
    )
    return index_id


def _owned_live_index_lease(lease: ArtifactIndexLease, *, now: datetime):
    return (
        ArtifactIndexJob.id == lease.job_id,
        ArtifactIndexJob.index_id == lease.generation_id,
        ArtifactIndexJob.status == "leased",
        ArtifactIndexJob.lease_token == lease.lease_token,
        ArtifactIndexJob.lease_expires_at > now,
    )


async def claim_due_index_job(
    session: AsyncSession,
    *,
    now: datetime,
    lease_seconds: float,
) -> ArtifactIndexLease | None:
    """Claim one due generation with `SKIP LOCKED`, reclaiming expired leases."""

    while True:
        row = (
            await session.execute(
                select(
                    ArtifactIndexJob.id,
                    ArtifactIndexJob.index_id,
                    ArtifactIndexJob.attempts,
                    ArtifactTextIndex.version_id,
                )
                .join(ArtifactTextIndex, ArtifactTextIndex.id == ArtifactIndexJob.index_id)
                .where(
                    ArtifactTextIndex.status == "building",
                    or_(
                        and_(
                            ArtifactIndexJob.status == "ready",
                            ArtifactIndexJob.next_attempt_at <= now,
                        ),
                        and_(
                            ArtifactIndexJob.status == "leased",
                            ArtifactIndexJob.lease_expires_at <= now,
                        ),
                    ),
                )
                .order_by(ArtifactIndexJob.next_attempt_at, ArtifactIndexJob.id)
                .with_for_update(skip_locked=True, of=ArtifactIndexJob)
                .limit(1)
            )
        ).one_or_none()
        if row is None:
            return None
        job_id, index_id, prior_attempts, version_id = row
        if prior_attempts < MAX_INDEX_ATTEMPTS:
            break
        await session.execute(
            update(ArtifactIndexJob)
            .where(ArtifactIndexJob.id == job_id)
            .values(
                status="dead",
                lease_token=None,
                lease_expires_at=None,
                failure_code="indexing-failed",
                updated_at=now,
            )
        )
        await session.execute(
            update(ArtifactTextIndex)
            .where(
                ArtifactTextIndex.id == index_id,
                ArtifactTextIndex.status == "building",
            )
            .values(status="failed", failure_code="indexing-failed", updated_at=now)
        )
        await _audit_index_transition(
            session,
            ArtifactIndexLease(job_id, version_id, index_id, uuid4(), prior_attempts),
            "artifact.index.failed",
            "dead",
        )

    lease_token = uuid4()
    attempt = prior_attempts + 1
    await session.execute(
        update(ArtifactIndexJob)
        .where(ArtifactIndexJob.id == job_id)
        .values(
            status="leased",
            attempts=attempt,
            lease_token=lease_token,
            lease_expires_at=now + timedelta(seconds=lease_seconds),
            failure_code=None,
            updated_at=now,
        )
    )
    lease = ArtifactIndexLease(job_id, version_id, index_id, lease_token, attempt)
    if attempt == 1:
        await _audit_index_transition(
            session, lease, "artifact.index.start", "started"
        )
    return lease


async def heartbeat_index_job(
    session: AsyncSession,
    lease: ArtifactIndexLease,
    *,
    now: datetime,
    lease_seconds: float,
) -> bool:
    """Extend only the exact live index lease token."""

    result = await session.execute(
        update(ArtifactIndexJob)
        .where(*_owned_live_index_lease(lease, now=now))
        .values(
            lease_expires_at=now + timedelta(seconds=lease_seconds),
            updated_at=now,
        )
    )
    return result.rowcount == 1


async def retry_index_job(
    session: AsyncSession,
    lease: ArtifactIndexLease,
    *,
    now: datetime,
    failure_code: str,
) -> bool:
    """Release a live lease for bounded retry or fail its generation permanently."""

    terminal = lease.attempt >= MAX_INDEX_ATTEMPTS
    result = await session.execute(
        update(ArtifactIndexJob)
        .where(*_owned_live_index_lease(lease, now=now))
        .values(
            status="dead" if terminal else "ready",
            next_attempt_at=(
                now
                if terminal
                else now + timedelta(seconds=_INITIAL_RETRY_SECONDS * 2 ** (lease.attempt - 1))
            ),
            lease_token=None,
            lease_expires_at=None,
            failure_code=failure_code,
            updated_at=now,
        )
    )
    if result.rowcount != 1:
        return False
    if terminal:
        changed = await session.execute(
            update(ArtifactTextIndex)
            .where(
                ArtifactTextIndex.id == lease.generation_id,
                ArtifactTextIndex.status == "building",
            )
            .values(status="failed", failure_code=failure_code, updated_at=now)
        )
        if changed.rowcount != 1:
            raise RuntimeError("terminal index job must own a building generation")
        await _audit_index_transition(
            session, lease, "artifact.index.failed", "dead"
        )
    else:
        await _audit_index_transition(
            session, lease, "artifact.index.retry", "retry"
        )
    return True


async def fail_index_job(
    session: AsyncSession,
    lease: ArtifactIndexLease,
    *,
    now: datetime,
    failure_code: str,
) -> bool:
    """Fail an unrecoverable input while the exact lease remains live."""

    result = await session.execute(
        update(ArtifactIndexJob)
        .where(*_owned_live_index_lease(lease, now=now))
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
    changed = await session.execute(
        update(ArtifactTextIndex)
        .where(
            ArtifactTextIndex.id == lease.generation_id,
            ArtifactTextIndex.status == "building",
        )
        .values(status="failed", failure_code=failure_code, updated_at=now)
    )
    if changed.rowcount != 1:
        raise RuntimeError("failed index job must own a building generation")
    await _audit_index_transition(session, lease, "artifact.index.failed", "dead")
    return True
