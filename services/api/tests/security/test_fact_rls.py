from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from sqlalchemy.sql.elements import TextClause

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.identity import Role


async def _seed_proposal(
    engine: AsyncEngine,
    *,
    project_id: UUID,
    session_id: UUID,
    proposer_id: UUID,
    status: str = "pending",
    decision_actor_id: UUID | None = None,
) -> UUID:
    proposal_id = uuid4()
    is_terminal = status in ("confirmed", "rejected", "withdrawn", "conflicted")
    decision_actor_id = decision_actor_id or (proposer_id if is_terminal else None)
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO fact_proposals "
                "(id, project_id, field_key, label, value_type, value, proposer_id, "
                "source_session_id, source_tool_call_id, base_revision, assertion_reason, status, "
                "decision_actor_id, decision_reason, payload_sha256, idempotency_key, "
                "permission_revision, admission_expires_at, admitted_at, decided_at) "
                "VALUES (:id, :project, 'account.owner', 'Account owner', 'text', "
                "to_jsonb('Ada'::text), :proposer, :session, :tool_call, 0, 'Known by the team', "
                "CAST(:status AS varchar), :decision_actor, :decision_reason, :payload_hash, "
                ":idempotency_key, 1, "
                "CURRENT_TIMESTAMP + INTERVAL '5 minutes', "
                "CASE WHEN CAST(:status AS text) = 'prepared' THEN NULL ELSE CURRENT_TIMESTAMP END, "
                "CASE WHEN :is_terminal THEN CURRENT_TIMESTAMP ELSE NULL END)"
            ),
            {
                "id": proposal_id,
                "project": project_id,
                "proposer": proposer_id,
                "session": session_id,
                "tool_call": f"call-{proposal_id}",
                "status": status,
                "decision_actor": decision_actor_id,
                "decision_reason": "Not accepted" if status == "rejected" else None,
                "payload_hash": proposal_id.hex.ljust(64, "0"),
                "idempotency_key": f"prepare-{proposal_id}",
                "is_terminal": is_terminal,
            },
        )
        if is_terminal:
            await connection.execute(
                text(
                    "INSERT INTO business_outbox "
                    "(id, aggregate_kind, aggregate_id, project_id, source_session_id, payload_sha256) "
                    "VALUES (:id, 'fact_proposal', :proposal, :project, :session, :payload_hash)"
                ),
                {
                    "id": uuid4(),
                    "proposal": proposal_id,
                    "project": project_id,
                    "session": session_id,
                    "payload_hash": proposal_id.hex.ljust(64, "0"),
                },
            )
    return proposal_id


def _fact_evidence_insert() -> TextClause:
    return text(
        "INSERT INTO fact_proposal_evidence "
        "(proposal_id, project_id, session_id, citation_id, admission_event_sequence, artifact_id, "
        "version_id, index_id, index_generation, chunk_id, line_start, line_end) "
        "VALUES (:proposal, :project, :session, :citation, 0, :artifact, :version, :index, 1, "
        ":chunk, :line, :line)"
    )


@pytest.mark.anyio
async def test_fact_proposals_are_visible_to_current_proposer_and_manager_members(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    manager,
    fact_project_session,
) -> None:
    proposal_id = await _seed_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
    )
    for account, role in ((alice, Role.SPECIALIST), (manager, Role.MANAGER)):
        await set_actor_context(actor_session, Actor(id=account.id, role=role))
        assert await actor_session.scalar(
            text("SELECT id FROM fact_proposals WHERE id = :id"), {"id": proposal_id}
        ) == proposal_id


@pytest.mark.anyio
async def test_fact_rls_hides_unrelated_guessed_and_prepared_proposals(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    bob,
    fact_project_session,
) -> None:
    pending_id = await _seed_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
    )
    prepared_id = await _seed_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
        status="prepared",
    )
    await set_actor_context(actor_session, Actor(id=bob.id, role=Role.SPECIALIST))

    assert await actor_session.scalar(
        text("SELECT id FROM fact_proposals WHERE id = :id"), {"id": pending_id}
    ) is None
    assert await actor_session.scalar(
        text("SELECT id FROM fact_proposals WHERE id = :id"), {"id": uuid4()}
    ) is None

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    assert await actor_session.scalar(
        text("SELECT id FROM fact_proposals WHERE id = :id"), {"id": prepared_id}
    ) is None


@pytest.mark.anyio
async def test_only_the_prepared_proposal_owner_can_add_evidence(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    manager,
    fact_project_session,
    fact_admitted_evidence,
) -> None:
    proposal_id = await _seed_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
        status="prepared",
    )
    await set_actor_context(actor_session, Actor(id=manager.id, role=Role.MANAGER))

    with pytest.raises(DBAPIError):
        async with actor_session.begin_nested():
            await actor_session.execute(
                _fact_evidence_insert(),
                {
                    **fact_admitted_evidence[0],
                    "proposal": proposal_id,
                    "project": fact_project_session.project_id,
                    "session": fact_project_session.id,
                },
            )


@pytest.mark.anyio
async def test_prepared_proposal_owner_can_add_evidence(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    fact_project_session,
    fact_admitted_evidence,
) -> None:
    proposal_id = await _seed_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
        status="prepared",
    )
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))

    await actor_session.execute(
        _fact_evidence_insert(),
        {
            **fact_admitted_evidence[0],
            "proposal": proposal_id,
            "project": fact_project_session.project_id,
            "session": fact_project_session.id,
        },
    )


@pytest.mark.anyio
@pytest.mark.parametrize("status", ["pending", "confirmed"])
async def test_proposal_owner_cannot_add_evidence_after_preparation(
    status: str,
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    manager,
    fact_project_session,
    fact_admitted_evidence,
) -> None:
    proposal_id = await _seed_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
        status=status,
        decision_actor_id=manager.id if status == "confirmed" else None,
    )
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))

    with pytest.raises(DBAPIError):
        async with actor_session.begin_nested():
            await actor_session.execute(
                _fact_evidence_insert(),
                {
                    **fact_admitted_evidence[0],
                    "proposal": proposal_id,
                    "project": fact_project_session.project_id,
                    "session": fact_project_session.id,
                },
            )


@pytest.mark.anyio
async def test_fact_rls_rechecks_revoked_membership_on_each_statement(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    fact_project_session,
) -> None:
    proposal_id = await _seed_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
    )
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    assert await actor_session.scalar(
        text("SELECT id FROM fact_proposals WHERE id = :id"), {"id": proposal_id}
    ) == proposal_id

    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "DELETE FROM project_memberships WHERE project_id = :project AND account_id = :actor"
            ),
            {"project": fact_project_session.project_id, "actor": alice.id},
        )

    assert await actor_session.scalar(
        text("SELECT id FROM fact_proposals WHERE id = :id"), {"id": proposal_id}
    ) is None


@pytest.mark.anyio
async def test_manager_role_without_current_membership_cannot_read_or_decide(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    manager,
    alice_project,
) -> None:
    session_id = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO xagent_sessions "
                "(id, owner_id, project_id, visibility, permission_revision_created, "
                "next_citation_ordinal, title) VALUES "
                "(:id, :owner, :project, 'project', 1, 1, 'Manager membership check')"
            ),
            {"id": session_id, "owner": alice.id, "project": alice_project.id},
        )
    proposal_id = await _seed_proposal(
        seeded_database,
        project_id=alice_project.id,
        session_id=session_id,
        proposer_id=alice.id,
    )
    await set_actor_context(actor_session, Actor(id=manager.id, role=Role.MANAGER))

    assert await actor_session.scalar(
        text("SELECT id FROM fact_proposals WHERE id = :id"), {"id": proposal_id}
    ) is None
    result = await actor_session.execute(
        text(
            "UPDATE fact_proposals SET status = 'rejected', decision_actor_id = :actor, "
            "decision_reason = 'Not accepted', decided_at = CURRENT_TIMESTAMP WHERE id = :id"
        ),
        {"id": proposal_id, "actor": manager.id},
    )
    assert result.rowcount == 0


@pytest.mark.anyio
async def test_specialist_can_propose_but_only_manager_member_can_decide(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    manager,
    fact_project_session,
) -> None:
    prepared_id = uuid4()
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    await actor_session.execute(
        text(
            "INSERT INTO fact_proposals "
            "(id, project_id, field_key, label, value_type, value, proposer_id, "
            "source_session_id, source_tool_call_id, base_revision, assertion_reason, status, "
            "payload_sha256, idempotency_key, permission_revision, admission_expires_at, admitted_at) "
            "VALUES (:id, :project, 'account.owner', 'Account owner', 'text', "
            "to_jsonb('Ada'::text), :actor, :session, 'call-propose', 0, 'Known by the team', "
            "'prepared', :payload_hash, 'prepare-propose', 1, "
            "CURRENT_TIMESTAMP + INTERVAL '5 minutes', NULL)"
        ),
        {
            "id": prepared_id,
            "project": fact_project_session.project_id,
            "actor": alice.id,
            "session": fact_project_session.id,
            "payload_hash": "9" * 64,
        },
    )
    proposal_id = await _seed_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
    )
    with pytest.raises(DBAPIError):
        async with actor_session.begin_nested():
            await actor_session.execute(
                text(
                    "UPDATE fact_proposals SET status = 'rejected', decision_actor_id = :actor, "
                    "decision_reason = 'No', decided_at = CURRENT_TIMESTAMP WHERE id = :id"
                ),
                {"id": proposal_id, "actor": alice.id},
            )

    await set_actor_context(actor_session, Actor(id=manager.id, role=Role.MANAGER))
    manager_update = await actor_session.execute(
        text(
            "UPDATE fact_proposals SET status = 'rejected', decision_actor_id = :actor, "
            "decision_reason = 'Not accepted', decided_at = CURRENT_TIMESTAMP WHERE id = :id"
        ),
        {"id": proposal_id, "actor": manager.id},
    )
    assert manager_update.rowcount == 1
    await actor_session.execute(
        text(
            "INSERT INTO business_outbox "
            "(id, aggregate_kind, aggregate_id, project_id, source_session_id, payload_sha256) "
            "VALUES (:id, 'fact_proposal', :proposal, :project, :session, :payload_hash)"
        ),
        {
            "id": uuid4(),
            "proposal": proposal_id,
            "project": fact_project_session.project_id,
            "session": fact_project_session.id,
            "payload_hash": "9" * 64,
        },
    )


@pytest.mark.anyio
async def test_manager_cannot_attribute_proposal_decision_to_another_actor(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    manager,
    fact_project_session,
) -> None:
    proposal_id = await _seed_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
    )
    await set_actor_context(actor_session, Actor(id=manager.id, role=Role.MANAGER))

    with pytest.raises(DBAPIError):
        async with actor_session.begin_nested():
            await actor_session.execute(
                text(
                    "UPDATE fact_proposals SET status = 'rejected', decision_actor_id = :forged, "
                    "decision_reason = 'Not accepted', decided_at = CURRENT_TIMESTAMP WHERE id = :id"
                ),
                {"id": proposal_id, "forged": alice.id},
            )
            await actor_session.execute(
                text(
                    "INSERT INTO business_outbox "
                    "(id, aggregate_kind, aggregate_id, project_id, source_session_id, payload_sha256) "
                    "VALUES (:id, 'fact_proposal', :proposal, :project, :session, :payload_hash)"
                ),
                {
                    "id": uuid4(),
                    "proposal": proposal_id,
                    "project": fact_project_session.project_id,
                    "session": fact_project_session.id,
                    "payload_hash": "7" * 64,
                },
            )
            await actor_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.anyio
async def test_manager_cannot_attribute_fact_revision_to_another_actor(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    manager,
    fact_project_session,
) -> None:
    proposal_id = await _seed_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
    )
    await set_actor_context(actor_session, Actor(id=manager.id, role=Role.MANAGER))

    with pytest.raises(DBAPIError):
        async with actor_session.begin_nested():
            await actor_session.execute(
                text(
                    "INSERT INTO project_fact_revisions "
                    "(id, project_id, field_key, label, value_type, value, content_revision, "
                    "proposal_id, confirmed_by_id) VALUES (:id, :project, 'account.owner', "
                    "'Account owner', 'text', to_jsonb('Ada'::text), 1, :proposal, :forged)"
                ),
                {
                    "id": uuid4(),
                    "project": fact_project_session.project_id,
                    "proposal": proposal_id,
                    "forged": alice.id,
                },
            )
