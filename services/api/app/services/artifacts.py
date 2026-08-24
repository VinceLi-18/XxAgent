from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import Actor
from app.core.config import settings
from app.models.artifact import Artifact, ArtifactVersion, StagingUpload
from app.models.project import ProjectAction
from app.services.authorization import authorize_project
from app.services.malware import ClamAvScanner
from app.storage.minio_gateway import MinioGateway


def _value(values: Mapping[str, Any] | Any, name: str, default: Any = None) -> Any:
    return values.get(name, default) if isinstance(values, Mapping) else getattr(values, name, default)


def _uuid(value: UUID | str | None) -> UUID | None:
    return UUID(str(value)) if value is not None else None


_PROMOTION_CLEANUPS = "artifact_promotion_cleanups"
_PROMOTION_CLEANUP_LISTENERS = "artifact_promotion_cleanup_listeners"


class UploadRejectedError(Exception):
    """The caller's completed staging object did not satisfy validation."""


class ArtifactStorageError(Exception):
    """The private object store could not complete a storage operation."""


@dataclass
class _PromotionCleanup:
    gateway: Any
    staging_key: str
    object_key: str
    transaction: Any
    rolled_back: bool = False


@dataclass
class AuthorizedArtifactStream:
    content_type: str | None
    chunks: Iterable[bytes]

    def __iter__(self) -> Iterator[bytes]:
        return iter(self.chunks)


def _promotion_cleanups(session: AsyncSession) -> list[_PromotionCleanup]:
    info = session.sync_session.info
    cleanups = info.setdefault(_PROMOTION_CLEANUPS, [])
    if info.get(_PROMOTION_CLEANUP_LISTENERS):
        return cleanups

    def after_commit(sync_session: Any) -> None:
        if sync_session.get_nested_transaction() is not None:
            return
        for cleanup in sync_session.info.pop(_PROMOTION_CLEANUPS, []):
            try:
                cleanup.gateway.remove(cleanup.object_key if cleanup.rolled_back else cleanup.staging_key)
            except Exception:
                continue

    def after_soft_rollback(sync_session: Any, transaction: Any) -> None:
        cleanups = sync_session.info.get(_PROMOTION_CLEANUPS, [])
        if transaction.parent is None:
            for cleanup in cleanups:
                try:
                    cleanup.gateway.remove(cleanup.object_key)
                except Exception:
                    continue
            cleanups.clear()
        elif transaction.nested:
            for cleanup in cleanups:
                if cleanup.transaction is transaction:
                    cleanup.rolled_back = True

    event.listen(session.sync_session, "after_commit", after_commit)
    event.listen(session.sync_session, "after_soft_rollback", after_soft_rollback)
    info[_PROMOTION_CLEANUP_LISTENERS] = True
    return cleanups


class ArtifactService:
    def __init__(self, gateway: Any, scanner: Any) -> None:
        self.gateway = gateway
        self.scanner = scanner

    async def create(
        self,
        session: AsyncSession,
        actor: Actor,
        metadata: Mapping[str, Any] | Any,
    ) -> StagingUpload:
        project_id = _uuid(_value(metadata, "project_id"))
        if project_id is not None:
            await authorize_project(session, actor.id, project_id, ProjectAction.EDIT)
        upload_id = uuid4()
        upload = StagingUpload(
            id=upload_id,
            created_by_id=actor.id,
            filename=str(_value(metadata, "filename", "upload")),
            owner_id=None if project_id else actor.id,
            project_id=project_id,
            staging_key=f"staging/{upload_id}",
            expires_at=datetime.now(UTC) + timedelta(minutes=10),
        )
        session.add(upload)
        await session.flush()
        return upload

    async def complete(
        self,
        session: AsyncSession,
        actor: Actor,
        upload_id: UUID,
        declared: Mapping[str, Any] | Any,
    ) -> ArtifactVersion | None:
        upload = await session.scalar(
            select(StagingUpload).where(
                StagingUpload.id == upload_id,
                StagingUpload.created_by_id == actor.id,
                StagingUpload.expires_at > datetime.now(UTC),
            )
        )
        if upload is None:
            return None

        try:
            metadata = self.gateway.stat(upload.staging_key)
        except Exception as exc:
            raise ArtifactStorageError from exc
        if (
            metadata.size != _value(declared, "size")
            or metadata.size > settings.MAX_ARTIFACT_SIZE_BYTES
            or metadata.content_type != _value(declared, "content_type")
            or not isinstance(_value(declared, "sha256"), str)
            or not metadata.etag
        ):
            raise UploadRejectedError

        digest = sha256()

        def content() -> Iterable[bytes]:
            for chunk in self.gateway.stream(upload.staging_key):
                digest.update(chunk)
                yield chunk

        if not self.scanner.scan_stream(content()).clean or digest.hexdigest() != _value(declared, "sha256"):
            raise UploadRejectedError

        artifact = Artifact(
            id=uuid4(),
            filename=upload.filename,
            owner_id=upload.owner_id,
            project_id=upload.project_id,
        )
        version = ArtifactVersion(
            id=uuid4(),
            artifact_id=artifact.id,
            owner_id=upload.owner_id,
            project_id=upload.project_id,
            object_key=f"artifacts/{artifact.id}/{{version_id}}",
            size=metadata.size,
            content_type=metadata.content_type,
            sha256=digest.hexdigest(),
        )
        version.object_key = version.object_key.format(version_id=version.id)
        try:
            self.gateway.copy(upload.staging_key, version.object_key, etag=metadata.etag)
        except Exception as exc:
            raise UploadRejectedError from exc
        cleanups = _promotion_cleanups(session)
        cleanup = _PromotionCleanup(
            self.gateway,
            upload.staging_key,
            version.object_key,
            session.sync_session.get_nested_transaction() or session.sync_session.get_transaction(),
        )
        cleanups.append(cleanup)
        try:
            session.add_all((artifact, version))
            await session.flush()
            await session.delete(upload)
            await session.flush()
        except Exception:
            cleanups.remove(cleanup)
            try:
                self.gateway.remove(version.object_key)
            except Exception:
                pass
            raise
        return version

    async def open_authorized_stream(
        self,
        session: AsyncSession,
        artifact_id: UUID,
    ) -> AuthorizedArtifactStream | None:
        version = await session.scalar(
            select(ArtifactVersion)
            .where(ArtifactVersion.artifact_id == artifact_id)
            .order_by(ArtifactVersion.created_at.desc())
            .limit(1)
        )
        if version is None:
            return None
        return AuthorizedArtifactStream(
            content_type=version.content_type,
            chunks=self.gateway.stream(version.object_key),
        )


def _runtime_service() -> ArtifactService:
    return ArtifactService(MinioGateway.from_settings(), ClamAvScanner.from_settings())


async def create_staging_upload(
    session: AsyncSession,
    actor: Actor,
    metadata: Mapping[str, Any] | Any,
) -> StagingUpload:
    return await ArtifactService(None, None).create(session, actor, metadata)


async def complete_staging_upload(
    session: AsyncSession,
    actor: Actor,
    upload_id: UUID,
    declared: Mapping[str, Any] | Any,
) -> ArtifactVersion | None:
    return await _runtime_service().complete(session, actor, upload_id, declared)
