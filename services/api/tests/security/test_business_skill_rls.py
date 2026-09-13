"""Project membership is independently enforced on every Skill relation."""

from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.identity import Role


TABLES = ("business_skills", "business_skill_drafts", "business_skill_versions", "business_skill_test_runs", "business_skill_authorizations")


@pytest.mark.anyio
async def test_current_project_members_can_read_every_skill_relation(actor_session, business_skill_rows, alice, manager):
    for account, role in ((alice, Role.SPECIALIST), (manager, Role.MANAGER)):
        await set_actor_context(actor_session, Actor(id=account.id, role=role))
        for table in TABLES:
            assert await actor_session.scalar(text(f"SELECT count(*) FROM {table}")) == 1


@pytest.mark.anyio
@pytest.mark.parametrize("denial", ["cross-project", "removed", "disabled", "stale-role"])
async def test_ineligible_members_cannot_read_or_update_skills(seeded_database, actor_session, business_skill_rows, alice, bob, denial):
    async with seeded_database.begin() as connection:
        if denial == "removed":
            await connection.execute(text("DELETE FROM project_memberships WHERE account_id = :actor"), {"actor": alice.id})
        elif denial == "disabled":
            await connection.execute(text("UPDATE accounts SET is_active = false WHERE id = :actor"), {"actor": alice.id})
    account = bob if denial == "cross-project" else alice
    await set_actor_context(actor_session, Actor(id=account.id, role=Role.MANAGER if denial == "stale-role" else Role.SPECIALIST))
    for table in TABLES:
        assert await actor_session.scalar(text(f"SELECT count(*) FROM {table}")) == 0
    assert await actor_session.scalar(text("SELECT id FROM business_skills WHERE id = :id"), {"id": uuid4()}) is None
    result = await actor_session.execute(text("UPDATE business_skills SET display_name = 'Hijacked' WHERE id = :skill"), business_skill_rows)
    assert result.rowcount == 0


@pytest.mark.anyio
async def test_cross_project_insert_is_denied(actor_session, business_skill_rows, bob):
    await set_actor_context(actor_session, Actor(id=bob.id, role=Role.SPECIALIST))
    with pytest.raises(DBAPIError, match="row-level security"):
        await actor_session.execute(text("INSERT INTO business_skills (id, project_id, slug, display_name, created_by_id) VALUES (:id, :project, 'guessed-project', 'Guessed', :actor)"), {"id": uuid4(), "project": business_skill_rows["project"], "actor": bob.id})


@pytest.mark.anyio
async def test_worker_cannot_read_skill_data(worker_engine, business_skill_rows):
    for table in TABLES:
        with pytest.raises(DBAPIError, match="permission denied"):
            async with worker_engine.connect() as connection:
                await connection.execute(text(f"SELECT * FROM {table}"))


@pytest.mark.anyio
async def test_application_role_can_edit_draft_and_display_name(actor_session, business_skill_rows, alice):
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    await actor_session.execute(text("UPDATE business_skills SET display_name = 'Renamed' WHERE id = :skill"), business_skill_rows)
    await actor_session.execute(text("UPDATE business_skill_drafts SET revision = 2, instructions = 'Use exact citations.', content_digest = repeat('c',64), edited_by_id = :actor WHERE skill_id = :skill"), business_skill_rows)
    assert await actor_session.scalar(text("SELECT instructions FROM business_skill_drafts")) == "Use exact citations."


@pytest.mark.anyio
async def test_api_can_insert_publication_without_project_update_privilege(actor_session, business_skill_rows, manager):
    await set_actor_context(actor_session, Actor(id=manager.id, role=Role.MANAGER))
    version_id = uuid4()
    await actor_session.execute(text(
        "INSERT INTO business_skill_versions (id, skill_id, project_id, version_number, description, instructions, primary_tools, complete_tools, content_digest, tool_policy_digest, source_draft_revision, published_by_id) "
        "SELECT :id, skill_id, project_id, 2, description, instructions, primary_tools, complete_tools, content_digest, tool_policy_digest, source_draft_revision, :actor FROM business_skill_versions"
    ), {"id": version_id, "actor": manager.id})
    assert await actor_session.scalar(text("SELECT version_number FROM business_skill_versions WHERE id = :id"), {"id": version_id}) == 2
