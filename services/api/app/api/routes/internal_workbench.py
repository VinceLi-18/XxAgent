from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.api.routes.internal_sessions import SessionContext, get_session_context
from app.services.workbench import (
    WorkbenchContext,
    WorkbenchIdempotencyConflict,
    WorkbenchNotFound,
    bootstrap_workbench,
    create_and_select_project,
    normalize_context,
    project_detail,
)
from app.services.projects import ProjectCreationForbidden
from app.services.xagent_sessions import request_hash

router = APIRouter(prefix="/internal/xagent/workbench", tags=["internal-workbench"])
projects_router = APIRouter(prefix="/internal/xagent/projects", tags=["internal-projects"])


class VersionedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int


class SetContextRequest(VersionedRequest):
    kind: Literal["workbench", "project"]
    project_id: UUID | None = None

    @model_validator(mode="after")
    def valid_context_scope(self) -> "SetContextRequest":
        if (self.kind == "workbench") != (self.project_id is None):
            raise ValueError("上下文与项目不匹配")
        return self


class CreateProjectRequest(VersionedRequest):
    name: str = Field(min_length=1, max_length=255)
    idempotency_key: str = Field(min_length=1, max_length=255)

    @field_validator("name")
    @classmethod
    def nonblank_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("项目名称不能为空")
        return normalized


@router.post("/bootstrap")
async def bootstrap_route(
    request: VersionedRequest,
    context: SessionContext = Depends(get_session_context),
) -> dict[str, Any]:
    if request.schema_version != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "unsupported-version"},
        )
    return await bootstrap_workbench(context.session, context.principal)


@router.post("/context")
async def context_route(
    request: SetContextRequest,
    context: SessionContext = Depends(get_session_context),
) -> dict[str, Any]:
    if request.schema_version != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "unsupported-version"},
        )
    try:
        selected = await normalize_context(
            context.session,
            context.principal,
            WorkbenchContext(kind=request.kind, project_id=request.project_id),
        )
    except WorkbenchNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not-found"},
        ) from None
    return {
        "schema_version": 1,
        "account_id": str(context.principal.actor_id),
        "context": {
            "kind": selected.kind,
            "project_id": (
                str(selected.project_id) if selected.project_id is not None else None
            ),
        },
    }


@projects_router.post("", status_code=status.HTTP_201_CREATED)
async def create_project_route(
    request: CreateProjectRequest,
    response: Response,
    context: SessionContext = Depends(get_session_context),
) -> dict[str, Any]:
    if request.schema_version != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "unsupported-version"},
        )
    digest = request_hash(request.model_dump(exclude={"idempotency_key"}))
    try:
        result, replay = await create_and_select_project(
            context.session,
            context.principal,
            name=request.name,
            idempotency_key=request.idempotency_key,
            digest=digest,
        )
    except ProjectCreationForbidden:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden"},
        ) from None
    except WorkbenchIdempotencyConflict:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "idempotency-conflict"},
        ) from None
    if replay:
        response.status_code = status.HTTP_200_OK
    return result


@projects_router.post("/{project_id}")
async def project_detail_route(
    project_id: UUID,
    request: VersionedRequest,
    context: SessionContext = Depends(get_session_context),
) -> dict[str, Any]:
    if request.schema_version != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "unsupported-version"},
        )
    try:
        return await project_detail(
            context.session,
            context.principal,
            project_id,
        )
    except WorkbenchNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not-found"},
        ) from None
