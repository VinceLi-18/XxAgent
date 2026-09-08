import asyncio
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditEvent
from app.models.facts import BusinessOutbox, FactProposal
from app.models.xagent_session import XAgentSessionEvent
from app.services import xagent_sessions as session_service
from app.services.fact_validation import canonical_sha256
from app.services.facts import fact_decision_event
from test_fact_decisions import approve_body
from test_fact_queries import PASSWORD, headers, login, seed_proposal


async def seed_rejected_outboxes(
    engine,
    source_session,
    proposer_id: UUID,
    decision_actor_id: UUID,
    count: int,
) -> list[UUID]:
    """Insert deterministic terminal proposals and their exact decision Outbox rows."""
    created = datetime(2026, 9, 8, tzinfo=UTC)
    proposal_ids = [
        await seed_proposal(
            engine,
            source_session,
            proposer_id,
            proposal_id=UUID(int=20_000 + index),
            field_key=f"outbox_{index:03d}",
            created_at=created + timedelta(microseconds=index // 2),
        )
        for index in range(count)
    ]
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            for index, proposal_id in enumerate(proposal_ids):
                proposal = await session.get(FactProposal, proposal_id)
                assert proposal is not None
                proposal.status = "rejected"
                proposal.decision_actor_id = decision_actor_id
                proposal.decision_reason = "Unsupported source"
                proposal.decided_at = proposal.created_at
                await session.flush()
                event = fact_decision_event(proposal)
                session.add(BusinessOutbox(
                    id=UUID(int=30_000 + index),
                    aggregate_kind="fact_proposal",
                    aggregate_id=proposal.id,
                    project_id=proposal.project_id,
                    source_session_id=proposal.source_session_id,
                    payload_sha256=canonical_sha256(event),
                    created_at=proposal.created_at,
                ))
    return proposal_ids


def append_body(item: dict, *, sequence: int, key: str) -> dict[str, object]:
    """Build the exact Session append and private Outbox identity sidecar."""
    event = deepcopy(item["event"])
    return {
        "schema_version": 1,
        "expected_sequence": sequence - 1,
        "idempotency_key": key,
        "events": [{
            "event_type": "fact/proposal-decided",
            "schema_version": 1,
            "payload": {
                "seq": sequence,
                "time": 1_789_056_000_000 + sequence,
                "type": "fact/proposal-decided",
                "surfaceOp": "append",
                "data": event["data"],
            },
        }],
        "fact_outbox_events": [{
            "event_sequence": sequence,
            "outbox_id": item["outbox_id"],
            "payload_hash": item["payload_sha256"],
        }],
    }


@pytest.mark.anyio
async def test_outbox_pull_is_bounded_stable_persistent_and_closed(
    client,
    application,
    seeded_database,
    alice,
    manager,
    fact_project_session,
) -> None:
    """An unconsumed page survives clients and uses one stable ordered cursor."""
    token = await login(client, seeded_database, alice, "alice@example.test")
    await seed_rejected_outboxes(
        seeded_database,
        fact_project_session,
        alice.id,
        manager.id,
        35,
    )
    path = f"/internal/xagent/facts/sessions/{fact_project_session.id}/outbox/pull"

    first = await client.post(path, headers=headers(token), json={"schema_version": 1})
    assert first.status_code == 200
    first_body = first.json()
    assert first_body["schema_version"] == 1
    assert len(first_body["items"]) == 32
    assert first_body["next_cursor"] is not None
    assert [item["event"]["data"]["field_key"] for item in first_body["items"]] == [
        f"outbox_{index:03d}" for index in range(32)
    ]
    assert all(
        set(item) == {"outbox_id", "payload_sha256", "event"}
        for item in first_body["items"]
    )
    assert all(
        set(item["event"]) == {"type", "data"}
        and item["event"]["type"] == "fact/proposal-decided"
        and set(item["event"]["data"]) == {
            "proposal_id",
            "project_id",
            "field_key",
            "label",
            "status",
            "decision_reason",
        }
        for item in first_body["items"]
    )

    async with AsyncClient(
        transport=ASGITransport(app=application),
        base_url="http://testserver",
    ) as restarted_client:
        repeated = await restarted_client.post(
            path,
            headers=headers(token),
            json={"schema_version": 1},
        )
    assert repeated.json() == first_body

    second = await client.post(
        path,
        headers=headers(token),
        json={"schema_version": 1, "cursor": first_body["next_cursor"]},
    )
    assert second.status_code == 200
    assert [item["event"]["data"]["field_key"] for item in second.json()["items"]] == [
        "outbox_032",
        "outbox_033",
        "outbox_034",
    ]
    assert second.json()["next_cursor"] is None

    malformed = await client.post(
        path,
        headers=headers(token),
        json={"schema_version": 1, "cursor": "not-a-cursor"},
    )
    oversized = await client.post(
        path,
        headers=headers(token),
        json={"schema_version": 1, "limit": 33},
    )
    assert malformed.status_code == oversized.status_code == 422
    assert malformed.json() == oversized.json() == {"detail": {"code": "fact-input-invalid"}}

    await login(client, seeded_database, manager, "manager@example.test")
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "DELETE FROM project_memberships "
                    "WHERE project_id = :project AND account_id = :manager"
                ),
                {"project": fact_project_session.project_id, "manager": manager.id},
            )
    fresh_login = await client.post(
        "/api/v1/auth/login",
        json={"email": "manager@example.test", "password": PASSWORD},
    )
    assert fresh_login.status_code == 200
    unauthorized = await client.post(
        path,
        headers=headers(fresh_login.json()["access_token"]),
        json={"schema_version": 1},
    )
    guessed = await client.post(
        f"/internal/xagent/facts/sessions/{UUID(int=999_999)}/outbox/pull",
        headers=headers(fresh_login.json()["access_token"]),
        json={"schema_version": 1},
    )
    assert unauthorized.status_code == guessed.status_code == 404
    assert unauthorized.json() == guessed.json() == {"detail": {"code": "not-found"}}


@pytest.mark.anyio
async def test_outbox_append_validates_identity_consumes_atomically_and_replays(
    client,
    seeded_database,
    alice,
    manager,
    fact_project_session,
    monkeypatch,
) -> None:
    """Malformed, cancelled, or replayed projection cannot lose or duplicate an event."""
    token = await login(client, seeded_database, alice, "alice@example.test")
    await seed_rejected_outboxes(
        seeded_database,
        fact_project_session,
        alice.id,
        manager.id,
        1,
    )
    pull_path = f"/internal/xagent/facts/sessions/{fact_project_session.id}/outbox/pull"
    pulled = await client.post(
        pull_path,
        headers=headers(token),
        json={"schema_version": 1},
    )
    assert pulled.status_code == 200
    item = pulled.json()["items"][0]
    append_path = f"/internal/xagent/sessions/{fact_project_session.id}/append"
    body = append_body(item, sequence=0, key="outbox-append-once")

    wrong_hash = append_body(item, sequence=0, key="wrong-outbox-hash")
    wrong_hash["fact_outbox_events"][0]["payload_hash"] = "f" * 64
    altered = append_body(item, sequence=0, key="altered-outbox-event")
    altered["events"][0]["payload"]["data"]["label"] = "Altered"
    for invalid in (wrong_hash, altered):
        denied = await client.post(append_path, headers=headers(token), json=invalid)
        assert denied.status_code == 404
        assert denied.json() == {"detail": {"code": "not-found"}}

    original_store = session_service._store_idempotent_result

    async def cancel_after_event(*_args, **_kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(session_service, "_store_idempotent_result", cancel_after_event)
    with pytest.raises(asyncio.CancelledError):
        await client.post(append_path, headers=headers(token), json=body)
    monkeypatch.setattr(session_service, "_store_idempotent_result", original_store)

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        row = await session.get(BusinessOutbox, UUID(item["outbox_id"]))
        assert row is not None and row.consumed_at is None
        assert await session.scalar(select(func.count()).select_from(XAgentSessionEvent)) == 0
        assert await session.scalar(
            select(func.count()).select_from(AuditEvent).where(
                AuditEvent.action == "fact.cancel",
                AuditEvent.resource_id == row.id,
            )
        ) == 1

    committed = await client.post(append_path, headers=headers(token), json=body)
    replay = await client.post(append_path, headers=headers(token), json=body)
    assert committed.status_code == replay.status_code == 200
    assert replay.json() == committed.json() == {
        "schema_version": 1,
        "last_event_sequence": 0,
        "version": 2,
    }

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        row = await session.get(BusinessOutbox, UUID(item["outbox_id"]))
        events = (await session.scalars(
            select(XAgentSessionEvent).order_by(XAgentSessionEvent.sequence)
        )).all()
        assert row is not None and row.consumed_at is not None
        assert row.consumed_event_sequence == 0
        assert len(events) == 1
        assert events[0].event_type == "fact/proposal-decided"
        assert events[0].payload == body["events"][0]["payload"]
        assert events[0].audit_id is not None
        assert all(event.event_type != "turn/start" for event in events)

    empty = await client.post(
        pull_path,
        headers=headers(token),
        json={"schema_version": 1},
    )
    assert empty.json() == {"schema_version": 1, "items": [], "next_cursor": None}


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("corruption", "expected_status"),
    (
        ("outer_unknown", 422),
        ("event_schema_boolean", 422),
        ("sequence_boolean", 404),
        ("content_revision_boolean", 404),
        ("decision_data_unknown", 404),
    ),
)
async def test_fact_outbox_append_rejects_non_strict_decision_events(
    client,
    seeded_database,
    alice,
    manager,
    fact_project_session,
    corruption: str,
    expected_status: int,
) -> None:
    """Fact delivery rejects ignored fields and booleans masquerading as integers."""
    alice_token = await login(client, seeded_database, alice, "alice@example.test")
    manager_token = await login(client, seeded_database, manager, "manager@example.test")
    proposal_id = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key=f"strict_{corruption}",
    )
    approved = await client.post(
        f"/internal/xagent/facts/proposals/{proposal_id}/approve",
        headers=headers(manager_token),
        json=approve_body(f"strict-{corruption}"),
    )
    assert approved.status_code == 200
    pull = await client.post(
        f"/internal/xagent/facts/sessions/{fact_project_session.id}/outbox/pull",
        headers=headers(alice_token),
        json={"schema_version": 1},
    )
    assert pull.status_code == 200
    item = pull.json()["items"][0]
    body = append_body(item, sequence=0, key=f"strict-{corruption}")
    if corruption == "outer_unknown":
        body["events"][0]["unknown"] = "ignored"
    elif corruption == "event_schema_boolean":
        body["events"][0]["schema_version"] = True
    elif corruption == "sequence_boolean":
        body["events"][0]["payload"]["seq"] = False
    elif corruption == "content_revision_boolean":
        body["events"][0]["payload"]["data"]["content_revision"] = True
    else:
        body["events"][0]["payload"]["data"]["unknown"] = "ignored"

    denied = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=headers(alice_token),
        json=body,
    )
    assert denied.status_code == expected_status
    expected_code = "invalid-request" if expected_status == 422 else "not-found"
    assert denied.json() == {"detail": {"code": expected_code}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        outbox = await session.get(BusinessOutbox, UUID(item["outbox_id"]))
        assert outbox is not None and outbox.consumed_at is None
        assert await session.scalar(select(func.count()).select_from(XAgentSessionEvent)) == 0


@pytest.mark.anyio
async def test_ordinary_session_events_keep_existing_loose_envelope_compatibility(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    """Fact-only strict validation does not tighten an ordinary Session event."""
    token = await login(client, seeded_database, alice, "alice@example.test")
    response = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": "ordinary-loose-envelope",
            "events": [{
                "event_type": "ordinary/custom",
                "schema_version": "1",
                "payload": {"value": 1},
                "ignored_outer_field": True,
            }],
        },
    )
    assert response.status_code == 200
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        event = await session.scalar(select(XAgentSessionEvent))
    assert event is not None
    assert event.event_type == "ordinary/custom"
    assert event.schema_version == 1
    assert event.payload == {"value": 1}
