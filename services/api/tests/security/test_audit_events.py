from sqlalchemy import select, text
from sqlalchemy.exc import ProgrammingError
import pytest

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.audit import AuditEvent
from app.models.identity import Role


@pytest.mark.anyio
async def test_read_attempt_writes_an_allowed_audit_event(
    api_client, alice, alice_token, alice_private_thread, audit_session
):
    response = await api_client.get(
        f"/api/v1/conversations/{alice_private_thread.id}",
        headers={"Authorization": f"Bearer {alice_token}"},
    )

    assert response.status_code == 200
    event = await audit_session.scalar(
        select(AuditEvent).order_by(AuditEvent.created_at.desc())
    )
    assert (event.actor_id, event.action, event.resource_id, event.result) == (
        alice.id,
        "conversation.read",
        alice_private_thread.id,
        "allowed",
    )


@pytest.mark.anyio
async def test_denied_read_attempt_writes_a_denied_audit_event(
    api_client, alice, alice_token, bob_private_thread, audit_session
):
    response = await api_client.get(
        f"/api/v1/conversations/{bob_private_thread.id}",
        headers={"Authorization": f"Bearer {alice_token}"},
    )

    assert response.status_code == 404
    event = await audit_session.scalar(
        select(AuditEvent).order_by(AuditEvent.created_at.desc())
    )
    assert (event.actor_id, event.action, event.resource_id, event.result) == (
        alice.id,
        "conversation.read",
        bob_private_thread.id,
        "denied",
    )


@pytest.mark.anyio
async def test_application_role_cannot_update_or_delete_audit_events(
    api_client, actor_session, alice, alice_token, alice_private_thread
):
    response = await api_client.get(
        f"/api/v1/conversations/{alice_private_thread.id}",
        headers={"Authorization": f"Bearer {alice_token}"},
    )
    assert response.status_code == 200

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    for statement in (
        "UPDATE audit_events SET result = 'denied'",
        "DELETE FROM audit_events",
    ):
        with pytest.raises(ProgrammingError, match="permission denied"):
            async with actor_session.begin_nested():
                await actor_session.execute(text(statement))
