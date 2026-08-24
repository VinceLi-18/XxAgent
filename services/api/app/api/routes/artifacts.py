from datetime import timedelta
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.db_context import set_actor_context
from app.core.security import Actor, get_current_actor
from app.services import artifacts
from app.services.audit import write_audit_event
from app.services.authorization import ForbiddenError

router = APIRouter(prefix="/artifacts", tags=["artifacts"])


class CreateStagingUploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    project_id: UUID | None = None


class CompleteStagingUploadRequest(BaseModel):
    size: int = Field(ge=0)
    content_type: str | None = Field(max_length=255, default=None)
    sha256: str = Field(min_length=64, max_length=64)


async def _record_completion(
    session: AsyncSession,
    actor: Actor,
    upload_id: UUID,
    result: str,
) -> None:
    await write_audit_event(
        session,
        actor.id,
        "artifact.upload.complete",
        "staging_upload",
        upload_id,
        uuid4(),
        result,
    )


async def _record_read(
    session: AsyncSession,
    actor: Actor,
    artifact_id: UUID,
    result: str,
) -> None:
    await write_audit_event(
        session,
        actor.id,
        "artifact.read",
        "artifact",
        artifact_id,
        uuid4(),
        result,
    )


@router.post("/staging-uploads", status_code=status.HTTP_201_CREATED)
async def create_staging_upload(
    payload: CreateStagingUploadRequest,
    actor: Actor = Depends(get_current_actor),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    await set_actor_context(session, actor)
    service = artifacts._runtime_service()
    try:
        upload = await service.create(session, actor, payload)
    except ForbiddenError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found") from None
    put_url = service.gateway.create_staging_put_url(upload.staging_key, timedelta(minutes=10))
    return {"id": str(upload.id), "put_url": put_url}


@router.post(
    "/staging-uploads/{upload_id}/complete",
    status_code=status.HTTP_201_CREATED,
    response_model=None,
)
async def complete_staging_upload(
    upload_id: UUID,
    payload: CompleteStagingUploadRequest,
    actor: Actor = Depends(get_current_actor),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str] | JSONResponse:
    await set_actor_context(session, actor)
    try:
        version = await artifacts._runtime_service().complete(session, actor, upload_id, payload)
    except artifacts.UploadRejectedError:
        await _record_completion(session, actor, upload_id, "denied")
        return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content={"detail": "Upload rejected"})
    except artifacts.ArtifactStorageError:
        await _record_completion(session, actor, upload_id, "denied")
        return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"detail": "Upload unavailable"})
    if version is None:
        await _record_completion(session, actor, upload_id, "denied")
        return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"detail": "Not found"})
    await _record_completion(session, actor, upload_id, "allowed")
    return {"artifact_id": str(version.artifact_id), "version_id": str(version.id)}


@router.get("/{artifact_id}/content", response_class=StreamingResponse, response_model=None)
async def read_artifact(
    artifact_id: UUID,
    actor: Actor = Depends(get_current_actor),
    session: AsyncSession = Depends(get_session),
) -> StreamingResponse | JSONResponse:
    await set_actor_context(session, actor)
    stream = await artifacts._runtime_service().open_authorized_stream(session, artifact_id)
    if stream is None:
        await _record_read(session, actor, artifact_id, "denied")
        return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"detail": "Not found"})
    await _record_read(session, actor, artifact_id, "allowed")
    return StreamingResponse(stream, media_type=stream.content_type)
