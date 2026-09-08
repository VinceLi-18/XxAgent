import asyncio
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditEvent
from app.models.facts import (
    BusinessOutbox,
    FactOperationIdempotency,
    FactProposal,
    ProjectFactHead,
    ProjectFactRevision,
)
from app.models.project import ProjectMembership
from app.services import facts as facts_service
from test_fact_queries import (
    PASSWORD,
    admit_seeded_proposal,
    headers,
    login,
    seed_evidence,
    seed_proposal,
)


async def seed_pending_with_evidence(
    engine,
    source_session,
    proposer_id: UUID,
    admitted: dict,
    *,
    field_key: str,
) -> UUID:
    """Insert a pending proposal whose evidence came through the immutable ledger."""
    proposal_id = await seed_proposal(
        engine,
        source_session,
        proposer_id,
        field_key=field_key,
        status="prepared",
    )
    await seed_evidence(engine, proposal_id, source_session, admitted, proposer_id)
    await admit_seeded_proposal(engine, proposal_id)
    return proposal_id


def approve_body(key: str, note: str | None = "Reviewed") -> dict[str, object]:
    """Return the closed approval request body."""
    return {
        "schema_version": 1,
        "idempotency_key": key,
        "decision_note": note,
    }


def reject_body(key: str, reason: str = "Not supported") -> dict[str, object]:
    """Return the closed rejection request body."""
    return {
        "schema_version": 1,
        "idempotency_key": key,
        "reason": reason,
    }


@pytest.mark.anyio
async def test_decisions_recheck_role_membership_login_and_reviewer_evidence(
    client,
    seeded_database,
    alice,
    bob,
    manager,
    fact_project_session,
    fact_admitted_evidence,
) -> None:
    """Every reviewer authority is current, including evidence and project access."""
    alice_token = await login(client, seeded_database, alice, "alice@example.test")
    manager_token = await login(client, seeded_database, manager, "manager@example.test")
    evidence_proposal = await seed_pending_with_evidence(
        seeded_database,
        fact_project_session,
        alice.id,
        fact_admitted_evidence[0],
        field_key="evidence_backed",
    )

    specialist = await client.post(
        f"/internal/xagent/facts/proposals/{evidence_proposal}/approve",
        headers=headers(alice_token),
        json=approve_body("specialist-denied"),
    )
    guessed = await client.post(
        f"/internal/xagent/facts/proposals/{uuid4()}/approve",
        headers=headers(manager_token),
        json=approve_body("guessed-denied"),
    )
    assert specialist.status_code == guessed.status_code == 404
    assert specialist.json() == guessed.json() == {"detail": {"code": "not-found"}}

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "UPDATE artifacts SET project_id = NULL, owner_id = :owner "
                    "WHERE id = :artifact"
                ),
                {
                    "owner": bob.id,
                    "artifact": fact_admitted_evidence[0]["artifact"],
                },
            )
            await session.execute(
                text(
                    "UPDATE artifact_versions SET project_id = NULL, owner_id = :owner "
                    "WHERE id = :version"
                ),
                {
                    "owner": bob.id,
                    "version": fact_admitted_evidence[0]["version"],
                },
            )
    evidence_denied = await client.post(
        f"/internal/xagent/facts/proposals/{evidence_proposal}/approve",
        headers=headers(manager_token),
        json=approve_body("evidence-denied"),
    )
    assert evidence_denied.status_code == 404
    assert evidence_denied.json() == guessed.json()

    self_proposal = await seed_proposal(
        seeded_database,
        fact_project_session,
        manager.id,
        field_key="self_approval",
    )
    self_approval = await client.post(
        f"/internal/xagent/facts/proposals/{self_proposal}/approve",
        headers=headers(manager_token),
        json=approve_body("self-approval"),
    )
    assert self_approval.status_code == 200
    assert self_approval.json()["status"] == "confirmed"
    changed_replay = await client.post(
        f"/internal/xagent/facts/proposals/{self_proposal}/approve",
        headers=headers(manager_token),
        json=approve_body("self-approval", "Different review note"),
    )
    assert changed_replay.status_code == 409
    assert changed_replay.json() == {"detail": {"code": "idempotency-conflict"}}

    stale_proposal = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key="stale_manager",
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "DELETE FROM project_memberships "
                    "WHERE project_id = :project AND account_id = :manager"
                ),
                {"project": fact_project_session.project_id, "manager": manager.id},
            )
    stale = await client.post(
        f"/internal/xagent/facts/proposals/{stale_proposal}/approve",
        headers=headers(manager_token),
        json=approve_body("stale-manager"),
    )
    assert stale.status_code == 401
    fresh_login = await client.post(
        "/api/v1/auth/login",
        json={"email": "manager@example.test", "password": PASSWORD},
    )
    assert fresh_login.status_code == 200
    no_membership = await client.post(
        f"/internal/xagent/facts/proposals/{stale_proposal}/approve",
        headers=headers(fresh_login.json()["access_token"]),
        json=approve_body("membership-denied"),
    )
    assert no_membership.status_code == 404
    assert no_membership.json() == guessed.json()


@pytest.mark.anyio
async def test_approval_replay_rechecks_the_current_manager_role(
    client,
    seeded_database,
    alice,
    manager,
    fact_project_session,
) -> None:
    """A new specialist login cannot replay an earlier manager approval."""
    manager_token = await login(client, seeded_database, manager, "manager@example.test")
    proposal_id = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key="demoted_reviewer",
    )
    body = approve_body("demoted-reviewer")
    approved = await client.post(
        f"/internal/xagent/facts/proposals/{proposal_id}/approve",
        headers=headers(manager_token),
        json=body,
    )
    assert approved.status_code == 200

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text("UPDATE accounts SET role = 'specialist' WHERE id = :manager"),
                {"manager": manager.id},
            )
    fresh_login = await client.post(
        "/api/v1/auth/login",
        json={"email": "manager@example.test", "password": PASSWORD},
    )
    assert fresh_login.status_code == 200
    replay = await client.post(
        f"/internal/xagent/facts/proposals/{proposal_id}/approve",
        headers=headers(fresh_login.json()["access_token"]),
        json=body,
    )
    assert replay.status_code == 404
    assert replay.json() == {"detail": {"code": "not-found"}}


@pytest.mark.anyio
async def test_reject_and_withdraw_do_not_require_current_artifact_visibility(
    client,
    seeded_database,
    alice,
    bob,
    manager,
    fact_project_session,
    fact_admitted_evidence,
) -> None:
    """Non-approval terminal actions rely on durable evidence, not Artifact reads."""
    alice_token = await login(client, seeded_database, alice, "alice@example.test")
    manager_token = await login(client, seeded_database, manager, "manager@example.test")
    reject_id = await seed_pending_with_evidence(
        seeded_database,
        fact_project_session,
        alice.id,
        fact_admitted_evidence[0],
        field_key="reject_private_evidence",
    )
    withdraw_id = await seed_pending_with_evidence(
        seeded_database,
        fact_project_session,
        alice.id,
        fact_admitted_evidence[0],
        field_key="withdraw_private_evidence",
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "UPDATE artifacts SET project_id = NULL, owner_id = :owner "
                    "WHERE id = :artifact"
                ),
                {"owner": bob.id, "artifact": fact_admitted_evidence[0]["artifact"]},
            )
            await session.execute(
                text(
                    "UPDATE artifact_versions SET project_id = NULL, owner_id = :owner "
                    "WHERE id = :version"
                ),
                {"owner": bob.id, "version": fact_admitted_evidence[0]["version"]},
            )

    rejected = await client.post(
        f"/internal/xagent/facts/proposals/{reject_id}/reject",
        headers=headers(manager_token),
        json=reject_body("reject-private-evidence"),
    )
    withdrawn = await client.post(
        f"/internal/xagent/facts/proposals/{withdraw_id}/withdraw",
        headers=headers(alice_token),
        json={"schema_version": 1, "idempotency_key": "withdraw-private-evidence"},
    )
    assert rejected.status_code == withdrawn.status_code == 200
    assert rejected.json()["status"] == "rejected"
    assert withdrawn.json()["status"] == "withdrawn"


@pytest.mark.anyio
async def test_withdrawal_and_rejection_are_authorized_idempotent_and_terminal(
    client,
    seeded_database,
    alice,
    bob,
    manager,
    fact_project_session,
) -> None:
    """Only the proposer withdraws pending state, and every terminal state is final."""
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(ProjectMembership(
                project_id=fact_project_session.project_id,
                account_id=bob.id,
            ))
    alice_token = await login(client, seeded_database, alice, "alice@example.test")
    bob_token = await login(client, seeded_database, bob, "bob@example.test")
    manager_token = await login(client, seeded_database, manager, "manager@example.test")
    proposal_id = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key="withdraw_me",
    )
    withdraw_body = {"schema_version": 1, "idempotency_key": "withdraw-once"}
    wrong_actor = await client.post(
        f"/internal/xagent/facts/proposals/{proposal_id}/withdraw",
        headers=headers(bob_token),
        json=withdraw_body,
    )
    manager_wrong_actor = await client.post(
        f"/internal/xagent/facts/proposals/{proposal_id}/withdraw",
        headers=headers(manager_token),
        json={"schema_version": 1, "idempotency_key": "manager-withdraw"},
    )
    assert wrong_actor.status_code == manager_wrong_actor.status_code == 404

    withdrawn = await client.post(
        f"/internal/xagent/facts/proposals/{proposal_id}/withdraw",
        headers=headers(alice_token),
        json=withdraw_body,
    )
    replay = await client.post(
        f"/internal/xagent/facts/proposals/{proposal_id}/withdraw",
        headers=headers(alice_token),
        json=withdraw_body,
    )
    late_reject = await client.post(
        f"/internal/xagent/facts/proposals/{proposal_id}/reject",
        headers=headers(manager_token),
        json=reject_body("late-reject"),
    )
    assert withdrawn.status_code == replay.status_code == 200
    assert withdrawn.json() == replay.json() == {
        "schema_version": 1,
        "proposal_id": str(proposal_id),
        "status": "withdrawn",
    }
    assert late_reject.status_code == 409
    assert late_reject.json() == {"detail": {"code": "fact-already-decided"}}

    reject_proposal = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key="reject_me",
    )
    missing_reason = await client.post(
        f"/internal/xagent/facts/proposals/{reject_proposal}/reject",
        headers=headers(manager_token),
        json={"schema_version": 1, "idempotency_key": "missing-reason"},
    )
    rejected = await client.post(
        f"/internal/xagent/facts/proposals/{reject_proposal}/reject",
        headers=headers(manager_token),
        json=reject_body("reject-once", "Unsupported source"),
    )
    assert missing_reason.status_code == 422
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        assert await session.scalar(
            select(func.count()).select_from(BusinessOutbox)
        ) == 2


@pytest.mark.anyio
async def test_serializable_decision_races_have_one_winner_and_exact_replay(
    client,
    seeded_database,
    alice,
    manager,
    fact_project_session,
) -> None:
    """Concurrent decisions produce one durable outcome per proposal and field base."""
    manager_token = await login(client, seeded_database, manager, "manager@example.test")
    proposal_id = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key="identical_race",
    )

    async def approve(proposal: UUID, key: str):
        return await client.post(
            f"/internal/xagent/facts/proposals/{proposal}/approve",
            headers=headers(manager_token),
            json=approve_body(key),
        )

    identical = await asyncio.gather(
        approve(proposal_id, "same-decision"),
        approve(proposal_id, "same-decision"),
    )
    assert [response.status_code for response in identical] == [200, 200]
    assert identical[0].json() == identical[1].json()

    competing_id = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key="competing_race",
    )
    approved, rejected = await asyncio.gather(
        approve(competing_id, "competing-approve"),
        client.post(
            f"/internal/xagent/facts/proposals/{competing_id}/reject",
            headers=headers(manager_token),
            json=reject_body("competing-reject"),
        ),
    )
    assert sorted((approved.status_code, rejected.status_code)) == [200, 409]
    loser = approved if approved.status_code == 409 else rejected
    assert loser.json() == {"detail": {"code": "fact-already-decided"}}

    first = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key="same_base",
    )
    second = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key="same_base",
    )
    first_result, second_result = await asyncio.gather(
        approve(first, "same-base-first"),
        approve(second, "same-base-second"),
    )
    assert sorted((first_result.status_code, second_result.status_code)) == [200, 409]
    conflict = first_result if first_result.status_code == 409 else second_result
    assert conflict.json() == {"detail": {"code": "fact-revision-conflict"}}

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        statuses = dict((await session.execute(
            select(FactProposal.id, FactProposal.status).where(
                FactProposal.id.in_((first, second))
            )
        )).all())
        counts = (
            await session.scalar(select(func.count()).select_from(ProjectFactRevision)),
            await session.scalar(select(func.count()).select_from(ProjectFactHead)),
            await session.scalar(select(func.count()).select_from(BusinessOutbox)),
            await session.scalar(select(func.count()).select_from(FactOperationIdempotency)),
        )
    assert sorted(statuses.values()) == ["confirmed", "conflicted"]
    expected_confirmations = 3 if approved.status_code == 200 else 2
    assert counts == (
        expected_confirmations,
        expected_confirmations,
        4,
        4,
    )


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("stage", "target"),
    (
        ("revision", "_advance_fact_head"),
        ("head", "_mark_fact_proposal_terminal"),
        ("proposal", "_write_fact_decision_audit"),
        ("audit", "_create_fact_outbox"),
        ("outbox", "_store_fact_decision_operation"),
    ),
)
async def test_approval_rolls_back_every_write_after_injected_failure(
    client,
    seeded_database,
    alice,
    manager,
    fact_project_session,
    monkeypatch,
    stage: str,
    target: str,
) -> None:
    """A failure after any write leaves the pending proposal and no decision fragment."""
    manager_token = await login(client, seeded_database, manager, "manager@example.test")
    proposal_id = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key=f"rollback_{stage}",
    )

    async def fail(*_args, **_kwargs):
        raise RuntimeError(f"injected {stage} failure")

    monkeypatch.setattr(facts_service, target, fail, raising=False)
    response = await client.post(
        f"/internal/xagent/facts/proposals/{proposal_id}/approve",
        headers=headers(manager_token),
        json=approve_body(f"rollback-{stage}"),
    )
    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "service-unavailable"}}

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal = await session.get(FactProposal, proposal_id)
        counts = (
            await session.scalar(select(func.count()).select_from(ProjectFactRevision)),
            await session.scalar(select(func.count()).select_from(ProjectFactHead)),
            await session.scalar(select(func.count()).select_from(BusinessOutbox)),
            await session.scalar(select(func.count()).select_from(FactOperationIdempotency)),
            await session.scalar(
                select(func.count()).select_from(AuditEvent).where(
                    AuditEvent.resource_id == proposal_id,
                    AuditEvent.action.in_(("fact.approve", "fact.confirm")),
                )
            ),
        )
    assert proposal is not None and proposal.status == "pending"
    assert counts == (0, 0, 0, 0, 0)


@pytest.mark.anyio
@pytest.mark.parametrize(
    "corruption",
    (
        "missing_revision",
        "cross_proposal_revision",
        "proposal_status",
        "decision_actor",
        "revision_content_revision",
        "outbox_hash",
    ),
)
async def test_decision_replay_fails_closed_on_semantically_corrupt_identities(
    client,
    seeded_database,
    alice,
    manager,
    fact_project_session,
    corruption: str,
) -> None:
    """Replay validates every stored decision identity instead of trusting its row."""
    manager_token = await login(client, seeded_database, manager, "manager@example.test")
    proposal_id = await seed_proposal(
        seeded_database,
        fact_project_session,
        alice.id,
        field_key=f"corrupt_{corruption}",
    )
    body = approve_body(f"corrupt-{corruption}")
    approved = await client.post(
        f"/internal/xagent/facts/proposals/{proposal_id}/approve",
        headers=headers(manager_token),
        json=body,
    )
    assert approved.status_code == 200

    other_revision_id = None
    if corruption == "cross_proposal_revision":
        other_id = await seed_proposal(
            seeded_database,
            fact_project_session,
            alice.id,
            field_key="corrupt_other_field",
        )
        other = await client.post(
            f"/internal/xagent/facts/proposals/{other_id}/approve",
            headers=headers(manager_token),
            json=approve_body("corrupt-other"),
        )
        assert other.status_code == 200
        other_revision_id = other.json()["fact_revision_id"]

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            # Bypass database triggers/FKs only in this fixture so replay rejects corruption itself.
            if corruption in {"missing_revision", "cross_proposal_revision"}:
                await session.execute(text("SET LOCAL session_replication_role = replica"))
                await session.execute(
                    text(
                        "UPDATE fact_operation_idempotency SET revision_id = :revision "
                        "WHERE actor_id = :actor AND operation = 'approve' "
                        "AND idempotency_key = :key"
                    ),
                    {
                        "revision": (
                            str(UUID(int=987_654))
                            if corruption == "missing_revision"
                            else other_revision_id
                        ),
                        "actor": manager.id,
                        "key": body["idempotency_key"],
                    },
                )
            elif corruption == "proposal_status":
                await session.execute(text("SET LOCAL session_replication_role = replica"))
                await session.execute(
                    text(
                        "UPDATE fact_proposals SET status = 'rejected' "
                        "WHERE id = :proposal"
                    ),
                    {"proposal": proposal_id},
                )
            elif corruption == "decision_actor":
                await session.execute(text("SET LOCAL session_replication_role = replica"))
                await session.execute(
                    text(
                        "UPDATE fact_proposals SET decision_actor_id = :actor "
                        "WHERE id = :proposal"
                    ),
                    {"actor": alice.id, "proposal": proposal_id},
                )
            elif corruption == "revision_content_revision":
                await session.execute(text("SET LOCAL session_replication_role = replica"))
                await session.execute(
                    text(
                        "UPDATE project_fact_revisions SET content_revision = 99 "
                        "WHERE id = :revision"
                    ),
                    {"revision": approved.json()["fact_revision_id"]},
                )
            else:
                await session.execute(text("SET LOCAL session_replication_role = replica"))
                await session.execute(
                    text(
                        "UPDATE business_outbox SET payload_sha256 = :digest "
                        "WHERE aggregate_id = :proposal"
                    ),
                    {"digest": "f" * 64, "proposal": proposal_id},
                )

    replay = await client.post(
        f"/internal/xagent/facts/proposals/{proposal_id}/approve",
        headers=headers(manager_token),
        json=body,
    )
    assert replay.status_code == 503
    assert replay.json() == {"detail": {"code": "service-unavailable"}}
