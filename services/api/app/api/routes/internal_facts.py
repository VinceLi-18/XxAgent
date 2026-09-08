"""Authenticated internal routes for governed Fact operations."""

import asyncio
from collections.abc import Awaitable, Callable
from time import monotonic
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, Request, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.internal_auth import require_user_token
from app.api.routes.internal_sessions import SessionContext, get_session_context
from app.core.config import settings
from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.facts import FactProposal
from app.schemas.facts import (
    FactApproveRequest,
    FactHeadPageResponse,
    FactOutboxPageRequest,
    FactOutboxPageResponse,
    FactPageRequest,
    FactPrepareRequest,
    FactPrepareResponse,
    FactProposalDetailResponse,
    FactProposalDecisionResponse,
    FactProposalPageResponse,
    FactRejectRequest,
    FactRevisionDetailResponse,
    FactVersionedRequest,
    FactWithdrawRequest,
)
from app.services.audit import fact_audit_details, write_audit_event
from app.services.fact_validation import canonical_sha256
from app.services.facts import (
    FactErrorCode,
    FactProposalDecision,
    FactServiceError,
    approve_fact_proposal,
    get_fact_proposal,
    get_fact_revision,
    list_fact_heads,
    list_fact_proposals,
    pull_fact_outbox,
    prepare_fact,
    reject_fact_proposal,
    visible_fact_session,
    withdraw_fact_proposal,
)
from app.services.auth import AuthenticationRejected, Principal, introspect
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
        "fact-revision-conflict": status.HTTP_409_CONFLICT,
        "fact-already-decided": status.HTTP_409_CONFLICT,
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
        "fact-revision-conflict",
        "fact-already-decided",
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


async def _audit_cancellation(
    context: SessionContext,
    request: FactPrepareRequest,
    *,
    started: float,
) -> None:
    bind = context.session.bind
    if bind is None:
        return
    async with AsyncSession(bind, expire_on_commit=False) as audit_session:
        async with audit_session.begin():
            role = bind.dialect.identifier_preparer.quote(settings.POSTGRES_APP_USER)
            await audit_session.execute(text(f"SET LOCAL ROLE {role}"))
            await set_actor_context(
                audit_session,
                Actor(id=context.principal.actor_id, role=context.principal.role),
            )
            await write_audit_event(
                audit_session,
                context.principal.actor_id,
                "fact.cancel",
                "xagent_session",
                request.session_id,
                uuid4(),
                "cancelled",
                details=fact_audit_details(
                    session_id=request.session_id,
                    tool_call_id=request.tool_call_id,
                    operation="prepare",
                    request_sha256=canonical_sha256(
                        request.model_dump(mode="json", exclude={"idempotency_key"})
                    ),
                    permission_revision=request.permission_revision,
                    evidence_count=len(request.evidence_ids),
                    result="cancelled",
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
    except asyncio.CancelledError:
        try:
            await _audit_cancellation(context, request, started=started)
        except Exception as cancellation_audit_failure:
            # The original cancellation remains authoritative if its audit cannot commit.
            del cancellation_audit_failure
        raise
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


@router.post(
    "/projects/{project_id}/heads/list",
    response_model=FactHeadPageResponse,
)
async def list_heads_route(
    project_id: UUID,
    request: FactPageRequest,
    context: SessionContext = Depends(get_session_context),
) -> FactHeadPageResponse | JSONResponse:
    """Return one current-Fact page for an authorized project member."""
    try:
        result = await list_fact_heads(
            context.session,
            project_id=project_id,
            limit=request.limit,
            cursor=request.cursor,
        )
        return FactHeadPageResponse.model_validate(result)
    except FactServiceError as error:
        return _error(error.code.value)


@router.post(
    "/projects/{project_id}/proposals/list",
    response_model=FactProposalPageResponse,
)
async def list_proposals_route(
    project_id: UUID,
    request: FactPageRequest,
    context: SessionContext = Depends(get_session_context),
) -> FactProposalPageResponse | JSONResponse:
    """Return one public proposal page for an authorized project member."""
    try:
        result = await list_fact_proposals(
            context.session,
            project_id=project_id,
            limit=request.limit,
            cursor=request.cursor,
        )
        return FactProposalPageResponse.model_validate(result)
    except FactServiceError as error:
        return _error(error.code.value)


@router.post(
    "/revisions/{revision_id}",
    response_model=FactRevisionDetailResponse,
)
async def revision_detail_route(
    revision_id: UUID,
    _request: FactVersionedRequest,
    context: SessionContext = Depends(get_session_context),
) -> FactRevisionDetailResponse | JSONResponse:
    """Return one immutable revision and its field history."""
    try:
        return FactRevisionDetailResponse.model_validate(
            await get_fact_revision(context.session, revision_id)
        )
    except FactServiceError as error:
        return _error(error.code.value)


@router.post(
    "/proposals/{proposal_id}",
    response_model=FactProposalDetailResponse,
)
async def proposal_detail_route(
    proposal_id: UUID,
    _request: FactVersionedRequest,
    context: SessionContext = Depends(get_session_context),
) -> FactProposalDetailResponse | JSONResponse:
    """Return one admitted proposal without preparation secrets."""
    try:
        return FactProposalDetailResponse.model_validate(
            await get_fact_proposal(context.session, proposal_id)
        )
    except FactServiceError as error:
        return _error(error.code.value)


@router.post(
    "/sessions/{session_id}/outbox/pull",
    response_model=FactOutboxPageResponse,
)
async def pull_outbox_route(
    session_id: UUID,
    request: FactOutboxPageRequest,
    context: SessionContext = Depends(get_session_context),
) -> FactOutboxPageResponse | JSONResponse:
    """Return one stable page of unconsumed decisions for a visible Session."""
    try:
        response = FactOutboxPageResponse.model_validate(await pull_fact_outbox(
            context.session,
            actor_id=context.principal.actor_id,
            session_id=session_id,
            limit=request.limit,
            cursor=request.cursor,
        ))
        payload = response.model_dump(mode="json", exclude_none=True)
        payload["next_cursor"] = response.next_cursor
        return JSONResponse(content=jsonable_encoder(payload))
    except FactServiceError as error:
        return _error(error.code.value)


async def _serializable_decision(
    context: SessionContext,
    user_token: str,
    operation: Callable[[AsyncSession, Principal], Awaitable[FactProposalDecision]],
) -> FactProposalDecision:
    bind = context.session.bind
    if bind is None:
        raise FactServiceError(FactErrorCode.SERVICE_UNAVAILABLE)
    for attempt in range(3):
        try:
            async with AsyncSession(bind, expire_on_commit=False) as decision_session:
                async with decision_session.begin():
                    await decision_session.execute(
                        text("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
                    )
                    principal = await introspect(
                        user_token,
                        decision_session,
                        update_verification=False,
                    )
                    role = bind.dialect.identifier_preparer.quote(
                        settings.POSTGRES_APP_USER
                    )
                    await decision_session.execute(text(f"SET LOCAL ROLE {role}"))
                    await set_actor_context(
                        decision_session,
                        Actor(id=principal.actor_id, role=principal.role),
                    )
                    result = await operation(decision_session, principal)
            return result
        except AuthenticationRejected:
            raise FactServiceError(FactErrorCode.STALE_PERMISSION) from None
        except DBAPIError as error:
            sqlstate = getattr(error.orig, "sqlstate", None)
            if sqlstate == "40001" and attempt < 2:
                continue
            raise
    raise FactServiceError(FactErrorCode.SERVICE_UNAVAILABLE)


async def _audit_decision_denial(
    context: SessionContext,
    *,
    proposal_id: UUID,
    operation: str,
    request_sha256: str,
    result: str,
    started: float,
) -> None:
    await write_audit_event(
        context.session,
        context.principal.actor_id,
        "fact.authorization_denied",
        "fact_proposal",
        proposal_id,
        uuid4(),
        result,
        details=fact_audit_details(
            proposal_id=proposal_id,
            operation=operation,
            request_sha256=request_sha256,
            permission_revision=context.principal.permission_revision,
            result=result,
            latency_ms=max(0, int((monotonic() - started) * 1000)),
        ),
    )


async def _audit_decision_cancellation(
    context: SessionContext,
    *,
    proposal_id: UUID,
    operation: str,
    request_sha256: str,
    started: float,
) -> None:
    """Persist cancellation evidence outside the rolled-back decision transaction."""
    bind = context.session.bind
    if bind is None:
        return
    async with AsyncSession(bind, expire_on_commit=False) as audit_session:
        async with audit_session.begin():
            role = bind.dialect.identifier_preparer.quote(settings.POSTGRES_APP_USER)
            await audit_session.execute(text(f"SET LOCAL ROLE {role}"))
            await set_actor_context(
                audit_session,
                Actor(
                    id=context.principal.actor_id,
                    role=context.principal.role,
                ),
            )
            proposal = await audit_session.scalar(
                select(FactProposal).where(FactProposal.id == proposal_id)
            )
            await write_audit_event(
                audit_session,
                context.principal.actor_id,
                "fact.cancel",
                "fact_proposal" if proposal is not None else "xagent_session",
                proposal.id if proposal is not None else proposal_id,
                uuid4(),
                "cancelled",
                details=fact_audit_details(
                    project_id=proposal.project_id if proposal is not None else None,
                    session_id=(
                        proposal.source_session_id if proposal is not None else None
                    ),
                    proposal_id=proposal.id if proposal is not None else None,
                    operation=operation,
                    request_sha256=request_sha256,
                    permission_revision=context.principal.permission_revision,
                    result="cancelled",
                    status=proposal.status if proposal is not None else None,
                    latency_ms=max(0, int((monotonic() - started) * 1000)),
                ),
            )


async def _decision_route_result(
    context: SessionContext,
    user_token: str,
    *,
    proposal_id: UUID,
    operation_name: str,
    request_sha256: str,
    operation: Callable[[AsyncSession, Principal], Awaitable[FactProposalDecision]],
) -> FactProposalDecisionResponse | JSONResponse:
    started = monotonic()
    try:
        result = await _serializable_decision(context, user_token, operation)
    except asyncio.CancelledError:
        try:
            await _audit_decision_cancellation(
                context,
                proposal_id=proposal_id,
                operation=operation_name,
                request_sha256=request_sha256,
                started=started,
            )
        except Exception as cancellation_audit_failure:
            # The original cancellation remains authoritative if its audit cannot commit.
            del cancellation_audit_failure
        raise
    except FactServiceError as error:
        if error.code in {FactErrorCode.NOT_FOUND, FactErrorCode.STALE_PERMISSION}:
            try:
                await _audit_decision_denial(
                    context,
                    proposal_id=proposal_id,
                    operation=operation_name,
                    request_sha256=request_sha256,
                    result=error.code.value,
                    started=started,
                )
            except Exception:
                return _error(FactErrorCode.SERVICE_UNAVAILABLE.value)
        return _error(error.code.value)
    except Exception:
        return _error(FactErrorCode.SERVICE_UNAVAILABLE.value)
    if result.status == "conflicted":
        return _error(FactErrorCode.FACT_REVISION_CONFLICT.value)
    return FactProposalDecisionResponse.model_validate(result.payload())


@router.post(
    "/proposals/{proposal_id}/approve",
    response_model=FactProposalDecisionResponse,
    response_model_exclude_none=True,
)
async def approve_route(
    proposal_id: UUID,
    request: FactApproveRequest,
    context: SessionContext = Depends(get_session_context),
    user_token: str = Depends(require_user_token),
) -> FactProposalDecisionResponse | JSONResponse:
    """Approve or revision-conflict one proposal in a serializable transaction."""
    request_sha256 = canonical_sha256({
        "schema_version": 1,
        "operation": "approve",
        "proposal_id": str(proposal_id),
        "decision_reason": request.decision_note,
    })
    return await _decision_route_result(
        context,
        user_token,
        proposal_id=proposal_id,
        operation_name="approve",
        request_sha256=request_sha256,
        operation=lambda session, principal: approve_fact_proposal(
            session,
            actor=principal,
            proposal_id=proposal_id,
            decision_note=request.decision_note,
            idempotency_key=request.idempotency_key,
        ),
    )


@router.post(
    "/proposals/{proposal_id}/reject",
    response_model=FactProposalDecisionResponse,
    response_model_exclude_none=True,
)
async def reject_route(
    proposal_id: UUID,
    request: FactRejectRequest,
    context: SessionContext = Depends(get_session_context),
    user_token: str = Depends(require_user_token),
) -> FactProposalDecisionResponse | JSONResponse:
    """Reject one pending proposal under current manager membership."""
    request_sha256 = canonical_sha256({
        "schema_version": 1,
        "operation": "reject",
        "proposal_id": str(proposal_id),
        "decision_reason": request.reason,
    })
    return await _decision_route_result(
        context,
        user_token,
        proposal_id=proposal_id,
        operation_name="reject",
        request_sha256=request_sha256,
        operation=lambda session, principal: reject_fact_proposal(
            session,
            actor=principal,
            proposal_id=proposal_id,
            reason=request.reason,
            idempotency_key=request.idempotency_key,
        ),
    )


@router.post(
    "/proposals/{proposal_id}/withdraw",
    response_model=FactProposalDecisionResponse,
    response_model_exclude_none=True,
)
async def withdraw_route(
    proposal_id: UUID,
    request: FactWithdrawRequest,
    context: SessionContext = Depends(get_session_context),
    user_token: str = Depends(require_user_token),
) -> FactProposalDecisionResponse | JSONResponse:
    """Withdraw only the current proposer's pending proposal."""
    request_sha256 = canonical_sha256({
        "schema_version": 1,
        "operation": "withdraw",
        "proposal_id": str(proposal_id),
        "decision_reason": None,
    })
    return await _decision_route_result(
        context,
        user_token,
        proposal_id=proposal_id,
        operation_name="withdraw",
        request_sha256=request_sha256,
        operation=lambda session, principal: withdraw_fact_proposal(
            session,
            actor=principal,
            proposal_id=proposal_id,
            idempotency_key=request.idempotency_key,
        ),
    )
