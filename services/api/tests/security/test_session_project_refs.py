import asyncio
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tests.api.test_internal_sessions import _headers, _login


async def _create_private_session(client, token: str) -> str:
    response = await client.post(
        "/internal/xagent/sessions",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "title": "跨项目进度",
            "visibility": "private",
            "idempotency_key": "session-project-ref-source",
        },
    )
    assert response.status_code == 201
    return response.json()["session"]["id"]


@pytest.mark.anyio
async def test_private_session_registers_visible_project_reference(
    client,
    seeded_database,
    alice,
    alice_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    session_id = await _create_private_session(client, token)

    response = await client.post(
        "/internal/xagent/session-project-refs",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "session_id": session_id,
            "project_ids": [str(alice_project.id)],
            "idempotency_key": "register-visible-project",
        },
    )

    assert response.status_code == 204
    async with AsyncSession(seeded_database) as session:
        references = (
            await session.execute(
                text(
                    "SELECT session_id, project_id "
                    "FROM xagent_session_project_refs ORDER BY project_id"
                )
            )
        ).all()
    assert references == [(UUID(session_id), alice_project.id)]


@pytest.mark.anyio
async def test_project_reference_registration_replays_without_duplicate_rows(
    client,
    seeded_database,
    alice,
    alice_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    session_id = await _create_private_session(client, token)
    payload = {
        "schema_version": 1,
        "session_id": session_id,
        "project_ids": [str(alice_project.id)],
        "idempotency_key": "register-project-replay",
    }

    original = await client.post(
        "/internal/xagent/session-project-refs",
        headers=_headers(token),
        json=payload,
    )
    replay = await client.post(
        "/internal/xagent/session-project-refs",
        headers=_headers(token),
        json=payload,
    )

    assert original.status_code == replay.status_code == 204
    async with AsyncSession(seeded_database) as session:
        reference_count = await session.scalar(
            text(
                "SELECT count(*) FROM xagent_session_project_refs "
                "WHERE session_id = :session_id"
            ),
            {"session_id": session_id},
        )
    assert reference_count == 1


@pytest.mark.anyio
async def test_project_session_cannot_register_project_references(
    client,
    seeded_database,
    alice,
    alice_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    selected = await client.post(
        "/internal/xagent/workbench/context",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "kind": "project",
            "project_id": str(alice_project.id),
        },
    )
    assert selected.status_code == 200
    created = await client.post(
        "/internal/xagent/sessions",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "title": "项目会话",
            "visibility": "project",
            "project_id": str(alice_project.id),
            "idempotency_key": "project-session-source",
        },
    )
    assert created.status_code == 201

    response = await client.post(
        "/internal/xagent/session-project-refs",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "session_id": created.json()["session"]["id"],
            "project_ids": [str(alice_project.id)],
            "idempotency_key": "project-session-ref",
        },
    )

    assert response.status_code == 404
    assert response.json() == {"detail": {"code": "not-found"}}


@pytest.mark.anyio
async def test_invisible_project_rejects_the_whole_reference_batch_without_disclosure(
    client,
    seeded_database,
    alice,
    alice_project,
    bob_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    session_id = await _create_private_session(client, token)

    response = await client.post(
        "/internal/xagent/session-project-refs",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "session_id": session_id,
            "project_ids": [str(alice_project.id), str(bob_project.id)],
            "idempotency_key": "mixed-visible-projects",
        },
    )

    assert response.status_code == 404
    assert response.json() == {"detail": {"code": "not-found"}}
    assert str(bob_project.id) not in response.text
    async with AsyncSession(seeded_database) as session:
        reference_count = await session.scalar(
            text(
                "SELECT count(*) FROM xagent_session_project_refs "
                "WHERE session_id = :session_id"
            ),
            {"session_id": session_id},
        )
    assert reference_count == 0


@pytest.mark.anyio
async def test_project_reference_key_rejects_a_different_request(
    client,
    seeded_database,
    alice,
    alice_project,
    bob_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    session_id = await _create_private_session(client, token)
    common = {
        "schema_version": 1,
        "session_id": session_id,
        "idempotency_key": "changed-project-ref",
    }
    original = await client.post(
        "/internal/xagent/session-project-refs",
        headers=_headers(token),
        json={**common, "project_ids": [str(alice_project.id)]},
    )
    changed = await client.post(
        "/internal/xagent/session-project-refs",
        headers=_headers(token),
        json={**common, "project_ids": [str(bob_project.id)]},
    )

    assert original.status_code == 204
    assert changed.status_code == 409
    assert changed.json() == {"detail": {"code": "idempotency-conflict"}}
    assert str(bob_project.id) not in changed.text


@pytest.mark.anyio
async def test_concurrent_project_reference_replay_is_deduplicated(
    client,
    seeded_database,
    alice,
    alice_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    session_id = await _create_private_session(client, token)
    payload = {
        "schema_version": 1,
        "session_id": session_id,
        "project_ids": [str(alice_project.id)],
        "idempotency_key": "concurrent-project-ref",
    }

    first, second = await asyncio.gather(
        client.post(
            "/internal/xagent/session-project-refs",
            headers=_headers(token),
            json=payload,
        ),
        client.post(
            "/internal/xagent/session-project-refs",
            headers=_headers(token),
            json=payload,
        ),
    )

    assert first.status_code == second.status_code == 204
    async with AsyncSession(seeded_database) as session:
        reference_count = await session.scalar(
            text(
                "SELECT count(*) FROM xagent_session_project_refs "
                "WHERE session_id = :session_id"
            ),
            {"session_id": session_id},
        )
    assert reference_count == 1


@pytest.mark.anyio
async def test_lost_reference_access_hides_every_private_session_entry_until_restored(
    client,
    seeded_database,
    alice,
    bob,
    alice_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    created = await client.post(
        "/internal/xagent/sessions",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "title": "跨项目汇总",
            "visibility": "private",
            "idempotency_key": "lost-ref-source",
            "events": [
                {
                    "event_type": "message/user",
                    "schema_version": 1,
                    "payload": {"text": "原始日志"},
                }
            ],
        },
    )
    assert created.status_code == 201
    session_id = created.json()["session"]["id"]
    registered = await client.post(
        "/internal/xagent/session-project-refs",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "session_id": session_id,
            "project_ids": [str(alice_project.id)],
            "idempotency_key": "lost-ref-register",
        },
    )
    assert registered.status_code == 204

    async with AsyncSession(seeded_database) as session:
        async with session.begin():
            await session.execute(
                text("UPDATE projects SET owner_id = :owner_id WHERE id = :project_id"),
                {"owner_id": bob.id, "project_id": alice_project.id},
            )

    listed = await client.post(
        "/internal/xagent/sessions/list",
        headers=_headers(token),
        json={"schema_version": 1},
    )
    requests = [
        ("open", {"schema_version": 1}),
        ("events", {"schema_version": 1}),
        (
            "append",
            {
                "schema_version": 1,
                "expected_sequence": 0,
                "idempotency_key": "lost-ref-append",
                "events": [
                    {
                        "event_type": "message/user",
                        "schema_version": 1,
                        "payload": {"text": "不得写入"},
                    }
                ],
            },
        ),
        (
            "fork",
            {
                "schema_version": 1,
                "through_sequence": 0,
                "title": "不得分叉",
                "idempotency_key": "lost-ref-fork",
            },
        ),
        ("archive", {"schema_version": 1, "expected_version": 1}),
        ("authorize", {"schema_version": 1, "operation": "read"}),
        ("authorize", {"schema_version": 1, "operation": "edit"}),
        ("authorize", {"schema_version": 1, "operation": "owner"}),
    ]
    hidden = [
        await client.post(
            f"/internal/xagent/sessions/{session_id}/{operation}",
            headers=_headers(token),
            json=payload,
        )
        for operation, payload in requests
    ]

    assert listed.status_code == 200
    assert listed.json() == {"schema_version": 1, "sessions": []}
    assert [response.status_code for response in hidden] == [404] * len(hidden)
    assert [response.json() for response in hidden] == [
        {"detail": {"code": "session-not-found"}}
    ] * len(hidden)
    assert all(str(alice_project.id) not in response.text for response in hidden)

    async with AsyncSession(seeded_database) as session:
        async with session.begin():
            await session.execute(
                text("UPDATE projects SET owner_id = :owner_id WHERE id = :project_id"),
                {"owner_id": alice.id, "project_id": alice_project.id},
            )
    restored = await client.post(
        f"/internal/xagent/sessions/{session_id}/open",
        headers=_headers(token),
        json={"schema_version": 1},
    )

    assert restored.status_code == 200
    assert [event["payload"] for event in restored.json()["events"]] == [
        {"text": "原始日志"}
    ]
    assert restored.json()["session"]["archived"] is False
    assert restored.json()["session"]["last_event_sequence"] == 0


@pytest.mark.anyio
async def test_fork_inherits_private_session_project_references(
    client,
    seeded_database,
    alice,
    bob,
    alice_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    source_id = await _create_private_session(client, token)
    registered = await client.post(
        "/internal/xagent/session-project-refs",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "session_id": source_id,
            "project_ids": [str(alice_project.id)],
            "idempotency_key": "fork-inherits-ref",
        },
    )
    assert registered.status_code == 204
    forked = await client.post(
        f"/internal/xagent/sessions/{source_id}/fork",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "through_sequence": -1,
            "title": "跨项目副本",
            "idempotency_key": "fork-with-ref",
        },
    )
    assert forked.status_code == 201
    fork_id = forked.json()["session"]["id"]

    async with AsyncSession(seeded_database) as session:
        async with session.begin():
            await session.execute(
                text("UPDATE projects SET owner_id = :owner_id WHERE id = :project_id"),
                {"owner_id": bob.id, "project_id": alice_project.id},
            )
    listed = await client.post(
        "/internal/xagent/sessions/list",
        headers=_headers(token),
        json={"schema_version": 1},
    )
    fork_open = await client.post(
        f"/internal/xagent/sessions/{fork_id}/open",
        headers=_headers(token),
        json={"schema_version": 1},
    )

    assert listed.json() == {"schema_version": 1, "sessions": []}
    assert fork_open.status_code == 404
    assert fork_open.json() == {"detail": {"code": "session-not-found"}}


@pytest.mark.anyio
async def test_registration_replay_and_extension_fail_closed_after_reference_loss(
    client,
    seeded_database,
    alice,
    bob,
    alice_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    session_id = await _create_private_session(client, token)
    original_payload = {
        "schema_version": 1,
        "session_id": session_id,
        "project_ids": [str(alice_project.id)],
        "idempotency_key": "register-before-loss",
    }
    original = await client.post(
        "/internal/xagent/session-project-refs",
        headers=_headers(token),
        json=original_payload,
    )
    assert original.status_code == 204
    second_project_id = uuid4()
    async with AsyncSession(seeded_database) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO projects (id, name, owner_id) "
                    "VALUES (:id, '仍可见项目', :owner_id)"
                ),
                {"id": second_project_id, "owner_id": alice.id},
            )
            await session.execute(
                text("UPDATE projects SET owner_id = :owner_id WHERE id = :project_id"),
                {"owner_id": bob.id, "project_id": alice_project.id},
            )

    replay = await client.post(
        "/internal/xagent/session-project-refs",
        headers=_headers(token),
        json=original_payload,
    )
    extension = await client.post(
        "/internal/xagent/session-project-refs",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "session_id": session_id,
            "project_ids": [str(second_project_id)],
            "idempotency_key": "register-after-loss",
        },
    )

    assert replay.status_code == extension.status_code == 404
    assert replay.json() == extension.json() == {
        "detail": {"code": "session-not-found"}
    }
    async with AsyncSession(seeded_database) as session:
        project_ids = set(
            (
                await session.scalars(
                    text(
                        "SELECT project_id FROM xagent_session_project_refs "
                        "WHERE session_id = :session_id"
                    ),
                    {"session_id": session_id},
                )
            ).all()
        )
    assert project_ids == {alice_project.id}
