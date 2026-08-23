import os
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.identity import Role


@pytest.mark.anyio
async def test_specialist_cannot_read_other_specialists_private_thread(
    api_client, alice_token, bob_private_thread
):
    response = await api_client.get(
        f"/api/v1/conversations/{bob_private_thread.id}",
        headers={"Authorization": f"Bearer {alice_token}"},
    )

    assert response.status_code == 404


@pytest.mark.anyio
async def test_specialist_can_read_a_project_thread_after_membership(
    api_client, alice_token, shared_thread
):
    response = await api_client.get(
        f"/api/v1/conversations/{shared_thread.id}",
        headers={"Authorization": f"Bearer {alice_token}"},
    )

    assert response.status_code == 200
    assert response.json()["id"] == str(shared_thread.id)


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
