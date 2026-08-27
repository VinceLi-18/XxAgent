import os
from uuid import UUID

import pytest
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.identity import Role
from app.models.xagent_session import XAgentSession


@pytest.mark.anyio
async def test_specialist_cannot_read_other_specialists_private_session(
    actor_session, alice, bob_private_xagent_session
):
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    row = await actor_session.scalar(
        select(XAgentSession).where(
            XAgentSession.id == bob_private_xagent_session.id
        )
    )

    assert row is None


@pytest.mark.anyio
async def test_specialist_can_read_a_project_session_after_membership(
    actor_session, alice, shared_xagent_session
):
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    row = await actor_session.scalar(
        select(XAgentSession).where(XAgentSession.id == shared_xagent_session.id)
    )

    assert row is not None


@pytest.mark.anyio
async def test_set_local_context_is_cleared_before_the_next_pooled_actor(
    seeded_database, alice, application_role
):
    runtime_url = make_url(os.environ["JX_TEST_DATABASE_URL"]).set(
        username=application_role,
        password=os.environ["POSTGRES_APP_PASSWORD"],
    )
    pool_engine = create_async_engine(runtime_url, pool_size=1, max_overflow=0, pool_pre_ping=True)
    manager = Actor(id=UUID("00000000-0000-0000-0000-000000000003"), role=Role.MANAGER)

    try:
        async with AsyncSession(pool_engine, expire_on_commit=False) as reused_session:
            await set_actor_context(reused_session, Actor(id=alice.id, role=Role.SPECIALIST))
            await reused_session.commit()

            previous_actor_id, previous_role = (
                await reused_session.execute(
                    text(
                        "SELECT current_setting('app.actor_id', true), "
                        "current_setting('app.actor_role', true)"
                    )
                )
            ).one()
            assert (previous_actor_id, previous_role) == ("", "")

            await set_actor_context(reused_session, manager)
            actor_id, role = (
                await reused_session.execute(
                    text(
                        "SELECT current_setting('app.actor_id', true), "
                        "current_setting('app.actor_role', true)"
                    )
                )
            ).one()

            assert (actor_id, role) == (str(manager.id), "manager")
            await reused_session.commit()
    finally:
        await pool_engine.dispose()
