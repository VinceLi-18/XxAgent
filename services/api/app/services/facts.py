"""Governed Fact preparation, review queries, decisions, and delivery."""

import base64
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from time import monotonic
from uuid import UUID, uuid4

from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.artifact import Artifact, ArtifactVersion
from app.models.facts import (
    FACT_LIST_PAGE_MAX,
    FACT_OUTBOX_PAGE_MAX,
    BusinessOutbox,
    FactOperationIdempotency,
    FactProposal,
    FactProposalEvidence,
    FactProposalReceipt,
    FactProposalStatus,
    ProjectFactHead,
    ProjectFactRevision,
)
from app.models.identity import Role
from app.models.retrieval import ArtifactTextChunk, XAgentAdmittedEvidence
from app.models.xagent_session import XAgentSession
from app.schemas.facts import (
    FactPrepareRequest,
    FactPrepareResponse,
    FactProposalPublicResult,
)
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
    FACT_REVISION_CONFLICT = "fact-revision-conflict"
    FACT_ALREADY_DECIDED = "fact-already-decided"
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


@dataclass(frozen=True)
class FactProposalDecision:
    """The public identities produced by one terminal proposal operation."""

    proposal_id: UUID
    status: str
    fact_revision_id: UUID | None = None
    content_revision: int | None = None

    def payload(self) -> dict[str, object]:
        """Return the closed snake-case v1 wire result."""
        value: dict[str, object] = {
            "schema_version": 1,
            "proposal_id": self.proposal_id,
            "status": self.status,
        }
        if self.fact_revision_id is not None:
            value["fact_revision_id"] = self.fact_revision_id
        if self.content_revision is not None:
            value["content_revision"] = self.content_revision
        return value


@dataclass(frozen=True)
class FactCursor:
    """The stable creation time and UUID tie-breaker encoded by a v1 cursor."""

    created_at: datetime
    item_id: UUID


_PUBLIC_PROPOSAL_STATUSES = (
    FactProposalStatus.PENDING.value,
    FactProposalStatus.CONFIRMED.value,
    FactProposalStatus.REJECTED.value,
    FactProposalStatus.WITHDRAWN.value,
    FactProposalStatus.CONFLICTED.value,
)


def _encode_cursor(created_at: datetime, item_id: UUID) -> str:
    value = json.dumps(
        {"created_at": created_at.isoformat(), "id": str(item_id), "v": 1},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def _decode_cursor(value: str | None) -> FactCursor | None:
    if value is None:
        return None
    try:
        padding = "=" * (-len(value) % 4)
        decoded = base64.b64decode(
            value + padding,
            altchars=b"-_",
            validate=True,
        )
        payload = json.loads(decoded)
        if not isinstance(payload, dict) or set(payload) != {"created_at", "id", "v"}:
            raise ValueError
        if payload["v"] != 1 or not isinstance(payload["created_at"], str):
            raise ValueError
        created_at = datetime.fromisoformat(payload["created_at"])
        if created_at.tzinfo is None or created_at.utcoffset() is None:
            raise ValueError
        item_id = UUID(payload["id"])
        if str(item_id) != payload["id"]:
            raise ValueError
    except (UnicodeDecodeError, ValueError, TypeError, json.JSONDecodeError):
        raise FactServiceError(FactErrorCode.FACT_INPUT_INVALID) from None
    return FactCursor(created_at=created_at, item_id=item_id)


def _page_after(created_at, item_id, cursor: FactCursor | None):
    if cursor is None:
        return None
    return or_(
        created_at > cursor.created_at,
        and_(created_at == cursor.created_at, item_id > cursor.item_id),
    )


async def _evidence_by_proposal(
    session: AsyncSession,
    proposal_ids: set[UUID],
) -> dict[UUID, list[dict[str, object]]]:
    if not proposal_ids:
        return {}
    rows = (
        await session.scalars(
            select(FactProposalEvidence)
            .join(Artifact, Artifact.id == FactProposalEvidence.artifact_id)
            .join(
                ArtifactVersion,
                and_(
                    ArtifactVersion.id == FactProposalEvidence.version_id,
                    ArtifactVersion.artifact_id == FactProposalEvidence.artifact_id,
                ),
            )
            .where(FactProposalEvidence.proposal_id.in_(proposal_ids))
            .order_by(
                FactProposalEvidence.proposal_id,
                FactProposalEvidence.citation_id,
            )
        )
    ).all()
    grouped: dict[UUID, list[dict[str, object]]] = {}
    for row in rows:
        grouped.setdefault(row.proposal_id, []).append({
            "citation_id": row.citation_id,
            "artifact_id": row.artifact_id,
            "version_id": row.version_id,
            "index_id": row.index_id,
            "index_generation": row.index_generation,
            "chunk_id": row.chunk_id,
            "line_start": row.line_start,
            "line_end": row.line_end,
        })
    return grouped


def _typed_value(value_type: str, value: object) -> dict[str, object]:
    return {"type": value_type, "value": value}


def _proposal_payload(
    proposal: FactProposal,
    evidence: dict[UUID, list[dict[str, object]]],
) -> dict[str, object]:
    assert proposal.admitted_at is not None
    return {
        "id": proposal.id,
        "project_id": proposal.project_id,
        "field_key": proposal.field_key,
        "label": proposal.label,
        "value": _typed_value(proposal.value_type, proposal.value),
        "proposer_id": proposal.proposer_id,
        "base_revision": proposal.base_revision,
        "assertion_reason": proposal.assertion_reason,
        "status": proposal.status,
        "decision_actor_id": proposal.decision_actor_id,
        "decision_reason": proposal.decision_reason,
        "evidence": evidence.get(proposal.id, []),
        "created_at": proposal.created_at,
        "admitted_at": proposal.admitted_at,
        "decided_at": proposal.decided_at,
    }


def _revision_payload(
    revision: ProjectFactRevision,
    proposal: FactProposal,
    evidence: dict[UUID, list[dict[str, object]]],
) -> dict[str, object]:
    return {
        "id": revision.id,
        "project_id": revision.project_id,
        "field_key": revision.field_key,
        "label": revision.label,
        "value": _typed_value(revision.value_type, revision.value),
        "content_revision": revision.content_revision,
        "proposal_id": revision.proposal_id,
        "proposer_id": proposal.proposer_id,
        "confirmed_by_id": revision.confirmed_by_id,
        "assertion_reason": proposal.assertion_reason,
        "evidence": evidence.get(revision.proposal_id, []),
        "created_at": revision.created_at,
    }


async def list_fact_proposals(
    session: AsyncSession,
    *,
    project_id: UUID,
    limit: int,
    cursor: str | None,
) -> dict[str, object]:
    """Return one RLS-filtered page of public proposals."""
    if limit < 1 or limit > FACT_LIST_PAGE_MAX:
        raise FactServiceError(FactErrorCode.FACT_INPUT_INVALID)
    decoded = _decode_cursor(cursor)
    statement = select(FactProposal).where(
        FactProposal.project_id == project_id,
        FactProposal.status.in_(_PUBLIC_PROPOSAL_STATUSES),
    )
    after = _page_after(FactProposal.created_at, FactProposal.id, decoded)
    if after is not None:
        statement = statement.where(after)
    proposals = list((await session.scalars(
        statement.order_by(FactProposal.created_at, FactProposal.id).limit(limit + 1)
    )).all())
    if not proposals:
        await _require_visible_project(session, project_id)
    page = proposals[:limit]
    evidence = await _evidence_by_proposal(session, {item.id for item in page})
    return {
        "schema_version": 1,
        "items": [_proposal_payload(item, evidence) for item in page],
        "next_cursor": (
            _encode_cursor(page[-1].created_at, page[-1].id)
            if len(proposals) > limit
            else None
        ),
    }


async def get_fact_proposal(
    session: AsyncSession,
    proposal_id: UUID,
) -> dict[str, object]:
    """Return one public proposal through Fact RLS."""
    proposal = await session.scalar(select(FactProposal).where(
        FactProposal.id == proposal_id,
        FactProposal.status.in_(_PUBLIC_PROPOSAL_STATUSES),
    ))
    if proposal is None:
        raise FactServiceError(FactErrorCode.NOT_FOUND)
    evidence = await _evidence_by_proposal(session, {proposal.id})
    return {"schema_version": 1, "proposal": _proposal_payload(proposal, evidence)}


async def _require_visible_project(session: AsyncSession, project_id: UUID) -> None:
    visible = await session.scalar(
        text(
            "SELECT EXISTS (SELECT 1 FROM public.xagent_fact_authorized_project_ids() "
            "AS project_ids WHERE project_ids = :project_id)"
        ),
        {"project_id": project_id},
    )
    if visible is not True:
        raise FactServiceError(FactErrorCode.NOT_FOUND)


async def list_fact_heads(
    session: AsyncSession,
    *,
    project_id: UUID,
    limit: int,
    cursor: str | None,
) -> dict[str, object]:
    """Return current revisions in stable creation order through Fact RLS."""
    if limit < 1 or limit > FACT_LIST_PAGE_MAX:
        raise FactServiceError(FactErrorCode.FACT_INPUT_INVALID)
    decoded = _decode_cursor(cursor)
    statement = (
        select(ProjectFactRevision, FactProposal)
        .join(ProjectFactHead, ProjectFactHead.revision_id == ProjectFactRevision.id)
        .join(FactProposal, FactProposal.id == ProjectFactRevision.proposal_id)
        .where(ProjectFactHead.project_id == project_id)
    )
    after = _page_after(ProjectFactRevision.created_at, ProjectFactRevision.id, decoded)
    if after is not None:
        statement = statement.where(after)
    rows = list((await session.execute(
        statement.order_by(ProjectFactRevision.created_at, ProjectFactRevision.id)
        .limit(limit + 1)
    )).all())
    if not rows:
        await _require_visible_project(session, project_id)
    page = rows[:limit]
    evidence = await _evidence_by_proposal(
        session,
        {row.ProjectFactRevision.proposal_id for row in page},
    )
    return {
        "schema_version": 1,
        "items": [
            _revision_payload(row.ProjectFactRevision, row.FactProposal, evidence)
            for row in page
        ],
        "next_cursor": (
            _encode_cursor(
                page[-1].ProjectFactRevision.created_at,
                page[-1].ProjectFactRevision.id,
            )
            if len(rows) > limit
            else None
        ),
    }


async def get_fact_revision(
    session: AsyncSession,
    revision_id: UUID,
) -> dict[str, object]:
    """Return one revision and the bounded field history visible through RLS."""
    selected = (await session.execute(
        select(ProjectFactRevision, FactProposal)
        .join(FactProposal, FactProposal.id == ProjectFactRevision.proposal_id)
        .where(ProjectFactRevision.id == revision_id)
    )).one_or_none()
    if selected is None:
        raise FactServiceError(FactErrorCode.NOT_FOUND)
    history = list((await session.execute(
        select(ProjectFactRevision, FactProposal)
        .join(FactProposal, FactProposal.id == ProjectFactRevision.proposal_id)
        .where(
            ProjectFactRevision.project_id == selected.ProjectFactRevision.project_id,
            ProjectFactRevision.field_key == selected.ProjectFactRevision.field_key,
        )
        .order_by(ProjectFactRevision.content_revision.desc())
        .limit(FACT_LIST_PAGE_MAX)
    )).all())
    evidence = await _evidence_by_proposal(
        session,
        {row.ProjectFactRevision.proposal_id for row in history},
    )
    revision = _revision_payload(
        selected.ProjectFactRevision,
        selected.FactProposal,
        evidence,
    )
    return {
        "schema_version": 1,
        "revision": revision,
        "history": [
            _revision_payload(row.ProjectFactRevision, row.FactProposal, evidence)
            for row in history
        ],
    }


async def pull_fact_outbox(
    session: AsyncSession,
    *,
    actor_id: UUID,
    session_id: UUID,
    limit: int,
    cursor: str | None,
) -> dict[str, object]:
    """Return verified unconsumed decision events for one visible Project Session."""
    if limit < 1 or limit > FACT_OUTBOX_PAGE_MAX:
        raise FactServiceError(FactErrorCode.FACT_INPUT_INVALID)
    source = await visible_fact_session(session, actor_id, session_id)
    assert source.project_id is not None
    await _require_visible_project(session, source.project_id)
    decoded = _decode_cursor(cursor)
    statement = (
        select(BusinessOutbox, FactProposal, ProjectFactRevision)
        .join(FactProposal, FactProposal.id == BusinessOutbox.aggregate_id)
        .outerjoin(
            ProjectFactRevision,
            ProjectFactRevision.proposal_id == FactProposal.id,
        )
        .where(
            BusinessOutbox.source_session_id == session_id,
            BusinessOutbox.consumed_at.is_(None),
        )
    )
    after = _page_after(BusinessOutbox.created_at, BusinessOutbox.id, decoded)
    if after is not None:
        statement = statement.where(after)
    rows = list((await session.execute(
        statement.order_by(BusinessOutbox.created_at, BusinessOutbox.id)
        .limit(limit + 1)
    )).tuples().all())
    page = rows[:limit]
    items: list[dict[str, object]] = []
    for outbox, proposal, revision in page:
        event = fact_decision_event(proposal, revision=revision)
        if (
            outbox.aggregate_kind != "fact_proposal"
            or proposal.source_session_id != session_id
            or proposal.project_id != outbox.project_id
            or proposal.status not in {
                FactProposalStatus.CONFIRMED.value,
                FactProposalStatus.REJECTED.value,
                FactProposalStatus.WITHDRAWN.value,
                FactProposalStatus.CONFLICTED.value,
            }
            or (proposal.status == FactProposalStatus.CONFIRMED.value) != (revision is not None)
            or canonical_sha256(event) != outbox.payload_sha256
        ):
            raise FactServiceError(FactErrorCode.SERVICE_UNAVAILABLE)
        items.append({
            "outbox_id": outbox.id,
            "payload_sha256": outbox.payload_sha256,
            "event": event,
        })
    return {
        "schema_version": 1,
        "items": items,
        "next_cursor": (
            _encode_cursor(page[-1][0].created_at, page[-1][0].id)
            if len(rows) > limit
            else None
        ),
    }


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


def fact_decision_event(
    proposal: FactProposal,
    *,
    status: str | None = None,
    revision: ProjectFactRevision | None = None,
    decision_reason: str | None = None,
) -> dict[str, object]:
    """Build the closed public decision event whose hash is stored in Outbox."""
    terminal_status = status or proposal.status
    data: dict[str, object] = {
        "proposal_id": str(proposal.id),
        "project_id": str(proposal.project_id),
        "field_key": proposal.field_key,
        "label": proposal.label,
        "status": terminal_status,
    }
    if revision is not None:
        data["fact_revision_id"] = str(revision.id)
        data["content_revision"] = revision.content_revision
    reason = decision_reason if status is not None else proposal.decision_reason
    if reason is not None:
        data["decision_reason"] = reason
    return {"type": "fact/proposal-decided", "data": data}


def _decision_request_sha256(
    *,
    operation: str,
    proposal_id: UUID,
    decision_reason: str | None,
) -> str:
    return canonical_sha256({
        "schema_version": 1,
        "operation": operation,
        "proposal_id": str(proposal_id),
        "decision_reason": decision_reason,
    })


async def _decision_replay(
    session: AsyncSession,
    *,
    principal: Principal,
    operation: str,
    proposal_id: UUID,
    idempotency_key: str,
    request_sha256: str,
    started: float,
) -> FactProposalDecision | None:
    await _lock_operation(
        session,
        actor_id=principal.actor_id,
        operation=operation,
        idempotency_key=idempotency_key,
    )
    stored = await session.get(
        FactOperationIdempotency,
        (principal.actor_id, operation, idempotency_key),
    )
    if stored is None:
        return None
    if stored.request_sha256 != request_sha256 or stored.proposal_id != proposal_id:
        raise FactServiceError(FactErrorCode.IDEMPOTENCY_CONFLICT)
    proposal = await session.scalar(
        select(FactProposal).where(FactProposal.id == stored.proposal_id)
    )
    if proposal is None:
        raise FactServiceError(FactErrorCode.NOT_FOUND)
    outbox = await session.scalar(select(BusinessOutbox).where(
        BusinessOutbox.id == stored.outbox_id,
        BusinessOutbox.aggregate_id == proposal.id,
        BusinessOutbox.project_id == proposal.project_id,
    ))
    if outbox is None:
        raise FactServiceError(FactErrorCode.SERVICE_UNAVAILABLE)
    content_revision = None
    if stored.revision_id is not None:
        revision = await session.scalar(
            select(ProjectFactRevision).where(
                ProjectFactRevision.id == stored.revision_id
            )
        )
        if revision is None:
            raise FactServiceError(FactErrorCode.SERVICE_UNAVAILABLE)
        content_revision = revision.content_revision
    evidence_count = await session.scalar(
        select(func.count())
        .select_from(FactProposalEvidence)
        .where(FactProposalEvidence.proposal_id == proposal.id)
    )
    await write_audit_event(
        session,
        principal.actor_id,
        "fact.replay",
        "fact_proposal",
        proposal.id,
        uuid4(),
        "replayed",
        details=fact_audit_details(
            project_id=proposal.project_id,
            session_id=proposal.source_session_id,
            proposal_id=proposal.id,
            fact_revision_id=stored.revision_id,
            outbox_id=stored.outbox_id,
            operation=operation,
            request_sha256=request_sha256,
            payload_sha256=outbox.payload_sha256,
            evidence_count=evidence_count or 0,
            result="replayed",
            status=stored.response_status,
            latency_ms=max(0, int((monotonic() - started) * 1000)),
        ),
    )
    return FactProposalDecision(
        proposal_id=proposal.id,
        status=stored.response_status,
        fact_revision_id=stored.revision_id,
        content_revision=content_revision,
    )


async def _lock_pending_proposal(
    session: AsyncSession,
    *,
    principal: Principal,
    proposal_id: UUID,
    operation: str,
) -> FactProposal:
    proposal = await session.scalar(
        select(FactProposal)
        .where(FactProposal.id == proposal_id)
        .with_for_update()
    )
    if proposal is None:
        raise FactServiceError(FactErrorCode.NOT_FOUND)
    if operation in {"approve", "reject"}:
        if principal.role is not Role.MANAGER:
            raise FactServiceError(FactErrorCode.NOT_FOUND)
    elif operation == "withdraw":
        if proposal.proposer_id != principal.actor_id:
            raise FactServiceError(FactErrorCode.NOT_FOUND)
    else:
        raise FactServiceError(FactErrorCode.SERVICE_UNAVAILABLE)
    if proposal.status != FactProposalStatus.PENDING.value:
        raise FactServiceError(FactErrorCode.FACT_ALREADY_DECIDED)
    return proposal


async def _authorize_decision_evidence(
    session: AsyncSession,
    proposal: FactProposal,
) -> int:
    expected = await session.scalar(
        select(func.count())
        .select_from(FactProposalEvidence)
        .where(FactProposalEvidence.proposal_id == proposal.id)
    )
    if not expected:
        return 0
    admitted = XAgentAdmittedEvidence
    evidence = FactProposalEvidence
    authorized = await session.scalar(
        select(func.count())
        .select_from(evidence)
        .join(
            admitted,
            and_(
                admitted.session_id == evidence.session_id,
                admitted.citation_id == evidence.citation_id,
                admitted.admission_event_sequence == evidence.admission_event_sequence,
                admitted.artifact_id == evidence.artifact_id,
                admitted.version_id == evidence.version_id,
                admitted.index_id == evidence.index_id,
                admitted.index_generation == evidence.index_generation,
                admitted.chunk_id == evidence.chunk_id,
            ),
        )
        .join(
            Artifact,
            and_(
                Artifact.id == evidence.artifact_id,
                Artifact.project_id == proposal.project_id,
            ),
        )
        .join(
            ArtifactVersion,
            and_(
                ArtifactVersion.id == evidence.version_id,
                ArtifactVersion.artifact_id == evidence.artifact_id,
                ArtifactVersion.project_id == proposal.project_id,
            ),
        )
        .where(evidence.proposal_id == proposal.id)
    )
    if authorized != expected:
        raise FactServiceError(FactErrorCode.NOT_FOUND)
    return expected


async def _lock_fact_head(
    session: AsyncSession,
    proposal: FactProposal,
) -> ProjectFactHead | None:
    lock_name = f"{proposal.project_id}:fact-head:{proposal.field_key}"
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_name, 0))"),
        {"lock_name": lock_name},
    )
    return await session.scalar(
        select(ProjectFactHead)
        .where(
            ProjectFactHead.project_id == proposal.project_id,
            ProjectFactHead.field_key == proposal.field_key,
        )
        .with_for_update()
    )


async def _create_fact_revision(
    session: AsyncSession,
    proposal: FactProposal,
    principal: Principal,
) -> ProjectFactRevision:
    revision = ProjectFactRevision(
        id=uuid4(),
        project_id=proposal.project_id,
        field_key=proposal.field_key,
        label=proposal.label,
        value_type=proposal.value_type,
        value=proposal.value,
        content_revision=proposal.base_revision + 1,
        proposal_id=proposal.id,
        confirmed_by_id=principal.actor_id,
        created_at=datetime.now(UTC),
    )
    session.add(revision)
    await session.flush()
    return revision


async def _advance_fact_head(
    session: AsyncSession,
    proposal: FactProposal,
    revision: ProjectFactRevision,
    head: ProjectFactHead | None,
) -> None:
    if head is None:
        session.add(ProjectFactHead(
            project_id=proposal.project_id,
            field_key=proposal.field_key,
            revision_id=revision.id,
            content_revision=revision.content_revision,
            updated_at=revision.created_at,
        ))
    else:
        head.revision_id = revision.id
        head.content_revision = revision.content_revision
    await session.flush()


async def _mark_fact_proposal_terminal(
    session: AsyncSession,
    proposal: FactProposal,
    principal: Principal,
    *,
    status: str,
    decision_reason: str | None,
) -> None:
    proposal.status = status
    proposal.decision_actor_id = principal.actor_id
    proposal.decision_reason = decision_reason
    proposal.decided_at = datetime.now(UTC)
    await session.flush()


async def _write_fact_decision_audit(
    session: AsyncSession,
    proposal: FactProposal,
    principal: Principal,
    *,
    operation: str,
    request_sha256: str,
    payload_sha256: str,
    evidence_count: int,
    revision: ProjectFactRevision | None,
    outbox_id: UUID,
    started: float,
) -> None:
    action = {
        "approve": (
            "fact.approve"
            if proposal.status == FactProposalStatus.CONFIRMED.value
            else "fact.conflict"
        ),
        "reject": "fact.reject",
        "withdraw": "fact.withdraw",
    }[operation]
    details = fact_audit_details(
        project_id=proposal.project_id,
        session_id=proposal.source_session_id,
        proposal_id=proposal.id,
        fact_revision_id=revision.id if revision is not None else None,
        outbox_id=outbox_id,
        operation=operation,
        request_sha256=request_sha256,
        payload_sha256=payload_sha256,
        evidence_count=evidence_count if operation != "withdraw" else None,
        result=proposal.status,
        status=proposal.status,
        latency_ms=max(0, int((monotonic() - started) * 1000)),
    )
    await write_audit_event(
        session,
        principal.actor_id,
        action,
        "fact_proposal",
        proposal.id,
        uuid4(),
        proposal.status,
        details=details,
    )
    if proposal.status == FactProposalStatus.CONFIRMED.value:
        await write_audit_event(
            session,
            principal.actor_id,
            "fact.confirm",
            "project_fact_revision",
            revision.id if revision is not None else proposal.id,
            uuid4(),
            proposal.status,
            details=details,
        )


async def _create_fact_outbox(
    session: AsyncSession,
    proposal: FactProposal,
    *,
    outbox_id: UUID,
    payload_sha256: str,
) -> BusinessOutbox:
    row = BusinessOutbox(
        id=outbox_id,
        aggregate_kind="fact_proposal",
        aggregate_id=proposal.id,
        project_id=proposal.project_id,
        source_session_id=proposal.source_session_id,
        payload_sha256=payload_sha256,
        created_at=proposal.decided_at or datetime.now(UTC),
    )
    session.add(row)
    await session.flush()
    return row


async def _store_fact_decision_operation(
    session: AsyncSession,
    proposal: FactProposal,
    principal: Principal,
    *,
    operation: str,
    idempotency_key: str,
    request_sha256: str,
    revision: ProjectFactRevision | None,
    outbox_id: UUID,
) -> None:
    session.add(FactOperationIdempotency(
        actor_id=principal.actor_id,
        operation=operation,
        idempotency_key=idempotency_key,
        project_id=proposal.project_id,
        request_sha256=request_sha256,
        proposal_id=proposal.id,
        response_status=proposal.status,
        revision_id=revision.id if revision is not None else None,
        outbox_id=outbox_id,
    ))
    await session.flush()


async def _finish_fact_decision(
    session: AsyncSession,
    proposal: FactProposal,
    principal: Principal,
    *,
    operation: str,
    idempotency_key: str,
    request_sha256: str,
    decision_reason: str | None,
    status: str,
    evidence_count: int,
    revision: ProjectFactRevision | None,
    started: float,
) -> FactProposalDecision:
    await _mark_fact_proposal_terminal(
        session,
        proposal,
        principal,
        status=status,
        decision_reason=decision_reason,
    )
    event = fact_decision_event(proposal, revision=revision)
    payload_sha256 = canonical_sha256(event)
    outbox_id = uuid4()
    await _write_fact_decision_audit(
        session,
        proposal,
        principal,
        operation=operation,
        request_sha256=request_sha256,
        payload_sha256=payload_sha256,
        evidence_count=evidence_count,
        revision=revision,
        outbox_id=outbox_id,
        started=started,
    )
    await _create_fact_outbox(
        session,
        proposal,
        outbox_id=outbox_id,
        payload_sha256=payload_sha256,
    )
    await _store_fact_decision_operation(
        session,
        proposal,
        principal,
        operation=operation,
        idempotency_key=idempotency_key,
        request_sha256=request_sha256,
        revision=revision,
        outbox_id=outbox_id,
    )
    return FactProposalDecision(
        proposal_id=proposal.id,
        status=proposal.status,
        fact_revision_id=revision.id if revision is not None else None,
        content_revision=revision.content_revision if revision is not None else None,
    )


async def approve_fact_proposal(
    session: AsyncSession,
    *,
    actor: Principal,
    proposal_id: UUID,
    decision_note: str | None,
    idempotency_key: str,
) -> FactProposalDecision:
    """Confirm one proposal in a serializable all-or-nothing transaction."""
    started = monotonic()
    request_sha256 = _decision_request_sha256(
        operation="approve",
        proposal_id=proposal_id,
        decision_reason=decision_note,
    )
    replay = await _decision_replay(
        session,
        principal=actor,
        operation="approve",
        proposal_id=proposal_id,
        idempotency_key=idempotency_key,
        request_sha256=request_sha256,
        started=started,
    )
    if replay is not None:
        return replay
    proposal = await _lock_pending_proposal(
        session,
        principal=actor,
        proposal_id=proposal_id,
        operation="approve",
    )
    evidence_count = await _authorize_decision_evidence(session, proposal)
    head = await _lock_fact_head(session, proposal)
    if (head.content_revision if head is not None else 0) != proposal.base_revision:
        return await _finish_fact_decision(
            session,
            proposal,
            actor,
            operation="approve",
            idempotency_key=idempotency_key,
            request_sha256=request_sha256,
            decision_reason=decision_note,
            status=FactProposalStatus.CONFLICTED.value,
            evidence_count=evidence_count,
            revision=None,
            started=started,
        )
    revision = await _create_fact_revision(session, proposal, actor)
    await _advance_fact_head(session, proposal, revision, head)
    return await _finish_fact_decision(
        session,
        proposal,
        actor,
        operation="approve",
        idempotency_key=idempotency_key,
        request_sha256=request_sha256,
        decision_reason=decision_note,
        status=FactProposalStatus.CONFIRMED.value,
        evidence_count=evidence_count,
        revision=revision,
        started=started,
    )


async def reject_fact_proposal(
    session: AsyncSession,
    *,
    actor: Principal,
    proposal_id: UUID,
    reason: str,
    idempotency_key: str,
) -> FactProposalDecision:
    """Reject one pending proposal under current manager authorization."""
    return await _decide_without_revision(
        session,
        actor=actor,
        proposal_id=proposal_id,
        decision_reason=reason,
        idempotency_key=idempotency_key,
        operation="reject",
        status=FactProposalStatus.REJECTED.value,
    )


async def withdraw_fact_proposal(
    session: AsyncSession,
    *,
    actor: Principal,
    proposal_id: UUID,
    idempotency_key: str,
) -> FactProposalDecision:
    """Withdraw the current proposer's own pending proposal."""
    return await _decide_without_revision(
        session,
        actor=actor,
        proposal_id=proposal_id,
        decision_reason=None,
        idempotency_key=idempotency_key,
        operation="withdraw",
        status=FactProposalStatus.WITHDRAWN.value,
    )


async def _decide_without_revision(
    session: AsyncSession,
    *,
    actor: Principal,
    proposal_id: UUID,
    decision_reason: str | None,
    idempotency_key: str,
    operation: str,
    status: str,
) -> FactProposalDecision:
    started = monotonic()
    request_sha256 = _decision_request_sha256(
        operation=operation,
        proposal_id=proposal_id,
        decision_reason=decision_reason,
    )
    replay = await _decision_replay(
        session,
        principal=actor,
        operation=operation,
        proposal_id=proposal_id,
        idempotency_key=idempotency_key,
        request_sha256=request_sha256,
        started=started,
    )
    if replay is not None:
        return replay
    proposal = await _lock_pending_proposal(
        session,
        principal=actor,
        proposal_id=proposal_id,
        operation=operation,
    )
    evidence_count = await _authorize_decision_evidence(session, proposal)
    return await _finish_fact_decision(
        session,
        proposal,
        actor,
        operation=operation,
        idempotency_key=idempotency_key,
        request_sha256=request_sha256,
        decision_reason=decision_reason,
        status=status,
        evidence_count=evidence_count,
        revision=None,
        started=started,
    )
