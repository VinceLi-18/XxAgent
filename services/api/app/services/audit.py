from typing import Literal
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
