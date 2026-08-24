from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.internal_auth import require_service_identity, require_user_token
from app.core.config import settings
from app.core.db import get_admin_session
from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.services.auth import AuthenticationRejected, Principal, introspect
from app.services.xagent_sessions import (
    SessionErrorCode,
    SessionServiceError,
    append_events,
    authorize_session,
    archive_session,
    create_session,
    fork_session,
    list_sessions,
    open_session,
    read_events,
    request_hash,
    require_protocol_version,
)

router = APIRouter(prefix="/internal/xagent/sessions", tags=["internal-sessions"])


class VersionedRequest(BaseModel):
    schema_version: int


class EventInput(BaseModel):
    event_type: str = Field(min_length=1, max_length=100)
    schema_version: int = Field(ge=1)
    payload: dict[str, Any]
    tool_call_id: str | None = Field(default=None, max_length=255)


class CreateSessionRequest(VersionedRequest):
    session_id: UUID | None = None
    runtime_header: dict[str, Any] | None = None
    title: str = Field(min_length=1, max_length=255)
    visibility: Literal["private", "project"]
    project_id: UUID | None = None
    idempotency_key: str = Field(min_length=1, max_length=255)
    events: list[EventInput] = Field(default_factory=list, max_length=100)


class AppendRequest(VersionedRequest):
    expected_sequence: int = Field(ge=-1)
    idempotency_key: str = Field(min_length=1, max_length=255)
    events: list[EventInput] = Field(min_length=1, max_length=100)


class EventsRequest(VersionedRequest):
    after_sequence: int = Field(default=-1, ge=-1)
    limit: int = Field(default=100, ge=1, le=500)


class ForkRequest(VersionedRequest):
    through_sequence: int = Field(ge=-1)
    title: str = Field(min_length=1, max_length=255)
    idempotency_key: str = Field(min_length=1, max_length=255)


class ArchiveRequest(VersionedRequest):
    expected_version: int = Field(ge=1)


class AuthorizeRequest(VersionedRequest):
    operation: Literal["read", "edit", "owner"]


class SessionContext:
    def __init__(self, principal: Principal, session: AsyncSession) -> None:
        self.principal = principal
        self.session = session


async def get_session_context(
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
    role = session.get_bind().dialect.identifier_preparer.quote(settings.POSTGRES_APP_USER)
    await session.execute(text(f"SET LOCAL ROLE {role}"))
    await set_actor_context(
        session,
        Actor(id=principal.actor_id, role=principal.role),
    )
    return SessionContext(principal, session)


def _raise_http(error: SessionServiceError) -> None:
    status_code = {
        SessionErrorCode.NOT_FOUND: status.HTTP_404_NOT_FOUND,
        SessionErrorCode.SEQUENCE_CONFLICT: status.HTTP_409_CONFLICT,
        SessionErrorCode.IDEMPOTENCY_CONFLICT: status.HTTP_409_CONFLICT,
        SessionErrorCode.UNSUPPORTED_VERSION: status.HTTP_400_BAD_REQUEST,
    }[error.code]
    raise HTTPException(status_code=status_code, detail={"code": error.code.value})


def _check_version(version: int) -> None:
    try:
        require_protocol_version(version)
    except SessionServiceError as error:
        _raise_http(error)


def _check_event_versions(events: list[EventInput]) -> None:
    if any(event.schema_version != 1 for event in events):
        _raise_http(SessionServiceError(SessionErrorCode.UNSUPPORTED_VERSION))


@router.post("/list")
async def list_route(
    request: VersionedRequest,
    context: SessionContext = Depends(get_session_context),
) -> dict[str, Any]:
    _check_version(request.schema_version)
    return {"schema_version": 1, "sessions": await list_sessions(context.session)}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_route(
    request: CreateSessionRequest,
    response: Response,
    context: SessionContext = Depends(get_session_context),
) -> dict[str, Any]:
    _check_version(request.schema_version)
    _check_event_versions(request.events)
    digest = request_hash(request.model_dump(mode="json", exclude={"idempotency_key"}))
    try:
        result, replay = await create_session(
            context.session,
            context.principal,
            title=request.title,
            visibility=request.visibility,
            project_id=request.project_id,
            idempotency_key=request.idempotency_key,
            digest=digest,
            session_id=request.session_id,
            runtime_header=request.runtime_header,
            events=[event.model_dump(mode="json") for event in request.events],
        )
    except SessionServiceError as error:
        _raise_http(error)
    if replay:
        response.status_code = status.HTTP_200_OK
    return result


@router.post("/{session_id}/authorize", status_code=status.HTTP_204_NO_CONTENT)
async def authorize_route(
    session_id: UUID,
    request: AuthorizeRequest,
    context: SessionContext = Depends(get_session_context),
) -> Response:
    _check_version(request.schema_version)
    try:
        await authorize_session(context.session, session_id, request.operation)
    except SessionServiceError as error:
        _raise_http(error)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{session_id}/open")
async def open_route(
    session_id: UUID,
    request: VersionedRequest,
    context: SessionContext = Depends(get_session_context),
) -> dict[str, Any]:
    _check_version(request.schema_version)
    try:
        return await open_session(context.session, session_id)
    except SessionServiceError as error:
        _raise_http(error)


@router.post("/{session_id}/events")
async def events_route(
    session_id: UUID,
    request: EventsRequest,
    context: SessionContext = Depends(get_session_context),
) -> dict[str, Any]:
    _check_version(request.schema_version)
    try:
        events = await read_events(
            context.session,
            session_id,
            after_sequence=request.after_sequence,
            limit=request.limit,
        )
    except SessionServiceError as error:
        _raise_http(error)
    return {"schema_version": 1, "events": events}


@router.post("/{session_id}/append")
async def append_route(
    session_id: UUID,
    request: AppendRequest,
    context: SessionContext = Depends(get_session_context),
) -> dict[str, Any]:
    _check_version(request.schema_version)
    _check_event_versions(request.events)
    body = request.model_dump(mode="json", exclude={"idempotency_key"})
    try:
        return await append_events(
            context.session,
            context.principal,
            session_id=session_id,
            expected_sequence=request.expected_sequence,
            events=[event.model_dump(mode="json") for event in request.events],
            idempotency_key=request.idempotency_key,
            digest=request_hash(body),
        )
    except SessionServiceError as error:
        _raise_http(error)


@router.post("/{session_id}/fork", status_code=status.HTTP_201_CREATED)
async def fork_route(
    session_id: UUID,
    request: ForkRequest,
    response: Response,
    context: SessionContext = Depends(get_session_context),
) -> dict[str, Any]:
    _check_version(request.schema_version)
    try:
        result, replay = await fork_session(
            context.session,
            context.principal,
            source_id=session_id,
            through_sequence=request.through_sequence,
            title=request.title,
            idempotency_key=request.idempotency_key,
            digest=request_hash(request.model_dump(mode="json", exclude={"idempotency_key"})),
        )
    except SessionServiceError as error:
        _raise_http(error)
    if replay:
        response.status_code = status.HTTP_200_OK
    return result


@router.post("/{session_id}/archive")
async def archive_route(
    session_id: UUID,
    request: ArchiveRequest,
    context: SessionContext = Depends(get_session_context),
) -> dict[str, Any]:
    _check_version(request.schema_version)
    try:
        return await archive_session(
            context.session,
            session_id,
            expected_version=request.expected_version,
        )
    except SessionServiceError as error:
        _raise_http(error)
