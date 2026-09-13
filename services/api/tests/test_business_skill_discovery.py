"""Project discovery reauthorizes a bound Skill and never widens its Session project."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from api.test_internal_retrieval import _delegation_token
from test_business_skill_governance import body, creation, skill_api
from test_business_skill_publication import seed_test
from test_business_skill_mount import mount_body
from test_business_skill_test_runs import existing_actor_headers


@pytest.fixture
async def discovery(client, skill_api, seeded_database, fact_project_session, alice, existing_actor_headers):
    create = creation()
    create["primary_tools"] = ["list_accessible_projects"]
    draft = (await skill_api("/create", create)).json()["draft"]
    await seed_test(seeded_database, fact_project_session, alice.id, draft)
    await skill_api("/research/publish", body(expected_draft_revision=1), "manager")
    await skill_api("/research/authorization", body(authorized=True), "manager")
    prefix = f"/internal/xagent/business-skills/projects/{fact_project_session.project_id}/runtime"
    catalog = await client.post(f"{prefix}/catalog", headers=existing_actor_headers,
        json={"schema_version": 1, "session_id": str(fact_project_session.id)})
    entry, = catalog.json()["items"]
    loaded = await client.post(f"{prefix}/load", headers=existing_actor_headers, json={
        "schema_version": 1, "session_id": str(fact_project_session.id), "slug": "research", "version_key": entry["version_key"]})
    proof = {"kind": "published", "slug": "research", "version_key": entry["version_key"],
             "tool_policy_digest": loaded.json()["tool_policy_digest"]}
    async with seeded_database.begin() as connection:
        await connection.execute(text("INSERT INTO projects (id,name,owner_id) VALUES (:id,'Another accessible project',:actor)"),
            {"id": uuid4(), "actor": alice.id})
    async with seeded_database.connect() as connection:
        revision = (await connection.execute(text("SELECT revision FROM xagent_permission_revisions WHERE account_id=:actor"),
            {"actor": alice.id})).scalar_one()

    async def call(*, supplied=proof, session_id=None, private=False, query=None, tool="list_accessible_projects", overrides=None):
        session_id = UUID(str(session_id)) if session_id else fact_project_session.id
        project_id = None if private else fact_project_session.project_id
        identity = str(uuid4())
        token = _delegation_token(actor_id=alice.id, session_id=session_id, project_id=project_id,
            tool_call_id=identity, nonce=identity, permission_revision=revision, tool_name=tool, overrides=overrides)
        return await client.post("/internal/xagent/retrieval/projects", headers={**existing_actor_headers,
            "X-XAgent-Delegation": token}, json={"schema_version": 1, "session_id": str(session_id),
            "tool_call_id": identity, "permission_revision": revision,
            **({} if supplied is None else {"business_skill": supplied}), **({} if query is None else {"query": query})})
    return call, proof


@pytest.mark.anyio
async def test_published_skill_discovery_returns_only_its_session_project(discovery, fact_project_session):
    call, _ = discovery
    response = await call()
    assert response.status_code == 200, response.text
    assert [row["project_id"] for row in response.json()["projects"]] == [str(fact_project_session.project_id)]
    assert (await call(query="nonexistent-project-query")).json()["projects"] == []


@pytest.mark.anyio
@pytest.mark.parametrize("change", ["unbound", "version", "digest", "slug", "unauthorize", "retire", "removed", "disabled", "revoked"])
async def test_project_discovery_rejects_unbound_or_expired_skill_authority(discovery, skill_api, seeded_database, alice, change):
    call, proof = discovery
    supplied = dict(proof)
    if change == "unbound":
        supplied = None
    elif change == "version":
        supplied["version_key"] = str(uuid4())
    elif change == "digest":
        supplied["tool_policy_digest"] = "f" * 64
    elif change == "slug":
        supplied["slug"] = "other"
    elif change == "unauthorize":
        await skill_api("/research/authorization", body(authorized=False), "manager")
    elif change == "retire":
        await skill_api("/research/retire", body(), "manager")
    elif change == "removed":
        async with seeded_database.begin() as connection:
            await connection.execute(text("DELETE FROM project_memberships WHERE account_id=:actor"), {"actor": alice.id})
    else:
        statement = ("UPDATE accounts SET is_active=false WHERE id=:actor" if change == "disabled"
                     else "UPDATE xagent_auth_sessions SET revoked_at=now() WHERE account_id=:actor")
        async with seeded_database.begin() as connection:
            await connection.execute(text(statement), {"actor": alice.id})
    denied = await call(supplied=supplied)
    assert denied.status_code != 200
    assert "projects" not in denied.json()


@pytest.mark.anyio
async def test_private_discovery_preserves_accessible_projects_but_rejects_skill_proof(discovery, alice_private_xagent_session):
    call, proof = discovery
    private = dict(session_id=alice_private_xagent_session.id, private=True)
    response = await call(supplied=None, **private)
    assert response.status_code == 200, response.text
    assert len(response.json()["projects"]) == 2
    assert (await call(supplied=proof, **private)).status_code != 200


@pytest.mark.anyio
@pytest.mark.parametrize("change", ["kind", "tool", "session", "extra"])
async def test_published_discovery_rejects_wrong_proof_and_delegation(discovery, change):
    call, proof = discovery
    supplied = dict(proof)
    options = {}
    if change == "kind":
        supplied = {"kind": "test", "slug": "research", "run_number": 1, "tool_policy_digest": proof["tool_policy_digest"]}
    elif change == "tool":
        options["tool"] = "search_artifacts"
    elif change == "session":
        options["overrides"] = {"session_id": str(uuid4())}
    else:
        supplied["project_id"] = str(uuid4())
    assert (await call(supplied=supplied, **options)).status_code != 200


@pytest.mark.anyio
async def test_discovery_receipt_records_the_fixed_project_even_when_query_matches_nothing(discovery, seeded_database, fact_project_session):
    call, _ = discovery
    response = await call(query="nonexistent-project-query")
    assert response.status_code == 200, response.text
    async with seeded_database.connect() as connection:
        scope = (await connection.execute(text("SELECT scope FROM xagent_retrieval_receipts"))).scalar_one()
    assert scope["kind"] == "project"
    assert scope["project_ids"] == [str(fact_project_session.project_id)]
    assert scope["include_private"] is False


@pytest.mark.anyio
@pytest.mark.parametrize("change", ["allowed", "unbound", "published", "run", "digest", "unmounted", "retired", "settled"])
async def test_test_discovery_requires_its_mounted_run_and_read_only_policy(discovery, skill_api, change):
    call, published = discovery
    detail = (await skill_api("/research/detail")).json()
    draft = detail["draft"]
    started = (await skill_api("/research/tests/start", body(expected_draft_revision=draft["revision"],
        tool_policy_digest=draft["tool_policy_digest"], scenario="Discover current project"))).json()
    run = started["test"]["run_number"]
    session = started["session_id"]
    if change != "unmounted":
        mounted = await skill_api(f"/research/tests/{run}/mount", mount_body(started))
        assert mounted.json()["claimed"] is True
    supplied = {"kind": "test", "slug": "research", "run_number": run, "tool_policy_digest": draft["tool_policy_digest"]}
    if change == "unbound": supplied = None
    elif change == "published": supplied = published
    elif change == "run": supplied["run_number"] = run + 1
    elif change == "digest": supplied["tool_policy_digest"] = "f" * 64
    elif change == "retired": await skill_api("/research/retire", body(), "manager")
    elif change == "settled": await skill_api(f"/research/tests/{run}/settle", body(session_id=session, termination_reason="completed"))
    response = await call(supplied=supplied, session_id=session)
    if change == "allowed":
        assert response.status_code == 200, response.text
        assert len(response.json()["projects"]) == 1
    else:
        assert response.status_code != 200
