"""PostgreSQL enforces durable Business Skill identities and immutable evidence."""

import json
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from anyio import to_thread
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError


TABLES = (
    "business_skills", "business_skill_drafts", "business_skill_versions",
    "business_skill_test_runs", "business_skill_authorizations",
)


def migration_config(engine):
    config = Config(str(Path(__file__).resolve().parents[2] / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", engine.url.render_as_string(hide_password=False))
    return config


async def _insert_test_session(connection, project_id, actor_id):
    session_id = uuid4()
    await connection.execute(text(
        "INSERT INTO xagent_sessions (id, owner_id, project_id, visibility, "
        "permission_revision_created, title, purpose, next_citation_ordinal) "
        "VALUES (:id, :actor, :project, 'project', 1, 'Skill test', 'business_skill_test', 1)"
    ), {"id": session_id, "actor": actor_id, "project": project_id})
    return session_id


async def _insert_skill_history(connection, table, rows, skill_id, number, session_id=None):
    row_id = uuid4()
    if table == "business_skill_versions":
        statement = text(
            "INSERT INTO business_skill_versions (id, skill_id, project_id, version_number, "
            "description, instructions, primary_tools, complete_tools, content_digest, "
            "tool_policy_digest, source_draft_revision, published_by_id) "
            "SELECT :id, :skill, project_id, :number, description, instructions, primary_tools, "
            "complete_tools, content_digest, tool_policy_digest, source_draft_revision, "
            "published_by_id FROM business_skill_versions WHERE id = :source"
        )
        source_id = rows["version"]
    else:
        if session_id is None:
            session_id = await _insert_test_session(connection, rows["project"], rows["actor"])
        statement = text(
            "INSERT INTO business_skill_test_runs (id, skill_id, project_id, run_number, "
            "draft_revision, content_digest, tool_policy_digest, session_id, started_by_id, unexecuted_write_tools, test_tools) "
            "SELECT :id, :skill, project_id, :number, draft_revision, content_digest, "
            "tool_policy_digest, :session, started_by_id, unexecuted_write_tools, test_tools "
            "FROM business_skill_test_runs WHERE id = :source"
        )
        source_id = rows["run"]
    await connection.execute(statement, {
        "id": row_id, "skill": skill_id, "number": number,
        "source": source_id, "session": session_id,
    })
    return row_id


@pytest.mark.anyio
async def test_revision_018_installs_governed_skill_relations(seeded_database):
    async with seeded_database.connect() as connection:
        assert await connection.scalar(text("SELECT version_num FROM alembic_version")) == "021_artifact_detail_snapshots"
        tables = set(await connection.scalars(text(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
        )))
    assert set(TABLES) <= tables


@pytest.mark.anyio
async def test_empty_schema_round_trip_preserves_conversation_purpose(seeded_database, fact_project_session):
    config = migration_config(seeded_database)
    await seeded_database.dispose()
    await to_thread.run_sync(command.downgrade, config, "017_fact_tool_call_identity")
    await to_thread.run_sync(command.upgrade, config, "head")
    async with seeded_database.connect() as connection:
        assert await connection.scalar(text("SELECT purpose FROM xagent_sessions WHERE id = :id"),
                                       {"id": fact_project_session.id}) == "conversation"
        assert await connection.scalar(text("SELECT version_num FROM alembic_version")) == "021_artifact_detail_snapshots"


@pytest.mark.anyio
@pytest.mark.parametrize("purpose", ["conversation", "business_skill_test"])
async def test_session_purpose_is_chosen_at_creation_and_immutable(seeded_database, alice, fact_project_session, purpose):
    session_id = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(text(
            "INSERT INTO xagent_sessions (id, owner_id, project_id, visibility, permission_revision_created, title, purpose, next_citation_ordinal) "
            "VALUES (:id, :actor, :project, 'project', 1, 'Purpose test', :purpose, 1)"
        ), {"id": session_id, "actor": alice.id, "project": fact_project_session.project_id, "purpose": purpose})
    with pytest.raises(DBAPIError, match="purpose is immutable"):
        async with seeded_database.begin() as connection:
            await connection.execute(text("UPDATE xagent_sessions SET purpose = :purpose WHERE id = :id"),
                                     {"purpose": "conversation" if purpose == "business_skill_test" else "business_skill_test", "id": session_id})


@pytest.mark.anyio
@pytest.mark.parametrize("purpose", ["unknown", None])
async def test_session_rejects_unrecognized_purpose(seeded_database, fact_project_session, alice, purpose):
    with pytest.raises(DBAPIError, match="ck_xagent_session_purpose|not-null constraint"):
        async with seeded_database.begin() as connection:
            await connection.execute(text(
                "INSERT INTO xagent_sessions (id, owner_id, project_id, visibility, permission_revision_created, title, purpose, next_citation_ordinal) "
                "VALUES (:id, :actor, :project, 'project', 1, 'Invalid purpose', :purpose, 1)"
            ), {"id": uuid4(), "actor": alice.id, "project": fact_project_session.project_id, "purpose": purpose})


@pytest.mark.anyio
@pytest.mark.parametrize("assignment", [
    "description = 'Changed'", "instructions = 'Changed'", "primary_tools = '[]'::jsonb",
    "complete_tools = '[\"skill\"]'::jsonb", "content_digest = repeat('c', 64)",
    "tool_policy_digest = repeat('d', 64)", "source_draft_revision = 2",
    "published_by_id = '00000000-0000-0000-0000-000000000002'", "published_at = now() + interval '1 second'",
    "version_number = 2", "id = gen_random_uuid()",
])
async def test_published_version_fields_cannot_change(seeded_database, business_skill_rows, assignment):
    with pytest.raises(DBAPIError, match="versions are immutable"):
        async with seeded_database.begin() as connection:
            await connection.execute(text(f"UPDATE business_skill_versions SET {assignment} WHERE id = :id"), {"id": business_skill_rows["version"]})


@pytest.mark.anyio
async def test_published_version_cannot_be_deleted(seeded_database, business_skill_rows):
    with pytest.raises(DBAPIError, match="versions are immutable"):
        async with seeded_database.begin() as connection:
            await connection.execute(text("DELETE FROM business_skill_versions WHERE id = :id"), {"id": business_skill_rows["version"]})


@pytest.mark.anyio
@pytest.mark.parametrize("assignment", ["slug = 'renamed'", "project_id = gen_random_uuid()"])
async def test_stable_skill_identity_cannot_change(seeded_database, business_skill_rows, assignment):
    with pytest.raises(DBAPIError, match="identity is immutable"):
        async with seeded_database.begin() as connection:
            await connection.execute(text(f"UPDATE business_skills SET {assignment} WHERE id = :id"), {"id": business_skill_rows["skill"]})


@pytest.mark.anyio
async def test_slug_is_project_unique_and_one_draft_belongs_to_each_skill(seeded_database, business_skill_rows):
    for statement in (
        "INSERT INTO business_skills SELECT gen_random_uuid(), project_id, slug, display_name, NULL, status, created_by_id, created_at, updated_at FROM business_skills",
        "INSERT INTO business_skill_drafts SELECT * FROM business_skill_drafts",
    ):
        with pytest.raises(DBAPIError, match="unique constraint"):
            async with seeded_database.begin() as connection:
                await connection.execute(text(statement))


@pytest.mark.anyio
@pytest.mark.parametrize(("table", "assignment"), [
    ("business_skills", "status = 'paused'"), ("business_skills", "slug = 'Not Valid'"),
    ("business_skill_drafts", "revision = 0"), ("business_skill_drafts", "instructions = ''"),
    ("business_skill_drafts", "description = repeat('x', 2049)"),
    ("business_skill_drafts", "instructions = repeat('x', 65537)"),
    ("business_skill_drafts", "primary_tools = '[\"bash\"]'::jsonb"),
    ("business_skill_drafts", "content_digest = 'invalid'"),
    ("business_skill_test_runs", "status = 'passed'"),
    ("business_skill_test_runs", "verdict = 'approve'"),
    ("business_skill_test_runs", "verdict = 'pass'"),
])
async def test_closed_states_and_bounded_content_reject_invalid_writes(seeded_database, business_skill_rows, table, assignment):
    if table == "business_skill_drafts" and not assignment.startswith(("revision", "content_digest")):
        assignment += ", revision = 2, content_digest = repeat('c',64)"
    with pytest.raises(DBAPIError):
        async with seeded_database.begin() as connection:
            await connection.execute(text(f"UPDATE {table} SET {assignment}"))


@pytest.mark.anyio
async def test_current_version_cannot_reference_another_skill(seeded_database, business_skill_rows, alice):
    async with seeded_database.begin() as connection:
        await connection.execute(text(
            "INSERT INTO business_skills (id, project_id, slug, display_name, created_by_id) "
            "VALUES (:id, :project, 'second-skill', 'Second', :actor)"
        ), {"id": uuid4(), "project": business_skill_rows["project"], "actor": alice.id})
    with pytest.raises(DBAPIError, match="fk_business_skill_current_version"):
        async with seeded_database.begin() as connection:
            await connection.execute(text("UPDATE business_skills SET current_version_id = :version WHERE slug = 'second-skill'"), business_skill_rows)


@pytest.mark.anyio
@pytest.mark.parametrize(("table", "number"), [("business_skill_versions", "version_number"), ("business_skill_test_runs", "run_number")])
async def test_project_numbers_must_increase_across_skills(seeded_database, business_skill_rows, alice, table, number):
    async with seeded_database.begin() as connection:
        second = uuid4()
        await connection.execute(text("INSERT INTO business_skills (id, project_id, slug, display_name, created_by_id) VALUES (:id, :project, 'second-skill', 'Second', :actor)"),
                                 {"id": second, "project": business_skill_rows["project"], "actor": alice.id})
        await _insert_skill_history(connection, table, business_skill_rows, business_skill_rows["skill"], 5)
    with pytest.raises(DBAPIError, match="project number must increase"):
        async with seeded_database.begin() as connection:
            await _insert_skill_history(connection, table, business_skill_rows, second, 3)
    async with seeded_database.begin() as connection:
        higher_id = await _insert_skill_history(connection, table, business_skill_rows, second, 6)
        assert await connection.scalar(
            text(f"SELECT {number} FROM {table} WHERE id = :id"), {"id": higher_id}
        ) == 6
        assert list(await connection.scalars(
            text(f"SELECT {number} FROM {table} WHERE project_id = :project ORDER BY {number}"),
            {"project": business_skill_rows["project"]},
        )) == [1, 5, 6]


@pytest.mark.anyio
async def test_retirement_requires_authorization_removal_and_is_terminal(seeded_database, business_skill_rows):
    with pytest.raises(DBAPIError, match="retired skill cannot be authorized"):
        async with seeded_database.begin() as connection:
            await connection.execute(text("UPDATE business_skills SET status = 'retired'"))
    async with seeded_database.begin() as connection:
        await connection.execute(text("DELETE FROM business_skill_authorizations"))
        await connection.execute(text("UPDATE business_skills SET status = 'retired'"))
    for statement in (
        "UPDATE business_skills SET status = 'active'",
        "UPDATE business_skill_drafts SET instructions = 'changed', revision = 2, content_digest = repeat('c',64)",
    ):
        with pytest.raises(DBAPIError, match="retired"):
            async with seeded_database.begin() as connection:
                await connection.execute(text(statement))


@pytest.mark.anyio
@pytest.mark.parametrize("session_scope", ["same-project-conversation", "other-project-test"])
async def test_test_run_requires_its_own_project_test_session(
    seeded_database, business_skill_rows, fact_project_session, bob_project, alice, session_scope,
):
    session_id = fact_project_session.id
    if session_scope == "other-project-test":
        async with seeded_database.begin() as connection:
            session_id = await _insert_test_session(connection, bob_project.id, alice.id)
    with pytest.raises(DBAPIError, match="test run requires its project test session"):
        async with seeded_database.begin() as connection:
            await _insert_skill_history(
                connection, "business_skill_test_runs", business_skill_rows,
                business_skill_rows["skill"], 2, session_id,
            )


@pytest.mark.anyio
@pytest.mark.parametrize("source", ["skill", "test_session", "audit"])
async def test_nonempty_downgrade_preserves_revision_and_data(seeded_database, fact_project_session, alice, source):
    identifier = uuid4()
    async with seeded_database.begin() as connection:
        if source == "skill":
            await connection.execute(text("INSERT INTO business_skills (id, project_id, slug, display_name, created_by_id) VALUES (:id, :project, 'keep-me', 'Keep', :actor)"), {"id": identifier, "project": fact_project_session.project_id, "actor": alice.id})
        elif source == "test_session":
            await connection.execute(text("INSERT INTO xagent_sessions (id, owner_id, project_id, visibility, permission_revision_created, title, purpose, next_citation_ordinal) VALUES (:id, :actor, :project, 'project', 1, 'Keep', 'business_skill_test', 1)"), {"id": identifier, "actor": alice.id, "project": fact_project_session.project_id})
        else:
            await connection.execute(text("INSERT INTO audit_events (id, actor_id, action, resource_type, resource_id, request_id, result, details) VALUES (:id, :actor, 'business_skill.create', 'business_skill', :id, :id, 'created', CAST(:details AS jsonb))"), {"id": identifier, "actor": alice.id, "details": json.dumps({"project_id": str(fact_project_session.project_id), "skill_id": str(identifier), "result": "created"})})
    config = migration_config(seeded_database)
    await seeded_database.dispose()
    with pytest.raises(DBAPIError, match="cannot downgrade business skills with stored data"):
        await to_thread.run_sync(command.downgrade, config, "017_fact_tool_call_identity")
    async with seeded_database.connect() as connection:
        assert await connection.scalar(text("SELECT version_num FROM alembic_version")) == "021_artifact_detail_snapshots"
        table = {"skill": "business_skills", "test_session": "xagent_sessions", "audit": "audit_events"}[source]
        assert await connection.scalar(text(f"SELECT id FROM {table} WHERE id = :id"), {"id": identifier}) == identifier


@pytest.mark.anyio
@pytest.mark.parametrize(("action", "details", "expected"), [
    ("business_skill.create", {"result": "created"}, True),
    ("business_skill.create", {"result": "published"}, False),
    ("business_skill.unknown", {"result": "created"}, False),
    ("business_skill.create", {"result": "created", "instructions": "secret"}, False),
    ("business_skill.create", {"result": "created", "token": "secret"}, False),
    ("business_skill.publish", {"result": "published", "version_number": 1, "draft_revision": 1, "content_digest": "a" * 64, "tool_policy_digest": "b" * 64}, True),
    ("business_skill.publish", {"result": "published"}, False),
    ("business_skill.tool_authorization_denied", {"result": "not-found", "tool_name": "bash"}, False),
])
async def test_action_aware_audit_schema(seeded_database, action, details, expected):
    details = {"project_id": str(uuid4()), "skill_id": str(uuid4()), **details}
    async with seeded_database.connect() as connection:
        assert await connection.scalar(text("SELECT public.xagent_valid_business_skill_audit_details(:action, CAST(:details AS jsonb))"), {"action": action, "details": json.dumps(details)}) is expected


@pytest.mark.anyio
@pytest.mark.parametrize("complete_tools", [
    '["skill"]',
    '["propose_fact","search_artifacts","skill","submit_cited_answer"]',
    '["search_artifacts","skill"]',
])
async def test_publication_complete_tools_match_primary_tool_closure(seeded_database, business_skill_rows, complete_tools):
    with pytest.raises(DBAPIError, match="ck_business_skill_version_tool_closure"):
        async with seeded_database.begin() as connection:
            await connection.execute(text(
                "INSERT INTO business_skill_versions (id, skill_id, project_id, version_number, description, instructions, primary_tools, complete_tools, content_digest, tool_policy_digest, source_draft_revision, published_by_id) "
                "SELECT gen_random_uuid(), skill_id, project_id, 2, description, instructions, primary_tools, CAST(:tools AS jsonb), content_digest, tool_policy_digest, source_draft_revision, published_by_id FROM business_skill_versions"
            ), {"tools": complete_tools})


@pytest.mark.anyio
async def test_audit_storage_rejects_body_fields(seeded_database, alice, fact_project_session):
    with pytest.raises(DBAPIError, match="ck_audit_event_details"):
        async with seeded_database.begin() as connection:
            await connection.execute(text(
                "INSERT INTO audit_events (id, actor_id, action, resource_type, resource_id, request_id, result, details) "
                "VALUES (:id, :actor, 'business_skill.create', 'business_skill', :id, :id, 'created', CAST(:details AS jsonb))"
            ), {"id": uuid4(), "actor": alice.id, "details": json.dumps({"project_id": str(fact_project_session.project_id), "skill_id": str(uuid4()), "result": "created", "instructions": "private content"})})


@pytest.mark.anyio
async def test_successful_test_cannot_carry_denied_termination(seeded_database, business_skill_rows):
    with pytest.raises(DBAPIError, match="ck_business_skill_test_completed"):
        async with seeded_database.begin() as connection:
            await connection.execute(text("UPDATE business_skill_test_runs SET status = 'completed', termination_reason = 'tool-denied', settled_at = now()"))


@pytest.mark.anyio
async def test_models_read_published_content_and_test_identities(seeded_database, business_skill_rows):
    from sqlalchemy.ext.asyncio import AsyncSession
    from app.models.business_skills import BusinessSkill, BusinessSkillDraft, BusinessSkillVersion, BusinessSkillTestRun, BusinessSkillAuthorization

    async with AsyncSession(seeded_database) as session:
        skill = await session.get(BusinessSkill, business_skill_rows["skill"])
        version = await session.get(BusinessSkillVersion, skill.current_version_id)
        draft = await session.get(BusinessSkillDraft, skill.id)
        run = await session.get(BusinessSkillTestRun, business_skill_rows["run"])
        authorization = await session.get(BusinessSkillAuthorization, business_skill_rows["authorization"])
        assert version.instructions == draft.instructions == "Read cited evidence."
        assert version.complete_tools == ["search_artifacts", "skill", "submit_cited_answer"]
        assert run.session_id == business_skill_rows["session"]
        assert authorization.skill_id == skill.id
