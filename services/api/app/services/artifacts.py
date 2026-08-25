import re
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from minio.error import S3Error
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.artifact import (
    Artifact,
    ArtifactProcessingJob,
    ArtifactVersion,
    StagingUpload,
)
from app.models.project import ProjectAction
from app.models.xagent_session import XAgentIdempotencyKey
from app.services.authorization import ForbiddenError, authorize_project
from app.services.auth import Principal
from app.services.workbench import normalize_context
from app.services.xagent_sessions import request_hash
from app.storage.minio_gateway import MinioGateway


class UploadRejectedError(Exception):
    """暂存对象未通过完成校验。"""


class ArtifactStorageError(Exception):
    """私有对象存储无法完成操作。"""


class ArtifactIdempotencyConflict(Exception):
    pass


class ArtifactNotFound(Exception):
    pass


def _runtime_gateway() -> MinioGateway:
    return MinioGateway.from_settings(settings)


async def _require_project_edit(
    session: AsyncSession,
    principal: Principal,
    project_id: UUID | None,
) -> None:
    if project_id is None:
        return
    try:
        await authorize_project(
            session,
            principal.actor_id,
            project_id,
            ProjectAction.EDIT,
        )
    except ForbiddenError:
        raise ArtifactNotFound from None


async def _require_artifact_edit(
    session: AsyncSession,
    principal: Principal,
    artifact_id: UUID,
) -> Artifact:
    artifact = await session.scalar(select(Artifact).where(Artifact.id == artifact_id))
    if artifact is None:
        raise ArtifactNotFound
    await _require_project_edit(session, principal, artifact.project_id)
    return artifact


async def _require_upload_edit(
    session: AsyncSession,
    principal: Principal,
    upload: StagingUpload,
) -> None:
    if upload.artifact_id is not None:
        await _require_artifact_edit(session, principal, upload.artifact_id)
        return
    await _require_project_edit(session, principal, upload.project_id)


async def create_upload(
    session: AsyncSession,
    principal: Principal,
    *,
    filename: str,
    expected_size: int,
    artifact_id: UUID | None,
    idempotency_key: str,
) -> StagingUpload:
    if artifact_id is None:
        context = await normalize_context(session, principal, None)
        owner_id = principal.actor_id if context.kind == "workbench" else None
        project_id = context.project_id
    else:
        artifact = await session.scalar(
            select(Artifact).where(Artifact.id == artifact_id)
        )
        if artifact is None:
            raise ArtifactNotFound
        owner_id = artifact.owner_id
        project_id = artifact.project_id
    if project_id is not None:
        try:
            await authorize_project(
                session,
                principal.actor_id,
                project_id,
                ProjectAction.EDIT,
            )
        except ForbiddenError:
            raise ArtifactNotFound from None
    operation = "artifact.upload.create"
    digest = request_hash(
        {
            "filename": filename,
            "expected_size": expected_size,
            "artifact_id": str(artifact_id) if artifact_id is not None else None,
            "owner_id": str(owner_id) if owner_id is not None else None,
            "project_id": str(project_id) if project_id is not None else None,
        }
    )
    lock_name = f"{principal.actor_id}:{operation}:{idempotency_key}"
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_name, 0))"),
        {"lock_name": lock_name},
    )
    now = datetime.now(UTC)
    stored = await session.get(
        XAgentIdempotencyKey,
        (principal.actor_id, operation, idempotency_key),
    )
    if stored is not None and stored.expires_at > now:
        if stored.request_hash != digest:
            raise ArtifactIdempotencyConflict
        upload = await session.get(StagingUpload, UUID(stored.result["upload_id"]))
        if upload is not None:
            return upload

    upload_id = uuid4()
    expires_at = now + timedelta(minutes=10)
    upload = StagingUpload(
        id=upload_id,
        artifact_id=artifact_id,
        created_by_id=principal.actor_id,
        filename=filename,
        expected_size=expected_size,
        owner_id=owner_id,
        project_id=project_id,
        staging_key=f"staging/{upload_id}",
        expires_at=expires_at,
    )
    session.add(upload)
    result = {"upload_id": str(upload_id)}
    if stored is None:
        session.add(
            XAgentIdempotencyKey(
                actor_id=principal.actor_id,
                operation=operation,
                idempotency_key=idempotency_key,
                request_hash=digest,
                result=result,
                expires_at=expires_at,
            )
        )
    else:
        stored.request_hash = digest
        stored.result = result
        stored.expires_at = expires_at
    await session.flush()
    return upload


async def get_or_create_upload_put_url(
    session: AsyncSession,
    principal: Principal,
    *,
    upload: StagingUpload,
    idempotency_key: str,
) -> str:
    stored = await session.get(
        XAgentIdempotencyKey,
        (principal.actor_id, "artifact.upload.create", idempotency_key),
    )
    if stored is None or stored.result.get("upload_id") != str(upload.id):
        raise ArtifactNotFound
    put_url = stored.result.get("put_url")
    if isinstance(put_url, str):
        return put_url
    remaining = upload.expires_at - datetime.now(UTC)
    if remaining <= timedelta(0):
        raise ArtifactNotFound
    put_url = _runtime_gateway().create_staging_put_url(
        upload.staging_key,
        remaining,
    )
    stored.result = {**stored.result, "put_url": put_url}
    await session.flush()
    return put_url


async def complete_upload(
    session: AsyncSession,
    principal: Principal,
    *,
    upload_id: UUID,
    actual_size: int,
    sha256: str,
    idempotency_key: str,
) -> ArtifactVersion:
    normalized_sha256 = sha256.lower()
    operation = "artifact.upload.complete"
    digest = request_hash(
        {
            "upload_id": str(upload_id),
            "actual_size": actual_size,
            "sha256": normalized_sha256,
        }
    )
    lock_name = f"{principal.actor_id}:{operation}:{idempotency_key}"
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_name, 0))"),
        {"lock_name": lock_name},
    )
    now = datetime.now(UTC)
    stored = await session.get(
        XAgentIdempotencyKey,
        (principal.actor_id, operation, idempotency_key),
    )
    if stored is not None and stored.expires_at > now:
        version = await session.get(
            ArtifactVersion,
            UUID(stored.result["version_id"]),
        )
        if version is None:
            raise ArtifactNotFound
        await _require_artifact_edit(
            session,
            principal,
            version.artifact_id,
        )
        if stored.request_hash != digest:
            raise ArtifactIdempotencyConflict
        return version

    upload = await session.scalar(
        select(StagingUpload).where(
            StagingUpload.id == upload_id,
            StagingUpload.created_by_id == principal.actor_id,
            StagingUpload.expires_at > datetime.now(UTC),
        )
    )
    if upload is None:
        raise ArtifactNotFound
    await _require_upload_edit(session, principal, upload)
    if not re.fullmatch(r"[0-9a-fA-F]{64}", sha256):
        raise UploadRejectedError

    try:
        metadata = _runtime_gateway().stat(upload.staging_key)
    except KeyError:
        raise UploadRejectedError from None
    except S3Error as exc:
        if exc.code in {"NoSuchKey", "NoSuchObject"}:
            raise UploadRejectedError from None
        raise ArtifactStorageError from exc
    except Exception as exc:
        raise ArtifactStorageError from exc
    if (
        upload.expected_size is None
        or metadata.size != upload.expected_size
        or metadata.size != actual_size
        or metadata.size > settings.MAX_ARTIFACT_SIZE_BYTES
        or not isinstance(metadata.etag, str)
        or not metadata.etag.strip()
    ):
        raise UploadRejectedError

    if upload.artifact_id is None:
        if upload.project_id is not None:
            try:
                await authorize_project(
                    session,
                    principal.actor_id,
                    upload.project_id,
                    ProjectAction.EDIT,
                )
            except ForbiddenError:
                raise ArtifactNotFound from None
        artifact = Artifact(
            id=uuid4(),
            filename=upload.filename,
            created_by_id=principal.actor_id,
            owner_id=upload.owner_id,
            project_id=upload.project_id,
        )
        next_version = 1
        session.add(artifact)
        await session.flush()
    else:
        lock_name = f"artifact-version:{upload.artifact_id}"
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_name, 0))"),
            {"lock_name": lock_name},
        )
        artifact = await session.scalar(
            select(Artifact).where(Artifact.id == upload.artifact_id)
        )
        if artifact is None:
            raise ArtifactNotFound
        if artifact.project_id is not None:
            try:
                await authorize_project(
                    session,
                    principal.actor_id,
                    artifact.project_id,
                    ProjectAction.EDIT,
                )
            except ForbiddenError:
                raise ArtifactNotFound from None
        current_version = await session.scalar(
            select(func.max(ArtifactVersion.version_number)).where(
                ArtifactVersion.artifact_id == artifact.id
            )
        )
        next_version = (current_version or 0) + 1

    version = ArtifactVersion(
        id=uuid4(),
        artifact_id=artifact.id,
        owner_id=artifact.owner_id,
        project_id=artifact.project_id,
        version_number=next_version,
        original_filename=upload.filename,
        uploaded_by_id=principal.actor_id,
        declared_size=upload.expected_size,
        actual_size=metadata.size,
        detected_content_type=None,
        scan_status="pending",
        staging_key=upload.staging_key,
        staging_etag=metadata.etag,
        staging_expires_at=now + timedelta(days=1),
        object_key=None,
        size=metadata.size,
        content_type=None,
        sha256=normalized_sha256,
    )
    session.add(version)
    await session.flush()
    job = ArtifactProcessingJob(
        id=uuid4(),
        version_id=version.id,
        status="ready",
        attempts=0,
        next_attempt_at=now,
        lease_token=None,
        lease_expires_at=None,
        failure_code=None,
        created_at=now,
        updated_at=now,
    )
    session.add(job)
    await session.flush()
    result = {"version_id": str(version.id)}
    expires_at = now + timedelta(hours=24)
    if stored is None:
        session.add(
            XAgentIdempotencyKey(
                actor_id=principal.actor_id,
                operation=operation,
                idempotency_key=idempotency_key,
                request_hash=digest,
                result=result,
                expires_at=expires_at,
            )
        )
    else:
        stored.request_hash = digest
        stored.result = result
        stored.expires_at = expires_at
    await session.flush()
    return version
