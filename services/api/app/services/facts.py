"""Fact proposal preparation under current Project Session authorization."""

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from time import monotonic
from uuid import UUID, uuid4

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.artifact import Artifact
from app.models.facts import (
    FactOperationIdempotency,
    FactProposal,
    FactProposalEvidence,
    FactProposalReceipt,
    FactProposalStatus,
)
from app.models.retrieval import ArtifactTextChunk, XAgentAdmittedEvidence
from app.models.xagent_session import XAgentSession
from app.schemas.facts import FactPrepareRequest, FactPrepareResponse, FactProposalPublicResult
from app.services.audit import fact_audit_details, write_audit_event
from app.services.auth import Principal
from app.services.fact_receipts import FactReceiptClaims, new_receipt_times, persist_receipt
from app.services.fact_validation import canonical_sha256


class FactErrorCode(str, Enum):
    """Stable internal Fact preparation and admission failure codes."""

    FACT_INPUT_INVALID = "fact-input-invalid"
    FACT_EVIDENCE_INVALID = "fact-evidence-invalid"
    FACT_SESSION_INVALID = "fact-session-invalid"
    FACT_RECEIPT_INVALID = "fact-receipt-invalid"
    FACT_RECEIPT_EXPIRED = "fact-receipt-expired"
    NOT_FOUND = "not-found"
    STALE_PERMISSION = "stale-permission"
    IDEMPOTENCY_CONFLICT = "idempotency-conflict"
    SERVICE_UNAVAILABLE = "service-unavailable"


class FactServiceError(RuntimeError):
    """A stable Fact operation failure safe for the internal Host protocol."""

    def __init__(self, code: FactErrorCode) -> None:
        self.code = code
        super().__init__(code.value)


@dataclass(frozen=True)
class FactPrepareContext:
    """Server-derived project, Session sequence, and Fact head state."""

    project_id: UUID
    source_event_sequence: int
    base_revision: int


async def visible_fact_session(
    session: AsyncSession,
    actor_id: UUID,
    session_id: UUID,
) -> XAgentSession:
    """Return a visible Project Session or a non-disclosing stable failure."""
    item = await session.scalar(select(XAgentSession).where(XAgentSession.id == session_id))
    if item is None or (item.visibility == "private" and item.owner_id != actor_id):
        raise FactServiceError(FactErrorCode.NOT_FOUND)
    if item.visibility != "project" or item.project_id is None:
        raise FactServiceError(FactErrorCode.FACT_SESSION_INVALID)
    return item


async def _lock_operation(
    session: AsyncSession,
    *,
    actor_id: UUID,
    operation: str,
    idempotency_key: str,
) -> None:
    lock_name = f"{actor_id}:fact:{operation}:{idempotency_key}"
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_name, 0))"),
        {"lock_name": lock_name},
    )


async def _prepare_context(
    session: AsyncSession,
    request: FactPrepareRequest,
) -> FactPrepareContext:
    row = (
        await session.execute(
            text(
                "SELECT project_id, source_event_sequence, base_revision "
                "FROM public.xagent_fact_prepare_context("
                ":session_id, :permission_revision, :field_key, :tool_call_id)"
            ),
            {
                "session_id": request.session_id,
                "permission_revision": request.permission_revision,
                "field_key": request.field_key,
                "tool_call_id": request.tool_call_id,
            },
        )
    ).one_or_none()
    if row is None:
        raise FactServiceError(FactErrorCode.NOT_FOUND)
    return FactPrepareContext(
        project_id=row.project_id,
        source_event_sequence=row.source_event_sequence,
        base_revision=row.base_revision,
    )


async def _proposal_evidence(
    session: AsyncSession,
    request: FactPrepareRequest,
    context: FactPrepareContext,
    proposal_id: UUID,
    created_at: datetime,
) -> list[FactProposalEvidence]:
    if not request.evidence_ids:
        return []
    admitted = (
        await session.execute(
            select(
                XAgentAdmittedEvidence,
                ArtifactTextChunk.line_start,
                ArtifactTextChunk.line_end,
            )
            .join(
                ArtifactTextChunk,
                ArtifactTextChunk.id == XAgentAdmittedEvidence.chunk_id,
            )
            .join(Artifact, Artifact.id == XAgentAdmittedEvidence.artifact_id)
            .where(
                XAgentAdmittedEvidence.session_id == request.session_id,
                XAgentAdmittedEvidence.citation_id.in_(request.evidence_ids),
                Artifact.project_id == context.project_id,
            )
            .order_by(XAgentAdmittedEvidence.citation_id)
            .limit(len(request.evidence_ids))
        )
    ).all()
    by_citation = {row.XAgentAdmittedEvidence.citation_id: row for row in admitted}
    if set(by_citation) != set(request.evidence_ids):
        raise FactServiceError(FactErrorCode.FACT_EVIDENCE_INVALID)
    return [
        FactProposalEvidence(
            proposal_id=proposal_id,
            citation_id=citation_id,
            project_id=context.project_id,
            session_id=request.session_id,
            admission_event_sequence=row.XAgentAdmittedEvidence.admission_event_sequence,
            artifact_id=row.XAgentAdmittedEvidence.artifact_id,
            version_id=row.XAgentAdmittedEvidence.version_id,
            index_id=row.XAgentAdmittedEvidence.index_id,
            index_generation=row.XAgentAdmittedEvidence.index_generation,
            chunk_id=row.XAgentAdmittedEvidence.chunk_id,
            line_start=row.line_start,
            line_end=row.line_end,
            created_at=created_at,
        )
        for citation_id in request.evidence_ids
        for row in (by_citation[citation_id],)
    ]


async def _replay_prepare(
    session: AsyncSession,
    principal: Principal,
    request: FactPrepareRequest,
    operation: FactOperationIdempotency,
    *,
    request_sha256: str,
    started: float,
) -> FactPrepareResponse:
    if operation.request_sha256 != request_sha256:
        raise FactServiceError(FactErrorCode.IDEMPOTENCY_CONFLICT)
    stored = await session.scalar(
        select(FactProposalReceipt)
        .where(
            FactProposalReceipt.proposal_id == operation.proposal_id,
            FactProposalReceipt.actor_id == principal.actor_id,
        )
        .order_by(
            FactProposalReceipt.issued_at.desc(),
            FactProposalReceipt.receipt_digest_id.desc(),
        )
        .limit(1)
    )
    if stored is None:
        raise FactServiceError(FactErrorCode.SERVICE_UNAVAILABLE)
    if stored.consumed_at is not None:
        raise FactServiceError(FactErrorCode.FACT_RECEIPT_INVALID)
    if stored.expires_at <= datetime.now(UTC):
        raise FactServiceError(FactErrorCode.FACT_RECEIPT_EXPIRED)
    public_result = FactProposalPublicResult(proposalId=operation.proposal_id)
    receipt = await persist_receipt(
        session,
        FactReceiptClaims(
            proposal_id=operation.proposal_id,
            project_id=stored.project_id,
            actor_id=principal.actor_id,
            session_id=stored.session_id,
            tool_call_id=stored.tool_call_id,
            permission_revision=stored.permission_revision,
            source_event_sequence=stored.source_event_sequence,
            payload_sha256=stored.payload_sha256,
            issued_at=stored.issued_at,
            expires_at=stored.expires_at,
        ),
    )
    await write_audit_event(
        session,
        principal.actor_id,
        "fact.replay",
        "fact_proposal",
        operation.proposal_id,
        uuid4(),
        "replayed",
        details=fact_audit_details(
            project_id=stored.project_id,
            session_id=stored.session_id,
            proposal_id=operation.proposal_id,
            tool_call_id=stored.tool_call_id,
            operation="prepare",
            request_sha256=request_sha256,
            payload_sha256=stored.payload_sha256,
            permission_revision=stored.permission_revision,
            result="replayed",
            status=FactProposalStatus.PREPARED.value,
            latency_ms=max(0, int((monotonic() - started) * 1000)),
        ),
    )
    return FactPrepareResponse(
        result=public_result,
        receipt=receipt,
        payload_sha256=stored.payload_sha256,
    )


async def prepare_fact(
    session: AsyncSession,
    principal: Principal,
    request: FactPrepareRequest,
) -> FactPrepareResponse:
    """Persist one hidden immutable proposal and its private admission receipt."""
    started = monotonic()
    await _lock_operation(
        session,
        actor_id=principal.actor_id,
        operation="prepare",
        idempotency_key=request.idempotency_key,
    )
    request_sha256 = canonical_sha256(
        request.model_dump(mode="json", exclude={"idempotency_key"})
    )
    replay = await session.get(
        FactOperationIdempotency,
        (principal.actor_id, "prepare", request.idempotency_key),
    )
    if replay is not None:
        return await _replay_prepare(
            session,
            principal,
            request,
            replay,
            request_sha256=request_sha256,
            started=started,
        )
    context = await _prepare_context(session, request)
    proposal_id = uuid4()
    public_result = FactProposalPublicResult(proposalId=proposal_id)
    payload_sha256 = canonical_sha256(public_result.model_dump(mode="json"))
    issued_at, expires_at = new_receipt_times()
    proposal = FactProposal(
        id=proposal_id,
        project_id=context.project_id,
        field_key=request.field_key,
        label=request.label,
        value_type=request.value.type,
        value=request.value.value,
        proposer_id=principal.actor_id,
        source_session_id=request.session_id,
        source_tool_call_id=request.tool_call_id,
        base_revision=context.base_revision,
        assertion_reason=request.assertion_reason,
        status=FactProposalStatus.PREPARED.value,
        payload_sha256=payload_sha256,
        idempotency_key=request.idempotency_key,
        permission_revision=principal.permission_revision,
        admission_expires_at=expires_at,
        created_at=issued_at,
        updated_at=issued_at,
    )
    session.add(proposal)
    await session.flush()
    evidence = await _proposal_evidence(
        session,
        request,
        context,
        proposal_id,
        issued_at,
    )
    session.add_all(evidence)
    await session.flush()
    receipt = await persist_receipt(
        session,
        FactReceiptClaims(
            proposal_id=proposal_id,
            project_id=context.project_id,
            actor_id=principal.actor_id,
            session_id=request.session_id,
            tool_call_id=request.tool_call_id,
            permission_revision=principal.permission_revision,
            source_event_sequence=context.source_event_sequence,
            payload_sha256=payload_sha256,
            issued_at=issued_at,
            expires_at=expires_at,
        ),
    )
    session.add(
        FactOperationIdempotency(
            actor_id=principal.actor_id,
            operation="prepare",
            idempotency_key=request.idempotency_key,
            project_id=context.project_id,
            request_sha256=request_sha256,
            proposal_id=proposal_id,
            response_status=FactProposalStatus.PREPARED.value,
        )
    )
    await write_audit_event(
        session,
        principal.actor_id,
        "fact.prepare",
        "fact_proposal",
        proposal_id,
        uuid4(),
        "prepared",
        details=fact_audit_details(
            project_id=context.project_id,
            session_id=request.session_id,
            proposal_id=proposal_id,
            tool_call_id=request.tool_call_id,
            operation="prepare",
            request_sha256=request_sha256,
            payload_sha256=payload_sha256,
            permission_revision=principal.permission_revision,
            evidence_count=len(evidence),
            result="prepared",
            status="prepared",
            latency_ms=max(0, int((monotonic() - started) * 1000)),
        ),
    )
    return FactPrepareResponse(
        result=public_result,
        receipt=receipt,
        payload_sha256=payload_sha256,
    )
