from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.internal_auth import require_service_identity, require_user_token
from app.api.routes.internal_sessions import SessionContext, get_session_context
from app.core.db import get_admin_session
from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.services.auth import AuthenticationRejected, introspect
from app.services.workbench import (
    WorkbenchContext,
    WorkbenchIdempotencyConflict,
    WorkbenchNotFound,
    WorkbenchSessionNotFound,
    bootstrap_workbench,
    create_and_select_project,
    normalize_context,
    project_detail,
    register_session_project_refs,
)
from app.services.projects import ProjectCreationForbidden
from app.services.xagent_sessions import request_hash

router = APIRouter(prefix="/internal/xagent/workbench", tags=["internal-workbench"])
projects_router = APIRouter(prefix="/internal/xagent/projects", tags=["internal-projects"])
session_project_refs_router = APIRouter(
    prefix="/internal/xagent/session-project-refs",
    tags=["internal-session-project-refs"],
)


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


class RegisterSessionProjectRefsRequest(VersionedRequest):
    session_id: UUID
    project_ids: list[UUID] = Field(min_length=1, max_length=100)
    idempotency_key: str = Field(min_length=1, max_length=255)


async def get_session_project_refs_context(
    _: None = Depends(require_service_identity),
    token: str = Depends(require_user_token),
    session: AsyncSession = Depends(get_admin_session),
) -> SessionContext:
    try:
        principal = await introspect(token, session)
    except AuthenticationRejected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthenticated"},
        ) from None
    await set_actor_context(
        session,
        Actor(id=principal.actor_id, role=principal.role),
    )
    return SessionContext(principal, session)


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


@session_project_refs_router.post("", status_code=status.HTTP_204_NO_CONTENT)
async def register_session_project_refs_route(
    request: RegisterSessionProjectRefsRequest,
    context: SessionContext = Depends(get_session_project_refs_context),
) -> Response:
    if request.schema_version != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "unsupported-version"},
        )
    try:
        digest = request_hash(
            {
                "schema_version": request.schema_version,
                "session_id": str(request.session_id),
                "project_ids": sorted(
                    {str(project_id) for project_id in request.project_ids}
                ),
            }
        )
        await register_session_project_refs(
            context.session,
            context.principal,
            session_id=request.session_id,
            project_ids=request.project_ids,
            idempotency_key=request.idempotency_key,
            digest=digest,
        )
    except WorkbenchNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not-found"},
        ) from None
    except WorkbenchSessionNotFound:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "session-not-found"},
        ) from None
    except WorkbenchIdempotencyConflict:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "idempotency-conflict"},
        ) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)
