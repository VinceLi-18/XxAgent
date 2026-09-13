"""Hidden Skill tests do not count as project conversations."""

import pytest

from test_business_skill_governance import skill_api
from test_business_skill_test_runs import started_test, existing_actor_headers


@pytest.mark.anyio
async def test_bootstrap_excludes_test_session_scopes_and_counts(client, started_test, existing_actor_headers, fact_project_session):
    response = await client.post("/internal/xagent/workbench/bootstrap", headers=existing_actor_headers, json={"schema_version": 2})
    assert response.status_code == 200, response.text
    sessions = response.json()["sessions"]
    assert sum(item["project_id"] == str(fact_project_session.project_id) for item in sessions) == 1
    assert started_test[0]["session_id"] not in str(sessions)
