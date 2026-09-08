import asyncio
import json
from datetime import UTC, datetime, timedelta
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditEvent
from app.models.facts import BusinessOutbox, FactProposal
from app.services import facts as facts_service
from test_fact_admission import (
    _fact_attachment,
    _fact_result_event,
    _prepare_for_admission,
)
from test_fact_decisions import approve_body, reject_body
from test_fact_outbox import append_body
from test_fact_prepare import (
    _delegation_token,
    _permission_revision,
    _prepare_body,
    _prime_tool_call,
)
from test_fact_queries import headers, login, seed_proposal


@pytest.mark.anyio
async def test_prepare_and_admit_audits_are_redacted(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    """Receipt lifecycle audit stores fixed identities and hashes, never private text."""
    token, _, tool_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="audit-lifecycle",
    )
    append = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "audit-admit",
            "events": [_fact_result_event(
                sequence=1,
                tool_call_id=tool_call_id,
                proposal_id=prepared["result"]["proposalId"],
            )],
            "fact_proposal_receipts": [_fact_attachment(
                prepared,
                sequence=1,
                tool_call_id=tool_call_id,
            )],
            "fact_outbox_events": [],
        },
    )
    assert append.status_code == 200
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        lifecycle = list((await session.scalars(
            select(AuditEvent).where(AuditEvent.action.in_(("fact.prepare", "fact.admit")))
        )).all())
    assert {event.action for event in lifecycle} == {"fact.prepare", "fact.admit"}
    assert prepared["receipt"] not in json.dumps([event.details for event in lifecycle])


@pytest.mark.anyio
async def test_expiry_audit_is_redacted(
    client,
    seeded_database,
    alice,
    fact_project_session,
    monkeypatch,
) -> None:
    """Wall-clock expiry emits one redacted terminal audit without Session admission."""
    issued_at = datetime.now(UTC) - timedelta(minutes=6)
    monkeypatch.setattr(
        "app.services.facts.new_receipt_times",
        lambda: (issued_at, issued_at + timedelta(minutes=5)),
    )
    token = await login(client, seeded_database, alice, "alice@example.test")
    permission_revision = _permission_revision(token)
    expired_call = "call-admit-audit-expired"
    await _prime_tool_call(
        seeded_database,
        fact_project_session.id,
        alice.id,
        tool_call_id=expired_call,
    )
    expired_prepared = await client.post(
        "/internal/xagent/facts/proposals/prepare",
        headers={
            **headers(token),
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=fact_project_session.id,
                project_id=fact_project_session.project_id,
                tool_call_id=expired_call,
                permission_revision=permission_revision,
            ),
        },
        json={
            **_prepare_body(fact_project_session.id),
            "tool_call_id": expired_call,
            "permission_revision": permission_revision,
            "idempotency_key": "audit-expired-prepare",
        },
    )
    assert expired_prepared.status_code == 200
    expired = expired_prepared.json()
    denied = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "audit-expired-append",
            "events": [_fact_result_event(
                sequence=1,
                tool_call_id=expired_call,
                proposal_id=expired["result"]["proposalId"],
            )],
            "fact_proposal_receipts": [_fact_attachment(
                expired,
                sequence=1,
                tool_call_id=expired_call,
            )],
            "fact_outbox_events": [],
        },
    )
    assert denied.status_code == 410
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        expiry = await session.scalar(select(AuditEvent).where(
            AuditEvent.action == "fact.expire"
        ))
    assert expiry is not None
    assert expired["receipt"] not in json.dumps(expiry.details)


@pytest.mark.anyio
async def test_decision_and_projection_audits_cover_outcomes_without_content(
    client,
    seeded_database,
    alice,
    manager,
    fact_project_session,
) -> None:
    """Every Task 3 outcome records only stable identities, counts, hashes, and timing."""
    alice_token = await login(client, seeded_database, alice, "alice@example.test")
    manager_token = await login(client, seeded_database, manager, "manager@example.test")
    secrets = {
        "FORBIDDEN_FACT_TEXT",
        "FORBIDDEN_ASSERTION_REASON",
        "FORBIDDEN_DECISION_REASON",
        alice_token,
        manager_token,
    }

    approve_id = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key="audit_approve",
        value="FORBIDDEN_FACT_TEXT",
        assertion_reason="FORBIDDEN_ASSERTION_REASON",
    )
    denial = await client.post(
        f"/internal/xagent/facts/proposals/{approve_id}/approve",
        headers=headers(alice_token),
        json=approve_body("audit-specialist-denial"),
    )
    approved = await client.post(
        f"/internal/xagent/facts/proposals/{approve_id}/approve",
        headers=headers(manager_token),
        json=approve_body("audit-approve", "FORBIDDEN_DECISION_REASON"),
    )
    approve_replay = await client.post(
        f"/internal/xagent/facts/proposals/{approve_id}/approve",
        headers=headers(manager_token),
        json=approve_body("audit-approve", "FORBIDDEN_DECISION_REASON"),
    )
    assert denial.status_code == 404
    assert approved.status_code == approve_replay.status_code == 200

    reject_id = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key="audit_reject",
    )
    rejected = await client.post(
        f"/internal/xagent/facts/proposals/{reject_id}/reject",
        headers=headers(manager_token),
        json=reject_body("audit-reject", "FORBIDDEN_DECISION_REASON"),
    )
    withdraw_id = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key="audit_withdraw",
    )
    withdrawn = await client.post(
        f"/internal/xagent/facts/proposals/{withdraw_id}/withdraw",
        headers=headers(alice_token),
        json={"schema_version": 1, "idempotency_key": "audit-withdraw"},
    )
    assert rejected.status_code == withdrawn.status_code == 200

    conflict_first = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key="audit_conflict",
    )
    conflict_second = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key="audit_conflict",
    )
    first = await client.post(
        f"/internal/xagent/facts/proposals/{conflict_first}/approve",
        headers=headers(manager_token),
        json=approve_body("audit-conflict-first"),
    )
    conflict = await client.post(
        f"/internal/xagent/facts/proposals/{conflict_second}/approve",
        headers=headers(manager_token),
        json=approve_body("audit-conflict-second"),
    )
    assert first.status_code == 200
    assert conflict.status_code == 409

    pull = await client.post(
        f"/internal/xagent/facts/sessions/{fact_project_session.id}/outbox/pull",
        headers=headers(alice_token),
        json={"schema_version": 1, "limit": 1},
    )
    item = pull.json()["items"][0]
    projection = append_body(item, sequence=0, key="audit-outbox-append")
    projected = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=headers(alice_token),
        json=projection,
    )
    projection_replay = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=headers(alice_token),
        json=projection,
    )
    assert projected.status_code == projection_replay.status_code == 200

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        audits = list((await session.scalars(select(AuditEvent).where(
            AuditEvent.action.like("fact.%")
        ))).all())
        approved_outbox = await session.scalar(select(BusinessOutbox).where(
            BusinessOutbox.aggregate_id == approve_id
        ))
    actions = {event.action for event in audits}
    assert {
        "fact.authorization_denied",
        "fact.approve",
        "fact.confirm",
        "fact.reject",
        "fact.withdraw",
        "fact.conflict",
        "fact.outbox.project",
        "fact.replay",
    } <= actions
    approve_replay_audit = next(
        event
        for event in audits
        if event.action == "fact.replay"
        and event.resource_id == approve_id
        and event.details["operation"] == "approve"
    )
    assert approved_outbox is not None
    assert approve_replay_audit.details["payload_sha256"] == approved_outbox.payload_sha256
    serialized = json.dumps([event.details for event in audits])
    assert all(secret not in serialized for secret in secrets)


@pytest.mark.anyio
async def test_cancelled_decision_rolls_back_and_records_redacted_audit(
    client,
    seeded_database,
    alice,
    manager,
    fact_project_session,
    monkeypatch,
) -> None:
    """Cancellation before commit leaves a pending proposal and one durable audit."""
    manager_token = await login(client, seeded_database, manager, "manager@example.test")
    proposal_id = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key="cancelled_decision",
        value="FORBIDDEN_CANCELLED_VALUE",
        assertion_reason="FORBIDDEN_CANCELLED_REASON",
    )

    async def cancel(*_args, **_kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(facts_service, "_create_fact_outbox", cancel)
    with pytest.raises(asyncio.CancelledError):
        await client.post(
            f"/internal/xagent/facts/proposals/{proposal_id}/approve",
            headers=headers(manager_token),
            json=approve_body("cancelled-decision", "FORBIDDEN_CANCELLED_REASON"),
        )

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal = await session.get(FactProposal, proposal_id)
        audits = list((await session.scalars(select(AuditEvent).where(
            AuditEvent.action == "fact.cancel",
            AuditEvent.resource_id == proposal_id,
        ))).all())
    assert proposal is not None and proposal.status == "pending"
    assert len(audits) == 1
    assert audits[0].details["operation"] == "approve"
    assert "FORBIDDEN_CANCELLED" not in json.dumps(audits[0].details)
