"""API grants permit governance while denying immutable content writes."""

import pytest
from sqlalchemy import text


DML = {
    "business_skills": (True, True, True, False),
    "business_skill_drafts": (True, True, True, True),
    "business_skill_versions": (True, True, False, False),
    "business_skill_test_runs": (True, True, True, False),
    "business_skill_authorizations": (True, True, False, True),
}


@pytest.mark.anyio
async def test_api_and_worker_have_only_required_relation_privileges(seeded_database, application_role, worker_role):
    async with seeded_database.connect() as connection:
        for role in (application_role, worker_role):
            for table, expected in DML.items():
                actual = tuple((await connection.execute(text(
                    "SELECT has_table_privilege(:role, :table, 'SELECT'), has_table_privilege(:role, :table, 'INSERT'), "
                    "has_any_column_privilege(:role, :table, 'UPDATE'), has_table_privilege(:role, :table, 'DELETE')"
                ), {"role": role, "table": table})).one())
                assert actual == (expected if role == application_role else (False, False, False, False)), (role, table)


@pytest.mark.anyio
async def test_api_cannot_change_private_identities_or_test_evidence(seeded_database, application_role):
    columns = {
        "business_skills": ("id", "project_id", "slug", "created_by_id"),
        "business_skill_drafts": ("skill_id", "project_id"),
        "business_skill_versions": ("instructions", "published_by_id", "tool_policy_digest"),
        "business_skill_test_runs": ("session_id", "draft_revision", "content_digest", "tool_policy_digest", "started_by_id", "unexecuted_write_tools"),
        "business_skill_authorizations": ("skill_id", "project_id", "authorized_by_id"),
    }
    async with seeded_database.connect() as connection:
        for table, names in columns.items():
            for column in names:
                assert await connection.scalar(text("SELECT has_column_privilege(:role, :table, :column, 'UPDATE')"), {"role": application_role, "table": table, "column": column}) is False
