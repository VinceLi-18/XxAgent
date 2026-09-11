"""Real PostgreSQL tests for isolated execution and terminal evidence."""

import asyncio
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.business_skills import BusinessSkillTestRun
from app.models.xagent_session import XAgentSession, XAgentSessionEvent
from test_business_skill_governance import body, creation, skill_api
from test_fact_queries import headers, PASSWORD


@pytest.fixture
async def started_test(skill_api):
    draft = (await skill_api("/create", creation())).json()["draft"]
    request = body(expected_draft_revision=1, scenario="Find project evidence",
                   tool_policy_digest=draft["tool_policy_digest"])
    response = await skill_api("/research/tests/start", request)
    assert response.status_code == 200, response.text
    return response.json(), request


@pytest.fixture
async def existing_actor_headers(client, skill_api):
    response = await client.post("/api/v1/auth/login", json={
        "email": "alice@example.test", "password": PASSWORD,
    })
    return headers(response.json()["access_token"])


@pytest.mark.anyio
async def test_start_is_atomic_exact_and_replay_does_not_reuse_another_scenario(skill_api, seeded_database):
    draft = (await skill_api("/create", creation())).json()["draft"]
    request = body(expected_draft_revision=1, scenario="Find project evidence",
                   tool_policy_digest=draft["tool_policy_digest"])
    responses = await asyncio.gather(*[skill_api("/research/tests/start", request) for _ in range(2)])
    assert [r.status_code for r in responses] == [200, 200]
    first = responses[0].json()
    assert first == responses[1].json()
    assert first["test"]["run_number"] == 1
    assert first["draft"]["instructions"] == "# Research\nFind evidence."
    assert first["test"]["content_digest"] == draft["content_digest"]
    second = await skill_api("/research/tests/start", {**request, "idempotency_key": str(uuid4()), "scenario": "Second scenario"})
    assert second.json()["test"]["run_number"] == 2
    assert second.json()["session_id"] != first["session_id"]
    conflict = await skill_api("/research/tests/start", {**request, "scenario": "Different"})
    assert conflict.json() == {"detail": {"code": "idempotency-conflict"}}
    async with AsyncSession(seeded_database) as session:
        runs = list(await session.scalars(select(BusinessSkillTestRun)))
        sessions = list(await session.scalars(select(XAgentSession).where(XAgentSession.purpose == "business_skill_test")))
        assert len(runs) == len(sessions) == 2
        assert all(row.visibility == "project" for row in sessions)


@pytest.mark.anyio
@pytest.mark.parametrize("change,code", [
    ({"expected_draft_revision": 2}, "business-skill-revision-conflict"),
    ({"tool_policy_digest": "f" * 64}, "business-skill-policy-changed"),
])
async def test_invalid_start_creates_neither_run_nor_session(skill_api, seeded_database, change, code):
    draft = (await skill_api("/create", creation())).json()["draft"]
    response = await skill_api("/research/tests/start", body(**{
        "expected_draft_revision": 1, "scenario": "Test", "tool_policy_digest": draft["tool_policy_digest"], **change,
    }))
    assert response.json() == {"detail": {"code": code}}
    async with AsyncSession(seeded_database) as session:
        assert list(await session.scalars(select(BusinessSkillTestRun))) == []
        assert list(await session.scalars(select(XAgentSession).where(XAgentSession.purpose == "business_skill_test"))) == []


@pytest.mark.anyio
@pytest.mark.parametrize("reason,status", [
    ("completed", "completed"), ("tool-denied", "failed"), ("failed", "failed"),
    ("cancelled", "cancelled"), ("authorization-denied", "failed"),
    ("skill-not-loaded", "failed"), ("service-unavailable", "failed"),
])
async def test_terminal_settlement_is_exact_and_cannot_be_replaced(skill_api, started_test, reason, status):
    started, _ = started_test
    request = body(session_id=started["session_id"], termination_reason=reason)
    path = "/research/tests/1/settle"
    response = await skill_api(path, request)
    assert response.status_code == 200, response.text
    assert response.json()["test"]["status"] == status
    assert response.json()["test"]["verdict"] is None
    assert (await skill_api(path, request)).json() == response.json()
    conflicting = await skill_api(path, {**request, "termination_reason": "failed" if reason == "completed" else "completed"})
    assert conflicting.status_code == 409
    late = await skill_api(path, {**request, "idempotency_key": str(uuid4()), "termination_reason": "completed" if reason != "completed" else "cancelled"})
    assert late.status_code == 409


@pytest.mark.anyio
async def test_transcript_is_durable_after_edit_and_reauthorizes_membership(skill_api, started_test, seeded_database, alice, client, existing_actor_headers):
    started, _ = started_test
    async with AsyncSession(seeded_database) as session:
        assert list(await session.scalars(select(XAgentSessionEvent).where(XAgentSessionEvent.session_id == UUID(started["session_id"])))) == []
    appended = await client.post(f"/internal/xagent/sessions/{started['session_id']}/append", headers=existing_actor_headers, json={
        "schema_version": 1, "expected_sequence": -1, "idempotency_key": "test-admission",
        "events": [{"schema_version": 1, "event_type": "message/user", "payload": {"text": "Find project evidence"}}],
    })
    assert appended.status_code == 200, appended.text
    await skill_api("/research/draft", body(expected_draft_revision=1, instructions="Changed draft"))
    transcript = await skill_api("/research/tests/1/transcript")
    assert transcript.status_code == 200, transcript.text
    event = transcript.json()["events"][0]
    assert event["payload"] == {"text": "Find project evidence"}
    assert not {"session_id", "actor_id", "audit_id"} & event.keys()
    async with seeded_database.begin() as connection:
        await connection.execute(text("DELETE FROM project_memberships WHERE account_id=:actor"), {"actor": alice.id})
    assert (await skill_api("/research/tests/1/transcript")).status_code == 404


@pytest.mark.anyio
async def test_settlement_checks_session_identity(skill_api, started_test):
    response = await skill_api("/research/tests/1/settle", body(session_id=str(uuid4()), termination_reason="completed"))
    assert response.status_code == 404


@pytest.mark.anyio
async def test_concurrent_scenarios_allocate_distinct_project_numbers(skill_api, started_test):
    _, request = started_test
    other = creation()
    other["slug"] = "other"
    assert (await skill_api("/create", other)).status_code == 200
    results = await asyncio.gather(*[
        skill_api(f"/{slug}/tests/start", {**request, "idempotency_key": str(uuid4())})
        for slug in ["research", "other"]
    ])
    assert sorted(r.json()["test"]["run_number"] for r in results) == [2, 3]


@pytest.mark.anyio
async def test_test_session_retains_retrieval_admission(client, started_test, existing_actor_headers,
                                                       seeded_database, fact_project_session, alice, monkeypatch):
    from api.test_retrieval_session_append import _delegation_token, _seed_search_chunk, _tool_result

    async def embed(_self, texts):
        return [[1.0] + [0.0] * 1023 for _ in texts]

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", embed)
    await _seed_search_chunk(seeded_database, alice.id, fact_project_session.project_id)
    session_id = started_test[0]["session_id"]
    async with seeded_database.connect() as connection:
        revision = await connection.scalar(text("SELECT revision FROM xagent_permission_revisions WHERE account_id=:id"), {"id": alice.id})
    response = await client.post("/internal/xagent/retrieval/search", headers={
        **existing_actor_headers, "X-XAgent-Delegation": _delegation_token(actor_id=alice.id,
            session_id=UUID(session_id), project_id=fact_project_session.project_id, tool_call_id="test-search", permission_revision=revision),
    }, json={"schema_version": 1, "session_id": session_id, "tool_call_id": "test-search",
             "permission_revision": revision, "query": "预算", "include_private": False})
    assert response.status_code == 200, response.text
    search = response.json()
    response = await client.post(f"/internal/xagent/sessions/{session_id}/append", headers=existing_actor_headers, json={
        "schema_version": 1, "expected_sequence": -1, "idempotency_key": "test-search-append",
        "events": [_tool_result(0, "test-search", search)], "retrieval_receipts": [{
            "event_sequence": 0, "tool_call_id": "test-search", "receipt": search["receipt"], "payload_hash": search["payload_sha256"],
        }],
    })
    assert response.status_code == 200, response.text
    async with seeded_database.connect() as connection:
        assert await connection.scalar(text("SELECT count(*) FROM xagent_admitted_evidence WHERE session_id=:id"), {"id": UUID(session_id)}) == 1
        assert await connection.scalar(text("SELECT count(*) FROM xagent_admitted_evidence WHERE session_id=:id"), {"id": fact_project_session.id}) == 0


@pytest.mark.anyio
async def test_cancelled_settlement_rolls_back_and_late_cancellation_can_settle(skill_api, started_test, monkeypatch):
    from app.services import business_skills

    original = business_skills.store_test_replay
    entered = asyncio.Event()
    never = asyncio.Event()

    async def pause_after_write(*args, **kwargs):
        await original(*args, **kwargs)
        entered.set()
        await never.wait()

    monkeypatch.setattr(business_skills, "store_test_replay", pause_after_write)
    request = body(session_id=started_test[0]["session_id"], termination_reason="completed")
    pending = asyncio.create_task(skill_api("/research/tests/1/settle", request))
    try:
        await asyncio.wait_for(entered.wait(), 10)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
    monkeypatch.setattr(business_skills, "store_test_replay", original)
    assert (await skill_api("/research/detail")).json()["tests"][0]["status"] == "running"
    cancelled = await skill_api("/research/tests/1/settle", {**request, "termination_reason": "cancelled"})
    assert cancelled.json()["test"]["status"] == "cancelled"
    assert (await skill_api("/research/tests/1/settle", request)).status_code == 409


@pytest.mark.anyio
async def test_start_rolls_back_session_and_run_when_audit_cannot_commit(skill_api, seeded_database):
    draft = (await skill_api("/create", creation())).json()["draft"]
    async with seeded_database.begin() as connection:
        await connection.execute(text("CREATE FUNCTION fail_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='business_skill.test_start' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$"))
        await connection.execute(text("CREATE TRIGGER fail_test_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_test_audit()"))
    response = await skill_api("/research/tests/start", body(expected_draft_revision=1, tool_policy_digest=draft["tool_policy_digest"], scenario="Test"))
    assert response.status_code == 503
    async with seeded_database.connect() as connection:
        assert await connection.scalar(text("SELECT count(*) FROM business_skill_test_runs")) == 0
        assert await connection.scalar(text("SELECT count(*) FROM xagent_sessions WHERE purpose='business_skill_test'")) == 0


@pytest.mark.anyio
async def test_test_session_append_closes_after_settlement(client, skill_api, started_test, existing_actor_headers):
    session_id = started_test[0]["session_id"]
    assert (await skill_api("/research/tests/1/settle", body(session_id=session_id, termination_reason="cancelled"))).status_code == 200
    response = await client.post(f"/internal/xagent/sessions/{session_id}/append", headers=existing_actor_headers, json={
        "schema_version": 1, "expected_sequence": -1, "idempotency_key": "late-append",
        "events": [{"schema_version": 1, "event_type": "message/user", "payload": {"text": "Another scenario"}}],
    })
    assert response.status_code == 404


@pytest.mark.anyio
async def test_start_replay_retains_original_draft_and_reports_unexecuted_write_tools(skill_api):
    request = creation()
    request["primary_tools"] = ["propose_fact", "search_artifacts"]
    draft = (await skill_api("/create", request)).json()["draft"]
    start = body(expected_draft_revision=1, tool_policy_digest=draft["tool_policy_digest"], scenario="Find evidence")
    response = await skill_api("/research/tests/start", start)
    assert response.json()["test_tools"] == ["search_artifacts", "skill", "submit_cited_answer"]
    assert response.json()["unexecuted_write_tools"] == ["propose_fact"]
    await skill_api("/research/draft", body(expected_draft_revision=1, instructions="Changed"))
    assert (await skill_api("/research/tests/start", start)).json() == response.json()


@pytest.mark.anyio
@pytest.mark.parametrize("field,value", [("scenario", " "), ("scenario", "界" * 21846),
    ("expected_draft_revision", True), ("tool_policy_digest", "invalid"), ("principal", {"role": "manager"})])
async def test_test_start_rejects_unbounded_or_untrusted_inputs(skill_api, field, value):
    response = await skill_api("/research/tests/start", {**body(expected_draft_revision=1,
        tool_policy_digest="f" * 64, scenario="Test"), field: value})
    assert response.json() == {"detail": {"code": "business-skill-input-invalid"}}


@pytest.mark.anyio
async def test_test_session_run_settlement_and_audit_use_actor_rls(skill_api, seeded_database):
    draft = (await skill_api("/create", creation())).json()["draft"]
    async with seeded_database.begin() as connection:
        await connection.execute(text("""
            CREATE FUNCTION assert_test_writer() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF current_user <> 'xagent_api_test_app' OR
                    current_setting('app.actor_id', true) <> '00000000-0000-0000-0000-000000000001' THEN
                    RAISE EXCEPTION 'test writer escaped actor RLS';
                END IF;
                RETURN NEW;
            END $$
        """))
        for table in ("xagent_sessions", "business_skill_test_runs", "xagent_idempotency_keys", "audit_events"):
            await connection.execute(text(f"CREATE TRIGGER assert_test_writer BEFORE INSERT OR UPDATE ON {table} FOR EACH ROW EXECUTE FUNCTION assert_test_writer()"))
    started = await skill_api("/research/tests/start", body(expected_draft_revision=1,
        tool_policy_digest=draft["tool_policy_digest"], scenario="Test"))
    assert started.status_code == 200, started.text
    settled = await skill_api("/research/tests/1/settle", body(session_id=started.json()["session_id"], termination_reason="completed"))
    assert settled.status_code == 200, settled.text
