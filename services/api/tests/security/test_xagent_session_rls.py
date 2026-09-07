from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.identity import Role


async def _insert_session(
    engine,
    *,
    session_id: UUID,
    owner_id: UUID,
    project_id: UUID | None = None,
    visibility: str = "private",
) -> None:
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO xagent_sessions "
                    "(id, owner_id, project_id, visibility, permission_revision_created, "
                    "title, next_citation_ordinal) "
                    "VALUES (:id, :owner_id, :project_id, :visibility, 1, 'New session', 1)"
                ),
                {
                    "id": session_id,
                    "owner_id": owner_id,
                    "project_id": project_id,
                    "visibility": visibility,
                },
            )


async def _visible_session_ids(session: AsyncSession) -> list[UUID]:
    return list(
        (
            await session.scalars(
                text("SELECT id FROM xagent_sessions ORDER BY id")
            )
        ).all()
    )


@pytest.mark.anyio
async def test_private_sessions_are_hidden_from_other_users_and_managers(
    seeded_database,
    actor_session,
    alice,
    bob,
) -> None:
    alice_session = UUID("00000000-0000-0000-0000-000000000801")
    await _insert_session(seeded_database, session_id=alice_session, owner_id=alice.id)

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    assert await _visible_session_ids(actor_session) == [alice_session]

    await set_actor_context(actor_session, Actor(id=bob.id, role=Role.SPECIALIST))
    assert await _visible_session_ids(actor_session) == []

    await set_actor_context(actor_session, Actor(id=bob.id, role=Role.MANAGER))
    assert await _visible_session_ids(actor_session) == []


@pytest.mark.anyio
async def test_project_session_visibility_follows_membership_and_temporary_grants(
    seeded_database,
    actor_session,
    alice,
    bob,
    bob_project,
) -> None:
    member_session = UUID("00000000-0000-0000-0000-000000000802")
    grant_session = UUID("00000000-0000-0000-0000-000000000803")
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO project_memberships (id, project_id, account_id) "
                    "VALUES (:id, :project_id, :account_id)"
                ),
                {"id": uuid4(), "project_id": bob_project.id, "account_id": alice.id},
            )
    await _insert_session(
        seeded_database,
        session_id=member_session,
        owner_id=bob.id,
        project_id=bob_project.id,
        visibility="project",
    )

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    assert await _visible_session_ids(actor_session) == [member_session]

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text("DELETE FROM project_memberships WHERE project_id = :project_id"),
                {"project_id": bob_project.id},
            )
            await session.execute(
                text(
                    "INSERT INTO temporary_project_grants "
                    "(id, project_id, account_id, action, granted_by_id, expires_at) "
                    "VALUES (:id, :project_id, :account_id, 'read', :granted_by_id, :expires_at)"
                ),
                {
                    "id": uuid4(),
                    "project_id": bob_project.id,
                    "account_id": alice.id,
                    "granted_by_id": bob.id,
                    "expires_at": datetime.now(UTC) + timedelta(hours=1),
                },
            )
    await _insert_session(
        seeded_database,
        session_id=grant_session,
        owner_id=bob.id,
        project_id=bob_project.id,
        visibility="project",
    )
    assert await _visible_session_ids(actor_session) == [member_session, grant_session]


@pytest.mark.anyio
async def test_session_scope_constraints_reject_incoherent_rows(
    seeded_database,
    alice,
    alice_project,
) -> None:
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        for visibility, project_id in (("private", alice_project.id), ("project", None)):
            with pytest.raises(IntegrityError):
                async with session.begin():
                    await session.execute(
                        text(
                            "INSERT INTO xagent_sessions "
                            "(id, owner_id, project_id, visibility, permission_revision_created, "
                            "title, next_citation_ordinal) "
                            "VALUES (:id, :owner_id, :project_id, :visibility, 1, 'invalid', 1)"
                        ),
                        {
                            "id": uuid4(),
                            "owner_id": alice.id,
                            "project_id": project_id,
                            "visibility": visibility,
                        },
                    )


@pytest.mark.anyio
async def test_application_role_cannot_create_a_private_session_for_another_actor(
    actor_session,
    alice,
    bob,
) -> None:
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))

    with pytest.raises(DBAPIError) as rejected:
        async with actor_session.begin_nested():
            await actor_session.execute(
                text(
                    "INSERT INTO xagent_sessions "
                    "(id, owner_id, visibility, permission_revision_created, title, "
                    "next_citation_ordinal) "
                    "VALUES (:id, :owner_id, 'private', 1, 'forged', 1)"
                ),
                {"id": uuid4(), "owner_id": bob.id},
            )

    assert rejected.value.orig.sqlstate == "42501"


@pytest.mark.anyio
async def test_session_scope_is_immutable_while_title_and_archive_remain_editable(
    actor_session,
    alice,
    bob,
) -> None:
    session_id = uuid4()
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    await actor_session.execute(
        text(
            "INSERT INTO xagent_sessions "
            "(id, owner_id, visibility, permission_revision_created, title, "
            "next_citation_ordinal) "
            "VALUES (:id, :owner_id, 'private', 1, 'before', 1)"
        ),
        {"id": session_id, "owner_id": alice.id},
    )
    await actor_session.execute(
        text("UPDATE xagent_sessions SET title = 'after', archived = true WHERE id = :id"),
        {"id": session_id},
    )

    with pytest.raises(IntegrityError):
        async with actor_session.begin_nested():
            await actor_session.execute(
                text("UPDATE xagent_sessions SET owner_id = :owner_id WHERE id = :id"),
                {"id": session_id, "owner_id": bob.id},
            )


@pytest.mark.anyio
async def test_session_events_are_append_only_and_sequence_unique(
    actor_session,
    alice,
) -> None:
    session_id = uuid4()
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    await actor_session.execute(
        text(
            "INSERT INTO xagent_sessions "
            "(id, owner_id, visibility, permission_revision_created, title, "
            "next_citation_ordinal) "
            "VALUES (:id, :owner_id, 'private', 1, 'events', 1)"
        ),
        {"id": session_id, "owner_id": alice.id},
    )
    await actor_session.execute(
        text(
            "INSERT INTO xagent_session_events "
            "(session_id, sequence, event_type, schema_version, payload, actor_id) "
            "VALUES (:session_id, 0, 'session/start', 1, CAST(:payload AS jsonb), :actor_id)"
        ),
        {"session_id": session_id, "payload": "{}", "actor_id": alice.id},
    )

    with pytest.raises(IntegrityError):
        async with actor_session.begin_nested():
            await actor_session.execute(
                text(
                    "INSERT INTO xagent_session_events "
                    "(session_id, sequence, event_type, schema_version, payload, actor_id) "
                    "VALUES (:session_id, 0, 'duplicate', 1, CAST(:payload AS jsonb), :actor_id)"
                ),
                {"session_id": session_id, "payload": "{}", "actor_id": alice.id},
            )
    for statement in (
        "UPDATE xagent_session_events SET event_type = 'changed' WHERE session_id = :session_id",
        "DELETE FROM xagent_session_events WHERE session_id = :session_id",
    ):
        with pytest.raises(DBAPIError) as rejected:
            async with actor_session.begin_nested():
                await actor_session.execute(text(statement), {"session_id": session_id})
        assert rejected.value.orig.sqlstate == "42501"


@pytest.mark.anyio
async def test_project_members_and_unexpired_edit_grants_can_write_but_read_grants_cannot(
    seeded_database,
    actor_session,
    alice,
    bob,
    bob_project,
) -> None:
    session_id = uuid4()
    await _insert_session(
        seeded_database,
        session_id=session_id,
        owner_id=bob.id,
        project_id=bob_project.id,
        visibility="project",
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO project_memberships (id, project_id, account_id) "
                    "VALUES (:id, :project_id, :account_id)"
                ),
                {"id": uuid4(), "project_id": bob_project.id, "account_id": alice.id},
            )

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    updated = await actor_session.execute(
        text("UPDATE xagent_sessions SET title = 'member edit' WHERE id = :id"),
        {"id": session_id},
    )
    await actor_session.execute(
        text(
            "INSERT INTO xagent_session_events "
            "(session_id, sequence, event_type, schema_version, payload, actor_id) "
            "VALUES (:session_id, 0, 'member', 1, CAST(:payload AS jsonb), :actor_id)"
        ),
        {"session_id": session_id, "payload": "{}", "actor_id": alice.id},
    )
    assert updated.rowcount == 1

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text("DELETE FROM project_memberships WHERE project_id = :project_id"),
                {"project_id": bob_project.id},
            )
            await session.execute(
                text(
                    "INSERT INTO temporary_project_grants "
                    "(id, project_id, account_id, action, granted_by_id, expires_at) "
                    "VALUES (:id, :project_id, :account_id, 'read', :granted_by_id, :expires_at)"
                ),
                {
                    "id": uuid4(),
                    "project_id": bob_project.id,
                    "account_id": alice.id,
                    "granted_by_id": bob.id,
                    "expires_at": datetime.now(UTC) + timedelta(hours=1),
                },
            )
    read_only_update = await actor_session.execute(
        text("UPDATE xagent_sessions SET title = 'forbidden' WHERE id = :id"),
        {"id": session_id},
    )
    assert read_only_update.rowcount == 0

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "UPDATE temporary_project_grants SET action = 'edit' "
                    "WHERE project_id = :project_id AND account_id = :account_id"
                ),
                {"project_id": bob_project.id, "account_id": alice.id},
            )
    edit_grant_update = await actor_session.execute(
        text("UPDATE xagent_sessions SET title = 'grant edit' WHERE id = :id"),
        {"id": session_id},
    )
    assert edit_grant_update.rowcount == 1
