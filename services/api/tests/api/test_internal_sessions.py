from uuid import UUID

import pytest
from argon2 import PasswordHasher
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

PASSWORD = "correct horse battery staple"
SERVICE_TOKEN = "xagent-test-service-token-00000001"


async def _login(client, engine, account, email: str) -> str:
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO xagent_account_credentials "
                    "(account_id, password_hash, password_changed_at) "
                    "VALUES (:account_id, :password_hash, CURRENT_TIMESTAMP)"
                ),
                {"account_id": account.id, "password_hash": PasswordHasher().hash(PASSWORD)},
            )
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": PASSWORD},
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def _headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "X-XAgent-Service-Token": SERVICE_TOKEN,
    }


@pytest.mark.anyio
async def test_internal_sessions_require_both_service_and_current_user_identity(
    client,
    seeded_database,
    alice,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")

    without_service = await client.post(
        "/internal/xagent/sessions/list",
        headers={"Authorization": f"Bearer {token}"},
        json={"schema_version": 1},
    )
    without_user = await client.post(
        "/internal/xagent/sessions/list",
        headers={"X-XAgent-Service-Token": SERVICE_TOKEN},
        json={"schema_version": 1},
    )

    assert without_service.status_code == 403
    assert without_user.status_code == 401
    assert token not in without_service.text


@pytest.mark.anyio
async def test_create_list_open_append_and_archive_are_actor_isolated(
    client,
    seeded_database,
    alice,
    bob,
) -> None:
    alice_token = await _login(client, seeded_database, alice, "alice@example.test")
    bob_token = await _login(client, seeded_database, bob, "bob@example.test")
    created = await client.post(
        "/internal/xagent/sessions",
        headers=_headers(alice_token),
        json={
            "schema_version": 1,
            "title": "Alice private",
            "visibility": "private",
            "project_id": None,
            "idempotency_key": "create-alice-1",
        },
    )
    assert created.status_code == 201
    session_id = UUID(created.json()["session"]["id"])

    listed = await client.post(
        "/internal/xagent/sessions/list",
        headers=_headers(alice_token),
        json={"schema_version": 1},
    )
    hidden_list = await client.post(
        "/internal/xagent/sessions/list",
        headers=_headers(bob_token),
        json={"schema_version": 1},
    )
    hidden_open = await client.post(
        f"/internal/xagent/sessions/{session_id}/open",
        headers=_headers(bob_token),
        json={"schema_version": 1},
    )

    assert [item["id"] for item in listed.json()["sessions"]] == [str(session_id)]
    assert hidden_list.json() == {"schema_version": 1, "sessions": []}
    assert hidden_open.status_code == 404
    assert hidden_open.json() == {"detail": {"code": "not-found"}}

    appended = await client.post(
        f"/internal/xagent/sessions/{session_id}/append",
        headers=_headers(alice_token),
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": "append-alice-1",
            "events": [
                {
                    "event_type": "message/user",
                    "schema_version": 1,
                    "payload": {"text": "hello"},
                }
            ],
        },
    )
    opened = await client.post(
        f"/internal/xagent/sessions/{session_id}/open",
        headers=_headers(alice_token),
        json={"schema_version": 1},
    )
    archived = await client.post(
        f"/internal/xagent/sessions/{session_id}/archive",
        headers=_headers(alice_token),
        json={"schema_version": 1, "expected_version": 2},
    )

    assert appended.status_code == 200
    assert appended.json()["last_event_sequence"] == 0
    assert opened.json()["events"][0]["payload"] == {"text": "hello"}
    assert archived.status_code == 200
    assert archived.json()["session"]["archived"] is True


@pytest.mark.anyio
async def test_events_are_paginated_and_fork_copies_only_the_authorized_prefix(
    client,
    seeded_database,
    alice,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    created = await client.post(
        "/internal/xagent/sessions",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "title": "source",
            "visibility": "private",
            "idempotency_key": "source-1",
        },
    )
    source_id = created.json()["session"]["id"]
    await client.post(
        f"/internal/xagent/sessions/{source_id}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": "source-events-1",
            "events": [
                {"event_type": "one", "schema_version": 1, "payload": {"n": 1}},
                {"event_type": "two", "schema_version": 1, "payload": {"n": 2}},
            ],
        },
    )

    page = await client.post(
        f"/internal/xagent/sessions/{source_id}/events",
        headers=_headers(token),
        json={"schema_version": 1, "after_sequence": 0, "limit": 1},
    )
    forked = await client.post(
        f"/internal/xagent/sessions/{source_id}/fork",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "through_sequence": 0,
            "title": "fork",
            "idempotency_key": "fork-1",
        },
    )
    fork_id = forked.json()["session"]["id"]
    fork_open = await client.post(
        f"/internal/xagent/sessions/{fork_id}/open",
        headers=_headers(token),
        json={"schema_version": 1},
    )

    assert page.status_code == 200
    assert [event["sequence"] for event in page.json()["events"]] == [1]
    assert forked.status_code == 201
    assert [event["payload"] for event in fork_open.json()["events"]] == [{"n": 1}]


@pytest.mark.anyio
async def test_unsupported_schema_version_has_a_stable_error(
    client,
    seeded_database,
    alice,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    response = await client.post(
        "/internal/xagent/sessions/list",
        headers=_headers(token),
        json={"schema_version": 2},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": {"code": "unsupported-version"}}


@pytest.mark.anyio
async def test_runtime_header_and_requested_identity_round_trip_with_explicit_authorization(
    client,
    seeded_database,
    alice,
    bob,
) -> None:
    alice_token = await _login(client, seeded_database, alice, "alice@example.test")
    bob_token = await _login(client, seeded_database, bob, "bob@example.test")
    session_id = "00000000-0000-0000-0000-000000000701"
    runtime_header = {
        "version": 0,
        "id": session_id,
        "createdAt": 1787587200000,
        "cwd": "/workspace/alice",
    }
    created = await client.post(
        "/internal/xagent/sessions",
        headers=_headers(alice_token),
        json={
            "schema_version": 1,
            "session_id": session_id,
            "runtime_header": runtime_header,
            "title": "runtime",
            "visibility": "private",
            "idempotency_key": "runtime-header-1",
            "events": [
                {
                    "event_type": "turn/start",
                    "schema_version": 1,
                    "payload": {"type": "turn/start", "seq": 0, "time": 1, "data": {"turn": 1}},
                }
            ],
        },
    )

    assert created.status_code == 201
    assert created.json()["session"]["id"] == session_id
    assert created.json()["session"]["runtime_header"] == runtime_header
    opened = await client.post(
        f"/internal/xagent/sessions/{session_id}/open",
        headers=_headers(alice_token),
        json={"schema_version": 1},
    )
    assert opened.json()["events"][0]["payload"]["type"] == "turn/start"
    allowed = await client.post(
        f"/internal/xagent/sessions/{session_id}/authorize",
        headers=_headers(alice_token),
        json={"schema_version": 1, "operation": "edit"},
    )
    hidden = await client.post(
        f"/internal/xagent/sessions/{session_id}/authorize",
        headers=_headers(bob_token),
        json={"schema_version": 1, "operation": "read"},
    )
    assert allowed.status_code == 204
    assert hidden.status_code == 404
