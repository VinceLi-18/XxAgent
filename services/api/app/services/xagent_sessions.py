import hashlib
import json
from datetime import UTC, datetime, timedelta
from enum import Enum
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project
from app.models.workbench import XAgentSessionProjectRef
from app.models.xagent_session import XAgentIdempotencyKey, XAgentSession, XAgentSessionEvent
from app.services.auth import Principal

PROTOCOL_VERSION = 1


class SessionErrorCode(str, Enum):
    NOT_FOUND = "not-found"
    SESSION_NOT_FOUND = "session-not-found"
    SEQUENCE_CONFLICT = "sequence-conflict"
    IDEMPOTENCY_CONFLICT = "idempotency-conflict"
    UNSUPPORTED_VERSION = "unsupported-version"


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


async def append_events(
    session: AsyncSession,
    principal: Principal,
    *,
    session_id: UUID,
    expected_sequence: int,
    events: list[dict[str, Any]],
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
    if item.last_event_sequence != expected_sequence:
        raise SessionServiceError(SessionErrorCode.SEQUENCE_CONFLICT)
    for offset, event in enumerate(events, start=1):
        session.add(
            XAgentSessionEvent(
                session_id=session_id,
                sequence=expected_sequence + offset,
                event_type=event["event_type"],
                schema_version=event["schema_version"],
                payload=event["payload"],
                actor_id=principal.actor_id,
                tool_call_id=event.get("tool_call_id"),
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
