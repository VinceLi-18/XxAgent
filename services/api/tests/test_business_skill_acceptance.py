"""End-to-end acceptance for the persisted Business Skill lifecycle."""

import asyncio
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from api.test_retrieval_session_append import (
    _delegation_token as retrieval_delegation_token,
    _seed_search_chunk,
)
from test_business_skill_governance import body, creation, skill_api
from test_business_skill_mount import mount_body
from test_business_skill_publication import seed_test
from test_business_skill_test_runs import existing_actor_headers
from test_fact_prepare import (
    _delegation_token as fact_delegation_token,
    _prepare_body,
    _prime_tool_call,
)


async def complete_test_run(client, skill_api, actor_headers, slug, draft, run_number):
    """Run one mounted test Session through a completed human-pass verdict."""
    started_response = await skill_api(
        f"/{slug}/tests/start",
        body(
            expected_draft_revision=draft["revision"],
            scenario=f"Validate revision {draft['revision']}",
            tool_policy_digest=draft["tool_policy_digest"],
        ),
    )
    assert started_response.status_code == 200, started_response.text
    started = started_response.json()
    assert started["test"]["run_number"] == run_number
    assert started["test_tools"] == ["search_artifacts", "skill", "submit_cited_answer"]
    assert started["unexecuted_write_tools"] == ["propose_fact"]

    mounted = await skill_api(f"/{slug}/tests/{run_number}/mount", mount_body(started))
    assert mounted.status_code == 200, mounted.text
    assert mounted.json()["claimed"] is True
    appended = await client.post(
        f"/internal/xagent/sessions/{started['session_id']}/append",
        headers=actor_headers,
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": f"acceptance-transcript-{run_number}",
            "events": [{
                "schema_version": 1,
                "event_type": "message/user",
                "payload": {
                    "seq": 1,
                    "time": 1789142400000 + run_number,
                    "type": "message/user",
                    "surfaceOp": "append",
                    "data": {"content": [{"type": "text", "text": "Validate project evidence."}]},
                },
            }],
        },
    )
    assert appended.status_code == 200, appended.text
    settled = await skill_api(
        f"/{slug}/tests/{run_number}/settle",
        body(session_id=started["session_id"], termination_reason="completed"),
    )
    assert settled.status_code == 200, settled.text
    verdict = await skill_api(
        f"/{slug}/tests/{run_number}/verdict", body(verdict="pass"),
    )
    assert verdict.status_code == 200, verdict.text
    return started


@pytest.mark.anyio
async def test_real_stack_business_skill_release_runtime_and_retirement(
    client,
    skill_api,
    seeded_database,
    fact_project_session,
    alice,
    existing_actor_headers,
    monkeypatch,
):
    """Exercise the complete role, test, runtime, retrieval, Fact, and version path."""
    request = creation()
    request["primary_tools"] = ["propose_fact", "search_artifacts"]
    created = await skill_api("/create", request)
    assert created.status_code == 200, created.text
    first_draft = created.json()["draft"]
    first_run = await complete_test_run(
        client, skill_api, existing_actor_headers, "research", first_draft, 1,
    )

    listed = await client.post(
        "/internal/xagent/sessions/list",
        headers=existing_actor_headers,
        json={"schema_version": 1},
    )
    assert listed.status_code == 200, listed.text
    assert first_run["session_id"] not in {row["id"] for row in listed.json()["sessions"]}

    published = await skill_api(
        "/research/publish", body(expected_draft_revision=1), "manager",
    )
    assert published.status_code == 200, published.text
    assert published.json()["current_version"] == 1
    authorized = await skill_api(
        "/research/authorization", body(authorized=True), "manager",
    )
    assert authorized.status_code == 200, authorized.text

    runtime_base = (
        f"/internal/xagent/business-skills/projects/{fact_project_session.project_id}/runtime"
    )

    async def runtime(operation, **values):
        return await client.post(
            f"{runtime_base}/{operation}",
            headers=existing_actor_headers,
            json={
                "schema_version": 1,
                "session_id": str(fact_project_session.id),
                **values,
            },
        )

    catalog = await runtime("catalog")
    assert catalog.status_code == 200, catalog.text
    first_entry, = catalog.json()["items"]
    assert first_entry["slug"] == "research"
    assert first_entry["version_number"] == 1
    loaded = await runtime(
        "load", slug="research", version_key=first_entry["version_key"],
    )
    assert loaded.status_code == 200, loaded.text
    first_version = loaded.json()
    for tool_name in ("search_artifacts", "propose_fact"):
        decision = await runtime(
            "authorize-tool",
            slug="research",
            version_key=first_entry["version_key"],
            tool_policy_digest=first_version["tool_policy_digest"],
            tool_name=tool_name,
            cancelled=False,
        )
        assert decision.json() == {"schema_version": 1, "allowed": True}

    async def embed(_self, texts):
        return [[1.0] + [0.0] * 1023 for _ in texts]

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", embed)
    await _seed_search_chunk(
        seeded_database, alice.id, fact_project_session.project_id,
    )
    async with seeded_database.connect() as connection:
        permission_revision = await connection.scalar(
            text(
                "SELECT revision FROM xagent_permission_revisions "
                "WHERE account_id = :actor"
            ),
            {"actor": alice.id},
        )
    search_call_id = "acceptance-search"
    search = await client.post(
        "/internal/xagent/retrieval/search",
        headers={
            **existing_actor_headers,
            "X-XAgent-Delegation": retrieval_delegation_token(
                actor_id=alice.id,
                session_id=fact_project_session.id,
                project_id=fact_project_session.project_id,
                tool_call_id=search_call_id,
                permission_revision=permission_revision,
            ),
        },
        json={
            "schema_version": 1,
            "session_id": str(fact_project_session.id),
            "tool_call_id": search_call_id,
            "permission_revision": permission_revision,
            "query": "预算",
            "include_private": False,
        },
    )
    assert search.status_code == 200, search.text
    assert [item["text"] for item in search.json()["citations"]] == ["项目预算"]

    fact_call_id = "acceptance-propose-fact"
    await _prime_tool_call(
        seeded_database,
        fact_project_session.id,
        alice.id,
        tool_call_id=fact_call_id,
    )
    proposal = await client.post(
        "/internal/xagent/facts/proposals/prepare",
        headers={
            **existing_actor_headers,
            "X-XAgent-Delegation": fact_delegation_token(
                actor_id=alice.id,
                session_id=fact_project_session.id,
                project_id=fact_project_session.project_id,
                tool_call_id=fact_call_id,
                permission_revision=permission_revision,
            ),
        },
        json={
            **_prepare_body(fact_project_session.id),
            "tool_call_id": fact_call_id,
            "permission_revision": permission_revision,
            "idempotency_key": "acceptance-propose-fact",
        },
    )
    assert proposal.status_code == 200, proposal.text
    assert proposal.json()["result"]["status"] == "pending"

    second_draft_response = await skill_api(
        "/research/draft",
        body(expected_draft_revision=1, instructions="# Research\nUse the second release."),
    )
    assert second_draft_response.status_code == 200, second_draft_response.text
    second_draft = second_draft_response.json()["draft"]
    await complete_test_run(
        client, skill_api, existing_actor_headers, "research", second_draft, 2,
    )
    second_publish = await skill_api(
        "/research/publish", body(expected_draft_revision=2), "manager",
    )
    assert second_publish.status_code == 200, second_publish.text
    assert second_publish.json()["current_version"] == 2

    later_entry, = (await runtime("catalog")).json()["items"]
    assert later_entry["version_number"] == 2
    assert later_entry["version_key"] != first_entry["version_key"]
    historical = await runtime(
        "authorize-tool",
        slug="research",
        version_key=first_entry["version_key"],
        tool_policy_digest=first_version["tool_policy_digest"],
        tool_name="search_artifacts",
        cancelled=False,
    )
    assert historical.json() == {"schema_version": 1, "allowed": True}

    rollback = await skill_api(
        "/research/current-version", body(version_number=1), "manager",
    )
    assert rollback.status_code == 200, rollback.text
    assert rollback.json()["current_version"] == 1
    rolled_back_entry, = (await runtime("catalog")).json()["items"]
    assert rolled_back_entry["version_key"] == first_entry["version_key"]

    assert (
        await skill_api(
            "/research/authorization", body(authorized=False), "manager",
        )
    ).status_code == 200
    denied = await runtime(
        "authorize-tool",
        slug="research",
        version_key=first_entry["version_key"],
        tool_policy_digest=first_version["tool_policy_digest"],
        tool_name="search_artifacts",
        cancelled=False,
    )
    assert denied.status_code == 404
    retired = await skill_api("/research/retire", body(), "manager")
    assert retired.status_code == 200, retired.text
    assert retired.json()["status"] == "retired"
    assert (await runtime("catalog")).json()["items"] == []

    transcript = await skill_api("/research/tests/1/transcript")
    assert transcript.status_code == 200, transcript.text
    assert [event["event_type"] for event in transcript.json()["events"]] == [
        "config", "message/user",
    ]
    detail = await skill_api("/research/detail")
    assert [version["version_number"] for version in detail.json()["versions"]] == [2, 1]
    assert detail.json()["status"] == "retired"


@pytest.mark.anyio
async def test_real_stack_concurrent_release_writes_keep_one_consistent_result(
    skill_api, seeded_database, fact_project_session, alice,
):
    """Accept concurrent edits, publication replay, and retirement without stale authority."""
    created = await skill_api("/create", creation())
    assert created.status_code == 200, created.text
    edits = await asyncio.gather(
        skill_api(
            "/research/draft",
            body(expected_draft_revision=1, instructions="Concurrent edit A"),
        ),
        skill_api(
            "/research/draft",
            body(expected_draft_revision=1, instructions="Concurrent edit B"),
        ),
    )
    assert sorted(response.status_code for response in edits) == [200, 409]
    draft = next(response.json()["draft"] for response in edits if response.status_code == 200)
    await seed_test(seeded_database, fact_project_session, alice.id, draft)

    publish_request = body(expected_draft_revision=2)
    publications = await asyncio.gather(
        skill_api("/research/publish", publish_request, "manager"),
        skill_api("/research/publish", publish_request, "manager"),
    )
    assert [response.status_code for response in publications] == [200, 200]
    assert publications[0].json() == publications[1].json()
    assert len(publications[0].json()["versions"]) == 1

    retire, authorize = await asyncio.gather(
        skill_api("/research/retire", body(), "manager"),
        skill_api("/research/authorization", body(authorized=True), "manager"),
    )
    assert retire.status_code == 200, retire.text
    assert authorize.status_code in {200, 409}
    detail = await skill_api("/research/detail")
    assert detail.json()["status"] == "retired"
    assert detail.json()["authorized"] is False
