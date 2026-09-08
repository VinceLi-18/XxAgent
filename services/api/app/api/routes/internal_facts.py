"""Authenticated internal routes for governed Fact operations."""

from collections.abc import Awaitable, Callable
from time import monotonic
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.internal_sessions import SessionContext, get_session_context
from app.core.config import settings
from app.schemas.facts import FactPrepareRequest, FactPrepareResponse
from app.services.audit import fact_audit_details, write_audit_event
from app.services.fact_validation import canonical_sha256
from app.services.facts import (
    FactErrorCode,
    FactServiceError,
    prepare_fact,
    visible_fact_session,
)
from app.services.retrieval_delegation import (
    DelegationError,
    DelegationExpectation,
    consume_delegation_nonce,
    decode_and_validate_delegation,
    delegation_public_key,
)

MAX_FACT_BODY_BYTES = 64 * 1024


def _error(code: str) -> JSONResponse:
    status_code = {
        "fact-input-invalid": status.HTTP_422_UNPROCESSABLE_CONTENT,
        "fact-evidence-invalid": status.HTTP_422_UNPROCESSABLE_CONTENT,
        "fact-session-invalid": status.HTTP_409_CONFLICT,
        "fact-receipt-invalid": status.HTTP_409_CONFLICT,
        "fact-receipt-expired": status.HTTP_410_GONE,
        "not-found": status.HTTP_404_NOT_FOUND,
        "stale-permission": status.HTTP_409_CONFLICT,
        "idempotency-conflict": status.HTTP_409_CONFLICT,
    }.get(code, status.HTTP_503_SERVICE_UNAVAILABLE)
    stable_codes = {
        "fact-input-invalid",
        "fact-evidence-invalid",
        "fact-session-invalid",
        "fact-receipt-invalid",
        "fact-receipt-expired",
        "not-found",
        "stale-permission",
        "idempotency-conflict",
    }
    stable_code = code if code in stable_codes else "service-unavailable"
    return JSONResponse(status_code=status_code, content={"detail": {"code": stable_code}})


class _ClosedFactRoute(APIRoute):
    """Bound request bodies and map malformed Fact wire values to one stable error."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        handler = super().get_route_handler()

        async def closed_handler(request: Request) -> Response:
            try:
                declared = request.headers.get("content-length")
                if declared is not None:
                    try:
                        declared_size = int(declared)
                    except ValueError:
                        return _error("fact-input-invalid")
                    if declared_size < 0 or declared_size > MAX_FACT_BODY_BYTES:
                        return _error("fact-input-invalid")
                body = bytearray()
                async for chunk in request.stream():
                    if len(body) + len(chunk) > MAX_FACT_BODY_BYTES:
                        return _error("fact-input-invalid")
                    body.extend(chunk)

                async def receive() -> dict[str, object]:
                    return {"type": "http.request", "body": bytes(body), "more_body": False}

                return await handler(Request(request.scope, receive))
            except RequestValidationError:
                return _error("fact-input-invalid")

        return closed_handler


router = APIRouter(
    prefix="/internal/xagent/facts",
    tags=["internal-facts"],
    route_class=_ClosedFactRoute,
)


async def _verify_delegation(
    token: str | None,
    *,
    context: SessionContext,
    request: FactPrepareRequest,
    project_id: UUID,
) -> None:
    claims = decode_and_validate_delegation(
        token,
        DelegationExpectation(
            actor_id=context.principal.actor_id,
            session_id=request.session_id,
            project_id=project_id,
            tool_call_id=request.tool_call_id,
            tool_name="propose_fact",
            permission_revision=context.principal.permission_revision,
        ),
        public_key=delegation_public_key(settings.XAGENT_DELEGATION_PUBLIC_KEY),
        issuer=settings.XAGENT_DELEGATION_ISSUER,
        audience=settings.XAGENT_DELEGATION_AUDIENCE,
    )
    bind = context.session.bind
    if bind is None:
        raise DelegationError
    async with AsyncSession(bind, expire_on_commit=False) as nonce_session:
        async with nonce_session.begin():
            await consume_delegation_nonce(
                nonce_session,
                actor_id=context.principal.actor_id,
                claims=claims,
            )


async def _audit_denial(
    context: SessionContext,
    request: FactPrepareRequest,
    *,
    result: str,
    started: float,
) -> None:
    await write_audit_event(
        context.session,
        context.principal.actor_id,
        "fact.authorization_denied",
        "xagent_session",
        request.session_id,
        uuid4(),
        result,
        details=fact_audit_details(
            session_id=request.session_id,
            tool_call_id=request.tool_call_id,
            operation="prepare",
            request_sha256=canonical_sha256(
                request.model_dump(mode="json", exclude={"idempotency_key"})
            ),
            permission_revision=request.permission_revision,
            evidence_count=len(request.evidence_ids),
            result=result,
            latency_ms=max(0, int((monotonic() - started) * 1000)),
        ),
    )


@router.post("/proposals/prepare", response_model=FactPrepareResponse)
async def prepare_route(
    request: FactPrepareRequest,
    context: SessionContext = Depends(get_session_context),
    delegation_token: str | None = Header(default=None, alias="X-XAgent-Delegation"),
) -> FactPrepareResponse | JSONResponse:
    started = monotonic()
    try:
        if request.permission_revision != context.principal.permission_revision:
            raise FactServiceError(FactErrorCode.STALE_PERMISSION)
        session_item = await visible_fact_session(
            context.session,
            context.principal.actor_id,
            request.session_id,
        )
        assert session_item.project_id is not None
        await _verify_delegation(
            delegation_token,
            context=context,
            request=request,
            project_id=session_item.project_id,
        )
        async with context.session.begin_nested():
            return await prepare_fact(context.session, context.principal, request)
    except DelegationError:
        error = FactServiceError(FactErrorCode.NOT_FOUND)
    except FactServiceError as caught:
        error = caught
    except Exception:
        return _error(FactErrorCode.SERVICE_UNAVAILABLE.value)
    if error.code in {FactErrorCode.NOT_FOUND, FactErrorCode.STALE_PERMISSION}:
        try:
            await _audit_denial(
                context,
                request,
                result=error.code.value,
                started=started,
            )
        except Exception:
            return _error(FactErrorCode.SERVICE_UNAVAILABLE.value)
    return _error(error.code.value)
