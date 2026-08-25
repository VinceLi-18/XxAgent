from datetime import timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.routes.internal_sessions import SessionContext, get_session_context
from app.schemas.artifacts import (
    CompleteArtifactUploadRequest,
    CompleteArtifactUploadResponse,
    CreateArtifactUploadRequest,
    CreateArtifactUploadResponse,
)
from app.services import artifacts

router = APIRouter(prefix="/internal/xagent/artifacts", tags=["internal-artifacts"])


@router.post(
    "/uploads",
    response_model=CreateArtifactUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_upload_route(
    request: CreateArtifactUploadRequest,
    context: SessionContext = Depends(get_session_context),
) -> CreateArtifactUploadResponse:
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
) -> CreateArtifactUploadResponse:
    return await _create_upload_response(request, context, artifact_id=artifact_id)


async def _create_upload_response(
    request: CreateArtifactUploadRequest,
    context: SessionContext,
    *,
    artifact_id: UUID | None,
) -> CreateArtifactUploadResponse:
    try:
        upload = await artifacts.create_upload(
            context.session,
            context.principal,
            filename=request.filename,
            expected_size=request.size,
            artifact_id=artifact_id,
            idempotency_key=request.idempotency_key,
        )
    except artifacts.ArtifactIdempotencyConflict:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "idempotency-conflict"},
        ) from None
    except artifacts.ArtifactNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not-found"},
        ) from None
    return CreateArtifactUploadResponse(
        upload_id=upload.id,
        put_url=artifacts._runtime_gateway().create_staging_put_url(
            upload.staging_key,
            timedelta(minutes=10),
        ),
        expires_at=upload.expires_at,
    )


@router.post(
    "/uploads/{upload_id}/complete",
    response_model=CompleteArtifactUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def complete_upload_route(
    upload_id: UUID,
    request: CompleteArtifactUploadRequest,
    context: SessionContext = Depends(get_session_context),
) -> CompleteArtifactUploadResponse:
    try:
        version = await artifacts.complete_upload(
            context.session,
            context.principal,
            upload_id=upload_id,
            actual_size=request.actual_size,
            sha256=request.sha256,
            idempotency_key=request.idempotency_key,
        )
    except artifacts.ArtifactIdempotencyConflict:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "idempotency-conflict"},
        ) from None
    except artifacts.ArtifactNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not-found"},
        ) from None
    except artifacts.UploadRejectedError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": "upload-rejected"},
        ) from None
    except artifacts.ArtifactStorageError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "storage-unavailable"},
        ) from None
    return CompleteArtifactUploadResponse(
        artifact_id=version.artifact_id,
        version_id=version.id,
    )
