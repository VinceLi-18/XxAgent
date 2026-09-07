import asyncio
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tests.api.test_internal_sessions import _headers, _login


async def _create(client, token: str, *, key: str = "concurrency-create") -> str:
    response = await client.post(
        "/internal/xagent/sessions",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "title": "concurrency",
            "visibility": "private",
            "idempotency_key": key,
        },
    )
    assert response.status_code == 201
    return response.json()["session"]["id"]


@pytest.mark.anyio
async def test_expected_sequence_allows_only_one_concurrent_writer(
    client,
    seeded_database,
    alice,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    session_id = await _create(client, token)

    async def append(key: str, value: int):
        return await client.post(
            f"/internal/xagent/sessions/{session_id}/append",
            headers=_headers(token),
            json={
                "schema_version": 1,
                "expected_sequence": -1,
                "idempotency_key": key,
                "events": [
                    {"event_type": "race", "schema_version": 1, "payload": {"value": value}}
                ],
            },
        )

    first, second = await asyncio.gather(append("race-a", 1), append("race-b", 2))

    assert sorted((first.status_code, second.status_code)) == [200, 409]
    rejected = first if first.status_code == 409 else second
    assert rejected.json() == {"detail": {"code": "sequence-conflict"}}


@pytest.mark.anyio
async def test_idempotent_replay_returns_the_original_result_and_rejects_new_payload(
    client,
    seeded_database,
    alice,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    session_id = await _create(client, token)
    request = {
        "schema_version": 1,
        "expected_sequence": -1,
        "idempotency_key": "same-append",
        "events": [{"event_type": "once", "schema_version": 1, "payload": {"n": 1}}],
    }

    original = await client.post(
        f"/internal/xagent/sessions/{session_id}/append",
        headers=_headers(token),
        json=request,
    )
    replay = await client.post(
        f"/internal/xagent/sessions/{session_id}/append",
        headers=_headers(token),
        json=request,
    )
    changed = await client.post(
        f"/internal/xagent/sessions/{session_id}/append",
        headers=_headers(token),
        json={**request, "events": [{"event_type": "twice", "schema_version": 1, "payload": {"n": 2}}]},
    )

    assert original.status_code == replay.status_code == 200
    assert original.json() == replay.json()
    assert changed.status_code == 409
    assert changed.json() == {"detail": {"code": "idempotency-conflict"}}


@pytest.mark.anyio
async def test_fork_replay_after_committed_response_loss_keeps_exactly_one_child(
    client,
    seeded_database,
    alice,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    session_id = await _create(client, token, key="fork-loss-source")
    appended = await client.post(
        f"/internal/xagent/sessions/{session_id}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": "fork-loss-source-event",
            "events": [
                {"event_type": "once", "schema_version": 1, "payload": {"n": 1}}
            ],
        },
    )
    assert appended.status_code == 200
    request = {
        "schema_version": 1,
        "through_sequence": 0,
        "title": "recovered fork",
        "idempotency_key": "host-rpc-fork-loss",
    }

    committed_without_observing_response = await client.post(
        f"/internal/xagent/sessions/{session_id}/fork",
        headers=_headers(token),
        json=request,
    )
    replay = await client.post(
        f"/internal/xagent/sessions/{session_id}/fork",
        headers=_headers(token),
        json=request,
    )
    conflict = await client.post(
        f"/internal/xagent/sessions/{session_id}/fork",
        headers=_headers(token),
        json={**request, "through_sequence": -1},
    )

    assert committed_without_observing_response.status_code == 201
    assert replay.status_code == 200
    assert replay.json() == committed_without_observing_response.json()
    assert conflict.status_code == 409
    assert conflict.json() == {"detail": {"code": "idempotency-conflict"}}
    child_id = replay.json()["session"]["id"]
    async with AsyncSession(seeded_database) as session:
        durable_children = await session.scalar(
            text(
                "SELECT count(*) FROM xagent_sessions "
                "WHERE owner_id = :actor_id AND title = 'recovered fork'"
            ),
            {"actor_id": alice.id},
        )
        child_events = await session.scalar(
            text(
                "SELECT count(*) FROM xagent_session_events WHERE session_id = :child_id"
            ),
            {"child_id": child_id},
        )
    assert durable_children == 1
    assert child_events == 1


@pytest.mark.anyio
async def test_idempotent_replays_still_check_project_reference_access(
    client,
    seeded_database,
    alice,
    bob,
    alice_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    session_id = await _create(client, token)
    registered = await client.post(
        "/internal/xagent/session-project-refs",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "session_id": session_id,
            "project_ids": [str(alice_project.id)],
            "idempotency_key": "replay-reference",
        },
    )
    assert registered.status_code == 204
    append_request = {
        "schema_version": 1,
        "expected_sequence": -1,
        "idempotency_key": "replay-after-loss-append",
        "events": [
            {"event_type": "once", "schema_version": 1, "payload": {"n": 1}}
        ],
    }
    fork_request = {
        "schema_version": 1,
        "through_sequence": 0,
        "title": "replay fork",
        "idempotency_key": "replay-after-loss-fork",
    }
    original_append = await client.post(
        f"/internal/xagent/sessions/{session_id}/append",
        headers=_headers(token),
        json=append_request,
    )
    original_fork = await client.post(
        f"/internal/xagent/sessions/{session_id}/fork",
        headers=_headers(token),
        json=fork_request,
    )
    assert original_append.status_code == 200
    assert original_fork.status_code == 201

    async with AsyncSession(seeded_database) as session:
        async with session.begin():
            await session.execute(
                text("UPDATE projects SET owner_id = :owner_id WHERE id = :project_id"),
                {"owner_id": bob.id, "project_id": alice_project.id},
            )
    append_replay = await client.post(
        f"/internal/xagent/sessions/{session_id}/append",
        headers=_headers(token),
        json=append_request,
    )
    fork_replay = await client.post(
        f"/internal/xagent/sessions/{session_id}/fork",
        headers=_headers(token),
        json=fork_request,
    )

    assert append_replay.status_code == fork_replay.status_code == 404
    assert append_replay.json() == fork_replay.json() == {
        "detail": {"code": "session-not-found"}
    }


@pytest.mark.anyio
async def test_overlapping_project_reference_batches_lock_in_a_stable_order(
    client,
    seeded_database,
    alice,
    alice_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    first_session_id = await _create(client, token, key="ordered-ref-session-a")
    second_session_id = await _create(client, token, key="ordered-ref-session-b")
    second_project_id = uuid4()
    async with AsyncSession(seeded_database) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO projects (id, name, owner_id) "
                    "VALUES (:id, '并发项目', :owner_id)"
                ),
                {"id": second_project_id, "owner_id": alice.id},
            )

    async def register(session_id: str, project_ids: list[str], key: str):
        return await client.post(
            "/internal/xagent/session-project-refs",
            headers=_headers(token),
            json={
                "schema_version": 1,
                "session_id": session_id,
                "project_ids": project_ids,
                "idempotency_key": key,
            },
        )

    first, second = await asyncio.gather(
        register(
            first_session_id,
            [str(alice_project.id), str(second_project_id)],
            "ordered-ref-a",
        ),
        register(
            second_session_id,
            [str(second_project_id), str(alice_project.id)],
            "ordered-ref-b",
        ),
    )

    assert first.status_code == second.status_code == 204
    async with AsyncSession(seeded_database) as session:
        reference_count = await session.scalar(
            text(
                "SELECT count(*) FROM xagent_session_project_refs "
                "WHERE session_id IN (:first_session_id, :second_session_id)"
            ),
            {
                "first_session_id": first_session_id,
                "second_session_id": second_session_id,
            },
        )
    assert reference_count == 4
