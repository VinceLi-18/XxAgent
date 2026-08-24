import asyncio

import pytest

from tests.api.test_internal_sessions import _headers, _login


async def _create(client, token: str) -> str:
    response = await client.post(
        "/internal/xagent/sessions",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "title": "concurrency",
            "visibility": "private",
            "idempotency_key": "concurrency-create",
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
