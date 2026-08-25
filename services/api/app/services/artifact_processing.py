import asyncio
import hashlib
import logging
import unicodedata
from collections.abc import AsyncIterator, Callable, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Protocol
from uuid import UUID

from minio.error import S3Error
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from urllib3.exceptions import HTTPError

from app.models.artifact import ArtifactVersion
from app.services.artifact_cleanup_jobs import ArtifactCleanupLease, enqueue_cleanup
from app.services.artifact_jobs import (
    ArtifactJobLease,
    fail_job,
    publish_clean_job,
    quarantine_job,
    retry_job,
)
from app.services.malware import (
    ClamAvScanner,
    MalwareServiceUnavailable,
    MalwareVerdict,
)
from app.storage.minio_gateway import (
    MinioGateway,
    ObjectMetadata,
    ObjectVersioningUnavailable,
)

_MIME_SAMPLE_BYTES = 64 * 1024
_IDENTITY_FAILURE = "content-identity-mismatch"
_RETRYABLE_FAILURE = "inspection-unavailable"
_logger = logging.getLogger(__name__)


class _ArtifactProcessingSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file="../.env",
        env_ignore_empty=True,
        extra="ignore",
    )

    DATABASE_WORKER_URL: str
    MINIO_ENDPOINT: str
    MINIO_ACCESS_KEY: str
    MINIO_SECRET_KEY: str
    MINIO_SECURE: bool
    MINIO_BUCKET: str = "xagent-private"
    MINIO_TIMEOUT: float = Field(default=10, gt=0)
    CLAMAV_HOST: str = "clamav"
    CLAMAV_PORT: int = 3310
    CLAMAV_TIMEOUT: float = Field(default=10, gt=0)


@dataclass(frozen=True)
class ArtifactInspection:
    """Content facts derived from the single malware-scanned object stream."""

    size: int
    sha256: str
    content_type: str
    malware: Literal["clean", "infected"]


class _ArtifactGateway(Protocol):
    def require_versioning(self) -> None: ...

    def stat(self, key: str) -> ObjectMetadata: ...

    def stream(self, key: str) -> Iterable[bytes]: ...

    def copy(
        self,
        source: str,
        target: str,
        etag: str | None = None,
    ) -> str: ...

    def remove(self, key: str, version_id: str | None = None) -> None: ...


class _MalwareScanner(Protocol):
    def scan_stream(self, chunks: Iterable[bytes]) -> MalwareVerdict: ...


@dataclass(frozen=True)
class _ArtifactProcessingDependencies:
    sessions: async_sessionmaker[AsyncSession]
    gateway: _ArtifactGateway
    scanner: _MalwareScanner
    clock: Callable[[], datetime]


@dataclass(frozen=True)
class _ArtifactWork:
    artifact_id: UUID
    staging_key: str
    staging_etag: str
    recorded_size: int
    declared_sha256: str


class _ContentIdentityMismatch(Exception):
    pass


class ArtifactCleanupHandoffError(Exception):
    """Exact object-version ownership could not be persisted after removal failed."""

    def __init__(
        self,
        object_key: str,
        version_id: str,
        cleanup_error: BaseException,
        persistence_error: BaseException,
    ) -> None:
        super().__init__(f"cleanup ownership handoff failed for {object_key}@{version_id}")
        self.object_key = object_key
        self.version_id = version_id
        self.cleanup_error = cleanup_error
        self.persistence_error = persistence_error


class _InspectingChunks:
    def __init__(self, chunks: Iterable[bytes]) -> None:
        self._chunks = iter(chunks)
        self.size = 0
        self.digest = hashlib.sha256()
        self.sample = bytearray()
        self.exhausted = False

    def __iter__(self) -> "_InspectingChunks":
        return self

    def __next__(self) -> bytes:
        try:
            chunk = next(self._chunks)
        except StopIteration:
            self.exhausted = True
            raise
        self.size += len(chunk)
        self.digest.update(chunk)
        remaining = _MIME_SAMPLE_BYTES - len(self.sample)
        if remaining > 0:
            self.sample.extend(chunk[:remaining])
        return chunk


def _metadata_matches(work: _ArtifactWork, metadata: ObjectMetadata) -> bool:
    return metadata.size == work.recorded_size and metadata.etag == work.staging_etag


def _stat_exact(gateway: _ArtifactGateway, work: _ArtifactWork) -> ObjectMetadata:
    try:
        metadata = gateway.stat(work.staging_key)
    except KeyError as error:
        raise _ContentIdentityMismatch from error
    except S3Error as error:
        if error.code in {"NoSuchKey", "NoSuchObject"}:
            raise _ContentIdentityMismatch from error
        raise
    if not _metadata_matches(work, metadata):
        raise _ContentIdentityMismatch
    return metadata


def _detect_content_type(sample: bytes) -> str:
    normalized = sample.lstrip().lower()
    if normalized.startswith((b"<!doctype html", b"<html")):
        return "text/html"
    if normalized.startswith(b"<svg") or (
        normalized.startswith(b"<?xml") and b"<svg" in normalized
    ):
        return "image/svg+xml"
    if normalized.startswith((b"#!/bin/sh", b"#!/bin/bash", b"#!/usr/bin/env sh")):
        return "text/x-shellscript"
    try:
        decoded = sample.decode("utf-8")
    except UnicodeDecodeError:
        decoded = ""
    if decoded and all(
        character in "\t\n\r" or unicodedata.category(character)[0] != "C"
        for character in decoded
    ):
        return "text/plain"
    try:
        import magic

        detected = magic.from_buffer(sample, mime=True)
    except Exception:
        return "application/octet-stream"
    if not isinstance(detected, str) or not detected.strip():
        return "application/octet-stream"
    content_type = detected.split(";", 1)[0].strip().lower()
    if content_type in {"application/x-sh", "application/x-shellscript"}:
        return "text/x-shellscript"
    return content_type


def _inspect(
    gateway: _ArtifactGateway,
    scanner: _MalwareScanner,
    work: _ArtifactWork,
) -> ArtifactInspection:
    _stat_exact(gateway, work)
    chunks = _InspectingChunks(gateway.stream(work.staging_key))
    verdict = scanner.scan_stream(chunks)
    if not chunks.exhausted:
        raise MalwareServiceUnavailable("scanner returned before stream completion")
    _stat_exact(gateway, work)
    sha256 = chunks.digest.hexdigest()
    if chunks.size != work.recorded_size or sha256 != work.declared_sha256:
        raise _ContentIdentityMismatch
    return ArtifactInspection(
        size=chunks.size,
        sha256=sha256,
        content_type=_detect_content_type(bytes(chunks.sample)),
        malware=verdict.value,
    )


def _promote(
    gateway: _ArtifactGateway,
    work: _ArtifactWork,
    lease: ArtifactJobLease,
    final_key: str,
) -> str:
    _stat_exact(gateway, work)
    try:
        return gateway.copy(
            work.staging_key,
            final_key,
            etag=work.staging_etag,
        )
    except S3Error as error:
        if error.code in {"NoSuchKey", "NoSuchObject", "PreconditionFailed"}:
            raise _ContentIdentityMismatch from error
        raise


async def _load_work(
    dependencies: _ArtifactProcessingDependencies,
    lease: ArtifactJobLease,
) -> _ArtifactWork | None:
    async with dependencies.sessions() as session:
        async with session.begin():
            row = (
                await session.execute(
                    select(
                        ArtifactVersion.artifact_id,
                        ArtifactVersion.staging_key,
                        ArtifactVersion.staging_etag,
                        ArtifactVersion.actual_size,
                        ArtifactVersion.sha256,
                    ).where(
                        ArtifactVersion.id == lease.version_id,
                        ArtifactVersion.scan_status == "scanning",
                    )
                )
            ).one_or_none()
    if row is None:
        return None
    artifact_id, staging_key, staging_etag, actual_size, declared_sha256 = row
    if (
        not isinstance(staging_key, str)
        or not isinstance(staging_etag, str)
        or not staging_etag
        or not isinstance(actual_size, int)
    ):
        return None
    return _ArtifactWork(
        artifact_id=artifact_id,
        staging_key=staging_key,
        staging_etag=staging_etag,
        recorded_size=actual_size,
        declared_sha256=declared_sha256,
    )


async def _retry(
    dependencies: _ArtifactProcessingDependencies,
    lease: ArtifactJobLease,
) -> None:
    async with dependencies.sessions() as session:
        async with session.begin():
            await retry_job(
                session,
                lease,
                now=dependencies.clock(),
                failure_code=_RETRYABLE_FAILURE,
            )


async def _fail_identity(
    dependencies: _ArtifactProcessingDependencies,
    lease: ArtifactJobLease,
) -> None:
    async with dependencies.sessions() as session:
        async with session.begin():
            await fail_job(
                session,
                lease,
                now=dependencies.clock(),
                failure_code=_IDENTITY_FAILURE,
            )


async def _remove_or_enqueue_cleanup(
    dependencies: _ArtifactProcessingDependencies,
    *,
    object_key: str,
    version_id: str,
) -> BaseException | None:
    try:
        await asyncio.to_thread(
            dependencies.gateway.remove,
            object_key,
            version_id=version_id,
        )
    except BaseException as cleanup_error:
        try:
            async with dependencies.sessions() as session:
                async with session.begin():
                    await enqueue_cleanup(
                        session,
                        object_key=object_key,
                        version_id=version_id,
                        now=dependencies.clock(),
                    )
        except BaseException as persistence_error:
            raise ArtifactCleanupHandoffError(
                object_key,
                version_id,
                cleanup_error,
                persistence_error,
            ) from persistence_error
        return cleanup_error
    return None


async def _process_with_dependencies(
    lease: ArtifactJobLease,
    dependencies: _ArtifactProcessingDependencies,
) -> None:
    work = await _load_work(dependencies, lease)
    if work is None:
        await _fail_identity(dependencies, lease)
        return
    try:
        await asyncio.to_thread(dependencies.gateway.require_versioning)
    except (ObjectVersioningUnavailable, HTTPError, OSError, TimeoutError, S3Error):
        await _retry(dependencies, lease)
        return
    try:
        inspection = await asyncio.to_thread(
            _inspect,
            dependencies.gateway,
            dependencies.scanner,
            work,
        )
    except _ContentIdentityMismatch:
        await _fail_identity(dependencies, lease)
        return
    except (MalwareServiceUnavailable, OSError, TimeoutError, S3Error):
        await _retry(dependencies, lease)
        return

    if inspection.malware == MalwareVerdict.INFECTED:
        async with dependencies.sessions() as session:
            async with session.begin():
                quarantined = await quarantine_job(
                    session,
                    lease,
                    now=dependencies.clock(),
                    actual_size=inspection.size,
                    sha256=inspection.sha256,
                    content_type=inspection.content_type,
                )
        if quarantined:
            await asyncio.to_thread(dependencies.gateway.remove, work.staging_key)
        return

    final_key = f"artifacts/{work.artifact_id}/{lease.version_id}"
    try:
        target_version_id = await asyncio.to_thread(
            _promote,
            dependencies.gateway,
            work,
            lease,
            final_key,
        )
    except _ContentIdentityMismatch:
        await _fail_identity(dependencies, lease)
        return
    except (ObjectVersioningUnavailable, HTTPError, OSError, TimeoutError, S3Error):
        await _retry(dependencies, lease)
        return

    try:
        async with dependencies.sessions() as session:
            async with session.begin():
                published = await publish_clean_job(
                    session,
                    lease,
                    now=dependencies.clock(),
                    object_key=final_key,
                    actual_size=inspection.size,
                    sha256=inspection.sha256,
                    content_type=inspection.content_type,
                )
    except BaseException as publication_error:
        try:
            cleanup_error = await _remove_or_enqueue_cleanup(
                dependencies,
                object_key=final_key,
                version_id=target_version_id,
            )
        except ArtifactCleanupHandoffError as handoff_error:
            raise BaseExceptionGroup(
                "artifact publication and cleanup handoff failed",
                [publication_error, handoff_error],
            ) from publication_error
        if cleanup_error is not None:
            publication_error.add_note(
                f"exact object cleanup failed and was queued: {cleanup_error}"
            )
        raise
    if not published:
        await _remove_or_enqueue_cleanup(
            dependencies,
            object_key=final_key,
            version_id=target_version_id,
        )
        return
    try:
        await asyncio.to_thread(dependencies.gateway.remove, work.staging_key)
    except Exception:
        _logger.warning(
            "staging cleanup failed after artifact publication",
            extra={"staging_key": work.staging_key},
            exc_info=True,
        )


@asynccontextmanager
async def _runtime_dependencies() -> AsyncIterator[_ArtifactProcessingDependencies]:
    configured = _ArtifactProcessingSettings()
    engine = create_async_engine(configured.DATABASE_WORKER_URL, pool_pre_ping=True)
    try:
        yield _ArtifactProcessingDependencies(
            sessions=async_sessionmaker(engine, expire_on_commit=False),
            gateway=MinioGateway.from_worker_settings(configured),
            scanner=ClamAvScanner.from_settings(configured),
            clock=lambda: datetime.now(UTC),
        )
    finally:
        await engine.dispose()


async def process_artifact_job(lease: ArtifactJobLease) -> None:
    """Inspect and terminally publish one live artifact lease.

    The object body is consumed once outside database transactions. Publication rechecks
    the job ID, version ID, token, and lease expiry in one short worker transaction.

    @param lease The worker's time-limited authority for one artifact version.
    """

    async with _runtime_dependencies() as dependencies:
        await _process_with_dependencies(lease, dependencies)


async def process_artifact_cleanup_job(lease: ArtifactCleanupLease) -> None:
    """Remove the exact object version owned by a cleanup lease."""

    configured = _ArtifactProcessingSettings()
    gateway = MinioGateway.from_worker_settings(configured)
    await asyncio.to_thread(gateway.require_versioning)
    await asyncio.to_thread(
        gateway.remove,
        lease.object_key,
        version_id=lease.version_id,
    )
