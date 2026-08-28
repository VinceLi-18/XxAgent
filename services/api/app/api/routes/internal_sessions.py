from collections.abc import Awaitable, Callable
import re
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.internal_auth import require_service_identity, require_user_token
from app.core.config import settings
from app.core.db import get_admin_session
from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.services.auth import AuthenticationRejected, Principal, introspect
from app.services.workbench import normalize_context
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
    write_append_admission_denial,
)


class _PrivateAppendRoute(APIRoute):
    """Redact private append sidecars from malformed-wire responses."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        handler = super().get_route_handler()

        async def closed_handler(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError:
                if request.url.path.endswith("/append"):
                    return JSONResponse(
                        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                        content={"detail": {"code": "invalid-request"}},
                    )
                raise

        return closed_handler


router = APIRouter(
    prefix="/internal/xagent/sessions",
    tags=["internal-sessions"],
    route_class=_PrivateAppendRoute,
)


class VersionedRequest(BaseModel):
    schema_version: int


class _CitationEventData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    draftSha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    reason: Literal[
        "citation-missing", "citation-malformed", "citation-unknown",
        "citation-revoked", "answer-too-large", "stream-invalid",
    ]
    invalidIds: list[str] = Field(max_length=64)
    allowedIds: list[str] = Field(max_length=64)

    @field_validator("invalidIds")
    @classmethod
    def validate_invalid_ids(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value) or any(
            not item or len(item) > 255 or any(ord(char) < 32 for char in item)
            for item in value
        ):
            raise ValueError("invalid citation diagnostic")
        return value

    @field_validator("allowedIds")
    @classmethod
    def validate_allowed_ids(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("duplicate citation id")
        for item in value:
            match = re.fullmatch(r"\[资料([1-9][0-9]*)\]", item)
            if match is None or int(match.group(1)) > 9007199254740991:
                raise ValueError("invalid citation id")
        return value


class CitationCorrectionData(_CitationEventData):
    invalidDraft: str

    @field_validator("invalidDraft")
    @classmethod
    def validate_draft(cls, value: str) -> str:
        try:
            size = len(value.encode("utf-8"))
        except UnicodeEncodeError as error:
            raise ValueError("invalid citation draft") from error
        if size > 8192:
            raise ValueError("citation draft too large")
        return value


class CitationFailureData(_CitationEventData):
    pass


class EventInput(BaseModel):
    event_type: str = Field(min_length=1, max_length=100)
    schema_version: int = Field(ge=1)
    payload: dict[str, Any]
    tool_call_id: str | None = Field(default=None, max_length=255)

    @model_validator(mode="before")
    @classmethod
    def validate_citation_input(cls, value: Any) -> Any:
        if isinstance(value, dict) and value.get("event_type") in {
            "xagent/citation-correction", "xagent/citation-failure",
        }:
            keys = set(value)
            if keys not in (
                {"event_type", "schema_version", "payload"},
                {"event_type", "schema_version", "payload", "tool_call_id"},
            ):
                raise ValueError("invalid citation event input")
        return value

    @model_validator(mode="after")
    def validate_citation_event(self) -> "EventInput":
        models = {
            "xagent/citation-correction": CitationCorrectionData,
            "xagent/citation-failure": CitationFailureData,
        }
        model = models.get(self.event_type)
        if model is None:
            return self
        if self.schema_version != 1 or self.tool_call_id is not None:
            raise ValueError("invalid citation event envelope")
        envelope = self.payload
        if set(envelope) != {"type", "seq", "time", "data"}:
            raise ValueError("invalid citation event payload")
        if envelope.get("type") != self.event_type:
            raise ValueError("citation event type mismatch")
        seq = envelope.get("seq")
        time = envelope.get("time")
        if isinstance(seq, bool) or not isinstance(seq, int) or seq < 0:
            raise ValueError("invalid citation event sequence")
        if isinstance(time, bool) or not isinstance(time, int) or time < 0:
            raise ValueError("invalid citation event time")
        model.model_validate(envelope.get("data"))
        return self


class RetrievalReceiptAttachment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_sequence: StrictInt = Field(ge=0)
    tool_call_id: str = Field(min_length=1, max_length=255)
    receipt: str = Field(min_length=1, max_length=1024, pattern=r"^[A-Za-z0-9_-]+$")
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class CreateSessionRequest(VersionedRequest):
    model_config = ConfigDict(extra="ignore")

    session_id: UUID | None = None
    runtime_header: dict[str, Any] | None = None
    title: str = Field(min_length=1, max_length=255)
    idempotency_key: str = Field(min_length=1, max_length=255)
    events: list[EventInput] = Field(default_factory=list, max_length=100)


class AppendRequest(VersionedRequest):
    model_config = ConfigDict(extra="forbid")

    expected_sequence: int = Field(ge=-1)
    idempotency_key: str = Field(min_length=1, max_length=255)
    events: list[EventInput] = Field(min_length=1, max_length=100)
    retrieval_receipts: list[RetrievalReceiptAttachment] = Field(
        default_factory=list,
        max_length=100,
    )


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


def _error_status(error: SessionServiceError) -> int:
    return {
        SessionErrorCode.NOT_FOUND: status.HTTP_404_NOT_FOUND,
        SessionErrorCode.SESSION_NOT_FOUND: status.HTTP_404_NOT_FOUND,
        SessionErrorCode.SEQUENCE_CONFLICT: status.HTTP_409_CONFLICT,
        SessionErrorCode.IDEMPOTENCY_CONFLICT: status.HTTP_409_CONFLICT,
        SessionErrorCode.UNSUPPORTED_VERSION: status.HTTP_400_BAD_REQUEST,
        SessionErrorCode.EVIDENCE_EXPIRED: status.HTTP_410_GONE,
        SessionErrorCode.EVIDENCE_CONFLICT: status.HTTP_409_CONFLICT,
        SessionErrorCode.SERVICE_UNAVAILABLE: status.HTTP_503_SERVICE_UNAVAILABLE,
    }[error.code]


def _raise_http(error: SessionServiceError) -> None:
    status_code = _error_status(error)
    raise HTTPException(status_code=status_code, detail={"code": error.code.value})


def _error_response(error: SessionServiceError) -> JSONResponse:
    return JSONResponse(
        status_code=_error_status(error),
        content={"detail": {"code": error.code.value}},
    )


def _check_version(version: int) -> None:
    try:
        require_protocol_version(version)
    except SessionServiceError as error:
        _raise_http(error)


def _check_event_versions(events: list[EventInput]) -> None:
    if any(event.schema_version != 1 for event in events):
        _raise_http(SessionServiceError(SessionErrorCode.UNSUPPORTED_VERSION))


def _is_retrieval_event(event: dict[str, Any]) -> bool:
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return False
    data = payload.get("data")
    if not isinstance(data, dict):
        return False
    meta = data.get("meta")
    return isinstance(meta, dict) and meta.get("kind") == "xagent-retrieval"


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
        workbench_context = await normalize_context(
            context.session,
            context.principal,
            None,
        )
        result, replay = await create_session(
            context.session,
            context.principal,
            title=request.title,
            visibility=(
                "project" if workbench_context.kind == "project" else "private"
            ),
            project_id=workbench_context.project_id,
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


@router.post("/{session_id}/append", response_model=None)
async def append_route(
    session_id: UUID,
    request: AppendRequest,
    context: SessionContext = Depends(get_session_context),
) -> dict[str, Any] | JSONResponse:
    _check_version(request.schema_version)
    _check_event_versions(request.events)
    body = request.model_dump(mode="json", exclude={"idempotency_key"})
    events = [event.model_dump(mode="json") for event in request.events]
    attachments = [
        attachment.model_dump(mode="json")
        for attachment in request.retrieval_receipts
    ]
    retrieval_append = bool(attachments) or any(_is_retrieval_event(event) for event in events)
    try:
        async with context.session.begin_nested():
            return await append_events(
                context.session,
                context.principal,
                session_id=session_id,
                expected_sequence=request.expected_sequence,
                events=events,
                retrieval_receipts=attachments,
                idempotency_key=request.idempotency_key,
                digest=request_hash(body),
            )
    except SessionServiceError as error:
        if retrieval_append:
            try:
                await write_append_admission_denial(
                    context.session,
                    context.principal,
                    session_id=session_id,
                    attachments=attachments,
                    result=error.code.value,
                )
            except Exception:
                return _error_response(
                    SessionServiceError(SessionErrorCode.SERVICE_UNAVAILABLE)
                )
        return _error_response(error)
    except SQLAlchemyError:
        error = SessionServiceError(SessionErrorCode.SERVICE_UNAVAILABLE)
        if retrieval_append:
            try:
                await write_append_admission_denial(
                    context.session,
                    context.principal,
                    session_id=session_id,
                    attachments=attachments,
                    result=error.code.value,
                )
            except Exception:
                pass
        return _error_response(error)
    except Exception:
        error = SessionServiceError(SessionErrorCode.SERVICE_UNAVAILABLE)
        if retrieval_append:
            try:
                await write_append_admission_denial(
                    context.session,
                    context.principal,
                    session_id=session_id,
                    attachments=attachments,
                    result=error.code.value,
                )
            except Exception:
                pass
        return _error_response(error)


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
