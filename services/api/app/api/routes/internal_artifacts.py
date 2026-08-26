from collections.abc import Iterable
from typing import Any, Literal
from uuid import UUID, uuid4

from anyio import CancelScope
from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool
from starlette.responses import StreamingResponse
from starlette.types import Send

from app.api.routes.internal_sessions import SessionContext, get_session_context
from app.core.db import get_admin_session
from app.schemas.artifacts import (
    CompleteArtifactUploadRequest,
    CreateArtifactUploadRequest,
    CreateArtifactUploadResponse,
    ArtifactDetailResponse,
    ArtifactReadResponse,
    ArtifactSummaryResponse,
    EmptyArtifactRequest,
    RetryArtifactVersionRequest,
)
from app.services import artifacts
from app.services.audit import write_audit_event

router = APIRouter(prefix="/internal/xagent/artifacts", tags=["internal-artifacts"])
versions_router = APIRouter(
    prefix="/internal/xagent/artifact-versions",
    tags=["internal-artifact-versions"],
)
content_router = APIRouter(
    prefix="/api/v1/xagent/artifact-content",
    tags=["artifact-content"],
)


class _ArtifactStreamingResponse(StreamingResponse):
    """Close the storage iterator after completion or client disconnect."""

    def __init__(self, content: Iterable[bytes], **kwargs: Any) -> None:
        self._source_iterator = iter(content)
        super().__init__(self._source_iterator, **kwargs)

    async def stream_response(self, send: Send) -> None:
        try:
            await super().stream_response(send)
        finally:
            close = getattr(self._source_iterator, "close", None)
            if close is not None:
                with CancelScope(shield=True):
                    try:
                        await run_in_threadpool(close)
                    except Exception:
                        # Cleanup failures cannot replace delivery errors or reveal storage identities.
                        pass


def _error_response(status_code: int, code: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"detail": {"code": code}})


async def _audit_account_operation(
    context: SessionContext,
    *,
    action: str,
    resource_type: str,
    resource_id: UUID,
    request_id: UUID,
    result: str,
) -> None:
    await write_audit_event(
        context.session,
        context.principal.actor_id,
        action,
        resource_type,
        resource_id,
        request_id,
        result,
        executor_kind="account",
    )


@router.post(
    "/uploads",
    response_model=CreateArtifactUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_upload_route(
    request: CreateArtifactUploadRequest,
    context: SessionContext = Depends(get_session_context),
) -> CreateArtifactUploadResponse | JSONResponse:
    return await _create_upload_response(request, context, artifact_id=None)


@router.post(
    "/{artifact_id}/uploads",
    response_model=CreateArtifactUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_artifact_version_upload_route(
    artifact_id: UUID,
    request: CreateArtifactUploadRequest,
    context: SessionContext = Depends(get_session_context),
) -> CreateArtifactUploadResponse | JSONResponse:
    return await _create_upload_response(request, context, artifact_id=artifact_id)


async def _create_upload_response(
    request: CreateArtifactUploadRequest,
    context: SessionContext,
    *,
    artifact_id: UUID | None,
) -> CreateArtifactUploadResponse | JSONResponse:
    action = (
        "artifact.upload.create"
        if artifact_id is None
        else "artifact.version.upload.create"
    )
    request_id = uuid4()
    try:
        async with context.session.begin_nested():
            upload = await artifacts.create_upload(
                context.session,
                context.principal,
                filename=request.filename,
                expected_size=request.size,
                artifact_id=artifact_id,
                idempotency_key=request.idempotency_key,
            )
            put_url = await artifacts.get_or_create_upload_put_url(
                context.session,
                context.principal,
                upload=upload,
                idempotency_key=request.idempotency_key,
            )
    except artifacts.ArtifactIdempotencyConflict:
        code = "idempotency-conflict"
        await _audit_account_operation(
            context,
            action=action,
            resource_type="artifact" if artifact_id is not None else "staging_upload",
            resource_id=artifact_id or request_id,
            request_id=request_id,
            result=code,
        )
        return _error_response(status.HTTP_409_CONFLICT, code)
    except artifacts.ArtifactNotFound:
        code = "not-found"
        await _audit_account_operation(
            context,
            action=action,
            resource_type="artifact" if artifact_id is not None else "staging_upload",
            resource_id=artifact_id or request_id,
            request_id=request_id,
            result=code,
        )
        return _error_response(status.HTTP_404_NOT_FOUND, code)
    except artifacts.ArtifactStorageError:
        code = "service-unavailable"
        await _audit_account_operation(
            context,
            action=action,
            resource_type="artifact" if artifact_id is not None else "staging_upload",
            resource_id=artifact_id or request_id,
            request_id=request_id,
            result=code,
        )
        return _error_response(status.HTTP_503_SERVICE_UNAVAILABLE, code)
    await _audit_account_operation(
        context,
        action=action,
        resource_type="staging_upload",
        resource_id=upload.id,
        request_id=request_id,
        result="allowed",
    )
    return CreateArtifactUploadResponse(
        upload_id=upload.id,
        put_url=put_url,
        expires_at=upload.expires_at,
    )


@router.post(
    "/uploads/{upload_id}/complete",
    response_model=ArtifactDetailResponse,
    response_model_exclude_none=True,
    status_code=status.HTTP_201_CREATED,
)
async def complete_upload_route(
    upload_id: UUID,
    request: CompleteArtifactUploadRequest,
    context: SessionContext = Depends(get_session_context),
) -> ArtifactDetailResponse | JSONResponse:
    request_id = uuid4()
    try:
        async with context.session.begin_nested():
            detail, version_id = await artifacts.complete_upload(
                context.session,
                context.principal,
                upload_id=upload_id,
                actual_size=request.actual_size,
                sha256=request.sha256,
                idempotency_key=request.idempotency_key,
            )
    except artifacts.ArtifactIdempotencyConflict:
        code = "idempotency-conflict"
        await _audit_account_operation(
            context,
            action="artifact.upload.complete",
            resource_type="staging_upload",
            resource_id=upload_id,
            request_id=request_id,
            result=code,
        )
        return _error_response(status.HTTP_409_CONFLICT, code)
    except artifacts.ArtifactNotFound:
        code = "not-found"
        await _audit_account_operation(
            context,
            action="artifact.upload.complete",
            resource_type="staging_upload",
            resource_id=upload_id,
            request_id=request_id,
            result=code,
        )
        return _error_response(status.HTTP_404_NOT_FOUND, code)
    except artifacts.UploadRejectedError:
        code = "upload-rejected"
        await _audit_account_operation(
            context,
            action="artifact.upload.complete",
            resource_type="staging_upload",
            resource_id=upload_id,
            request_id=request_id,
            result=code,
        )
        return _error_response(status.HTTP_422_UNPROCESSABLE_CONTENT, code)
    except artifacts.ArtifactStorageError:
        code = "service-unavailable"
        await _audit_account_operation(
            context,
            action="artifact.upload.complete",
            resource_type="staging_upload",
            resource_id=upload_id,
            request_id=request_id,
            result=code,
        )
        return _error_response(status.HTTP_503_SERVICE_UNAVAILABLE, code)
    await _audit_account_operation(
        context,
        action="artifact.upload.complete",
        resource_type="artifact_version",
        resource_id=version_id,
        request_id=request_id,
        result="allowed",
    )
    return ArtifactDetailResponse.model_validate(detail)


@router.post(
    "/list",
    response_model=list[ArtifactSummaryResponse],
    response_model_exclude_none=True,
)
async def list_artifacts_route(
    _request: EmptyArtifactRequest,
    context: SessionContext = Depends(get_session_context),
) -> list[ArtifactSummaryResponse]:
    request_id = uuid4()
    response = [
        ArtifactSummaryResponse.model_validate(item)
        for item in await artifacts.list_artifacts(context.session, context.principal)
    ]
    await _audit_account_operation(
        context,
        action="artifact.list",
        resource_type="account",
        resource_id=context.principal.actor_id,
        request_id=request_id,
        result="allowed",
    )
    return response


@router.post(
    "/{artifact_id}",
    response_model=ArtifactDetailResponse,
    response_model_exclude_none=True,
)
async def artifact_detail_route(
    artifact_id: UUID,
    _request: EmptyArtifactRequest,
    context: SessionContext = Depends(get_session_context),
) -> ArtifactDetailResponse | JSONResponse:
    request_id = uuid4()
    try:
        async with context.session.begin_nested():
            detail = await artifacts.artifact_detail(
                context.session,
                context.principal,
                artifact_id,
            )
    except artifacts.ArtifactNotFound:
        code = "not-found"
        await _audit_account_operation(
            context,
            action="artifact.detail",
            resource_type="artifact",
            resource_id=artifact_id,
            request_id=request_id,
            result=code,
        )
        return _error_response(status.HTTP_404_NOT_FOUND, code)
    await _audit_account_operation(
        context,
        action="artifact.detail",
        resource_type="artifact",
        resource_id=artifact_id,
        request_id=request_id,
        result="allowed",
    )
    return ArtifactDetailResponse.model_validate(detail)


@versions_router.post(
    "/{version_id}/retry",
    response_model=ArtifactDetailResponse,
    response_model_exclude_none=True,
)
async def retry_artifact_version_route(
    version_id: UUID,
    request: RetryArtifactVersionRequest,
    context: SessionContext = Depends(get_session_context),
) -> ArtifactDetailResponse | JSONResponse:
    request_id = uuid4()
    try:
        async with context.session.begin_nested():
            detail = await artifacts.retry_version(
                context.session,
                context.principal,
                version_id=version_id,
                idempotency_key=request.idempotency_key,
            )
    except artifacts.ArtifactIdempotencyConflict:
        code = "idempotency-conflict"
        status_code = status.HTTP_409_CONFLICT
    except artifacts.ArtifactUploadExpired:
        code = "upload-expired"
        status_code = status.HTTP_410_GONE
    except artifacts.UploadRejectedError:
        code = "upload-rejected"
        status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
    except artifacts.ArtifactStorageError:
        code = "service-unavailable"
        status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    except artifacts.ArtifactNotFound:
        code = "not-found"
        status_code = status.HTTP_404_NOT_FOUND
    else:
        await _audit_account_operation(
            context,
            action="artifact.scan.retry",
            resource_type="artifact_version",
            resource_id=version_id,
            request_id=request_id,
            result="allowed",
        )
        return ArtifactDetailResponse.model_validate(detail)
    await _audit_account_operation(
        context,
        action="artifact.scan.retry",
        resource_type="artifact_version",
        resource_id=version_id,
        request_id=request_id,
        result=code,
    )
    return _error_response(status_code, code)


async def _read_response(
    version_id: UUID,
    context: SessionContext,
    *,
    preview: bool,
) -> ArtifactReadResponse | JSONResponse:
    request_id = uuid4()
    action = "artifact.preview" if preview else "artifact.download"
    try:
        async with context.session.begin_nested():
            url = await artifacts.create_read_url(
                context.session,
                context.principal,
                version_id=version_id,
                preview=preview,
            )
    except artifacts.ArtifactForbidden:
        code = "forbidden"
        status_code = status.HTTP_403_FORBIDDEN
    except artifacts.ArtifactStorageError:
        code = "service-unavailable"
        status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    except artifacts.ArtifactNotFound:
        code = "not-found"
        status_code = status.HTTP_404_NOT_FOUND
    else:
        await _audit_account_operation(
            context,
            action=action,
            resource_type="artifact_version",
            resource_id=version_id,
            request_id=request_id,
            result="allowed",
        )
        return ArtifactReadResponse(url=url)
    await _audit_account_operation(
        context,
        action=action,
        resource_type="artifact_version",
        resource_id=version_id,
        request_id=request_id,
        result=code,
    )
    return _error_response(status_code, code)


@versions_router.post("/{version_id}/preview", response_model=ArtifactReadResponse)
async def preview_artifact_version_route(
    version_id: UUID,
    _request: EmptyArtifactRequest,
    context: SessionContext = Depends(get_session_context),
) -> ArtifactReadResponse | JSONResponse:
    return await _read_response(version_id, context, preview=True)


@versions_router.post("/{version_id}/download", response_model=ArtifactReadResponse)
async def download_artifact_version_route(
    version_id: UUID,
    _request: EmptyArtifactRequest,
    context: SessionContext = Depends(get_session_context),
) -> ArtifactReadResponse | JSONResponse:
    return await _read_response(version_id, context, preview=False)


@content_router.get("/{version_id}")
async def artifact_content_route(
    version_id: UUID,
    expires: int = Query(ge=0),
    mode: Literal["inline", "attachment"] = Query(),
    signature: str = Query(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$"),
    session: AsyncSession = Depends(get_admin_session),
):
    try:
        object_key, content_type, disposition = await artifacts.resolve_read_content(
            session,
            version_id=version_id,
            expires=expires,
            mode=mode,
            signature=signature,
        )
    except artifacts.ArtifactForbidden:
        return _error_response(status.HTTP_403_FORBIDDEN, "forbidden")
    except artifacts.ArtifactNotFound:
        return _error_response(status.HTTP_404_NOT_FOUND, "not-found")
    return _ArtifactStreamingResponse(
        artifacts.stream_read_content(object_key),
        media_type=content_type,
        headers={"Content-Disposition": disposition},
    )
