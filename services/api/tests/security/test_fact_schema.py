import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from anyio import to_thread
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine


FACT_TABLES = {
    "project_fact_revisions",
    "project_fact_heads",
    "fact_proposals",
    "fact_proposal_evidence",
    "fact_proposal_receipts",
    "fact_operation_idempotency",
    "business_outbox",
}
PENDING = "pending"
TERMINAL = ("confirmed", "rejected", "withdrawn", "conflicted")


def _safe_fact_audit_details() -> dict[str, object]:
    return {
        "project_id": str(UUID(int=501)),
        "session_id": str(UUID(int=502)),
        "proposal_id": str(UUID(int=503)),
        "tool_call_id": "call-1",
        "request_sha256": "a" * 64,
        "payload_sha256": "b" * 64,
        "evidence_count": 1,
        "operation": "prepare",
        "result": "prepared",
        "status": "prepared",
        "latency_ms": 4,
    }


def _alembic_config(database_url: str) -> Config:
    backend_directory = Path(__file__).resolve().parents[2]
    config = Config(str(backend_directory / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


async def _insert_proposal(
    engine: AsyncEngine,
    *,
    project_id: UUID,
    session_id: UUID,
    proposer_id: UUID,
    status: str = PENDING,
    field_key: str = "customer.primary-contact",
    base_revision: int = 0,
    proposal_id: UUID | None = None,
    decision_actor_id: UUID | None = None,
) -> UUID:
    proposal_id = proposal_id or uuid4()
    is_prepared = status == "prepared"
    is_terminal = status in TERMINAL or status == "expired"
    public_terminal = status in TERMINAL
    decision_actor_id = decision_actor_id or (proposer_id if is_terminal else None)
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO fact_proposals "
                "(id, project_id, field_key, label, value_type, value, proposer_id, "
                "source_session_id, source_tool_call_id, base_revision, assertion_reason, status, "
                "decision_actor_id, decision_reason, payload_sha256, idempotency_key, "
                "permission_revision, admission_expires_at, admitted_at, decided_at) "
                "VALUES (:id, :project, :field_key, 'Primary contact', 'text', "
                "to_jsonb('Ada'::text), :proposer, :session, :tool_call, :base_revision, "
                "'Confirmed by the account team', :status, :decision_actor, :decision_reason, "
                ":payload_hash, :idempotency_key, 1, CURRENT_TIMESTAMP + INTERVAL '5 minutes', "
                "CASE WHEN :is_prepared THEN NULL ELSE CURRENT_TIMESTAMP END, "
                "CASE WHEN :is_terminal THEN CURRENT_TIMESTAMP ELSE NULL END)"
            ),
            {
                "id": proposal_id,
                "project": project_id,
                "field_key": field_key,
                "proposer": proposer_id,
                "session": session_id,
                "tool_call": f"call-{proposal_id}",
                "base_revision": base_revision,
                "status": status,
                "decision_actor": decision_actor_id,
                "decision_reason": "decision" if is_terminal else None,
                "payload_hash": proposal_id.hex.ljust(64, "0"),
                "idempotency_key": f"prepare-{proposal_id}",
                "is_prepared": is_prepared,
                "is_terminal": is_terminal,
            },
        )
        if public_terminal:
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


@pytest.mark.anyio
async def test_revision_017_installs_all_fact_relations(seeded_database: AsyncEngine) -> None:
    async with seeded_database.connect() as connection:
        revision = await connection.scalar(text("SELECT version_num FROM alembic_version"))
        tables = set(
            await connection.scalars(
                text("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'")
            )
        )

    assert revision == "017_fact_tool_call_identity"
    assert FACT_TABLES <= tables


@pytest.mark.anyio
async def test_fact_schema_enforces_closed_types_states_keys_and_positive_revisions(
    seeded_database: AsyncEngine,
    alice,
    fact_project_session,
) -> None:
    values = {
        "id": uuid4(),
        "project": fact_project_session.project_id,
        "proposer": alice.id,
        "session": fact_project_session.id,
        "payload_hash": "a" * 64,
    }
    invalid_fragments = (
        ("'customer.name'", "'money'", "'pending'", "ck_fact_proposal_value"),
        ("'customer.name'", "'text'", "'approved'", None),
        ("'Customer Name'", "'text'", "'pending'", "ck_fact_proposal_field_key"),
    )
    for field_key, value_type, status, constraint in invalid_fragments:
        with pytest.raises(IntegrityError, match=constraint):
            async with seeded_database.begin() as connection:
                await connection.execute(
                    text(
                        "INSERT INTO fact_proposals "
                        "(id, project_id, field_key, label, value_type, value, proposer_id, "
                        "source_session_id, source_tool_call_id, base_revision, assertion_reason, "
                        "status, payload_sha256, idempotency_key, permission_revision, "
                        "admission_expires_at, admitted_at) "
                        f"VALUES (:id, :project, {field_key}, 'Customer', {value_type}, "
                        "to_jsonb('Ada'::text), :proposer, :session, 'call-invalid', 0, 'reason', "
                        f"{status}, :payload_hash, 'invalid', 1, "
                        "CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)"
                    ),
                    {**values, "id": uuid4()},
                )

    proposal_id = await _insert_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
    )
    with pytest.raises(IntegrityError, match="ck_project_fact_revision_content_revision"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO project_fact_revisions "
                    "(id, project_id, field_key, label, value_type, value, content_revision, "
                    "proposal_id, confirmed_by_id) VALUES (:id, :project, 'customer.primary-contact', "
                    "'Primary contact', 'text', to_jsonb('Ada'::text), 0, :proposal, :actor)"
                ),
                {
                    "id": uuid4(),
                    "project": fact_project_session.project_id,
                    "proposal": proposal_id,
                    "actor": alice.id,
                },
            )


@pytest.mark.anyio
async def test_fact_heads_require_same_field_and_next_revision(
    seeded_database: AsyncEngine,
    alice,
    fact_project_session,
) -> None:
    project_id = fact_project_session.project_id
    first_proposal = await _insert_proposal(
        seeded_database,
        project_id=project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
        status="confirmed",
    )
    first_revision = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO project_fact_revisions "
                "(id, project_id, field_key, label, value_type, value, content_revision, "
                "proposal_id, confirmed_by_id) VALUES (:id, :project, 'customer.primary-contact', "
                "'Primary contact', 'text', to_jsonb('Ada'::text), 1, :proposal, :actor)"
            ),
            {
                "id": first_revision,
                "project": project_id,
                "proposal": first_proposal,
                "actor": alice.id,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO project_fact_heads "
                "(project_id, field_key, revision_id, content_revision) "
                "VALUES (:project, 'customer.primary-contact', :revision, 1)"
            ),
            {"project": project_id, "revision": first_revision},
        )

    with pytest.raises(IntegrityError, match="project_fact_heads_pkey"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO project_fact_heads "
                    "(project_id, field_key, revision_id, content_revision) "
                    "VALUES (:project, 'customer.primary-contact', :revision, 1)"
                ),
                {"project": project_id, "revision": first_revision},
            )

    second_proposal = await _insert_proposal(
        seeded_database,
        project_id=project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
        status="confirmed",
        field_key="customer.secondary-contact",
    )
    second_revision = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO project_fact_revisions "
                "(id, project_id, field_key, label, value_type, value, content_revision, "
                "proposal_id, confirmed_by_id) VALUES (:id, :project, "
                "'customer.secondary-contact', 'Secondary contact', 'text', "
                "to_jsonb('Grace'::text), 1, :proposal, :actor)"
            ),
            {
                "id": second_revision,
                "project": project_id,
                "proposal": second_proposal,
                "actor": alice.id,
            },
        )

    with pytest.raises(IntegrityError, match="fk_project_fact_head_revision_identity"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO project_fact_heads "
                    "(project_id, field_key, revision_id, content_revision) "
                    "VALUES (:project, 'customer.billing-contact', :revision, 1)"
                ),
                {"project": project_id, "revision": second_revision},
            )

    with pytest.raises(DBAPIError, match="fact head must advance by exactly one revision"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE project_fact_heads SET content_revision = 3 "
                    "WHERE project_id = :project AND field_key = 'customer.primary-contact'"
                ),
                {"project": project_id},
            )


@pytest.mark.anyio
async def test_confirmed_revisions_and_terminal_proposals_are_immutable(
    seeded_database: AsyncEngine,
    alice,
    fact_project_session,
) -> None:
    proposal_id = await _insert_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
        status="confirmed",
    )
    revision_id = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO project_fact_revisions "
                "(id, project_id, field_key, label, value_type, value, content_revision, "
                "proposal_id, confirmed_by_id) VALUES (:id, :project, 'customer.primary-contact', "
                "'Primary contact', 'text', to_jsonb('Ada'::text), 1, :proposal, :actor)"
            ),
            {
                "id": revision_id,
                "project": fact_project_session.project_id,
                "proposal": proposal_id,
                "actor": alice.id,
            },
        )

    with pytest.raises(DBAPIError, match="confirmed fact revisions are immutable"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text("UPDATE project_fact_revisions SET label = 'Changed' WHERE id = :id"),
                {"id": revision_id},
            )
    with pytest.raises(DBAPIError, match="terminal fact proposals are immutable"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text("UPDATE fact_proposals SET status = 'rejected' WHERE id = :id"),
                {"id": proposal_id},
            )


@pytest.mark.anyio
async def test_fact_evidence_requires_admitted_identity_and_exact_chunk_range(
    seeded_database: AsyncEngine,
    alice,
    fact_project_session,
) -> None:
    artifact_id = uuid4()
    version_id = uuid4()
    index_id = uuid4()
    chunk_id = uuid4()
    proposal_id = await _insert_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
        status="prepared",
    )
    embedding = "[0" + ",0" * 1023 + "]"
    async with seeded_database.begin() as connection:
        await connection.execute(
            text("SELECT set_config('app.actor_id', CAST(:actor AS text), true)"),
            {"actor": str(alice.id)},
        )
        await connection.execute(
            text(
                "INSERT INTO xagent_session_events "
                "(session_id, sequence, event_type, schema_version, payload, actor_id) "
                "VALUES (:session, 0, 'tool/result', 1, '{}'::jsonb, :actor)"
            ),
            {"session": fact_project_session.id, "actor": alice.id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, project_id, created_by_id) "
                "VALUES (:artifact, 'facts.txt', :project, :actor)"
            ),
            {"artifact": artifact_id, "project": fact_project_session.project_id, "actor": alice.id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, project_id, version_number, original_filename, uploaded_by_id, "
                "declared_size, actual_size, detected_content_type, scan_status, object_key, size, "
                "content_type, sha256) VALUES (:version, :artifact, :project, 1, 'facts.txt', "
                ":actor, 1, 1, 'text/plain', 'clean', :object_key, 1, 'text/plain', :sha256)"
            ),
            {
                "version": version_id,
                "artifact": artifact_id,
                "project": fact_project_session.project_id,
                "actor": alice.id,
                "object_key": f"artifacts/{artifact_id}/{version_id}",
                "sha256": "1" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_text_indexes "
                "(id, artifact_id, version_id, generation, content_sha256, parser_revision, "
                "embedding_model, embedding_revision, vector_dimensions, configuration_fingerprint, status) "
                "VALUES (:index, :artifact, :version, 1, :sha256, 'parser-1', 'bge-m3', "
                "'revision-1', 1024, :fingerprint, 'ready')"
            ),
            {
                "index": index_id,
                "artifact": artifact_id,
                "version": version_id,
                "sha256": "2" * 64,
                "fingerprint": "3" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_text_chunks "
                "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                "VALUES (:chunk, :index, 0, 10, 12, 'fact evidence', 2, :sha256, CAST(:embedding AS vector))"
            ),
            {"chunk": chunk_id, "index": index_id, "sha256": "4" * 64, "embedding": embedding},
        )
        await connection.execute(
            text(
                "INSERT INTO xagent_admitted_evidence "
                "(session_id, citation_id, admission_event_sequence, artifact_id, version_id, "
                "index_id, index_generation, chunk_id) VALUES (:session, '[资料1]', 0, :artifact, "
                ":version, :index, 1, :chunk)"
            ),
            {
                "session": fact_project_session.id,
                "artifact": artifact_id,
                "version": version_id,
                "index": index_id,
                "chunk": chunk_id,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO fact_proposal_evidence "
                "(proposal_id, project_id, session_id, citation_id, admission_event_sequence, artifact_id, "
                "version_id, index_id, index_generation, chunk_id, line_start, line_end) "
                "VALUES (:proposal, :project, :session, '[资料1]', 0, :artifact, :version, :index, 1, "
                ":chunk, 10, 12)"
            ),
            {
                "proposal": proposal_id,
                "project": fact_project_session.project_id,
                "session": fact_project_session.id,
                "artifact": artifact_id,
                "version": version_id,
                "index": index_id,
                "chunk": chunk_id,
            },
        )

    with pytest.raises(IntegrityError, match="fk_fact_proposal_evidence_admitted_identity"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.actor_id', CAST(:actor AS text), true)"),
                {"actor": str(alice.id)},
            )
            await connection.execute(
                text(
                    "INSERT INTO fact_proposal_evidence "
                    "(proposal_id, project_id, session_id, citation_id, admission_event_sequence, artifact_id, "
                    "version_id, index_id, index_generation, chunk_id, line_start, line_end) "
                    "VALUES (:proposal, :project, :session, '[资料2]', 0, :artifact, :version, :index, 1, "
                    ":chunk, 10, 12)"
                ),
                {
                    "proposal": proposal_id,
                    "project": fact_project_session.project_id,
                    "session": fact_project_session.id,
                    "artifact": artifact_id,
                    "version": version_id,
                    "index": index_id,
                    "chunk": chunk_id,
                },
            )

    with pytest.raises(IntegrityError, match="fk_fact_proposal_evidence_chunk_range"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE fact_proposal_evidence SET line_end = 13 "
                    "WHERE proposal_id = :proposal AND citation_id = '[资料1]'"
                ),
                {"proposal": proposal_id},
            )


@pytest.mark.anyio
async def test_fact_proposal_rejects_sixty_fifth_evidence_row(
    seeded_database: AsyncEngine,
    alice,
    fact_project_session,
    fact_admitted_evidence,
) -> None:
    proposal_id = await _insert_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
        status="prepared",
    )
    statement = text(
        "INSERT INTO fact_proposal_evidence "
        "(proposal_id, project_id, session_id, citation_id, admission_event_sequence, artifact_id, "
        "version_id, index_id, index_generation, chunk_id, line_start, line_end) "
        "VALUES (:proposal, :project, :session, :citation, 0, :artifact, :version, :index, 1, "
        ":chunk, :line, :line)"
    )
    async with seeded_database.begin() as connection:
        await connection.execute(
            text("SELECT set_config('app.actor_id', CAST(:actor AS text), true)"),
            {"actor": str(alice.id)},
        )
        await connection.execute(
            statement,
            [
                {
                    **row,
                    "proposal": proposal_id,
                    "project": fact_project_session.project_id,
                    "session": fact_project_session.id,
                }
                for row in fact_admitted_evidence[:64]
            ],
        )

    with pytest.raises(DBAPIError, match="at most 64 evidence rows"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text("SELECT set_config('app.actor_id', CAST(:actor AS text), true)"),
                {"actor": str(alice.id)},
            )
            await connection.execute(
                statement,
                {
                    **fact_admitted_evidence[64],
                    "proposal": proposal_id,
                    "project": fact_project_session.project_id,
                    "session": fact_project_session.id,
                },
            )


@pytest.mark.anyio
async def test_fact_receipts_require_exact_proposal_and_consumption_claims(
    seeded_database: AsyncEngine,
    alice,
    fact_project_session,
) -> None:
    proposal_id = await _insert_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
    )

    with pytest.raises(IntegrityError, match="fk_fact_proposal_receipt_claims"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO fact_proposal_receipts "
                    "(receipt_digest_id, proposal_id, project_id, actor_id, session_id, "
                    "tool_call_id, permission_revision, source_event_sequence, payload_sha256, "
                    "issued_at, expires_at) VALUES (:receipt, :proposal, :project, :actor, "
                    ":session, :tool_call, 2, 1, :payload_hash, CURRENT_TIMESTAMP, "
                    "CURRENT_TIMESTAMP + INTERVAL '5 minutes')"
                ),
                {
                    "receipt": uuid4(),
                    "proposal": proposal_id,
                    "project": fact_project_session.project_id,
                    "actor": alice.id,
                    "session": fact_project_session.id,
                    "tool_call": f"call-{proposal_id}",
                    "payload_hash": proposal_id.hex.ljust(64, "0"),
                },
            )

    receipt_id = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO fact_proposal_receipts "
                "(receipt_digest_id, proposal_id, project_id, actor_id, session_id, "
                "tool_call_id, permission_revision, source_event_sequence, payload_sha256, "
                "issued_at, expires_at) VALUES (:receipt, :proposal, :project, :actor, "
                ":session, :tool_call, 1, 1, :payload_hash, CURRENT_TIMESTAMP, "
                "CURRENT_TIMESTAMP + INTERVAL '5 minutes')"
            ),
            {
                "receipt": receipt_id,
                "proposal": proposal_id,
                "project": fact_project_session.project_id,
                "actor": alice.id,
                "session": fact_project_session.id,
                "tool_call": f"call-{proposal_id}",
                "payload_hash": proposal_id.hex.ljust(64, "0"),
            },
        )
    async with seeded_database.connect() as connection:
        assert await connection.scalar(
            text(
                "SELECT receipt_digest_id FROM fact_proposal_receipts "
                "WHERE receipt_digest_id = :receipt"
            ),
            {"receipt": receipt_id},
        ) == receipt_id

    for event_sequence, payload_hash in (
        (2, proposal_id.hex.ljust(64, "0")),
        (1, "f" * 64),
    ):
        with pytest.raises(IntegrityError, match="ck_fact_proposal_receipt_consumption"):
            async with seeded_database.begin() as connection:
                await connection.execute(
                    text(
                        "UPDATE fact_proposal_receipts SET consumed_at = CURRENT_TIMESTAMP, "
                        "consumed_event_sequence = :event_sequence, "
                        "consumed_payload_sha256 = :payload_hash "
                        "WHERE receipt_digest_id = :receipt"
                    ),
                    {
                        "receipt": receipt_id,
                        "event_sequence": event_sequence,
                        "payload_hash": payload_hash,
                    },
                )

    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "UPDATE fact_proposal_receipts SET consumed_at = CURRENT_TIMESTAMP, "
                "consumed_event_sequence = source_event_sequence, "
                "consumed_payload_sha256 = payload_sha256 WHERE receipt_digest_id = :receipt"
            ),
            {"receipt": receipt_id},
        )


@pytest.mark.anyio
async def test_one_outbox_row_is_required_for_each_public_terminal_proposal(
    seeded_database: AsyncEngine,
    alice,
    fact_project_session,
) -> None:
    proposal_id = await _insert_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
        status="confirmed",
    )
    with pytest.raises(IntegrityError, match="uq_business_outbox_fact_proposal"):
        async with seeded_database.begin() as connection:
            await connection.execute(
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
                    "payload_hash": "8" * 64,
                },
            )

    with pytest.raises(DBAPIError, match="terminal fact proposals require exactly one outbox row"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text("DELETE FROM business_outbox WHERE aggregate_id = :proposal"),
                {"proposal": proposal_id},
            )


@pytest.mark.anyio
async def test_fact_operation_idempotency_binds_decision_status_revision_and_outbox(
    seeded_database: AsyncEngine,
    alice,
    fact_project_session,
) -> None:
    """Decision operation rows reject contradictory or cross-proposal identities."""
    project_id = fact_project_session.project_id
    first = await _insert_proposal(
        seeded_database,
        project_id=project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
        status="confirmed",
        field_key="operation.first",
    )
    second = await _insert_proposal(
        seeded_database,
        project_id=project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
        status="confirmed",
        field_key="operation.second",
    )
    first_revision = uuid4()
    second_revision = uuid4()
    async with seeded_database.begin() as connection:
        for proposal, revision, field_key in (
            (first, first_revision, "operation.first"),
            (second, second_revision, "operation.second"),
        ):
            await connection.execute(
                text(
                    "INSERT INTO project_fact_revisions "
                    "(id, project_id, field_key, label, value_type, value, content_revision, "
                    "proposal_id, confirmed_by_id) VALUES (:revision, :project, :field_key, "
                    "'Operation', 'text', to_jsonb('Ada'::text), 1, :proposal, :actor)"
                ),
                {
                    "revision": revision,
                    "project": project_id,
                    "field_key": field_key,
                    "proposal": proposal,
                    "actor": alice.id,
                },
            )
        outboxes = dict((await connection.execute(
            text(
                "SELECT aggregate_id, id FROM business_outbox "
                "WHERE aggregate_id IN (:first, :second)"
            ),
            {"first": first, "second": second},
        )).all())

    statement = text(
        "INSERT INTO fact_operation_idempotency "
        "(actor_id, operation, idempotency_key, project_id, request_sha256, proposal_id, "
        "response_status, revision_id, outbox_id) VALUES "
        "(:actor, 'approve', :key, :project, :digest, :proposal, :status, :revision, :outbox)"
    )
    invalid = (
        (
            "status",
            "rejected",
            None,
            outboxes[first],
            "ck_fact_operation_idempotency_decision_status",
        ),
        (
            "missing-revision",
            "confirmed",
            None,
            outboxes[first],
            "ck_fact_operation_idempotency_revision_identity",
        ),
        (
            "missing-outbox",
            "confirmed",
            first_revision,
            None,
            "ck_fact_operation_idempotency_outbox_identity",
        ),
        (
            "cross-revision",
            "confirmed",
            second_revision,
            outboxes[first],
            "fk_fact_operation_idempotency_revision_proposal",
        ),
        (
            "cross-outbox",
            "confirmed",
            first_revision,
            outboxes[second],
            "fk_fact_operation_idempotency_outbox_proposal",
        ),
    )
    for key, status, revision, outbox, constraint in invalid:
        with pytest.raises(IntegrityError, match=constraint):
            async with seeded_database.begin() as connection:
                await connection.execute(
                    statement,
                    {
                        "actor": alice.id,
                        "key": key,
                        "project": project_id,
                        "digest": "d" * 64,
                        "proposal": first,
                        "status": status,
                        "revision": revision,
                        "outbox": outbox,
                    },
                )


@pytest.mark.anyio
async def test_fact_audit_validator_rejects_content_and_secret_keys(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    safe_details = _safe_fact_audit_details()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO audit_events "
                "(id, actor_id, action, resource_type, resource_id, request_id, result, details) "
                "VALUES (:id, :actor, 'fact.prepare', 'fact_proposal', :resource, :request, "
                "'prepared', CAST(:details AS jsonb))"
            ),
            {
                "id": uuid4(),
                "actor": alice.id,
                "resource": UUID(int=503),
                "request": uuid4(),
                "details": json.dumps(safe_details),
            },
        )

    with pytest.raises(IntegrityError, match="ck_audit_event_details"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO audit_events "
                    "(id, actor_id, action, resource_type, resource_id, request_id, result, details) "
                    "VALUES (:id, :actor, 'fact.exfiltrate', 'fact_proposal', :resource, :request, "
                    "'prepared', CAST(:details AS jsonb))"
                ),
                {
                    "id": uuid4(),
                    "actor": alice.id,
                    "resource": UUID(int=503),
                    "request": uuid4(),
                    "details": json.dumps(
                        {key: value for key, value in safe_details.items() if key != "tool_call_id"}
                    ),
                },
            )

    with pytest.raises(IntegrityError, match="ck_audit_event_details"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO audit_events "
                    "(id, actor_id, action, resource_type, resource_id, request_id, result, details) "
                    "VALUES (:id, :actor, 'fact.approve', 'fact_proposal', :resource, :request, "
                    "'confirmed', CAST(:details AS jsonb))"
                ),
                {
                    "id": uuid4(),
                    "actor": alice.id,
                    "resource": UUID(int=503),
                    "request": uuid4(),
                    "details": json.dumps(safe_details),
                },
            )

    forbidden_keys = (
        "field_key",
        "label",
        "value",
        "assertion_reason",
        "decision_reason",
        "evidence_text",
        "credential",
        "token",
        "receipt",
        "url",
        "object_key",
    )
    for forbidden_key in forbidden_keys:
        with pytest.raises(IntegrityError, match="ck_audit_event_details"):
            async with seeded_database.begin() as connection:
                await connection.execute(
                    text(
                        "INSERT INTO audit_events "
                        "(id, actor_id, action, resource_type, resource_id, request_id, result, details) "
                        "VALUES (:id, :actor, 'fact.prepare', 'fact_proposal', :resource, :request, "
                        "'prepared', CAST(:details AS jsonb))"
                    ),
                    {
                        "id": uuid4(),
                        "actor": alice.id,
                        "resource": UUID(int=503),
                        "request": uuid4(),
                        "details": json.dumps({**safe_details, forbidden_key: "secret content"}),
                    },
                )


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("operation", "sk_live_secret"),
        ("result", "customer secret"),
        ("status", "hidden value"),
    ],
)
async def test_fact_audit_validator_rejects_secret_like_scalar_values(
    seeded_database: AsyncEngine,
    alice,
    key: str,
    value: str,
) -> None:
    with pytest.raises(IntegrityError, match="ck_audit_event_details"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO audit_events "
                    "(id, actor_id, action, resource_type, resource_id, request_id, result, details) "
                    "VALUES (:id, :actor, 'fact.prepare', 'fact_proposal', :resource, :request, "
                    "'prepared', CAST(:details AS jsonb))"
                ),
                {
                    "id": uuid4(),
                    "actor": alice.id,
                    "resource": UUID(int=503),
                    "request": uuid4(),
                    "details": json.dumps({**_safe_fact_audit_details(), key: value}),
                },
            )


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("tool_call_id", "expected"),
    [
        ("call_00_UTka2FfoIbNh3F3j9WZN7457", True),
        ("provider opaque identity", True),
        ("x" * 255, True),
        ("", False),
        ("x" * 256, False),
        (7, False),
    ],
)
async def test_fact_audit_validator_accepts_bounded_opaque_tool_call_identities(
    seeded_database: AsyncEngine,
    tool_call_id: object,
    expected: bool,
) -> None:
    details = {**_safe_fact_audit_details(), "tool_call_id": tool_call_id}
    async with seeded_database.connect() as connection:
        valid = await connection.scalar(
            text(
                "SELECT public.xagent_valid_fact_audit_details(:action, CAST(:details AS jsonb))"
            ),
            {"action": "fact.prepare", "details": json.dumps(details)},
        )
    assert valid is expected


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("action", "operation", "result", "status"),
    [
        ("fact.prepare", "prepare", "confirmed", "confirmed"),
        ("fact.prepare", "prepare", "prepared", "confirmed"),
        ("fact.prepare", "prepare", "prepared", None),
        ("fact.replay", "prepare", "cancelled", "prepared"),
        ("fact.replay", "prepare", "replayed", None),
        ("fact.cancel", "prepare", "replayed", "prepared"),
        ("fact.authorization_denied", "approve", "confirmed", None),
        ("fact.authorization_denied", "approve", "not-found", "prepared"),
    ],
)
async def test_fact_audit_validator_rejects_action_incompatible_outcomes(
    seeded_database: AsyncEngine,
    alice,
    action: str,
    operation: str,
    result: str,
    status: str | None,
) -> None:
    details: dict[str, object] = {
        "project_id": str(UUID(int=501)),
        "session_id": str(UUID(int=502)),
        "proposal_id": str(UUID(int=503)),
        "operation": operation,
        "request_sha256": "a" * 64,
        "payload_sha256": "b" * 64,
        "result": result,
        "latency_ms": 4,
    }
    if status is not None:
        details["status"] = status

    with pytest.raises(IntegrityError, match="ck_audit_event_details"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO audit_events "
                    "(id, actor_id, action, resource_type, resource_id, request_id, result, details) "
                    "VALUES (:id, :actor, :action, 'fact_proposal', :resource, :request, "
                    ":result, CAST(:details AS jsonb))"
                ),
                {
                    "id": uuid4(),
                    "actor": alice.id,
                    "action": action,
                    "resource": UUID(int=503),
                    "request": uuid4(),
                    "result": result,
                    "details": json.dumps(details),
                },
            )


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("action", "operation", "result", "status"),
    [
        ("fact.prepare", "prepare", "prepared", "prepared"),
        ("fact.admit", "admit", "pending", "pending"),
        ("fact.expire", "expire", "expired", "expired"),
        ("fact.withdraw", "withdraw", "withdrawn", "withdrawn"),
        ("fact.approve", "approve", "confirmed", "confirmed"),
        ("fact.reject", "reject", "rejected", "rejected"),
        ("fact.conflict", "approve", "conflicted", "conflicted"),
        ("fact.confirm", "approve", "confirmed", "confirmed"),
        ("fact.outbox.project", "outbox_append", "projected", "confirmed"),
        ("fact.outbox.project", "outbox_append", "projected", "rejected"),
        ("fact.outbox.project", "outbox_append", "projected", "withdrawn"),
        ("fact.outbox.project", "outbox_append", "projected", "conflicted"),
        ("fact.replay", "prepare", "replayed", "prepared"),
        ("fact.replay", "admit", "replayed", "pending"),
        ("fact.replay", "approve", "replayed", "conflicted"),
        ("fact.cancel", "prepare", "cancelled", "prepared"),
        ("fact.cancel", "approve", "cancelled", "pending"),
        ("fact.authorization_denied", "approve", "not-found", None),
        ("fact.authorization_denied", "approve", "stale-permission", None),
    ],
)
async def test_fact_audit_validator_accepts_planned_action_schemas(
    seeded_database: AsyncEngine,
    action: str,
    operation: str,
    result: str,
    status: str | None,
) -> None:
    details: dict[str, object] = {
        "project_id": str(UUID(int=501)),
        "session_id": str(UUID(int=502)),
        "proposal_id": str(UUID(int=503)),
        "operation": operation,
        "request_sha256": "a" * 64,
        "payload_sha256": "b" * 64,
        "result": result,
        "latency_ms": 4,
    }
    if action in ("fact.prepare", "fact.admit"):
        details["tool_call_id"] = "call-1"
    if action in ("fact.admit", "fact.outbox.project"):
        details["event_sequence"] = 1
    if status is not None:
        details["status"] = status

    async with seeded_database.connect() as connection:
        valid = await connection.scalar(
            text(
                "SELECT public.xagent_valid_fact_audit_details(:action, CAST(:details AS jsonb))"
            ),
            {"action": action, "details": json.dumps(details)},
        )
    assert valid is True


@pytest.mark.anyio
async def test_empty_fact_schema_can_downgrade_and_upgrade_again(
    seeded_database: AsyncEngine,
) -> None:
    config = _alembic_config(seeded_database.url.render_as_string(hide_password=False))
    await seeded_database.dispose()

    await to_thread.run_sync(command.downgrade, config, "015_citation_authorization")
    await to_thread.run_sync(command.upgrade, config, "head")

    async with seeded_database.connect() as connection:
        revision = await connection.scalar(text("SELECT version_num FROM alembic_version"))
        tables = set(
            await connection.scalars(
                text("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'")
            )
        )
    assert revision == "017_fact_tool_call_identity"
    assert FACT_TABLES <= tables


@pytest.mark.anyio
async def test_opaque_fact_tool_call_audit_rejects_revision_017_downgrade_before_ddl(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    audit_id = uuid4()
    details = {
        **_safe_fact_audit_details(),
        "tool_call_id": "call_00_UTka2FfoIbNh3F3j9WZN7457",
    }
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO audit_events "
                "(id, actor_id, action, resource_type, resource_id, request_id, result, details) "
                "VALUES (:id, :actor, 'fact.prepare', 'fact_proposal', :resource, :request, "
                "'prepared', CAST(:details AS jsonb))"
            ),
            {
                "id": audit_id,
                "actor": alice.id,
                "resource": UUID(int=503),
                "request": uuid4(),
                "details": json.dumps(details),
            },
        )
    config = _alembic_config(seeded_database.url.render_as_string(hide_password=False))
    await seeded_database.dispose()

    with pytest.raises(
        DBAPIError,
        match="cannot downgrade opaque Fact tool-call identities to revision 016",
    ):
        await to_thread.run_sync(
            command.downgrade,
            config,
            "016_xagent_fact_approval",
        )

    async with seeded_database.connect() as connection:
        revision = await connection.scalar(text("SELECT version_num FROM alembic_version"))
        stored = await connection.scalar(
            text("SELECT id FROM audit_events WHERE id = :id"), {"id": audit_id}
        )
    assert revision == "017_fact_tool_call_identity"
    assert stored == audit_id


@pytest.mark.anyio
async def test_fact_audit_event_rejects_downgrade_before_ddl(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    audit_id = uuid4()
    details = _safe_fact_audit_details()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO audit_events "
                "(id, actor_id, action, resource_type, resource_id, request_id, result, details) "
                "VALUES (:id, :actor, 'fact.prepare', 'fact_proposal', :resource, :request, "
                "'prepared', CAST(:details AS jsonb))"
            ),
            {
                "id": audit_id,
                "actor": alice.id,
                "resource": UUID(int=503),
                "request": uuid4(),
                "details": json.dumps(details),
            },
        )
    config = _alembic_config(seeded_database.url.render_as_string(hide_password=False))
    await seeded_database.dispose()

    with pytest.raises(DBAPIError, match="cannot downgrade fact approval with stored data"):
        await to_thread.run_sync(command.downgrade, config, "015_citation_authorization")

    async with seeded_database.connect() as connection:
        revision = await connection.scalar(text("SELECT version_num FROM alembic_version"))
        stored = await connection.scalar(
            text("SELECT id FROM audit_events WHERE id = :id"), {"id": audit_id}
        )
    assert revision == "017_fact_tool_call_identity"
    assert stored == audit_id


@pytest.mark.anyio
async def test_non_empty_fact_schema_rejects_downgrade_before_ddl(
    seeded_database: AsyncEngine,
    alice,
    fact_project_session,
) -> None:
    proposal_id = await _insert_proposal(
        seeded_database,
        project_id=fact_project_session.project_id,
        session_id=fact_project_session.id,
        proposer_id=alice.id,
    )
    config = _alembic_config(seeded_database.url.render_as_string(hide_password=False))
    await seeded_database.dispose()

    with pytest.raises(DBAPIError, match="cannot downgrade fact approval with stored data"):
        await to_thread.run_sync(command.downgrade, config, "015_citation_authorization")

    async with seeded_database.connect() as connection:
        revision = await connection.scalar(text("SELECT version_num FROM alembic_version"))
        stored = await connection.scalar(
            text("SELECT id FROM fact_proposals WHERE id = :id"), {"id": proposal_id}
        )
        tables = set(
            await connection.scalars(
                text("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'")
            )
        )
    assert revision == "017_fact_tool_call_identity"
    assert stored == proposal_id
    assert FACT_TABLES <= tables
