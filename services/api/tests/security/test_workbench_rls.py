from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.identity import Role


async def _insert_private_session(
    engine: AsyncEngine,
    *,
    session_id: UUID,
    owner_id: UUID,
) -> None:
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO xagent_sessions "
                "(id, owner_id, visibility, permission_revision_created, title) "
                "VALUES (:id, :owner_id, 'private', 1, 'Workbench RLS test')"
            ),
            {"id": session_id, "owner_id": owner_id},
        )


@pytest.mark.anyio
async def test_accounts_only_read_their_own_workbench_preference(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    bob,
    alice_project,
    bob_project,
) -> None:
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO xagent_workbench_preferences "
                "(account_id, context_kind, project_id) VALUES "
                "(:alice_id, 'project', :alice_project_id), "
                "(:bob_id, 'project', :bob_project_id)"
            ),
            {
                "alice_id": alice.id,
                "alice_project_id": alice_project.id,
                "bob_id": bob.id,
                "bob_project_id": bob_project.id,
            },
        )

    await set_actor_context(
        actor_session,
        Actor(id=alice.id, role=Role.SPECIALIST),
    )
    rows = (
        await actor_session.execute(
            text(
                "SELECT account_id, project_id FROM xagent_workbench_preferences "
                "ORDER BY account_id"
            )
        )
    ).all()
    own_update = await actor_session.execute(
        text(
            "UPDATE xagent_workbench_preferences "
            "SET context_kind = 'workbench', project_id = NULL "
            "WHERE account_id = :account_id"
        ),
        {"account_id": alice.id},
    )
    other_update = await actor_session.execute(
        text(
            "UPDATE xagent_workbench_preferences "
            "SET context_kind = 'workbench', project_id = NULL "
            "WHERE account_id = :account_id"
        ),
        {"account_id": bob.id},
    )
    may_delete = await actor_session.scalar(
        text(
            "SELECT has_table_privilege("
            "current_user, 'xagent_workbench_preferences', 'DELETE')"
        )
    )

    assert rows == [(alice.id, alice_project.id)]
    assert own_update.rowcount == 1
    assert other_update.rowcount == 0
    assert may_delete is False


@pytest.mark.anyio
async def test_accounts_cannot_select_an_inaccessible_project_as_their_context(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    bob_project,
) -> None:
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO xagent_workbench_preferences "
                "(account_id, context_kind, project_id) "
                "VALUES (:account_id, 'workbench', NULL)"
            ),
            {"account_id": alice.id},
        )

    await set_actor_context(
        actor_session,
        Actor(id=alice.id, role=Role.SPECIALIST),
    )
    with pytest.raises(DBAPIError, match="row-level security policy"):
        await actor_session.execute(
            text(
                "UPDATE xagent_workbench_preferences "
                "SET context_kind = 'project', project_id = :project_id "
                "WHERE account_id = :account_id"
            ),
            {"account_id": alice.id, "project_id": bob_project.id},
        )


@pytest.mark.anyio
async def test_accounts_read_only_their_own_capability_grants_without_write_access(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    bob,
    manager,
) -> None:
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO xagent_account_capability_grants "
                "(account_id, capability, granted_by_id) VALUES "
                "(:alice_id, 'project.create', :granted_by_id), "
                "(:bob_id, 'project.create', :granted_by_id)"
            ),
            {
                "alice_id": alice.id,
                "bob_id": bob.id,
                "granted_by_id": manager.id,
            },
        )

    await set_actor_context(
        actor_session,
        Actor(id=alice.id, role=Role.SPECIALIST),
    )
    rows = (
        await actor_session.execute(
            text(
                "SELECT account_id, capability "
                "FROM xagent_account_capability_grants ORDER BY account_id"
            )
        )
    ).all()
    write_privileges = {
        privilege: await actor_session.scalar(
            text(
                "SELECT has_table_privilege("
                "current_user, 'xagent_account_capability_grants', :privilege)"
            ),
            {"privilege": privilege},
        )
        for privilege in ("INSERT", "UPDATE", "DELETE")
    }

    assert rows == [(alice.id, "project.create")]
    assert write_privileges == {"INSERT": False, "UPDATE": False, "DELETE": False}


@pytest.mark.anyio
async def test_accounts_only_read_project_refs_for_their_private_sessions(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    bob,
    alice_project,
    bob_project,
) -> None:
    alice_session_id = UUID("00000000-0000-0000-0000-000000000911")
    bob_session_id = UUID("00000000-0000-0000-0000-000000000912")
    await _insert_private_session(
        seeded_database,
        session_id=alice_session_id,
        owner_id=alice.id,
    )
    await _insert_private_session(
        seeded_database,
        session_id=bob_session_id,
        owner_id=bob.id,
    )
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO xagent_session_project_refs (session_id, project_id) VALUES "
                "(:alice_session_id, :bob_project_id), "
                "(:bob_session_id, :alice_project_id)"
            ),
            {
                "alice_session_id": alice_session_id,
                "bob_project_id": bob_project.id,
                "bob_session_id": bob_session_id,
                "alice_project_id": alice_project.id,
            },
        )

    await set_actor_context(
        actor_session,
        Actor(id=alice.id, role=Role.SPECIALIST),
    )
    rows = (
        await actor_session.execute(
            text(
                "SELECT session_id, project_id FROM xagent_session_project_refs "
                "ORDER BY session_id, project_id"
            )
        )
    ).all()
    may_insert = await actor_session.scalar(
        text(
            "SELECT has_table_privilege("
            "current_user, 'xagent_session_project_refs', 'INSERT')"
        )
    )

    assert rows == [(alice_session_id, bob_project.id)]
    assert may_insert is False
