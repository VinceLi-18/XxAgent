"""Execution authorization is narrower than historical test transcript access."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from test_business_skill_governance import body, skill_api
from test_business_skill_mount import mount_body
from test_business_skill_test_runs import started_test, existing_actor_headers


def authorization(started, **changes):
    return {"schema_version": 1, "session_id": started["session_id"],
        "tool_policy_digest": started["test"]["tool_policy_digest"], "tool_name": "search_artifacts", "cancelled": False, **changes}


@pytest.mark.anyio
async def test_retirement_blocks_mount_and_execution_but_not_history(skill_api, started_test):
    started = started_test[0]
    assert (await skill_api("/research/retire", body(), actor="manager")).status_code == 200
    mount = await skill_api("/research/tests/1/mount", mount_body(started))
    assert mount.status_code == 409
    assert mount.json() == {"detail": {"code": "business-skill-retired"}}
    assert (await skill_api("/research/tests/1/transcript")).status_code == 200


@pytest.mark.anyio
async def test_test_policy_is_persisted_and_draft_edits_do_not_change_authorization(skill_api, started_test, seeded_database):
    started, request = started_test
    assert (await skill_api("/research/tests/1/mount", mount_body(started))).json()["claimed"] is True
    changed = await skill_api("/research/draft", body(expected_draft_revision=1, primary_tools=[]))
    assert changed.status_code == 200
    for tool in ["skill", "search_artifacts", "submit_cited_answer"]:
        response = await skill_api("/research/tests/1/authorize-tool", authorization(started, tool_name=tool))
        assert response.status_code == 200, response.text
        assert response.json() == {"schema_version": 1, "allowed": True}
    assert (await skill_api("/research/tests/start", request)).json() == started
    second = (await skill_api("/research/tests/start", body(expected_draft_revision=2, scenario="Read only",
        tool_policy_digest=changed.json()["draft"]["tool_policy_digest"]))).json()
    assert second["test"]["run_number"] == 2
    assert second["test_tools"] == ["skill"]
    assert (await skill_api("/research/tests/2/mount", mount_body(second))).json()["claimed"] is True
    assert (await skill_api("/research/tests/2/authorize-tool", authorization(second))).json() == {
        "detail": {"code": "business-skill-tool-denied"}}
    assert (await skill_api("/research/tests/2/authorize-tool", authorization(started, tool_name="skill"))).json() == {
        "detail": {"code": "not-found"}}
    async with seeded_database.connect() as connection:
        assert await connection.scalar(text("SELECT test_tools FROM business_skill_test_runs WHERE session_id=:session"),
            {"session": UUID(started["session_id"])}) == ["search_artifacts", "skill", "submit_cited_answer"]


@pytest.mark.anyio
@pytest.mark.parametrize("change,code", [
    ({"tool_name": "propose_fact"}, "business-skill-tool-denied"),
    ({"tool_name": "write_file"}, "business-skill-tool-denied"),
    ({"tool_name": "list_accessible_projects"}, "business-skill-tool-denied"),
    ({"session_id": str(uuid4())}, "not-found"),
    ({"tool_policy_digest": "f" * 64}, "business-skill-policy-changed"),
    ({"cancelled": True}, "business-skill-cancelled"),
])
async def test_test_authorization_rejects_unowned_or_unselected_execution(skill_api, started_test, seeded_database, change, code):
    started = started_test[0]
    assert (await skill_api("/research/tests/1/mount", mount_body(started))).status_code == 200
    response = await skill_api("/research/tests/1/authorize-tool", authorization(started, **change))
    assert response.json() == {"detail": {"code": code}}
    async with seeded_database.connect() as connection:
        rows = (await connection.execute(text("SELECT details FROM audit_events WHERE action='business_skill.tool_authorization_denied'"))).scalars().all()
        assert len(rows) == 1
        assert "search_artifacts" not in str(rows)


@pytest.mark.anyio
@pytest.mark.parametrize("state", ["unmounted", "retired", "terminal", "removed", "disabled", "stale", "revoked"])
async def test_test_authorization_rechecks_current_execution_state(skill_api, started_test, seeded_database, alice, state):
    started = started_test[0]
    if state != "unmounted":
        assert (await skill_api("/research/tests/1/mount", mount_body(started))).status_code == 200
    if state == "retired":
        assert (await skill_api("/research/retire", body(), actor="manager")).status_code == 200
    if state == "terminal":
        assert (await skill_api("/research/tests/1/settle", body(session_id=started["session_id"], termination_reason="cancelled"))).status_code == 200
    statements = {"removed": "DELETE FROM project_memberships WHERE account_id=:actor",
        "disabled": "UPDATE accounts SET is_active=false WHERE id=:actor",
        "stale": "UPDATE xagent_permission_revisions SET revision=revision+1 WHERE account_id=:actor",
        "revoked": "UPDATE xagent_auth_sessions SET revoked_at=now() WHERE account_id=:actor"}
    if state in statements:
        async with seeded_database.begin() as connection:
            await connection.execute(text(statements[state]), {"actor": alice.id})
    response = await skill_api("/research/tests/1/authorize-tool", authorization(started))
    code = {"unmounted": "business-skill-conflict", "terminal": "business-skill-conflict",
        "retired": "business-skill-retired"}.get(state, "not-found")
    assert response.status_code == (404 if code == "not-found" else 409), response.text
    assert response.json() == {"detail": {"code": code}}
    if state in {"retired", "terminal"}:
        assert (await skill_api("/research/tests/1/transcript")).status_code == 200
    if state == "retired":
        settled = await skill_api("/research/tests/1/settle", body(session_id=started["session_id"], termination_reason="authorization-denied"))
        assert settled.status_code == 200, settled.text
        assert settled.json()["test"]["status"] == "failed"


@pytest.mark.anyio
async def test_test_authorization_requires_host_starter_project_and_test_session(
    client, skill_api, started_test, existing_actor_headers, fact_project_session, bob_project,
):
    started = started_test[0]
    request = authorization(started)
    assert (await skill_api("/research/tests/1/authorize-tool", request, actor="manager")).status_code == 404
    assert (await skill_api("/research/tests/1/authorize-tool", {**request, "session_id": str(fact_project_session.id)})).status_code == 404
    for project in [bob_project.id, fact_project_session.project_id]:
        path = f"/internal/xagent/business-skills/projects/{project}/research/tests/1/authorize-tool"
        response = await client.post(path, json=request, headers=existing_actor_headers if project == bob_project.id else {})
        assert response.status_code == (404 if project == bob_project.id else 403)


@pytest.mark.anyio
@pytest.mark.parametrize("change", [{"cancelled": "false"}, {"tool_name": ""}, {"schema_version": True}, {"allowed": True}])
async def test_test_authorization_rejects_malformed_inputs(skill_api, started_test, change):
    assert (await skill_api("/research/tests/1/authorize-tool", authorization(started_test[0], **change))).status_code == 422
