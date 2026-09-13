"""Atomic Host ownership of one real factory publication for a draft run."""

import asyncio
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from test_business_skill_governance import body, skill_api
from test_business_skill_test_runs import existing_actor_headers, started_test


def mount_body(started):
    return body(session_id=started["session_id"], runtime_header={
        "version": 0, "id": f"session-{started['session_id']}", "createdAt": 1,
        "cwd": "/workspace/project",
    }, events=[{"schema_version": 1, "event_type": "config", "payload": {
        "seq": 0, "time": 1, "type": "config", "data": {"provider": "mock", "model": "mock"},
    }}])


@pytest.mark.anyio
async def test_mount_accepts_the_source_project_workspace(skill_api, started_test, seeded_database):
    request = mount_body(started_test[0])
    response = await skill_api("/research/tests/1/mount", request)
    assert response.status_code == 200, response.text
    async with seeded_database.connect() as connection:
        runtime_header = await connection.scalar(text(
            "SELECT runtime_header FROM xagent_sessions WHERE id=:id"),
            {"id": UUID(request["session_id"])})
    assert runtime_header["cwd"] == "/workspace/project"


@pytest.mark.anyio
async def test_mount_accepts_a_windows_source_project_workspace(skill_api, started_test):
    request = mount_body(started_test[0])
    request["runtime_header"]["cwd"] = "C:\\workspace\\project"
    response = await skill_api("/research/tests/1/mount", request)
    assert response.status_code == 200, response.text


@pytest.mark.anyio
@pytest.mark.parametrize("cwd", [None, "", "relative/project", 1, True])
async def test_mount_rejects_an_invalid_source_project_workspace(skill_api, started_test, cwd):
    request = mount_body(started_test[0])
    request["runtime_header"]["cwd"] = cwd
    response = await skill_api("/research/tests/1/mount", request)
    assert response.status_code == 422
    assert response.json() == {"detail": {"code": "business-skill-input-invalid"}}


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["mount", "cancel-unmounted"])
async def test_mount_and_cleanup_require_current_project_and_host_identity(
    client, skill_api, started_test, existing_actor_headers, fact_project_session, bob_project, operation,
):
    request = mount_body(started_test[0]) if operation == "mount" else body(session_id=started_test[0]["session_id"])
    path = f"/internal/xagent/business-skills/projects/{bob_project.id}/research/tests/1/{operation}"
    response = await client.post(path, json=request, headers=existing_actor_headers)
    assert response.status_code == 404
    assert response.json() == {"detail": {"code": "not-found"}}
    path = f"/internal/xagent/business-skills/projects/{fact_project_session.project_id}/research/tests/1/{operation}"
    for missing in ["X-XAgent-Service-Token", "Authorization"]:
        response = await client.post(path, json=request, headers={key: value for key, value in existing_actor_headers.items() if key != missing})
        assert response.status_code in {401, 403}
    assert (await skill_api("/research/tests/1/mount", mount_body(started_test[0]))).json()["claimed"] is True


@pytest.mark.anyio
async def test_cancel_unmounted_and_mount_have_one_atomic_winner(skill_api, started_test, seeded_database):
    started = started_test[0]
    cancel = body(session_id=started["session_id"])
    mount, cancellation = await asyncio.gather(
        skill_api("/research/tests/1/mount", mount_body(started)),
        skill_api("/research/tests/1/cancel-unmounted", cancel),
    )
    assert cancellation.status_code == 200, cancellation.text
    status = cancellation.json()["test"]["status"]
    if status == "cancelled":
        assert mount.status_code == 409
    else:
        assert status == "running"
        assert mount.json()["claimed"] is True
    assert (await skill_api("/research/tests/1/cancel-unmounted", cancel)).json() == cancellation.json()
    async with seeded_database.connect() as connection:
        assert await connection.scalar(text("SELECT count(*) FROM audit_events WHERE action='business_skill.test_settle'")) == (1 if status == "cancelled" else 0)


@pytest.mark.anyio
async def test_cancel_unmounted_is_terminal_and_preserves_empty_transcript(skill_api, started_test):
    request = body(session_id=started_test[0]["session_id"])
    response = await skill_api("/research/tests/1/cancel-unmounted", request)
    assert response.status_code == 200, response.text
    assert response.json()["test"]["status"] == "cancelled"
    assert (await skill_api("/research/tests/1/cancel-unmounted", {**request, "idempotency_key": str(uuid4())})).json() == response.json()
    assert (await skill_api("/research/tests/1/transcript")).json()["events"] == []
    assert (await skill_api("/research/tests/1/mount", mount_body(started_test[0]))).status_code == 409


@pytest.mark.anyio
async def test_concurrent_mount_claims_once_and_replay_never_executes_again(skill_api, started_test, seeded_database):
    request = mount_body(started_test[0])
    responses = await asyncio.gather(*[skill_api("/research/tests/1/mount", request) for _ in range(2)])
    assert [r.status_code for r in responses] == [200, 200]
    assert sorted(r.json()["claimed"] for r in responses) == [False, True]
    assert (await skill_api("/research/tests/1/mount", request)).json()["claimed"] is False
    conflict = await skill_api("/research/tests/1/mount", {**request, "idempotency_key": str(uuid4()),
        "runtime_header": {**request["runtime_header"], "createdAt": 2}})
    assert conflict.status_code == 409
    changed = {**request, "events": []}
    assert (await skill_api("/research/tests/1/mount", changed)).status_code == 409
    assert (await skill_api("/research/tests/1/cancel-unmounted", body(session_id=request["session_id"]))).json()["test"]["status"] == "running"
    async with seeded_database.connect() as connection:
        row = (await connection.execute(text("SELECT runtime_header,last_event_sequence FROM xagent_sessions WHERE id=:id"),
            {"id": UUID(request["session_id"])})).one()
        assert row.runtime_header == request["runtime_header"]
        assert row.last_event_sequence == 0
        assert await connection.scalar(text("SELECT count(*) FROM xagent_session_events WHERE session_id=:id"),
            {"id": UUID(request["session_id"])}) == 1


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["wrong-session", "wrong-actor", "terminal", "header", "events", "foreign-header"])
async def test_mount_rejects_unowned_or_nonempty_execution(skill_api, started_test, seeded_database, kind):
    request = mount_body(started_test[0])
    if kind == "wrong-session":
        request["session_id"] = str(uuid4())
        request["runtime_header"]["id"] = f"session-{request['session_id']}"
    if kind == "foreign-header":
        request["runtime_header"]["id"] = f"session-{uuid4()}"
    if kind == "terminal":
        await skill_api("/research/tests/1/settle", body(session_id=request["session_id"], termination_reason="cancelled"))
    if kind in {"header", "events"}:
        async with seeded_database.begin() as connection:
            statement = "UPDATE xagent_sessions SET runtime_header='{}'::jsonb WHERE id=:id" if kind == "header" else (
                "INSERT INTO xagent_session_events(session_id,sequence,schema_version,event_type,payload,actor_id) "
                "SELECT id,0,1,'message/user','{}'::jsonb,owner_id FROM xagent_sessions WHERE id=:id")
            await connection.execute(text(statement), {"id": UUID(request["session_id"]), "event": uuid4()})
    response = await skill_api("/research/tests/1/mount", request, actor="manager" if kind == "wrong-actor" else "specialist")
    assert response.status_code in {404, 409, 422}, response.text


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["mount", "cancel-unmounted"])
@pytest.mark.parametrize("revocation", ["removed", "disabled", "stale", "revoked"])
async def test_mount_reauthorizes_before_replaying_claim(skill_api, started_test, seeded_database, alice, revocation, operation):
    request = mount_body(started_test[0])
    assert (await skill_api("/research/tests/1/mount", request)).json()["claimed"] is True
    statements = {
        "removed": "DELETE FROM project_memberships WHERE account_id=:actor",
        "disabled": "UPDATE accounts SET is_active=false WHERE id=:actor",
        "stale": "UPDATE xagent_permission_revisions SET revision=revision+1 WHERE account_id=:actor",
        "revoked": "UPDATE xagent_auth_sessions SET revoked_at=now() WHERE account_id=:actor",
    }
    async with seeded_database.begin() as connection:
        await connection.execute(text(statements[revocation]), {"actor": alice.id})
    payload = request if operation == "mount" else body(session_id=request["session_id"])
    assert (await skill_api(f"/research/tests/1/{operation}", payload)).status_code == 404


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["mount", "cancel-unmounted"])
async def test_cancelled_mount_rolls_back_header_events_and_claim(skill_api, started_test, seeded_database, monkeypatch, operation):
    from app.services import business_skills
    original = business_skills.store_test_replay
    entered = asyncio.Event()
    release = asyncio.Event()

    async def pause(*args, **kwargs):
        await original(*args, **kwargs)
        entered.set()
        await release.wait()

    monkeypatch.setattr(business_skills, "store_test_replay", pause)
    request = mount_body(started_test[0])
    payload = request if operation == "mount" else body(session_id=request["session_id"])
    pending = asyncio.create_task(skill_api(f"/research/tests/1/{operation}", payload))
    try:
        await asyncio.wait_for(entered.wait(), 10)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
    monkeypatch.setattr(business_skills, "store_test_replay", original)
    async with seeded_database.connect() as connection:
        assert await connection.scalar(text("SELECT runtime_header FROM xagent_sessions WHERE id=:id"),
            {"id": UUID(request["session_id"])}) is None
    assert (await skill_api("/research/tests/1/mount", request)).json()["claimed"] is True


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["mount", "cancel-unmounted"])
async def test_another_actor_or_conversation_session_cannot_own_a_test(skill_api, started_test, fact_project_session, operation):
    request = mount_body(started_test[0]) if operation == "mount" else body(session_id=started_test[0]["session_id"])
    assert (await skill_api(f"/research/tests/1/{operation}", request, actor="manager")).status_code == 404
    request["session_id"] = str(fact_project_session.id)
    if operation == "mount":
        request["runtime_header"]["id"] = f"session-{fact_project_session.id}"
    assert (await skill_api(f"/research/tests/1/{operation}", request)).status_code == 404


@pytest.mark.anyio
@pytest.mark.parametrize("field,value", [("seq", 1), ("seq", True), ("time", -1), ("time", True),
    ("surfaceOp", "append"), ("type", "user/message")])
async def test_mount_rejects_invalid_startup_event_envelopes(skill_api, started_test, field, value):
    request = mount_body(started_test[0])
    request["events"][0]["payload"][field] = value
    assert (await skill_api("/research/tests/1/mount", request)).status_code == 422
