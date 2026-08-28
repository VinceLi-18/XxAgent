import hashlib
import json
from datetime import UTC, datetime, timedelta
from enum import Enum
from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project, ProjectAction
from app.models.retrieval import XAgentRetrievalReceipt
from app.models.workbench import XAgentSessionProjectRef
from app.models.xagent_session import XAgentIdempotencyKey, XAgentSession, XAgentSessionEvent
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
) -> tuple[str, str, dict[str, Any]]:
    try:
        payload = event["payload"]
        data = payload["data"]
        meta = data["meta"]
        message = data["message"]
        result = message["content"][0]
        tool_call_id = result["toolCallId"]
        if (
            event["event_type"] != "tool/result"
            or payload["type"] != "tool/result"
            or payload["seq"] != sequence
            or set(meta) != {"kind", "payloadHash", "citations"}
            or meta["kind"] != "xagent-retrieval"
            or message["source"] != {"kind": "tool", "callId": tool_call_id}
            or result["type"] != "tool-result"
            or result["isError"] is not False
            or result["toolCallId"] != tool_call_id
            or not isinstance(meta["payloadHash"], str)
            or not isinstance(meta["citations"], list)
        ):
            raise ValueError
        content = result["content"]
        if receipt_kind == "artifact_search" and meta["citations"] == []:
            if content != [{"type": "text", "text": "未找到符合当前明确范围的资料证据。"}]:
                raise ValueError
            public = {"citations": []}
        else:
            if (
                not isinstance(content, list)
                or len(content) != 1
                or content[0].get("type") != "text"
                or not isinstance(content[0].get("text"), str)
            ):
                raise ValueError
            public = json.loads(content[0]["text"])
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
        return tool_call_id, digest, public
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
) -> list[RetrievalCandidate]:
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
            return []
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
    return candidates


async def _admit_retrieval_receipts(
    session: AsyncSession,
    principal: Principal,
    item: XAgentSession,
    *,
    expected_sequence: int,
    events: list[dict[str, Any]],
    attachments: list[dict[str, Any]],
) -> dict[int, str]:
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

    admitted: dict[int, str] = {}
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
        tool_call_id, digest, public = _retrieval_public_payload(
            event,
            sequence=sequence,
            receipt_kind=receipt.kind,
        )
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
        try:
            await authorize_projects(session, principal.actor_id, claims.project_ids, ProjectAction.READ)
        except ForbiddenError:
            raise SessionServiceError(SessionErrorCode.SESSION_NOT_FOUND) from None
        if receipt.kind == "project_discovery":
            _validate_project_discovery(public, claims)
        else:
            await _validate_artifact_search(session, public, claims)
        if item.visibility == "private" and claims.project_ids:
            await session.execute(
                insert(XAgentSessionProjectRef)
                .values([
                    {"session_id": item.id, "project_id": project_id}
                    for project_id in claims.project_ids
                ])
                .on_conflict_do_nothing(index_elements=["session_id", "project_id"])
            )
        receipt.consumed_at = datetime.now(UTC)
        receipt.consumed_event_sequence = sequence
        receipt.consumed_payload_sha256 = digest
        admitted[sequence] = tool_call_id
    return admitted


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
    admitted = await _admit_retrieval_receipts(
        session,
        principal,
        item,
        expected_sequence=expected_sequence,
        events=events,
        attachments=retrieval_receipts,
    )
    for offset, event in enumerate(events, start=1):
        sequence = expected_sequence + offset
        admitted_identity = admitted.get(sequence)
        session.add(
            XAgentSessionEvent(
                session_id=session_id,
                sequence=sequence,
                event_type=event["event_type"],
                schema_version=event["schema_version"],
                payload=event["payload"],
                actor_id=principal.actor_id,
                tool_call_id=(
                    admitted_identity
                    if admitted_identity is not None
                    else event.get("tool_call_id")
                ),
            )
        )
    item.last_event_sequence = expected_sequence + len(events)
    item.version += 1
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
    title: str,
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
    target = XAgentSession(
        id=uuid4(),
        owner_id=principal.actor_id,
        project_id=source.project_id,
        visibility=source.visibility,
        permission_revision_created=principal.permission_revision,
        title=title,
        last_event_sequence=through_sequence,
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
