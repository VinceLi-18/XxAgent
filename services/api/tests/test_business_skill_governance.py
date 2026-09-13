"""Governance wire validation, authority, and optimistic drafting."""

import asyncio
from uuid import uuid4

import pytest
from sqlalchemy import text

from test_fact_queries import headers, login


def body(**values):
    return {"schema_version": 1, "idempotency_key": str(uuid4()), **values}


def creation(**values):
    return body(slug="research", display_name="Research", description="Find evidence",
                instructions="# Research\nFind evidence.", primary_tools=["search_artifacts"], **values)


@pytest.fixture
async def skill_api(client, seeded_database, fact_project_session, alice, manager):
    tokens = {
        "specialist": await login(client, seeded_database, alice, "alice@example.test"),
        "manager": await login(client, seeded_database, manager, "manager@example.test"),
    }
    base = f"/internal/xagent/business-skills/projects/{fact_project_session.project_id}"

    async def post(path, payload=None, actor="specialist"):
        return await client.post(base + path, json=payload or {"schema_version": 1},
                                 headers=headers(tokens[actor]))

    return post


@pytest.mark.anyio
@pytest.mark.parametrize("field,value", [
    ("slug", "Bad_slug"), ("slug", "a--b"), ("slug", "a" * 129),
    ("description", " \n\t"), ("description", "界" * 683),
    ("instructions", " \n\t"), ("instructions", "界" * 21846),
    ("display_name", "界" * 86), ("display_name", "  "),
    ("primary_tools", ["bash"]), ("primary_tools", ["search_artifacts", "search_artifacts"]),
    ("primary_tools", ["search_artifacts", "propose_fact"]),
    ("principal", {"role": "manager"}), ("schema_version", True),
])
async def test_create_rejects_invalid_wire_values(skill_api, field, value):
    payload = creation()
    payload[field] = value
    response = await skill_api("/create", payload)
    assert response.status_code == 422
    assert response.json() == {"detail": {"code": "business-skill-input-invalid"}}


@pytest.mark.anyio
async def test_create_edit_replay_and_display_only_revision(skill_api):
    request = creation()
    first = await skill_api("/create", request)
    assert first.status_code == 200, first.text
    assert (await skill_api("/create", request)).json() == first.json()
    assert first.json()["slug"] == "research"
    assert first.json()["draft"]["revision"] == 1
    assert first.json()["authorized"] is False
    edit = body(expected_draft_revision=1, instructions="Changed instructions")
    changed = await skill_api("/research/draft", edit)
    assert changed.status_code == 200, changed.text
    assert changed.json()["draft"]["revision"] == 2
    assert (await skill_api("/research/draft", edit)).json() == changed.json()
    renamed = await skill_api("/research/draft", body(expected_draft_revision=2, display_name="Renamed"))
    assert renamed.json()["draft"]["revision"] == 2
    assert renamed.json()["draft"]["content_digest"] == changed.json()["draft"]["content_digest"]
    assert renamed.json()["display_name"] == "Renamed"
    conflict = await skill_api("/create", {**request, "description": "Another description"})
    assert conflict.json() == {"detail": {"code": "idempotency-conflict"}}


@pytest.mark.anyio
async def test_concurrent_draft_edits_have_one_winner(skill_api):
    assert (await skill_api("/create", creation())).status_code == 200
    results = await asyncio.gather(*[
        skill_api("/research/draft", body(expected_draft_revision=1, instructions=value))
        for value in ("One", "Two")
    ])
    assert sorted(result.status_code for result in results) == [200, 409]
    assert [r.json() for r in results if r.status_code == 409] == [
        {"detail": {"code": "business-skill-revision-conflict"}}
    ]


@pytest.mark.anyio
@pytest.mark.parametrize("path,payload", [
    ("/list", {"limit": 0}), ("/list", {"limit": 101}), ("/list", {"limit": True}),
    ("/research/draft", {"expected_draft_revision": 0, "instructions": "changed"}),
    ("/research/current-version", {"version_number": 0}),
    ("/research/tests/0/verdict", {"verdict": "pass"}),
])
async def test_revisions_versions_runs_and_pages_are_bounded(skill_api, path, payload):
    request = {"schema_version": 1, **payload} if path == "/list" else body(**payload)
    assert (await skill_api(path, request)).status_code == 422


@pytest.mark.anyio
@pytest.mark.parametrize("operation,payload", [
    ("publish", {"expected_draft_revision": 1}),
    ("authorization", {"authorized": True}),
    ("current-version", {"version_number": 1}), ("retire", {}),
])
async def test_specialists_cannot_govern(skill_api, operation, payload):
    assert (await skill_api("/create", creation())).status_code == 200
    response = await skill_api(f"/research/{operation}", body(**payload))
    assert response.status_code == 403
    assert response.json() == {"detail": {"code": "forbidden"}}


@pytest.mark.anyio
@pytest.mark.parametrize("revocation", ["removed", "disabled", "stale", "revoked"])
async def test_revoked_actors_and_unknown_projects_are_indistinguishable(
    skill_api, seeded_database, alice, revocation,
):
    assert (await skill_api("/create", creation())).status_code == 200
    statements = {
        "removed": "DELETE FROM project_memberships WHERE account_id = :actor",
        "disabled": "UPDATE accounts SET is_active = false WHERE id = :actor",
        "stale": "UPDATE xagent_permission_revisions SET revision = revision + 1 WHERE account_id = :actor",
        "revoked": "UPDATE xagent_auth_sessions SET revoked_at = now() WHERE account_id = :actor",
    }
    async with seeded_database.begin() as connection:
        await connection.execute(text(statements[revocation]), {"actor": alice.id})
    response = await skill_api("/research/detail")
    missing = await skill_api("/missing/detail")
    assert response.status_code == missing.status_code == 404
    assert response.json() == missing.json() == {"detail": {"code": "not-found"}}


@pytest.mark.anyio
async def test_list_pagination_and_detail_contain_only_public_identities(skill_api):
    for slug in ["a", "b", "c"]:
        request = creation()
        request["slug"] = slug
        assert (await skill_api("/create", request)).status_code == 200
    first = (await skill_api("/list", {"schema_version": 1, "limit": 2})).json()
    assert [row["slug"] for row in first["items"]] == ["a", "b"]
    second = (await skill_api("/list", {"schema_version": 1, "limit": 2, "cursor": first["next_cursor"]})).json()
    assert [row["slug"] for row in second["items"]] == ["c"]
    assert second["next_cursor"] is None
    detail = (await skill_api("/a/detail")).json()
    assert detail["versions"] == detail["tests"] == []
    def check(value):
        if isinstance(value, dict):
            assert not any(key.endswith("_id") or key == "id" for key in value)
            for child in value.values():
                check(child)
        elif isinstance(value, list):
            for child in value:
                check(child)
    check(detail)


@pytest.mark.anyio
async def test_governance_writes_execute_as_application_actor(skill_api, seeded_database, application_role, alice):
    async with seeded_database.begin() as connection:
        await connection.execute(text("""
            CREATE FUNCTION assert_governance_writer() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF current_user <> 'xagent_api_test_app' OR
                    current_setting('app.actor_id', true) <> '00000000-0000-0000-0000-000000000001' THEN
                    RAISE EXCEPTION 'governance writer escaped actor RLS';
                END IF;
                RETURN NEW;
            END $$
        """))
        for table in ("business_skills", "business_skill_drafts", "xagent_idempotency_keys", "audit_events"):
            await connection.execute(text(f"CREATE TRIGGER assert_writer BEFORE INSERT ON {table} FOR EACH ROW EXECUTE FUNCTION assert_governance_writer()"))
    response = await skill_api("/create", creation())
    assert response.status_code == 200, response.text


@pytest.mark.anyio
async def test_nonmember_cannot_read_or_replay_another_project(client, skill_api, seeded_database, bob, fact_project_session):
    request = creation()
    assert (await skill_api("/create", request)).status_code == 200
    token = await login(client, seeded_database, bob, "bob@example.test")
    for project in [fact_project_session.project_id, uuid4()]:
        response = await client.post(f"/internal/xagent/business-skills/projects/{project}/research/detail",
            headers=headers(token), json={"schema_version": 1})
        assert response.status_code == 404
        assert response.json() == {"detail": {"code": "not-found"}}


@pytest.mark.anyio
async def test_membership_removal_denies_an_existing_idempotent_replay(
    skill_api, seeded_database, alice, fact_project_session,
):
    request = creation()
    created = await skill_api("/create", request)
    assert created.status_code == 200, created.text

    async with seeded_database.begin() as connection:
        await connection.execute(
            text("DELETE FROM project_memberships WHERE account_id = :actor AND project_id = :project"),
            {"actor": alice.id, "project": fact_project_session.project_id},
        )

    replay = await skill_api("/create", request)
    assert replay.status_code == 404
    assert replay.json() == {"detail": {"code": "not-found"}}


@pytest.mark.anyio
async def test_detail_includes_bounded_public_audit_summary(skill_api):
    assert (await skill_api("/create", creation())).status_code == 200
    assert (await skill_api("/research/draft", body(expected_draft_revision=1, display_name="Renamed"))).status_code == 200
    detail = (await skill_api("/research/detail", {"schema_version": 1, "limit": 1})).json()
    assert len(detail["audit_summary"]) == 1
    assert set(detail["audit_summary"][0]) == {"action", "result", "version_number", "created_at"}
    assert detail["audit_summary"][0]["action"] == "business_skill.draft_update"
