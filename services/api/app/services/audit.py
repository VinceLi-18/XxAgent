from typing import Any, Literal
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditEvent


async def write_audit_event(
    session: AsyncSession,
    actor_id: UUID,
    action: str,
    resource_type: str,
    resource_id: UUID,
    request_id: UUID,
    result: str,
    *,
    executor_kind: Literal["account", "artifact_worker"] = "account",
    artifact_id: UUID | None = None,
    version_id: UUID | None = None,
    index_id: UUID | None = None,
    index_generation: int | None = None,
    details: dict[str, Any] | None = None,
) -> AuditEvent:
    event = AuditEvent(
        id=uuid4(),
        actor_id=actor_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        request_id=request_id,
        result=result,
        executor_kind=executor_kind,
        artifact_id=artifact_id,
        version_id=version_id,
        index_id=index_id,
        index_generation=index_generation,
        details=details or {},
    )
    if executor_kind == "artifact_worker":
        await session.execute(
            AuditEvent.__table__.insert().values(
                id=event.id,
                actor_id=actor_id,
                action=action,
                resource_type=resource_type,
                resource_id=resource_id,
                request_id=request_id,
                result=result,
                executor_kind=executor_kind,
                artifact_id=artifact_id,
                version_id=version_id,
                index_id=index_id,
                index_generation=index_generation,
            )
        )
        return event
    session.add(event)
    await session.flush()
    return event


def retrieval_audit_details(
    *,
    session_id: str,
    tool_call_id: str,
    project_scope_sha256: str,
    query_sha256: str,
    candidate_count: int,
    returned_count: int,
    result: str,
    latency_ms: int,
    evidence: list[dict[str, object]] | None = None,
    max_evidence: Literal[8, 64] = 8,
) -> dict[str, Any]:
    """Build the fixed redacted fields permitted for a retrieval audit."""
    details = {
        "session_id": session_id,
        "tool_call_id": tool_call_id,
        "project_scope_sha256": project_scope_sha256,
        "query_sha256": query_sha256,
        "candidate_count": candidate_count,
        "returned_count": returned_count,
        "result": result,
        "latency_ms": latency_ms,
        "evidence": evidence or [],
    }
    if (
        len(tool_call_id) == 0
        or len(tool_call_id) > 255
        or any(
            len(value) != 64 or any(character not in "0123456789abcdef" for character in value)
            for value in (project_scope_sha256, query_sha256)
        )
        or any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in (
            candidate_count, returned_count, latency_ms
        ))
        or len(result) == 0
        or len(result) > 32
    ):
        raise ValueError("retrieval audit details are invalid")
    UUID(session_id)
    if len(details["evidence"]) > max_evidence:
        raise ValueError("retrieval audit details are invalid")
    for identity in details["evidence"]:
        if set(identity) != {"artifact_id", "version_id", "index_id", "generation", "chunk_id"}:
            raise ValueError("retrieval audit details are invalid")
        UUID(str(identity["artifact_id"]))
        UUID(str(identity["version_id"]))
        UUID(str(identity["index_id"]))
        UUID(str(identity["chunk_id"]))
        generation = identity["generation"]
        if isinstance(generation, bool) or not isinstance(generation, int) or generation < 1:
            raise ValueError("retrieval audit details are invalid")
    return details


def fact_audit_details(
    *,
    operation: str,
    result: str,
    latency_ms: int,
    project_id: UUID | None = None,
    session_id: UUID | None = None,
    proposal_id: UUID | None = None,
    tool_call_id: str | None = None,
    request_sha256: str | None = None,
    payload_sha256: str | None = None,
    permission_revision: int | None = None,
    evidence_count: int | None = None,
    status: str | None = None,
    event_sequence: int | None = None,
) -> dict[str, Any]:
    """Build redacted fields accepted by the action-specific Fact audit validator."""
    details: dict[str, Any] = {
        "operation": operation,
        "result": result,
        "latency_ms": latency_ms,
    }
    optional = {
        "project_id": str(project_id) if project_id is not None else None,
        "session_id": str(session_id) if session_id is not None else None,
        "proposal_id": str(proposal_id) if proposal_id is not None else None,
        "tool_call_id": tool_call_id,
        "request_sha256": request_sha256,
        "payload_sha256": payload_sha256,
        "permission_revision": permission_revision,
        "evidence_count": evidence_count,
        "status": status,
        "event_sequence": event_sequence,
    }
    details.update({key: value for key, value in optional.items() if value is not None})
    return details
