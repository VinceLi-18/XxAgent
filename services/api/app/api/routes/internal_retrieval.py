"""Authenticated internal routes for project discovery, retrieval, and citations."""

import hashlib
import time
from collections.abc import Awaitable, Callable
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.internal_auth import require_service_identity, require_user_token
from app.api.routes.internal_sessions import SessionContext
from app.core.config import settings
from app.core.db import get_admin_session
from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.xagent_session import XAgentSession
from app.retrieval.embedding_client import EmbeddingClient, RetrievalUnavailableError
from app.schemas.retrieval import (
    CitationAuthorizeRequest,
    CitationAuthorizeResponse,
    CitationResolveRequest,
    CitationResolveResponse,
    CitationResult,
    ProjectDiscoveryRequest,
    ProjectDiscoveryResponse,
    ProjectResult,
    SearchRequest,
    SearchResponse,
)
from app.services.audit import retrieval_audit_details, write_audit_event
from app.services.auth import AuthenticationRejected, introspect
from app.services.retrieval import (
    RetrievalCandidate,
    RetrievalError,
    authorize_session_citations,
    hybrid_search,
    list_accessible_projects,
    load_retrieval_session,
    payload_sha256,
    reserve_citation_ordinals,
    resolve_scope,
    scope_sha256,
)
from app.services.retrieval_receipts import ReceiptClaims, new_receipt_times, persist_receipt
from app.services.retrieval_delegation import (
    DelegationError,
    DelegationExpectation,
    consume_delegation_nonce,
    decode_and_validate_delegation,
    delegation_public_key,
)


MAX_RETRIEVAL_BODY_BYTES = 64 * 1024


class _ClosedRetrievalRoute(APIRoute):
    """Map malformed or unknown internal wire fields to the closed protocol error."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        handler = super().get_route_handler()

        async def closed_handler(request: Request) -> Response:
            try:
                declared = request.headers.get("content-length")
                if declared is not None:
                    try:
                        declared_size = int(declared)
                    except ValueError:
                        return _error("service-unavailable")
                    if declared_size < 0 or declared_size > MAX_RETRIEVAL_BODY_BYTES:
                        return _error("service-unavailable")
                body = bytearray()
                async for chunk in request.stream():
                    body.extend(chunk)
                    if len(body) > MAX_RETRIEVAL_BODY_BYTES:
                        return _error("service-unavailable")
                async def receive() -> dict[str, object]:
                    return {
                        "type": "http.request",
                        "body": bytes(body),
                        "more_body": False,
                    }

                return await handler(Request(request.scope, receive))
            except RequestValidationError:
                return _error("service-unavailable")

        return closed_handler


router = APIRouter(
    prefix="/internal/xagent/retrieval",
    tags=["internal-retrieval"],
    route_class=_ClosedRetrievalRoute,
)


async def get_retrieval_context(
    _: None = Depends(require_service_identity),
    token: str = Depends(require_user_token),
    session: AsyncSession = Depends(get_admin_session),
) -> SessionContext:
    """Authenticate retrieval inside one serializable authorization snapshot."""
    await session.execute(text("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"))
    try:
        principal = await introspect(token, session)
    except AuthenticationRejected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthenticated"},
        ) from None
    role = session.get_bind().dialect.identifier_preparer.quote(settings.POSTGRES_APP_USER)
    await session.execute(text(f"SET LOCAL ROLE {role}"))
    await set_actor_context(session, Actor(id=principal.actor_id, role=principal.role))
    return SessionContext(principal, session)


def _error(code: str) -> JSONResponse:
    status_code = {
        "invalid-retrieval-scope": status.HTTP_400_BAD_REQUEST,
        "retrieval-unavailable": status.HTTP_503_SERVICE_UNAVAILABLE,
        "evidence-expired": status.HTTP_409_CONFLICT,
        "evidence-conflict": status.HTTP_409_CONFLICT,
        "citation-invalid": status.HTTP_422_UNPROCESSABLE_CONTENT,
        "service-unavailable": status.HTTP_503_SERVICE_UNAVAILABLE,
    }.get(code, status.HTTP_503_SERVICE_UNAVAILABLE)
    stable_code = code if code in {
        "invalid-retrieval-scope", "retrieval-unavailable",
        "evidence-expired", "evidence-conflict", "citation-invalid",
    } else "service-unavailable"
    return JSONResponse(status_code=status_code, content={"detail": {"code": stable_code}})


def _check_revision(request_revision: int, context: SessionContext) -> None:
    if request_revision != context.principal.permission_revision:
        raise RetrievalError("service-unavailable")


async def _verify_delegation(
    token: str | None,
    *,
    context: SessionContext,
    session_item: XAgentSession,
    session_id: UUID,
    tool_call_id: str,
    tool_name: str,
) -> None:
    claims = decode_and_validate_delegation(
        token,
        DelegationExpectation(
            actor_id=context.principal.actor_id,
            session_id=session_id,
            project_id=session_item.project_id if session_item.visibility == "project" else None,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
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
                nonce_session, actor_id=context.principal.actor_id, claims=claims
            )


async def _write_retrieval_audit(
    context: SessionContext,
    *,
    action: str,
    session_id: UUID,
    tool_call_id: str,
    result: str,
    project_scope_sha256: str = "0" * 64,
    query_sha256: str = "0" * 64,
    candidate_count: int = 0,
    returned_count: int = 0,
    latency_ms: int = 0,
    evidence: list[dict[str, object]] | None = None,
) -> None:
    await write_audit_event(
        context.session,
        context.principal.actor_id,
        action,
        "xagent_session",
        session_id,
        uuid4(),
        result,
        executor_kind="account",
        details=retrieval_audit_details(
            session_id=str(session_id),
            tool_call_id=tool_call_id,
            project_scope_sha256=project_scope_sha256,
            query_sha256=query_sha256,
            candidate_count=candidate_count,
            returned_count=returned_count,
            result=result,
            latency_ms=latency_ms,
            evidence=evidence,
        ),
    )


async def _write_isolated_failure_audit(
    context: SessionContext,
    *,
    action: str,
    session_id: UUID,
    tool_call_id: str,
    result: str,
    started: float,
) -> None:
    """Persist a redacted denial after the operation transaction is unusable."""
    bind = context.session.bind
    if bind is None:
        return
    async with AsyncSession(bind, expire_on_commit=False) as audit_session:
        async with audit_session.begin():
            await write_audit_event(
                audit_session,
                context.principal.actor_id,
                action,
                "xagent_session",
                session_id,
                uuid4(),
                result,
                details=retrieval_audit_details(
                    session_id=str(session_id),
                    tool_call_id=tool_call_id,
                    project_scope_sha256="0" * 64,
                    query_sha256="0" * 64,
                    candidate_count=0,
                    returned_count=0,
                    result=result,
                    latency_ms=max(0, int((time.monotonic() - started) * 1000)),
                ),
            )


@router.post("/projects", response_model=ProjectDiscoveryResponse)
async def projects_route(
    request: ProjectDiscoveryRequest,
    context: SessionContext = Depends(get_retrieval_context),
    delegation_token: str | None = Header(default=None, alias="X-XAgent-Delegation"),
) -> ProjectDiscoveryResponse | JSONResponse:
    started = time.monotonic()
    try:
        _check_revision(request.permission_revision, context)
        session_item = await load_retrieval_session(
            context.session, context.principal.actor_id, request.session_id, lock=True
        )
        await _verify_delegation(
            delegation_token, context=context, session_item=session_item,
            session_id=request.session_id, tool_call_id=request.tool_call_id,
            tool_name="list_accessible_projects",
        )
        if session_item.visibility != "private":
            raise RetrievalError("invalid-retrieval-scope")
        projects = await list_accessible_projects(context.session, query=request.query)
        public_projects = [
            {"project_id": str(item["project_id"]), "name": item["name"]}
            for item in projects
        ]
        digest = payload_sha256({"schema_version": 1, "projects": public_projects})
        issued_at, expires_at = new_receipt_times()
        receipt = await persist_receipt(
            context.session,
            ReceiptClaims(
                kind="project_discovery",
                actor_id=context.principal.actor_id,
                session_id=request.session_id,
                tool_call_id=request.tool_call_id,
                query_sha256=hashlib.sha256((request.query or "").encode()).hexdigest(),
                scope={
                    "kind": "private", "project_ids": [], "include_private": False,
                    "sha256": hashlib.sha256(b"private-project-discovery").hexdigest(),
                },
                permission_revision=context.principal.permission_revision,
                project_ids=tuple(item["project_id"] for item in projects),
                index_generations=(),
                chunk_ids=(),
                payload_sha256=digest,
                issued_at=issued_at,
                expires_at=expires_at,
                citation_ordinal_start=None,
                citation_ordinal_end=None,
            ),
        )
        await _write_retrieval_audit(
            context, action="retrieval.project_discovery", session_id=request.session_id,
            tool_call_id=request.tool_call_id, result="allowed",
            project_scope_sha256=hashlib.sha256(b"private-project-discovery").hexdigest(),
            query_sha256=hashlib.sha256((request.query or "").encode()).hexdigest(),
            candidate_count=len(projects), returned_count=len(projects),
            latency_ms=max(0, int((time.monotonic() - started) * 1000)),
        )
        return ProjectDiscoveryResponse(
            projects=[ProjectResult(**item) for item in projects],
            receipt=receipt,
            payload_sha256=digest,
        )
    except (DelegationError, RetrievalError) as error:
        await _write_retrieval_audit(
            context, action="retrieval.project_discovery", session_id=request.session_id,
            tool_call_id=request.tool_call_id, result=error.code,
            latency_ms=max(0, int((time.monotonic() - started) * 1000)),
        )
        return _error(error.code)
    except Exception:
        await context.session.rollback()
        await _write_isolated_failure_audit(
            context, action="retrieval.project_discovery", session_id=request.session_id,
            tool_call_id=request.tool_call_id, result="service-unavailable", started=started,
        )
        return _error("service-unavailable")


@router.post("/search", response_model=SearchResponse)
async def search_route(
    request: SearchRequest,
    context: SessionContext = Depends(get_retrieval_context),
    delegation_token: str | None = Header(default=None, alias="X-XAgent-Delegation"),
) -> SearchResponse | JSONResponse:
    started = time.monotonic()
    try:
        _check_revision(request.permission_revision, context)
        session_item = await load_retrieval_session(
            context.session, context.principal.actor_id, request.session_id, lock=True
        )
        await _verify_delegation(
            delegation_token, context=context, session_item=session_item,
            session_id=request.session_id, tool_call_id=request.tool_call_id,
            tool_name="search_artifacts",
        )
        scope = await resolve_scope(
            context.session,
            actor_id=context.principal.actor_id,
            session_item=session_item,
            project_ids=request.project_ids,
            include_private=request.include_private,
        )
        async with httpx.AsyncClient(
            base_url=settings.EMBEDDING_URL,
            timeout=settings.EMBEDDING_TIMEOUT,
        ) as http_client:
            candidates, candidate_count = await hybrid_search(
                context.session,
                EmbeddingClient(http_client),
                query=request.query,
                scope=scope,
                citation_ordinal_start=session_item.next_citation_ordinal,
            )
        ordinal_start = (
            await reserve_citation_ordinals(
                context.session, request.session_id, len(candidates)
            )
            if candidates
            else None
        )
        citation_base = ordinal_start if ordinal_start is not None else 1
        citations = [
            CitationResult(
                id=f"[资料{citation_base + offset}]",
                artifact_id=item.artifact_id,
                version_id=item.version_id,
                chunk_id=item.chunk_id,
                display_name=item.filename,
                version_number=item.version_number,
                line_start=item.line_start,
                line_end=item.line_end,
                text=item.text,
                scope="project" if item.project_id is not None else "private",
            )
            for offset, item in enumerate(candidates)
        ]
        public_citations = [item.model_dump(mode="json") for item in citations]
        digest = payload_sha256({"schema_version": 1, "citations": public_citations})
        issued_at, expires_at = new_receipt_times()
        receipt = await persist_receipt(
            context.session,
            ReceiptClaims(
                kind="artifact_search",
                actor_id=context.principal.actor_id,
                session_id=request.session_id,
                tool_call_id=request.tool_call_id,
                query_sha256=hashlib.sha256(request.query.encode()).hexdigest(),
                scope={
                    **scope.public_value(session_item.visibility),
                    "sha256": scope_sha256(scope, session_item.visibility),
                },
                permission_revision=context.principal.permission_revision,
                project_ids=scope.project_ids,
                index_generations=tuple(
                    {
                        item.index_id: {
                            "index_id": str(item.index_id),
                            "generation": item.generation,
                        }
                        for item in candidates
                    }.values()
                ),
                chunk_ids=tuple(item.chunk_id for item in candidates),
                payload_sha256=digest,
                issued_at=issued_at,
                expires_at=expires_at,
                citation_ordinal_start=ordinal_start,
                citation_ordinal_end=(ordinal_start + len(citations) - 1) if ordinal_start else None,
            ),
        )
        await _write_retrieval_audit(
            context, action="retrieval.search", session_id=request.session_id,
            tool_call_id=request.tool_call_id, result="allowed",
            project_scope_sha256=scope_sha256(scope, session_item.visibility),
            query_sha256=hashlib.sha256(request.query.encode()).hexdigest(),
            candidate_count=candidate_count, returned_count=len(citations),
            latency_ms=max(0, int((time.monotonic() - started) * 1000)),
            evidence=[
                {
                    "artifact_id": str(item.artifact_id),
                    "version_id": str(item.version_id),
                    "index_id": str(item.index_id),
                    "generation": item.generation,
                    "chunk_id": str(item.chunk_id),
                }
                for item in candidates
            ],
        )
        return SearchResponse(citations=citations, receipt=receipt, payload_sha256=digest)
    except (DelegationError, RetrievalError, RetrievalUnavailableError) as error:
        code = error.code
        await _write_retrieval_audit(
            context, action="retrieval.search", session_id=request.session_id,
            tool_call_id=request.tool_call_id, result=code,
            latency_ms=max(0, int((time.monotonic() - started) * 1000)),
        )
        return _error(code)
    except Exception:
        await context.session.rollback()
        await _write_isolated_failure_audit(
            context, action="retrieval.search", session_id=request.session_id,
            tool_call_id=request.tool_call_id, result="retrieval-unavailable", started=started,
        )
        return _error("retrieval-unavailable")


async def _authorized_citations(
    request: CitationAuthorizeRequest | CitationResolveRequest,
    context: SessionContext,
    delegation_token: str | None,
    tool_name: str,
) -> list[RetrievalCandidate]:
    _check_revision(request.permission_revision, context)
    session_item = await load_retrieval_session(
        context.session, context.principal.actor_id, request.session_id
    )
    await _verify_delegation(
        delegation_token, context=context, session_item=session_item,
        session_id=request.session_id, tool_call_id=request.tool_call_id,
        tool_name=tool_name,
    )
    identities = [
        (item.id, item.artifact_id, item.version_id, item.chunk_id)
        for item in (request.citations if hasattr(request, "citations") else [request.citation])
    ]
    return await authorize_session_citations(
        context.session,
        actor_id=context.principal.actor_id,
        session_id=request.session_id,
        citations=identities,
    )


@router.post("/citations/authorize", response_model=CitationAuthorizeResponse)
async def authorize_citations_route(
    request: CitationAuthorizeRequest,
    context: SessionContext = Depends(get_retrieval_context),
    delegation_token: str | None = Header(default=None, alias="X-XAgent-Delegation"),
) -> CitationAuthorizeResponse | JSONResponse:
    started = time.monotonic()
    try:
        candidates = await _authorized_citations(
            request, context, delegation_token, "authorize_citations"
        )
        await _write_retrieval_audit(
            context, action="retrieval.citation_authorize", session_id=request.session_id,
            tool_call_id=request.tool_call_id, result="allowed",
            latency_ms=max(0, int((time.monotonic() - started) * 1000)),
            evidence=[
                {
                    "artifact_id": str(item.artifact_id),
                    "version_id": str(item.version_id),
                    "index_id": str(item.index_id),
                    "generation": item.generation,
                    "chunk_id": str(item.chunk_id),
                }
                for item in candidates
            ],
        )
        return CitationAuthorizeResponse(authorized=True)
    except (DelegationError, RetrievalError) as error:
        await _write_retrieval_audit(
            context, action="retrieval.citation_authorize", session_id=request.session_id,
            tool_call_id=request.tool_call_id, result=error.code,
            latency_ms=max(0, int((time.monotonic() - started) * 1000)),
        )
        return _error(error.code)
    except Exception:
        await context.session.rollback()
        await _write_isolated_failure_audit(
            context, action="retrieval.citation_authorize", session_id=request.session_id,
            tool_call_id=request.tool_call_id, result="citation-invalid", started=started,
        )
        return _error("citation-invalid")


@router.post("/citations/resolve", response_model=CitationResolveResponse)
async def resolve_citation_route(
    request: CitationResolveRequest,
    context: SessionContext = Depends(get_retrieval_context),
    delegation_token: str | None = Header(default=None, alias="X-XAgent-Delegation"),
) -> CitationResolveResponse | JSONResponse:
    started = time.monotonic()
    try:
        candidates = await _authorized_citations(
            request, context, delegation_token, "resolve_citation"
        )
        item = candidates[0]
        await _write_retrieval_audit(
            context, action="retrieval.citation_resolve", session_id=request.session_id,
            tool_call_id=request.tool_call_id, result="allowed",
            latency_ms=max(0, int((time.monotonic() - started) * 1000)),
            evidence=[{
                "artifact_id": str(item.artifact_id), "version_id": str(item.version_id),
                "index_id": str(item.index_id), "generation": item.generation,
                "chunk_id": str(item.chunk_id),
            }],
        )
        return CitationResolveResponse(
            artifact_id=item.artifact_id,
            version_id=item.version_id,
            chunk_id=item.chunk_id,
            line_start=item.line_start,
            line_end=item.line_end,
        )
    except (DelegationError, RetrievalError) as error:
        await _write_retrieval_audit(
            context, action="retrieval.citation_resolve", session_id=request.session_id,
            tool_call_id=request.tool_call_id, result=error.code,
            latency_ms=max(0, int((time.monotonic() - started) * 1000)),
        )
        return _error(error.code)
    except Exception:
        await context.session.rollback()
        await _write_isolated_failure_audit(
            context, action="retrieval.citation_resolve", session_id=request.session_id,
            tool_call_id=request.tool_call_id, result="citation-invalid", started=started,
        )
        return _error("citation-invalid")
