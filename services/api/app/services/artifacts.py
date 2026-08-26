import re
import unicodedata
from datetime import UTC, datetime, timedelta
from typing import Any
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


class ArtifactUploadExpired(Exception):
    pass


class ArtifactForbidden(Exception):
    pass


INLINE_TYPES = frozenset(
    {
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/json",
        "image/png",
        "image/jpeg",
        "image/webp",
    }
)
READ_URL_SECONDS = 60


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
    try:
        put_url = _runtime_gateway().create_staging_put_url(
            upload.staging_key,
            remaining,
        )
    except Exception as exc:
        raise ArtifactStorageError from exc
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


def _version_projection(version: ArtifactVersion) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": version.id,
        "version": version.version_number,
        "original_filename": version.original_filename,
        "uploaded_by": version.uploaded_by_id,
        "size": version.actual_size,
        "content_type": version.detected_content_type,
        "status": version.scan_status,
        "created_at": version.created_at,
    }
    if version.scan_status in {"clean", "quarantined"}:
        result["sha256"] = version.sha256
    return result


def _summary_projection(
    artifact: Artifact,
    versions: list[ArtifactVersion],
) -> dict[str, Any]:
    latest = versions[0]
    latest_clean = next(
        (version for version in versions if version.scan_status == "clean"),
        None,
    )
    scope: dict[str, Any]
    if artifact.owner_id is not None:
        scope = {"kind": "private"}
    else:
        scope = {"kind": "project", "project_id": artifact.project_id}
    return {
        "id": artifact.id,
        "display_name": artifact.filename,
        "scope": scope,
        "latest_version": latest.version_number,
        "latest_status": latest.scan_status,
        "latest_clean_version": (
            latest_clean.version_number if latest_clean is not None else None
        ),
    }


async def _ordered_versions(
    session: AsyncSession,
    artifact_id: UUID,
) -> list[ArtifactVersion]:
    return list(
        (
            await session.scalars(
                select(ArtifactVersion)
                .where(ArtifactVersion.artifact_id == artifact_id)
                .order_by(
                    ArtifactVersion.version_number.desc(),
                    ArtifactVersion.id.desc(),
                )
            )
        ).all()
    )


async def list_artifacts(
    session: AsyncSession,
    principal: Principal,
) -> list[dict[str, Any]]:
    context = await normalize_context(session, principal, None)
    scope_filter = (
        Artifact.owner_id == principal.actor_id
        if context.kind == "workbench"
        else Artifact.project_id == context.project_id
    )
    items = list(
        (
            await session.scalars(
                select(Artifact)
                .where(scope_filter)
                .order_by(Artifact.created_at.desc(), Artifact.id.desc())
            )
        ).all()
    )
    result: list[dict[str, Any]] = []
    for artifact in items:
        versions = await _ordered_versions(session, artifact.id)
        if versions:
            result.append(_summary_projection(artifact, versions))
    return result


async def _can_edit_artifact(
    session: AsyncSession,
    principal: Principal,
    artifact: Artifact,
) -> bool:
    if artifact.owner_id is not None:
        return artifact.owner_id == principal.actor_id
    if artifact.project_id is None:
        return False
    try:
        await authorize_project(
            session,
            principal.actor_id,
            artifact.project_id,
            ProjectAction.EDIT,
        )
    except ForbiddenError:
        return False
    return True


async def artifact_detail(
    session: AsyncSession,
    principal: Principal,
    artifact_id: UUID,
) -> dict[str, Any]:
    artifact = await session.scalar(select(Artifact).where(Artifact.id == artifact_id))
    if artifact is None:
        raise ArtifactNotFound
    versions = await _ordered_versions(session, artifact.id)
    if not versions:
        raise ArtifactNotFound
    return {
        **_summary_projection(artifact, versions),
        "can_edit": await _can_edit_artifact(session, principal, artifact),
        "versions": [_version_projection(version) for version in versions],
    }


def _safe_download_filename(filename: str) -> str:
    sanitized = "".join(
        "_"
        if character in {"/", "\\", '"'} or unicodedata.category(character) == "Cc"
        else character
        for character in filename
    ).strip()
    if not sanitized or sanitized in {".", ".."}:
        return "download"
    return sanitized[:255]


async def create_read_url(
    session: AsyncSession,
    principal: Principal,
    *,
    version_id: UUID,
    preview: bool,
) -> str:
    version = await session.scalar(
        select(ArtifactVersion).where(
            ArtifactVersion.id == version_id,
            ArtifactVersion.scan_status == "clean",
        )
    )
    if version is None or version.object_key is None:
        raise ArtifactNotFound
    artifact = await session.scalar(
        select(Artifact).where(Artifact.id == version.artifact_id)
    )
    if artifact is None:
        raise ArtifactNotFound
    content_type = version.detected_content_type
    if preview and content_type not in INLINE_TYPES:
        raise ArtifactForbidden
    filename = _safe_download_filename(version.original_filename)
    try:
        return _runtime_gateway().create_read_url(
            version.object_key,
            expires_seconds=READ_URL_SECONDS,
            disposition="inline" if preview else "attachment",
            filename=filename,
        )
    except Exception as exc:
        raise ArtifactStorageError from exc


async def retry_version(
    session: AsyncSession,
    principal: Principal,
    *,
    version_id: UUID,
    idempotency_key: str,
) -> dict[str, Any]:
    visible = await session.scalar(
        select(ArtifactVersion).where(ArtifactVersion.id == version_id)
    )
    if visible is None:
        raise ArtifactNotFound
    await _require_artifact_edit(session, principal, visible.artifact_id)

    operation = "artifact.version.retry"
    digest = request_hash({"version_id": str(version_id)})
    lock_name = f"{principal.actor_id}:{operation}:{idempotency_key}"
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_name, 0))"),
        {"lock_name": lock_name},
    )
    version = await session.scalar(
        select(ArtifactVersion)
        .where(ArtifactVersion.id == version_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if version is None:
        raise ArtifactNotFound
    await _require_artifact_edit(session, principal, version.artifact_id)
    now = datetime.now(UTC)
    stored = await session.get(
        XAgentIdempotencyKey,
        (principal.actor_id, operation, idempotency_key),
    )
    if stored is not None and stored.expires_at > now:
        if stored.request_hash != digest:
            raise ArtifactIdempotencyConflict
        return await artifact_detail(session, principal, version.artifact_id)

    if version.scan_status != "failed":
        raise ArtifactNotFound
    if (
        version.staging_expires_at is None
        or version.staging_expires_at <= now
        or version.staging_key is None
        or version.staging_etag is None
        or version.actual_size is None
    ):
        raise ArtifactUploadExpired
    try:
        metadata = _runtime_gateway().stat(version.staging_key)
    except KeyError:
        raise ArtifactUploadExpired from None
    except S3Error as exc:
        if exc.code in {"NoSuchKey", "NoSuchObject"}:
            raise ArtifactUploadExpired from None
        raise ArtifactStorageError from exc
    except Exception as exc:
        raise ArtifactStorageError from exc
    if metadata.size != version.actual_size or metadata.etag != version.staging_etag:
        raise UploadRejectedError

    version.scan_status = "pending"
    job = await session.scalar(
        select(ArtifactProcessingJob)
        .where(ArtifactProcessingJob.version_id == version.id)
        .with_for_update()
    )
    if job is None:
        session.add(
            ArtifactProcessingJob(
                id=uuid4(),
                version_id=version.id,
                status="ready",
                attempts=0,
                next_attempt_at=now,
            )
        )
    else:
        job.status = "ready"
        job.attempts = 0
        job.next_attempt_at = now
        job.lease_token = None
        job.lease_expires_at = None
        job.failure_code = None
        job.updated_at = now
    result = {"artifact_id": str(version.artifact_id), "version_id": str(version.id)}
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
    return await artifact_detail(session, principal, version.artifact_id)
