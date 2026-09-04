import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import Enum
from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project, ProjectAction
from app.models.retrieval import XAgentCitedAnswerEvidence, XAgentRetrievalReceipt
from app.models.workbench import XAgentSessionProjectRef
from app.models.xagent_session import XAgentIdempotencyKey, XAgentSession, XAgentSessionEvent
from app.services.audit import retrieval_audit_details, write_audit_event
from app.services.auth import Principal
from app.services.authorization import ForbiddenError, authorize_projects
from app.services.retrieval import (
    RetrievalCandidate,
    RetrievalError,
    authorize_citation_chunks,
    payload_sha256,
)
from app.services.retrieval_receipts import (
    ReceiptClaims,
    ReceiptKind,
    RetrievalReceiptError,
    receipt_digest_id,
    verify_receipt,
)

PROTOCOL_VERSION = 1


class SessionErrorCode(str, Enum):
    NOT_FOUND = "not-found"
    SESSION_NOT_FOUND = "session-not-found"
    SEQUENCE_CONFLICT = "sequence-conflict"
    IDEMPOTENCY_CONFLICT = "idempotency-conflict"
    UNSUPPORTED_VERSION = "unsupported-version"
    EVIDENCE_EXPIRED = "evidence-expired"
    EVIDENCE_CONFLICT = "evidence-conflict"
    SERVICE_UNAVAILABLE = "service-unavailable"


class SessionServiceError(Exception):
    def __init__(self, code: SessionErrorCode) -> None:
        self.code = code
        super().__init__(code.value)


def require_protocol_version(version: int) -> None:
    if version != PROTOCOL_VERSION:
        raise SessionServiceError(SessionErrorCode.UNSUPPORTED_VERSION)


def request_hash(value: dict[str, Any]) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def session_payload(item: XAgentSession) -> dict[str, Any]:
    return {
        "id": str(item.id),
        "owner_id": str(item.owner_id),
        "project_id": str(item.project_id) if item.project_id is not None else None,
        "visibility": item.visibility,
        "permission_revision_created": item.permission_revision_created,
        "title": item.title,
        "runtime_header": item.runtime_header,
        "archived": item.archived,
        "last_event_sequence": item.last_event_sequence,
        "version": item.version,
        "created_at": item.created_at.isoformat(),
        "updated_at": item.updated_at.isoformat(),
    }


def event_payload(item: XAgentSessionEvent) -> dict[str, Any]:
    return {
        "session_id": str(item.session_id),
        "sequence": item.sequence,
        "event_type": item.event_type,
        "schema_version": item.schema_version,
        "payload": item.payload,
        "actor_id": str(item.actor_id),
        "tool_call_id": item.tool_call_id,
        "audit_id": str(item.audit_id) if item.audit_id is not None else None,
        "created_at": item.created_at.isoformat(),
    }


async def _lock_idempotency_key(
    session: AsyncSession,
    *,
    actor_id: UUID,
    operation: str,
    key: str,
) -> None:
    lock_name = f"{actor_id}:{operation}:{key}"
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_name, 0))"),
        {"lock_name": lock_name},
    )


async def _idempotent_result(
    session: AsyncSession,
    *,
    actor_id: UUID,
    operation: str,
    key: str,
    digest: str,
) -> dict[str, Any] | None:
    await _lock_idempotency_key(
        session,
        actor_id=actor_id,
        operation=operation,
        key=key,
    )
    stored = await session.get(XAgentIdempotencyKey, (actor_id, operation, key))
    if stored is None or stored.expires_at <= datetime.now(UTC):
        return None
    if stored.request_hash != digest:
        raise SessionServiceError(SessionErrorCode.IDEMPOTENCY_CONFLICT)
    return stored.result


async def _store_idempotent_result(
    session: AsyncSession,
    *,
    actor_id: UUID,
    operation: str,
    key: str,
    digest: str,
    result: dict[str, Any],
) -> None:
    stored = await session.get(XAgentIdempotencyKey, (actor_id, operation, key))
    if stored is None:
        session.add(
            XAgentIdempotencyKey(
                actor_id=actor_id,
                operation=operation,
                idempotency_key=key,
                request_hash=digest,
                result=result,
                expires_at=datetime.now(UTC) + timedelta(hours=24),
            )
        )
    else:
        stored.request_hash = digest
        stored.result = result
        stored.expires_at = datetime.now(UTC) + timedelta(hours=24)
    await session.flush()


async def list_sessions(session: AsyncSession) -> list[dict[str, Any]]:
    rows = (
        await session.scalars(
            select(XAgentSession).order_by(XAgentSession.updated_at.desc(), XAgentSession.id)
        )
    ).all()
    inaccessible_session_ids = await _private_session_ids_with_inaccessible_refs(
        session,
        {item.id for item in rows if item.visibility == "private"},
    )
    visible_rows = [item for item in rows if item.id not in inaccessible_session_ids]
    return [session_payload(item) for item in visible_rows]


async def create_session(
    session: AsyncSession,
    principal: Principal,
    *,
    title: str,
    visibility: str,
    project_id: UUID | None,
    idempotency_key: str,
    digest: str,
    session_id: UUID | None = None,
    runtime_header: dict[str, Any] | None = None,
    events: list[dict[str, Any]] | None = None,
) -> tuple[dict[str, Any], bool]:
    operation = "session.create"
    replay = await _idempotent_result(
        session,
        actor_id=principal.actor_id,
        operation=operation,
        key=idempotency_key,
        digest=digest,
    )
    if replay is not None:
        return replay, True

    item = XAgentSession(
        id=session_id or uuid4(),
        owner_id=principal.actor_id,
        project_id=project_id,
        visibility=visibility,
        permission_revision_created=principal.permission_revision,
        title=title,
        runtime_header=runtime_header,
    )
    session.add(item)
    await session.flush()
    initial_events = events or []
    for sequence, event in enumerate(initial_events):
        session.add(
            XAgentSessionEvent(
                session_id=item.id,
                sequence=sequence,
                event_type=event["event_type"],
                schema_version=event["schema_version"],
                payload=event["payload"],
                actor_id=principal.actor_id,
                tool_call_id=event.get("tool_call_id"),
            )
        )
    item.last_event_sequence = len(initial_events) - 1
    await session.flush()
    result = {"schema_version": PROTOCOL_VERSION, "session": session_payload(item)}
    await _store_idempotent_result(
        session,
        actor_id=principal.actor_id,
        operation=operation,
        key=idempotency_key,
        digest=digest,
        result=result,
    )
    return result, False


async def authorize_session(
    session: AsyncSession,
    session_id: UUID,
    operation: str,
) -> None:
    actor_id = "NULLIF(current_setting('app.actor_id', true), '')::uuid"
    if operation == "read":
        await _visible_session(session, session_id)
        return
    elif operation == "edit":
        visible = await session.scalar(
            select(XAgentSession).where(
                XAgentSession.id == session_id,
                text(
                    f"((visibility = 'private' AND owner_id = {actor_id}) OR "
                    "(visibility = 'project' AND project_id IN "
                    "(SELECT public.xagent_authorized_project_edit_ids())))"
                ),
            )
        )
        if visible is not None:
            await _require_private_session_ref_access(session, visible)
            return
    elif operation == "owner":
        visible = await session.scalar(
            select(XAgentSession).where(
                XAgentSession.id == session_id,
                text(f"owner_id = {actor_id}"),
            )
        )
        if visible is not None:
            await _require_private_session_ref_access(session, visible)
            return
    raise SessionServiceError(SessionErrorCode.NOT_FOUND)


async def _private_session_refs_are_authorized(
    session: AsyncSession,
    item: XAgentSession,
) -> bool:
    if item.visibility != "private":
        return True
    inaccessible_session_ids = await _private_session_ids_with_inaccessible_refs(
        session,
        {item.id},
    )
    return item.id not in inaccessible_session_ids


async def _private_session_ids_with_inaccessible_refs(
    session: AsyncSession,
    session_ids: set[UUID],
) -> set[UUID]:
    if not session_ids:
        return set()
    references = (
        await session.execute(
            select(
                XAgentSessionProjectRef.session_id,
                XAgentSessionProjectRef.project_id,
            ).where(XAgentSessionProjectRef.session_id.in_(session_ids))
        )
    ).all()
    if not references:
        return set()
    project_ids = {project_id for _, project_id in references}
    visible_project_ids = set(
        (
            await session.scalars(
                select(Project.id).where(Project.id.in_(project_ids))
            )
        ).all()
    )
    return {
        session_id
        for session_id, project_id in references
        if project_id not in visible_project_ids
    }


async def _require_private_session_ref_access(
    session: AsyncSession,
    item: XAgentSession,
) -> None:
    if not await _private_session_refs_are_authorized(session, item):
        raise SessionServiceError(SessionErrorCode.SESSION_NOT_FOUND)


async def _visible_session(
    session: AsyncSession,
    session_id: UUID,
    *,
    lock: bool = False,
) -> XAgentSession:
    statement = select(XAgentSession).where(XAgentSession.id == session_id)
    if lock:
        statement = statement.with_for_update()
    item = await session.scalar(statement)
    if item is None:
        raise SessionServiceError(SessionErrorCode.NOT_FOUND)
    await _require_private_session_ref_access(session, item)
    return item


async def read_events(
    session: AsyncSession,
    session_id: UUID,
    *,
    after_sequence: int = -1,
    limit: int = 500,
) -> list[dict[str, Any]]:
    await _visible_session(session, session_id)
    rows = (
        await session.scalars(
            select(XAgentSessionEvent)
            .where(
                XAgentSessionEvent.session_id == session_id,
                XAgentSessionEvent.sequence > after_sequence,
            )
            .order_by(XAgentSessionEvent.sequence)
            .limit(limit)
        )
    ).all()
    return [event_payload(item) for item in rows]


async def open_session(session: AsyncSession, session_id: UUID) -> dict[str, Any]:
    item = await _visible_session(session, session_id)
    events = await read_events(session, session_id)
    return {
        "schema_version": PROTOCOL_VERSION,
        "session": session_payload(item),
        "events": events,
    }


def _receipt_claims(item: XAgentRetrievalReceipt) -> ReceiptClaims:
    return ReceiptClaims(
        kind=cast(ReceiptKind, item.kind),
        actor_id=item.actor_id,
        session_id=item.session_id,
        tool_call_id=item.tool_call_id,
        query_sha256=item.query_sha256,
        scope=item.scope,
        permission_revision=item.permission_revision,
        project_ids=tuple(UUID(value) for value in item.project_ids),
        index_generations=tuple(item.index_generations),
        chunk_ids=tuple(UUID(value) for value in item.chunk_ids),
        payload_sha256=item.payload_sha256,
        issued_at=item.issued_at,
        expires_at=item.expires_at,
        citation_ordinal_start=item.citation_ordinal_start,
        citation_ordinal_end=item.citation_ordinal_end,
    )


def _retrieval_public_payload(
    event: dict[str, Any],
    *,
    sequence: int,
    receipt_kind: str,
) -> tuple[str, str, dict[str, Any], dict[str, Any]]:
    try:
        payload = event["payload"]
        data = payload["data"]
        meta = data["meta"]
        message = data["message"]
        message_content = message["content"]
        if not isinstance(message_content, list) or len(message_content) != 1:
            raise ValueError
        result = message_content[0]
        result_content = result["content"]
        if not isinstance(result_content, list) or len(result_content) != 1:
            raise ValueError
        text_content = result_content[0]
        tool_call_id = result["toolCallId"]
        has_source_event_seqs = "sourceEventSeqs" in payload
        source_event_seqs = payload.get("sourceEventSeqs")
        if (
            event["event_type"] != "tool/result"
            or event["schema_version"] != 1
            or set(payload) - {"sourceEventSeqs"}
            != {"seq", "time", "type", "data", "surfaceOp"}
            or payload["type"] != "tool/result"
            or payload["surfaceOp"] != "append"
            or payload["seq"] != sequence
            or isinstance(payload["time"], bool)
            or not isinstance(payload["time"], int)
            or payload["time"] < 0
            or set(data) != {"turn", "step", "message", "meta"}
            or any(
                isinstance(data[key], bool)
                or not isinstance(data[key], int)
                or data[key] < 0
                for key in ("turn", "step")
            )
            or set(meta) != {"kind", "payloadHash", "citations"}
            or meta["kind"] != "xagent-retrieval"
            or set(message) != {"id", "role", "source", "content"}
            or not isinstance(message["id"], str)
            or not 1 <= len(message["id"]) <= 255
            or message["role"] != "user"
            or set(message["source"]) != {"kind", "callId"}
            or message["source"] != {"kind": "tool", "callId": tool_call_id}
            or set(result) != {"type", "toolCallId", "isError", "content"}
            or result["type"] != "tool-result"
            or result["isError"] is not False
            or result["toolCallId"] != tool_call_id
            or not isinstance(tool_call_id, str)
            or not 1 <= len(tool_call_id) <= 255
            or set(text_content) != {"type", "text"}
            or text_content["type"] != "text"
            or not isinstance(text_content["text"], str)
            or not isinstance(meta["payloadHash"], str)
            or not isinstance(meta["citations"], list)
            or (
                has_source_event_seqs
                and (
                    not isinstance(source_event_seqs, list)
                    or len(source_event_seqs) == 0
                    or len(source_event_seqs) > 100
                    or len(set(source_event_seqs)) != len(source_event_seqs)
                    or any(
                        isinstance(source, bool)
                        or not isinstance(source, int)
                        or source < 0
                        or source >= sequence
                        for source in source_event_seqs
                    )
                )
            )
        ):
            raise ValueError
        if receipt_kind == "artifact_search" and meta["citations"] == []:
            if text_content["text"] != "未找到符合当前明确范围的资料证据。":
                raise ValueError
            public = {"citations": []}
        else:
            public = json.loads(text_content["text"])
        expected_key = "projects" if receipt_kind == "project_discovery" else "citations"
        if set(public) != {expected_key} or not isinstance(public[expected_key], list):
            raise ValueError
        citation_ids = (
            [item["id"] for item in public["citations"]]
            if receipt_kind == "artifact_search"
            else []
        )
        if meta["citations"] != citation_ids:
            raise ValueError
        digest = payload_sha256({"schema_version": 1, **public})
        if meta["payloadHash"] != digest:
            raise ValueError
        canonical_text = (
            "未找到符合当前明确范围的资料证据。"
            if receipt_kind == "artifact_search" and public["citations"] == []
            else json.dumps(public, ensure_ascii=False, separators=(",", ":"))
        )
        canonical_payload = {
            "seq": sequence,
            "time": payload["time"],
            "type": "tool/result",
            "surfaceOp": "append",
            **(
                {"sourceEventSeqs": source_event_seqs}
                if has_source_event_seqs
                else {}
            ),
            "data": {
                "turn": data["turn"],
                "step": data["step"],
                "message": {
                    "id": message["id"],
                    "role": "user",
                    "source": {"kind": "tool", "callId": tool_call_id},
                    "content": [{
                        "type": "tool-result",
                        "toolCallId": tool_call_id,
                        "isError": False,
                        "content": [{"type": "text", "text": canonical_text}],
                    }],
                },
            },
        }
        return tool_call_id, digest, public, canonical_payload
    except (AttributeError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
        raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT) from None


def _validate_receipt_scope(item: XAgentSession, claims: ReceiptClaims) -> None:
    scope = claims.scope
    expected_keys = {"kind", "project_ids", "include_private", "sha256"}
    if (
        set(scope) != expected_keys
        or scope["kind"] != item.visibility
        or not isinstance(scope["sha256"], str)
        or len(scope["sha256"]) != 64
        or any(character not in "0123456789abcdef" for character in scope["sha256"])
    ):
        raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)
    expected_project_ids = (
        []
        if claims.kind == "project_discovery"
        else [str(value) for value in claims.project_ids]
    )
    if scope["project_ids"] != expected_project_ids:
        raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)
    if claims.kind == "project_discovery" and scope["include_private"] is not False:
        raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)
    if item.visibility == "project":
        if (
            item.project_id is None
            or claims.project_ids != (item.project_id,)
            or scope["include_private"] is not False
        ):
            raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)
    elif not isinstance(scope["include_private"], bool):
        raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)


def _validate_project_discovery(public: dict[str, Any], claims: ReceiptClaims) -> None:
    projects = public["projects"]
    try:
        if len(projects) > 20 or any(set(project) != {"project_id", "name"} for project in projects):
            raise ValueError
        project_ids = tuple(UUID(project["project_id"]) for project in projects)
        if project_ids != claims.project_ids or any(
            not isinstance(project["name"], str) or not project["name"]
            for project in projects
        ):
            raise ValueError
        if (
            claims.chunk_ids
            or claims.index_generations
            or claims.citation_ordinal_start is not None
            or claims.citation_ordinal_end is not None
        ):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT) from None


async def _validate_artifact_search(
    session: AsyncSession,
    public: dict[str, Any],
    claims: ReceiptClaims,
) -> dict[UUID, RetrievalCandidate]:
    citations = public["citations"]
    citation_keys = {
        "id", "artifact_id", "version_id", "chunk_id", "display_name",
        "version_number", "line_start", "line_end", "text", "scope",
    }
    try:
        if len(citations) > 8 or any(set(citation) != citation_keys for citation in citations):
            raise ValueError
        start = claims.citation_ordinal_start
        end = claims.citation_ordinal_end
        if not citations:
            if claims.chunk_ids or start is not None or end is not None:
                raise ValueError
            return {}
        if start is None or end != start + len(citations) - 1:
            raise ValueError
        if [citation["id"] for citation in citations] != [
            f"[资料{start + offset}]" for offset in range(len(citations))
        ]:
            raise ValueError
        identities = [
            (UUID(citation["artifact_id"]), UUID(citation["version_id"]), UUID(citation["chunk_id"]))
            for citation in citations
        ]
        if tuple(identity[2] for identity in identities) != claims.chunk_ids:
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT) from None
    try:
        candidates = await authorize_citation_chunks(session, identities=identities)
    except RetrievalError:
        raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT) from None
    by_chunk = {candidate.chunk_id: candidate for candidate in candidates}
    try:
        generations = {
            UUID(entry["index_id"]): entry["generation"]
            for entry in claims.index_generations
        }
    except (KeyError, TypeError, ValueError):
        raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT) from None
    if len(generations) != len(claims.index_generations):
        raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)
    for citation, identity in zip(citations, identities, strict=True):
        candidate = by_chunk.get(identity[2])
        if candidate is None or (
            candidate.artifact_id != identity[0]
            or candidate.version_id != identity[1]
            or generations.get(candidate.index_id) != candidate.generation
            or citation["display_name"] != candidate.filename
            or citation["version_number"] != candidate.version_number
            or citation["line_start"] != candidate.line_start
            or citation["line_end"] != candidate.line_end
            or citation["text"] != candidate.text
            or citation["scope"] != ("project" if candidate.project_id is not None else "private")
            or (
                candidate.project_id is not None
                and candidate.project_id not in claims.project_ids
            )
        ):
            raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)
    return by_chunk


@dataclass
class _PendingRetrievalAdmission:
    sequence: int
    receipt: XAgentRetrievalReceipt
    claims: ReceiptClaims
    tool_call_id: str
    digest: str
    public: dict[str, Any]
    canonical_payload: dict[str, Any]


@dataclass(frozen=True)
class _AdmittedRetrieval:
    tool_call_id: str
    payload: dict[str, Any]
    audit_id: UUID


@dataclass(frozen=True)
class _CitationEvidence:
    admission_sequence: int
    artifact_id: UUID
    version_id: UUID
    index_id: UUID
    index_generation: int
    chunk_id: UUID


async def _load_retrieval_admissions(
    session: AsyncSession,
    principal: Principal,
    item: XAgentSession,
    *,
    expected_sequence: int,
    events: list[dict[str, Any]],
    attachments: list[dict[str, Any]],
) -> list[_PendingRetrievalAdmission]:
    by_sequence: dict[int, dict[str, Any]] = {}
    for attachment in attachments:
        sequence = attachment["event_sequence"]
        if sequence in by_sequence:
            raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)
        by_sequence[sequence] = attachment
    retrieval_sequences = {
        expected_sequence + offset
        for offset, event in enumerate(events, start=1)
        if isinstance(event.get("payload", {}).get("data", {}).get("meta"), dict)
        and event["payload"]["data"]["meta"].get("kind") == "xagent-retrieval"
    }
    if retrieval_sequences != set(by_sequence):
        raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)

    pending: list[_PendingRetrievalAdmission] = []
    for sequence in sorted(by_sequence):
        attachment = by_sequence[sequence]
        event = events[sequence - expected_sequence - 1]
        receipt_id = receipt_digest_id(attachment["receipt"])
        receipt = await session.scalar(
            select(XAgentRetrievalReceipt)
            .where(XAgentRetrievalReceipt.id == receipt_id)
            .with_for_update()
        )
        if receipt is None or receipt.consumed_at is not None:
            raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)
        claims = _receipt_claims(receipt)
        try:
            verify_receipt(attachment["receipt"], receipt.id, claims, claims)
        except RetrievalReceiptError as error:
            code = (
                SessionErrorCode.EVIDENCE_EXPIRED
                if error.code == "evidence-expired"
                else SessionErrorCode.EVIDENCE_CONFLICT
            )
            raise SessionServiceError(code) from None
        tool_call_id, digest, public, canonical_payload = _retrieval_public_payload(
            event,
            sequence=sequence,
            receipt_kind=receipt.kind,
        )
        if attachment["receipt"] in json.dumps(
            canonical_payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ):
            raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)
        if (
            receipt.actor_id != principal.actor_id
            or receipt.session_id != item.id
            or receipt.permission_revision != principal.permission_revision
            or receipt.tool_call_id != attachment["tool_call_id"]
            or tool_call_id != attachment["tool_call_id"]
            or digest != attachment["payload_hash"]
            or digest != receipt.payload_sha256
        ):
            raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)
        _validate_receipt_scope(item, claims)
        if receipt.kind == "project_discovery":
            _validate_project_discovery(public, claims)
        pending.append(_PendingRetrievalAdmission(
            sequence=sequence,
            receipt=receipt,
            claims=claims,
            tool_call_id=tool_call_id,
            digest=digest,
            public=public,
            canonical_payload=canonical_payload,
        ))
    return pending


async def _session_ref_project_ids(
    session: AsyncSession,
    session_id: UUID,
) -> tuple[UUID, ...]:
    return tuple((await session.scalars(
        select(XAgentSessionProjectRef.project_id)
        .where(XAgentSessionProjectRef.session_id == session_id)
        .order_by(XAgentSessionProjectRef.project_id)
    )).all())


async def _finalize_append_authorization(
    session: AsyncSession,
    principal: Principal,
    item: XAgentSession,
    pending: list[_PendingRetrievalAdmission],
) -> XAgentSession:
    existing_project_ids = await _session_ref_project_ids(session, item.id)
    project_ids = set(existing_project_ids)
    if item.project_id is not None:
        project_ids.add(item.project_id)
    for admission in pending:
        project_ids.update(admission.claims.project_ids)
    ordered_project_ids = tuple(sorted(project_ids))
    try:
        authorized = await session.scalar(
            text(
                "SELECT public.xagent_finalize_retrieval_authorization"
                "(:session_id, :permission_revision, CAST(:project_ids AS uuid[]))"
            ),
            {
                "session_id": item.id,
                "permission_revision": principal.permission_revision,
                "project_ids": list(ordered_project_ids),
            },
        )
    except Exception:
        raise SessionServiceError(SessionErrorCode.SERVICE_UNAVAILABLE) from None
    if authorized is not True:
        raise SessionServiceError(SessionErrorCode.SESSION_NOT_FOUND)
    refreshed = await _visible_session(session, item.id, lock=True)
    refreshed_refs = await _session_ref_project_ids(session, item.id)
    if set(refreshed_refs) != set(existing_project_ids):
        raise SessionServiceError(SessionErrorCode.SESSION_NOT_FOUND)
    try:
        await authorize_projects(
            session,
            principal.actor_id,
            ordered_project_ids,
            ProjectAction.READ,
        )
    except ForbiddenError:
        raise SessionServiceError(SessionErrorCode.SESSION_NOT_FOUND) from None
    return refreshed


def _audit_evidence(candidates: list[RetrievalCandidate]) -> list[dict[str, object]]:
    return [{
        "artifact_id": str(candidate.artifact_id),
        "version_id": str(candidate.version_id),
        "index_id": str(candidate.index_id),
        "generation": candidate.generation,
        "chunk_id": str(candidate.chunk_id),
    } for candidate in candidates]


async def _admit_retrieval_receipts(
    session: AsyncSession,
    principal: Principal,
    item: XAgentSession,
    pending: list[_PendingRetrievalAdmission],
) -> dict[int, _AdmittedRetrieval]:
    admitted: dict[int, _AdmittedRetrieval] = {}
    for admission in pending:
        candidates_by_chunk = (
            {}
            if admission.receipt.kind == "project_discovery"
            else await _validate_artifact_search(
                session,
                admission.public,
                admission.claims,
            )
        )
        candidates = [
            candidates_by_chunk[UUID(citation["chunk_id"])]
            for citation in admission.public.get("citations", [])
        ]
        evidence = _audit_evidence(candidates)
        public_items = (
            admission.public["projects"]
            if admission.receipt.kind == "project_discovery"
            else admission.public["citations"]
        )
        metadata_evidence = [{
            "citationId": citation["id"],
            "artifactId": str(candidate.artifact_id),
            "versionId": str(candidate.version_id),
            "chunkId": str(candidate.chunk_id),
            "indexId": str(candidate.index_id),
            "generation": candidate.generation,
        } for citation, candidate in zip(
            admission.public.get("citations", []),
            candidates,
            strict=True,
        )]
        admission.canonical_payload["data"]["meta"] = {
            "kind": "xagent-retrieval",
            "tool": admission.receipt.kind,
            "payloadHash": admission.digest,
            "scopeHash": admission.claims.scope["sha256"],
            "queryHash": admission.claims.query_sha256,
            "citations": [
                citation["id"] for citation in admission.public.get("citations", [])
            ],
            "evidence": metadata_evidence,
        }
        audit = await write_audit_event(
            session,
            principal.actor_id,
            "retrieval.evidence_admission",
            "xagent_session",
            item.id,
            item.id,
            "allowed",
            details=retrieval_audit_details(
                session_id=str(item.id),
                tool_call_id=admission.tool_call_id,
                project_scope_sha256=admission.claims.scope["sha256"],
                query_sha256=admission.claims.query_sha256,
                candidate_count=len(public_items),
                returned_count=len(public_items),
                result="allowed",
                latency_ms=0,
                evidence=evidence,
            ),
        )
        if item.visibility == "private" and admission.claims.project_ids:
            await session.execute(
                insert(XAgentSessionProjectRef)
                .values([
                    {"session_id": item.id, "project_id": project_id}
                    for project_id in admission.claims.project_ids
                ])
                .on_conflict_do_nothing(index_elements=["session_id", "project_id"])
            )
        admission.receipt.consumed_at = datetime.now(UTC)
        admission.receipt.consumed_event_sequence = admission.sequence
        admission.receipt.consumed_payload_sha256 = admission.digest
        admitted[admission.sequence] = _AdmittedRetrieval(
            tool_call_id=admission.tool_call_id,
            payload=admission.canonical_payload,
            audit_id=audit.id,
        )
    return admitted


def _citation_id(value: object) -> str:
    if (
        not isinstance(value, str)
        or len(value) > 32
        or not value.startswith("[资料")
        or not value.endswith("]")
    ):
        raise ValueError
    ordinal = value[3:-1]
    if not ordinal.isascii() or not ordinal.isdigit() or ordinal.startswith("0"):
        raise ValueError
    return value


def _canonical_uuid(value: object) -> UUID:
    if not isinstance(value, str):
        raise ValueError
    parsed = UUID(value)
    if str(parsed) != value:
        raise ValueError
    return parsed


def _valid_source_event_sequences(payload: dict[str, Any], sequence: int) -> bool:
    if "sourceEventSeqs" not in payload:
        return True
    values = payload["sourceEventSeqs"]
    return (
        isinstance(values, list)
        and 1 <= len(values) <= 100
        and len(set(values)) == len(values)
        and all(
            not isinstance(value, bool)
            and isinstance(value, int)
            and 0 <= value < sequence
            for value in values
        )
    )


def _canonical_retrieval_evidence(
    *,
    event_type: object,
    schema_version: object,
    payload: object,
    sequence: int,
) -> list[tuple[str, _CitationEvidence]] | None:
    """Parse exact server-canonical retrieval metadata from one durable event."""
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    meta = data.get("meta") if isinstance(data, dict) else None
    if not isinstance(meta, dict) or meta.get("kind") != "xagent-retrieval":
        return None
    try:
        if (
            event_type != "tool/result"
            or schema_version != 1
            or set(payload) - {"sourceEventSeqs"}
            != {"seq", "time", "type", "data", "surfaceOp"}
            or payload["seq"] != sequence
            or payload["type"] != "tool/result"
            or payload["surfaceOp"] != "append"
            or not _valid_source_event_sequences(payload, sequence)
            or set(data) != {"turn", "step", "message", "meta"}
            or set(meta)
            != {
                "kind", "tool", "payloadHash", "scopeHash", "queryHash",
                "citations", "evidence",
            }
            or meta["tool"] not in {"project_discovery", "artifact_search"}
            or any(
                not isinstance(meta[key], str)
                or len(meta[key]) != 64
                or any(character not in "0123456789abcdef" for character in meta[key])
                for key in ("payloadHash", "scopeHash", "queryHash")
            )
            or not isinstance(meta["citations"], list)
            or not isinstance(meta["evidence"], list)
            or len(meta["citations"]) > 8
            or len(meta["citations"]) != len(meta["evidence"])
        ):
            raise ValueError
        citation_ids = [_citation_id(value) for value in meta["citations"]]
        if len(set(citation_ids)) != len(citation_ids):
            raise ValueError
        parsed: list[tuple[str, _CitationEvidence]] = []
        for citation_id, value in zip(citation_ids, meta["evidence"], strict=True):
            if (
                not isinstance(value, dict)
                or set(value)
                != {
                    "citationId", "artifactId", "versionId", "chunkId",
                    "indexId", "generation",
                }
                or value["citationId"] != citation_id
                or isinstance(value["generation"], bool)
                or not isinstance(value["generation"], int)
                or value["generation"] < 1
            ):
                raise ValueError
            parsed.append((
                citation_id,
                _CitationEvidence(
                    admission_sequence=sequence,
                    artifact_id=_canonical_uuid(value["artifactId"]),
                    version_id=_canonical_uuid(value["versionId"]),
                    index_id=_canonical_uuid(value["indexId"]),
                    index_generation=value["generation"],
                    chunk_id=_canonical_uuid(value["chunkId"]),
                ),
            ))
        return parsed
    except (KeyError, TypeError, ValueError):
        raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT) from None


def _canonical_cited_answer(
    event: dict[str, Any],
    *,
    sequence: int,
) -> tuple[str, list[str]] | None:
    payload = event.get("payload")
    data = payload.get("data") if isinstance(payload, dict) else None
    meta = data.get("meta") if isinstance(data, dict) else None
    if not isinstance(meta, dict) or meta.get("kind") != "xagent-cited-answer":
        return None
    try:
        message = data["message"]
        content = message["content"]
        if not isinstance(content, list) or len(content) != 1:
            raise ValueError
        result = content[0]
        result_content = result["content"]
        if not isinstance(result_content, list) or len(result_content) != 1:
            raise ValueError
        text_content = result_content[0]
        tool_call_id = result["toolCallId"]
        if (
            event.get("event_type") != "tool/result"
            or event.get("schema_version") != 1
            or set(payload) - {"sourceEventSeqs"}
            != {"seq", "time", "type", "data", "surfaceOp"}
            or payload["seq"] != sequence
            or payload["type"] != "tool/result"
            or payload["surfaceOp"] != "append"
            or isinstance(payload["time"], bool)
            or not isinstance(payload["time"], int)
            or payload["time"] < 0
            or not _valid_source_event_sequences(payload, sequence)
            or set(data) != {"turn", "step", "message", "meta"}
            or any(
                isinstance(data[key], bool)
                or not isinstance(data[key], int)
                or data[key] < 0
                for key in ("turn", "step")
            )
            or set(meta) != {"kind", "schemaVersion", "blocks", "citationIds"}
            or meta["schemaVersion"] != 1
            or not isinstance(meta["blocks"], list)
            or not 1 <= len(meta["blocks"]) <= 256
            or not isinstance(meta["citationIds"], list)
            or set(message) != {"id", "role", "source", "content"}
            or not isinstance(message["id"], str)
            or not 1 <= len(message["id"]) <= 255
            or message["role"] != "user"
            or set(message["source"]) != {"kind", "callId"}
            or message["source"] != {"kind": "tool", "callId": tool_call_id}
            or set(result) != {"type", "toolCallId", "isError", "content"}
            or result["type"] != "tool-result"
            or result["isError"] is not False
            or result["toolCallId"] != tool_call_id
            or not isinstance(tool_call_id, str)
            or not 1 <= len(tool_call_id) <= 255
            or set(text_content) != {"type", "text"}
            or text_content["type"] != "text"
            or not isinstance(text_content["text"], str)
            or len(json.dumps(
                {"blocks": meta["blocks"]},
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()) > 64 * 1024
        ):
            raise ValueError
        citation_count = 0
        has_markdown = False
        rendered: list[str] = []
        first_use: list[str] = []
        seen: set[str] = set()
        previous_citation: str | None = None
        for block in meta["blocks"]:
            if not isinstance(block, dict) or not isinstance(block.get("type"), str):
                raise ValueError
            if block["type"] == "markdown":
                if set(block) != {"type", "text"} or not isinstance(block["text"], str):
                    raise ValueError
                has_markdown = has_markdown or bool(block["text"])
                rendered.append(block["text"])
                previous_citation = None
            elif block["type"] == "citation":
                if set(block) != {"type", "id"}:
                    raise ValueError
                citation_id = _citation_id(block["id"])
                citation_count += 1
                if citation_count > 64 or citation_id == previous_citation:
                    raise ValueError
                rendered.append(f"【已验证资料：{citation_id}】")
                previous_citation = citation_id
                if citation_id not in seen:
                    seen.add(citation_id)
                    first_use.append(citation_id)
            else:
                raise ValueError
        if (
            not has_markdown
            or citation_count == 0
            or meta["citationIds"] != first_use
            or text_content["text"] != "".join(rendered)
        ):
            raise ValueError
        return tool_call_id, first_use
    except (KeyError, TypeError, ValueError):
        raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT) from None


async def _cited_answer_provenance(
    session: AsyncSession,
    item: XAgentSession,
    *,
    expected_sequence: int,
    events: list[dict[str, Any]],
    admitted: dict[int, _AdmittedRetrieval],
) -> tuple[list[XAgentCitedAnswerEvidence], dict[int, str]]:
    """Bind new cited answers to prior server-canonical retrieval events."""
    evidence_by_id: dict[str, _CitationEvidence] = {}

    def add_evidence(values: list[tuple[str, _CitationEvidence]] | None) -> None:
        for citation_id, evidence in values or []:
            if citation_id in evidence_by_id:
                raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)
            evidence_by_id[citation_id] = evidence

    previous = (
        await session.scalars(
            select(XAgentSessionEvent)
            .where(
                XAgentSessionEvent.session_id == item.id,
                XAgentSessionEvent.sequence <= expected_sequence,
            )
            .order_by(XAgentSessionEvent.sequence)
        )
    ).all()
    for stored in previous:
        add_evidence(_canonical_retrieval_evidence(
            event_type=stored.event_type,
            schema_version=stored.schema_version,
            payload=stored.payload,
            sequence=stored.sequence,
        ))

    provenance: list[XAgentCitedAnswerEvidence] = []
    answer_tool_calls: dict[int, str] = {}
    for offset, event in enumerate(events, start=1):
        sequence = expected_sequence + offset
        admission = admitted.get(sequence)
        if admission is not None:
            add_evidence(_canonical_retrieval_evidence(
                event_type="tool/result",
                schema_version=1,
                payload=admission.payload,
                sequence=sequence,
            ))
        answer = _canonical_cited_answer(event, sequence=sequence)
        if answer is None:
            continue
        tool_call_id, citation_ids = answer
        answer_tool_calls[sequence] = tool_call_id
        for citation_id in citation_ids:
            evidence = evidence_by_id.get(citation_id)
            if evidence is None or evidence.admission_sequence >= sequence:
                raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)
            provenance.append(XAgentCitedAnswerEvidence(
                session_id=item.id,
                answer_event_sequence=sequence,
                citation_id=citation_id,
                admission_event_sequence=evidence.admission_sequence,
                artifact_id=evidence.artifact_id,
                version_id=evidence.version_id,
                index_id=evidence.index_id,
                index_generation=evidence.index_generation,
                chunk_id=evidence.chunk_id,
            ))
    return provenance, answer_tool_calls


async def _reject_consumed_receipt_reuse(
    session: AsyncSession,
    attachments: list[dict[str, Any]],
) -> None:
    for attachment in attachments:
        receipt = await session.scalar(
            select(XAgentRetrievalReceipt)
            .where(
                XAgentRetrievalReceipt.id
                == receipt_digest_id(attachment["receipt"])
            )
            .with_for_update()
        )
        if receipt is None or receipt.consumed_at is None:
            continue
        claims = _receipt_claims(receipt)
        try:
            verify_receipt(attachment["receipt"], receipt.id, claims, claims)
        except RetrievalReceiptError as error:
            if error.code == "evidence-expired":
                raise SessionServiceError(SessionErrorCode.EVIDENCE_EXPIRED) from None
        raise SessionServiceError(SessionErrorCode.EVIDENCE_CONFLICT)


async def write_append_admission_denial(
    session: AsyncSession,
    principal: Principal,
    *,
    session_id: UUID,
    attachments: list[dict[str, Any]],
    result: str,
) -> None:
    """Write one closed denial audit without retaining the private sidecar."""
    fallback_hash = hashlib.sha256(b"unavailable").hexdigest()
    tool_call_id = "missing-receipt"
    scope_hash = fallback_hash
    query_hash = fallback_hash
    candidate_count = 0
    if attachments:
        attachment = attachments[0]
        tool_call_id = attachment["tool_call_id"]
        receipt = await session.scalar(
            select(XAgentRetrievalReceipt).where(
                XAgentRetrievalReceipt.id == receipt_digest_id(attachment["receipt"])
            )
        )
        if receipt is not None:
            claims = _receipt_claims(receipt)
            if (
                isinstance(claims.scope.get("sha256"), str)
                and len(claims.scope["sha256"]) == 64
            ):
                scope_hash = claims.scope["sha256"]
            query_hash = claims.query_sha256
            candidate_count = len(
                claims.project_ids
                if claims.kind == "project_discovery"
                else claims.chunk_ids
            )
    await write_audit_event(
        session,
        principal.actor_id,
        "retrieval.evidence_admission",
        "xagent_session",
        session_id,
        session_id,
        result,
        details=retrieval_audit_details(
            session_id=str(session_id),
            tool_call_id=tool_call_id,
            project_scope_sha256=scope_hash,
            query_sha256=query_hash,
            candidate_count=candidate_count,
            returned_count=0,
            result=result,
            latency_ms=0,
        ),
    )


async def append_events(
    session: AsyncSession,
    principal: Principal,
    *,
    session_id: UUID,
    expected_sequence: int,
    events: list[dict[str, Any]],
    retrieval_receipts: list[dict[str, Any]],
    idempotency_key: str,
    digest: str,
) -> dict[str, Any]:
    operation = f"session.append:{session_id}"
    item = await _visible_session(session, session_id, lock=True)
    replay = await _idempotent_result(
        session,
        actor_id=principal.actor_id,
        operation=operation,
        key=idempotency_key,
        digest=digest,
    )
    if replay is not None:
        return replay
    await _reject_consumed_receipt_reuse(session, retrieval_receipts)
    if item.last_event_sequence != expected_sequence:
        raise SessionServiceError(SessionErrorCode.SEQUENCE_CONFLICT)
    pending = await _load_retrieval_admissions(
        session,
        principal,
        item,
        expected_sequence=expected_sequence,
        events=events,
        attachments=retrieval_receipts,
    )
    if pending:
        item = await _finalize_append_authorization(session, principal, item, pending)
    admitted = await _admit_retrieval_receipts(
        session,
        principal,
        item,
        pending,
    )
    provenance, answer_tool_calls = await _cited_answer_provenance(
        session,
        item,
        expected_sequence=expected_sequence,
        events=events,
        admitted=admitted,
    )
    for offset, event in enumerate(events, start=1):
        sequence = expected_sequence + offset
        admission = admitted.get(sequence)
        session.add(
            XAgentSessionEvent(
                session_id=session_id,
                sequence=sequence,
                event_type=event["event_type"],
                schema_version=event["schema_version"],
                payload=(admission.payload if admission is not None else event["payload"]),
                actor_id=principal.actor_id,
                tool_call_id=(
                    admission.tool_call_id
                    if admission is not None
                    else answer_tool_calls.get(sequence, event.get("tool_call_id"))
                ),
                audit_id=(admission.audit_id if admission is not None else None),
            )
        )
    item.last_event_sequence = expected_sequence + len(events)
    item.version += 1
    await session.flush()
    session.add_all(provenance)
    await session.flush()
    result = {
        "schema_version": PROTOCOL_VERSION,
        "last_event_sequence": item.last_event_sequence,
        "version": item.version,
    }
    await _store_idempotent_result(
        session,
        actor_id=principal.actor_id,
        operation=operation,
        key=idempotency_key,
        digest=digest,
        result=result,
    )
    return result


async def fork_session(
    session: AsyncSession,
    principal: Principal,
    *,
    source_id: UUID,
    through_sequence: int,
    title: str | None,
    idempotency_key: str,
    digest: str,
) -> tuple[dict[str, Any], bool]:
    operation = f"session.fork:{source_id}"
    source = await _visible_session(session, source_id, lock=True)
    replay = await _idempotent_result(
        session,
        actor_id=principal.actor_id,
        operation=operation,
        key=idempotency_key,
        digest=digest,
    )
    if replay is not None:
        return replay, True
    if through_sequence < -1 or through_sequence > source.last_event_sequence:
        raise SessionServiceError(SessionErrorCode.SEQUENCE_CONFLICT)
    target_id = uuid4()
    runtime_header = _fork_runtime_header(
        source,
        target_id=target_id,
        through_sequence=through_sequence,
    )
    target = XAgentSession(
        id=target_id,
        owner_id=principal.actor_id,
        project_id=source.project_id,
        visibility=source.visibility,
        permission_revision_created=principal.permission_revision,
        title=source.title if title is None else title,
        runtime_header=runtime_header,
        last_event_sequence=through_sequence,
        next_citation_ordinal=source.next_citation_ordinal,
    )
    session.add(target)
    await session.flush()
    if source.visibility == "private":
        await session.execute(
            text(
                "SELECT public.xagent_copy_private_session_project_refs("
                ":source_id, :target_id)"
            ),
            {"source_id": source.id, "target_id": target.id},
        )
    source_events = (
        await session.scalars(
            select(XAgentSessionEvent)
            .where(
                XAgentSessionEvent.session_id == source_id,
                XAgentSessionEvent.sequence <= through_sequence,
            )
            .order_by(XAgentSessionEvent.sequence)
        )
    ).all()
    for event in source_events:
        session.add(
            XAgentSessionEvent(
                session_id=target.id,
                sequence=event.sequence,
                event_type=event.event_type,
                schema_version=event.schema_version,
                payload=event.payload,
                actor_id=principal.actor_id,
                tool_call_id=event.tool_call_id,
                audit_id=event.audit_id,
            )
        )
    await session.flush()
    source_provenance = (
        await session.scalars(
            select(XAgentCitedAnswerEvidence)
            .where(
                XAgentCitedAnswerEvidence.session_id == source_id,
                XAgentCitedAnswerEvidence.answer_event_sequence <= through_sequence,
                XAgentCitedAnswerEvidence.admission_event_sequence <= through_sequence,
            )
            .order_by(
                XAgentCitedAnswerEvidence.answer_event_sequence,
                XAgentCitedAnswerEvidence.citation_id,
            )
        )
    ).all()
    session.add_all([
        XAgentCitedAnswerEvidence(
            session_id=target.id,
            answer_event_sequence=value.answer_event_sequence,
            citation_id=value.citation_id,
            admission_event_sequence=value.admission_event_sequence,
            artifact_id=value.artifact_id,
            version_id=value.version_id,
            index_id=value.index_id,
            index_generation=value.index_generation,
            chunk_id=value.chunk_id,
        )
        for value in source_provenance
    ])
    await session.flush()
    result = {"schema_version": PROTOCOL_VERSION, "session": session_payload(target)}
    await _store_idempotent_result(
        session,
        actor_id=principal.actor_id,
        operation=operation,
        key=idempotency_key,
        digest=digest,
        result=result,
    )
    return result, False


def _fork_runtime_header(
    source: XAgentSession,
    *,
    target_id: UUID,
    through_sequence: int,
) -> dict[str, Any] | None:
    """Derive ordinary-fork runtime metadata only from the persisted source."""
    header = source.runtime_header
    if header is None:
        return None
    source_runtime_id = f"session-{source.id}"
    if (
        not isinstance(header, dict)
        or header.get("version") != 0
        or header.get("id") != source_runtime_id
        or isinstance(header.get("createdAt"), bool)
        or not isinstance(header.get("createdAt"), int)
        or header["createdAt"] < 0
        or ("cwd" in header and not isinstance(header["cwd"], str))
        or ("agentPreset" in header and not isinstance(header["agentPreset"], str))
    ):
        raise SessionServiceError(SessionErrorCode.SERVICE_UNAVAILABLE)
    return {
        "version": 0,
        "id": f"session-{target_id}",
        "createdAt": int(datetime.now(UTC).timestamp() * 1000),
        **({"cwd": header["cwd"]} if "cwd" in header else {}),
        "parentSession": source_runtime_id,
        "seedLength": through_sequence + 1,
        **({"agentPreset": header["agentPreset"]} if "agentPreset" in header else {}),
    }


async def archive_session(
    session: AsyncSession,
    session_id: UUID,
    *,
    expected_version: int,
) -> dict[str, Any]:
    item = await _visible_session(session, session_id, lock=True)
    if item.version != expected_version:
        raise SessionServiceError(SessionErrorCode.SEQUENCE_CONFLICT)
    item.archived = True
    item.version += 1
    await session.flush()
    return {"schema_version": PROTOCOL_VERSION, "session": session_payload(item)}
