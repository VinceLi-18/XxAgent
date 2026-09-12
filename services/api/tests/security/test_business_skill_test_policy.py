"""Immutable sorted read-only execution policy and lossless migration refusal."""

import json
from uuid import uuid4

import pytest
from alembic import command
from anyio import to_thread
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from security.test_business_skill_schema import migration_config, _insert_test_session


@pytest.mark.anyio
async def test_test_policy_has_no_default_and_is_immutable(seeded_database, business_skill_rows, application_role, worker_role):
    async with seeded_database.connect() as connection:
        assert (await connection.execute(text("SELECT is_nullable,column_default FROM information_schema.columns "
            "WHERE table_name='business_skill_test_runs' AND column_name='test_tools'"))).one() == ("NO", None)
        for role in [application_role, worker_role]:
            assert await connection.scalar(text("SELECT has_column_privilege(:role, 'business_skill_test_runs', 'test_tools', 'UPDATE')"), {"role": role}) is False
    with pytest.raises(DBAPIError, match="test input identity is immutable"):
        async with seeded_database.begin() as connection:
            await connection.execute(text("UPDATE business_skill_test_runs SET test_tools='[\"skill\"]'"))


@pytest.mark.anyio
@pytest.mark.parametrize("value", [None, [], "skill", ["propose_fact", "skill"], ["bash", "skill"], ["skill", "skill"],
    ["skill", "search_artifacts", "submit_cited_answer"], ["search_artifacts", "skill"], ["skill", "submit_cited_answer"], {}])
async def test_test_policy_rejects_invalid_or_incomplete_tools(seeded_database, business_skill_rows, value):
    rows = business_skill_rows
    with pytest.raises(DBAPIError, match="ck_business_skill_test_tools|not-null constraint"):
        async with seeded_database.begin() as connection:
            session = await _insert_test_session(connection, rows["project"], rows["actor"])
            await connection.execute(text("INSERT INTO business_skill_test_runs (id,skill_id,project_id,run_number,draft_revision,"
                "content_digest,tool_policy_digest,session_id,started_by_id,unexecuted_write_tools,test_tools) "
                "SELECT :id,skill_id,project_id,2,draft_revision,content_digest,tool_policy_digest,:session,started_by_id,"
                "unexecuted_write_tools,CAST(:value AS jsonb) FROM business_skill_test_runs WHERE id=:source"),
                {"id": uuid4(), "session": session, "source": rows["run"], "value": None if value is None else json.dumps(value)})


@pytest.mark.anyio
async def test_empty_test_policy_migration_round_trip(seeded_database):
    config = migration_config(seeded_database)
    await seeded_database.dispose()
    await to_thread.run_sync(command.downgrade, config, "019_skill_test_permissions")
    await to_thread.run_sync(command.upgrade, config, "head")
    async with seeded_database.connect() as connection:
        assert await connection.scalar(text("SELECT version_num FROM alembic_version")) == "020_skill_test_policy"


@pytest.mark.anyio
async def test_nonempty_test_policy_upgrade_refuses_to_invent_history(seeded_database, fact_project_session, alice):
    config = migration_config(seeded_database)
    await seeded_database.dispose()
    await to_thread.run_sync(command.downgrade, config, "019_skill_test_permissions")
    async with seeded_database.begin() as connection:
        skill = uuid4()
        await connection.execute(text("INSERT INTO business_skills (id,project_id,slug,display_name,created_by_id) "
            "VALUES (:id,:project,'legacy','Legacy',:actor)"), {"id": skill, "project": fact_project_session.project_id, "actor": alice.id})
        session = await _insert_test_session(connection, fact_project_session.project_id, alice.id)
        await connection.execute(text("INSERT INTO business_skill_test_runs (id,skill_id,project_id,run_number,draft_revision,"
            "content_digest,tool_policy_digest,session_id,started_by_id,unexecuted_write_tools) "
            "VALUES (:id,:skill,:project,1,1,repeat('a',64),repeat('b',64),:session,:actor,'[]')"),
            {"id": uuid4(), "skill": skill, "project": fact_project_session.project_id, "session": session, "actor": alice.id})
    with pytest.raises(DBAPIError, match="cannot migrate nonempty Business Skill test tool policy"):
        await to_thread.run_sync(command.upgrade, config, "head")
    async with seeded_database.connect() as connection:
        assert await connection.scalar(text("SELECT version_num FROM alembic_version")) == "019_skill_test_permissions"
        assert await connection.scalar(text("SELECT count(*) FROM business_skill_test_runs")) == 1
        assert await connection.scalar(text("SELECT count(*) FROM information_schema.columns WHERE "
            "table_name='business_skill_test_runs' AND column_name='test_tools'")) == 0


@pytest.mark.anyio
async def test_nonempty_test_policy_downgrade_preserves_history(seeded_database, business_skill_rows):
    config = migration_config(seeded_database)
    await seeded_database.dispose()
    with pytest.raises(DBAPIError, match="cannot migrate nonempty Business Skill test tool policy"):
        await to_thread.run_sync(command.downgrade, config, "019_skill_test_permissions")
    async with seeded_database.connect() as connection:
        assert await connection.scalar(text("SELECT version_num FROM alembic_version")) == "020_skill_test_policy"
        assert await connection.scalar(text("SELECT test_tools FROM business_skill_test_runs")) == ["search_artifacts", "skill", "submit_cited_answer"]
