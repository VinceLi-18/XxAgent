from uuid import UUID

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
) -> AuditEvent:
    event = AuditEvent(
        actor_id=actor_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        request_id=request_id,
        result=result,
    )
    session.add(event)
    await session.flush()
    return event
