"""Runtime decisions use current project authority and immutable pinned versions."""

from uuid import uuid4

import pytest
from sqlalchemy import text

from test_business_skill_governance import body, creation, skill_api
from test_business_skill_publication import seed_test
from test_business_skill_test_runs import existing_actor_headers


@pytest.fixture
async def runtime_api(client, skill_api, seeded_database, fact_project_session, alice, existing_actor_headers):
    draft = (await skill_api("/create", creation())).json()["draft"]
    await seed_test(seeded_database, fact_project_session, alice.id, draft)
    assert (await skill_api("/research/publish", body(expected_draft_revision=1), "manager")).status_code == 200
    assert (await skill_api("/research/authorization", body(authorized=True), "manager")).status_code == 200

    async def post(operation, **values):
        return await client.post(f"/internal/xagent/business-skills/projects/{fact_project_session.project_id}/runtime/{operation}",
            headers=existing_actor_headers, json={"schema_version": 1, "session_id": str(fact_project_session.id), **values})
    assert (await post("catalog")).status_code == 200
    return post


@pytest.mark.anyio
async def test_catalog_then_exact_load_returns_complete_policy(runtime_api):
    catalog = await runtime_api("catalog")
    assert catalog.status_code == 200, catalog.text
    entry, = catalog.json()["items"]
    assert entry["slug"] == "research" and entry["version_number"] == 1
    assert "instructions" not in entry
    loaded = await runtime_api("load", slug="research", version_key=entry["version_key"])
    assert loaded.status_code == 200, loaded.text
    assert loaded.json()["instructions"] == "# Research\nFind evidence."
    assert loaded.json()["complete_tools"] == ["search_artifacts", "skill", "submit_cited_answer"]


@pytest.mark.anyio
@pytest.mark.parametrize("mutation", ["unauthorize", "retire", "removed", "stale"])
async def test_catalog_load_and_tools_recheck_live_authority(runtime_api, skill_api, seeded_database, alice, mutation):
    entry, = (await runtime_api("catalog")).json()["items"]
    loaded = (await runtime_api("load", slug="research", version_key=entry["version_key"])).json()
    if mutation == "unauthorize":
        await skill_api("/research/authorization", body(authorized=False), "manager")
    elif mutation == "retire":
        await skill_api("/research/retire", body(), "manager")
    else:
        statement = "DELETE FROM project_memberships WHERE account_id=:actor" if mutation == "removed" else "UPDATE xagent_permission_revisions SET revision=revision+1 WHERE account_id=:actor"
        async with seeded_database.begin() as connection:
            await connection.execute(text(statement), {"actor": alice.id})
    catalog = await runtime_api("catalog")
    assert catalog.json().get("items", []) == []
    assert (await runtime_api("load", slug="research", version_key=entry["version_key"])).status_code == 404
    denied = await runtime_api("authorize-tool", slug="research", version_key=entry["version_key"], tool_policy_digest=loaded["tool_policy_digest"], tool_name="search_artifacts", cancelled=False)
    assert denied.status_code == 404


@pytest.mark.anyio
async def test_pinned_historical_execution_survives_publication_but_load_requires_current(runtime_api, skill_api, seeded_database, fact_project_session, alice):
    old, = (await runtime_api("catalog")).json()["items"]
    loaded = (await runtime_api("load", slug="research", version_key=old["version_key"])).json()
    draft = (await skill_api("/research/draft", body(expected_draft_revision=1, instructions="New body"))).json()["draft"]
    await seed_test(seeded_database, fact_project_session, alice.id, draft)
    await skill_api("/research/publish", body(expected_draft_revision=2), "manager")
    current, = (await runtime_api("catalog")).json()["items"]
    second = (await runtime_api("load", slug="research", version_key=current["version_key"])).json()
    assert (await runtime_api("load", slug="research", version_key=old["version_key"])).status_code == 409
    allowed = await runtime_api("authorize-tool", slug="research", version_key=old["version_key"], tool_policy_digest=loaded["tool_policy_digest"], tool_name="submit_cited_answer", cancelled=False)
    assert allowed.json() == {"schema_version": 1, "allowed": True}
    await skill_api("/research/current-version", body(version_number=1), "manager")
    assert (await runtime_api("load", slug="research", version_key=old["version_key"])).status_code == 200
    allowed = await runtime_api("authorize-tool", slug="research", version_key=current["version_key"],
        tool_policy_digest=second["tool_policy_digest"], tool_name="search_artifacts", cancelled=False)
    assert allowed.json() == {"schema_version": 1, "allowed": True}


@pytest.mark.anyio
@pytest.mark.parametrize("change,code", [
    ({"tool_name": "bash secret instructions"}, "business-skill-tool-denied"),
    ({"tool_name": "propose_fact"}, "business-skill-tool-denied"),
    ({"version_key": str(uuid4())}, "not-found"),
    ({"tool_policy_digest": "f" * 64}, "business-skill-policy-changed"),
    ({"cancelled": True}, "business-skill-cancelled"),
])
async def test_tool_denials_are_closed_and_audited_without_content(runtime_api, seeded_database, change, code):
    entry, = (await runtime_api("catalog")).json()["items"]
    loaded = (await runtime_api("load", slug="research", version_key=entry["version_key"])).json()
    response = await runtime_api("authorize-tool", **{
        "slug": "research", "version_key": entry["version_key"], "tool_policy_digest": loaded["tool_policy_digest"],
        "tool_name": "search_artifacts", "cancelled": False, **change,
    })
    assert response.json() == {"detail": {"code": code}}
    async with seeded_database.connect() as connection:
        details = (await connection.execute(text("SELECT details FROM audit_events WHERE action='business_skill.tool_authorization_denied'"))).scalars().all()
    assert len(details) == 1
    assert not any("secret" in str(item) or "Find evidence" in str(item) or "tool_name" in item for item in details)


@pytest.mark.anyio
async def test_runtime_rejects_unknown_slug_and_other_session(runtime_api):
    assert (await runtime_api("load", slug="unknown", version_key=str(uuid4()))).status_code == 404
    assert (await runtime_api("catalog", session_id=str(uuid4()))).status_code == 404


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["private", "test", "wrong-project"])
async def test_catalog_rejects_nonconversation_or_other_project_session(runtime_api, seeded_database, fact_project_session, alice, kind):
    session_id = uuid4()
    async with seeded_database.begin() as connection:
        other_project = uuid4()
        await connection.execute(text("INSERT INTO projects(id,name,owner_id) VALUES (:id,'Other',:actor)"), {"id": other_project, "actor": alice.id})
        await connection.execute(text("INSERT INTO project_memberships(id,project_id,account_id) VALUES (:id,:project,:actor)"), {"id": uuid4(), "project": other_project, "actor": alice.id})
        await connection.execute(text("INSERT INTO xagent_sessions (id,owner_id,project_id,visibility,purpose,permission_revision_created,title,next_citation_ordinal) VALUES (:id,:actor,:project,:visibility,:purpose,1,'Hidden',1)"), {
            "id": session_id, "actor": alice.id, "project": fact_project_session.project_id if kind == "test" else other_project if kind == "wrong-project" else None,
            "visibility": "private" if kind == "private" else "project", "purpose": "business_skill_test" if kind == "test" else "conversation",
        })
    assert (await runtime_api("catalog", session_id=str(session_id))).status_code == 404


@pytest.mark.anyio
async def test_catalog_excludes_unpublished_and_unauthorized_skills(runtime_api, skill_api):
    draft = creation()
    draft["slug"] = "unpublished"
    await skill_api("/create", draft)
    assert [entry["slug"] for entry in (await runtime_api("catalog")).json()["items"]] == ["research"]
    await skill_api("/research/authorization", body(authorized=False), "manager")
    assert (await runtime_api("catalog")).json()["items"] == []


@pytest.mark.anyio
async def test_backend_failure_never_returns_cached_permission(runtime_api, seeded_database, application_role):
    entry, = (await runtime_api("catalog")).json()["items"]
    loaded = (await runtime_api("load", slug="research", version_key=entry["version_key"])).json()
    async with seeded_database.begin() as connection:
        await connection.execute(text(f'REVOKE SELECT ON business_skill_versions FROM "{application_role}"'))
    for operation, values in [("catalog", {}), ("load", {"slug": "research", "version_key": entry["version_key"]}),
        ("authorize-tool", {"slug": "research", "version_key": entry["version_key"], "tool_policy_digest": loaded["tool_policy_digest"], "tool_name": "skill", "cancelled": False})]:
        response = await runtime_api(operation, **values)
        assert response.status_code == 503
        assert response.json() == {"detail": {"code": "service-unavailable"}}


@pytest.mark.anyio
async def test_opaque_version_key_cannot_authorize_another_skill(runtime_api, skill_api, seeded_database, fact_project_session, alice):
    first, = (await runtime_api("catalog")).json()["items"]
    created = creation()
    created["slug"] = "other"
    draft = (await skill_api("/create", created)).json()["draft"]
    await seed_test(seeded_database, fact_project_session, alice.id, draft, slug="other")
    await skill_api("/other/publish", body(expected_draft_revision=1), "manager")
    await skill_api("/other/authorization", body(authorized=True), "manager")
    assert (await runtime_api("load", slug="other", version_key=first["version_key"])).status_code == 404
    denied = await runtime_api("authorize-tool", slug="other", version_key=first["version_key"],
        tool_policy_digest=draft["tool_policy_digest"], tool_name="search_artifacts", cancelled=False)
    assert denied.status_code == 404


@pytest.mark.anyio
async def test_unreachable_database_returns_closed_unavailability(runtime_api, seeded_database, monkeypatch):
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
    from app.core.db import get_admin_session
    from app.main import app

    unavailable = create_async_engine(seeded_database.url.set(port=1), connect_args={"timeout": 1})

    async def disconnected_database():
        async with AsyncSession(unavailable) as session:
            yield session

    monkeypatch.setitem(app.dependency_overrides, get_admin_session, disconnected_database)
    try:
        response = await runtime_api("catalog")
        assert response.status_code == 503
        assert response.json() == {"detail": {"code": "service-unavailable"}}
    finally:
        await unavailable.dispose()
