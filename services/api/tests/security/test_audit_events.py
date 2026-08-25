from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import ProgrammingError

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.audit import AuditEvent
from app.models.identity import Role
from app.models.xagent_session import XAgentSessionEvent
from app.services.audit import write_audit_event


@pytest.mark.anyio
async def test_session_event_can_reference_the_current_actors_audit_event(
    actor_session,
    alice,
    alice_private_xagent_session,
) -> None:
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    audit_event = await write_audit_event(
        actor_session,
        alice.id,
        "session.append",
        "xagent_session",
        alice_private_xagent_session.id,
        uuid4(),
        "allowed",
    )
    session_event = XAgentSessionEvent(
        session_id=alice_private_xagent_session.id,
        sequence=0,
        event_type="message/user",
        schema_version=1,
        payload={"text": "hello"},
        actor_id=alice.id,
        audit_id=audit_event.id,
    )
    actor_session.add(session_event)
    await actor_session.flush()

    stored_event = await actor_session.scalar(
        select(XAgentSessionEvent).where(
            XAgentSessionEvent.session_id == alice_private_xagent_session.id,
            XAgentSessionEvent.sequence == 0,
        )
    )

    assert stored_event is not None
    assert stored_event.audit_id == audit_event.id


@pytest.mark.anyio
async def test_actor_cannot_read_another_actors_session_audit_event(
    actor_session,
    audit_session,
    alice,
    bob,
    bob_private_xagent_session,
) -> None:
    event = AuditEvent(
        actor_id=bob.id,
        action="session.open",
        resource_type="xagent_session",
        resource_id=bob_private_xagent_session.id,
        request_id=uuid4(),
        result="allowed",
    )
    async with audit_session.begin():
        audit_session.add(event)

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    stored_event = await actor_session.scalar(
        select(AuditEvent).where(AuditEvent.id == event.id)
    )

    assert stored_event is None


@pytest.mark.anyio
async def test_application_role_cannot_update_or_delete_audit_events(
    actor_session,
    alice,
    alice_private_xagent_session,
) -> None:
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    await write_audit_event(
        actor_session,
        alice.id,
        "session.open",
        "xagent_session",
        alice_private_xagent_session.id,
        uuid4(),
        "allowed",
    )

    for statement in (
        "UPDATE audit_events SET result = 'denied'",
        "DELETE FROM audit_events",
    ):
        with pytest.raises(ProgrammingError, match="permission denied"):
            async with actor_session.begin_nested():
                await actor_session.execute(text(statement))
