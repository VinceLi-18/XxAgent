from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.identity import Role


async def _require_retrieval_schema(engine: AsyncEngine) -> None:
    required_tables = {
        "artifact_text_indexes",
        "artifact_text_chunks",
        "artifact_index_jobs",
        "artifact_search_heads",
        "xagent_retrieval_receipts",
        "xagent_admitted_evidence",
        "xagent_cited_answer_evidence",
    }
    required_columns = {
        "artifact_text_indexes.artifact_id",
        "artifact_text_indexes.version_id",
        "artifact_text_indexes.generation",
        "artifact_text_indexes.status",
        "artifact_text_chunks.embedding",
        "artifact_text_chunks.lexical_document",
        "artifact_index_jobs.index_id",
        "artifact_search_heads.index_id",
        "audit_events.artifact_id",
        "audit_events.version_id",
        "audit_events.index_id",
        "audit_events.index_generation",
        "xagent_retrieval_receipts.expires_at",
        "xagent_retrieval_receipts.consumed_at",
        "xagent_admitted_evidence.citation_id",
        "xagent_admitted_evidence.admission_event_sequence",
        "xagent_admitted_evidence.version_id",
        "xagent_admitted_evidence.index_generation",
        "xagent_cited_answer_evidence.answer_event_sequence",
        "xagent_cited_answer_evidence.admission_event_sequence",
        "xagent_cited_answer_evidence.version_id",
        "xagent_cited_answer_evidence.index_generation",
        "xagent_sessions.next_citation_ordinal",
    }
    async with engine.connect() as connection:
        table_names = set(
            await connection.scalars(
                text("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'")
            )
        )
        rows = await connection.execute(
            text(
                "SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = 'public'"
            )
        )
        extensions = set(
            await connection.scalars(
                text("SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm')")
            )
        )

    assert required_tables <= table_names
    assert required_columns <= {f"{table}.{column}" for table, column in rows}
    assert extensions == {"vector", "pg_trgm"}


async def _insert_artifact_version(engine: AsyncEngine, account_id: UUID) -> tuple[UUID, UUID]:
    artifact_id = uuid4()
    version_id = uuid4()
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                "VALUES (:artifact_id, 'retrieval.txt', :account_id, :account_id)"
            ),
            {"artifact_id": artifact_id, "account_id": account_id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, uploaded_by_id, "
                "declared_size, actual_size, detected_content_type, scan_status, object_key, size, "
                "content_type, sha256) "
                "VALUES (:version_id, :artifact_id, :account_id, 1, 'retrieval.txt', :account_id, "
                "1, 1, 'text/plain', 'clean', :object_key, 1, 'text/plain', :sha256)"
            ),
            {
                "version_id": version_id,
                "artifact_id": artifact_id,
                "account_id": account_id,
                "object_key": f"artifacts/{artifact_id}/{version_id}",
                "sha256": "0" * 64,
            },
        )
    return artifact_id, version_id


async def _insert_index(engine: AsyncEngine, artifact_id: UUID, version_id: UUID) -> UUID:
    index_id = uuid4()
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifact_text_indexes "
                "(id, artifact_id, version_id, generation, content_sha256, parser_revision, "
                "embedding_model, embedding_revision, vector_dimensions, configuration_fingerprint, status) "
                "VALUES (:id, :artifact_id, :version_id, 1, :sha256, 'parser-1', 'bge-m3', "
                "'revision-1', 1024, :fingerprint, 'building')"
            ),
            {
                "id": index_id,
                "artifact_id": artifact_id,
                "version_id": version_id,
                "sha256": "1" * 64,
                "fingerprint": "2" * 64,
            },
        )
    return index_id


@pytest.mark.anyio
async def test_retrieval_schema_installs_extensions_and_durable_tables(
    seeded_database: AsyncEngine,
) -> None:
    await _require_retrieval_schema(seeded_database)


@pytest.mark.anyio
@pytest.mark.parametrize(
    "table",
    ("xagent_admitted_evidence", "xagent_cited_answer_evidence"),
)
async def test_cited_answer_provenance_is_immutable_and_not_available_to_workers(
    seeded_database: AsyncEngine,
    application_role: str,
    worker_role: str,
    table: str,
) -> None:
    async with seeded_database.connect() as connection:
        privileges = tuple((await connection.execute(
            text(
                "SELECT has_table_privilege(:application_role, "
                f"'{table}', 'SELECT'), "
                "has_table_privilege(:application_role, "
                f"'{table}', 'INSERT'), "
                "has_table_privilege(:application_role, "
                f"'{table}', 'UPDATE'), "
                "has_table_privilege(:application_role, "
                f"'{table}', 'DELETE'), "
                "has_table_privilege(:worker_role, "
                f"'{table}', 'SELECT')"
            ),
            {"application_role": application_role, "worker_role": worker_role},
        )).one())
        row_security = tuple((await connection.execute(
            text(
                "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                f"WHERE oid = '{table}'::regclass"
            )
        )).one())

    assert privileges == (True, True, False, False, False)
    assert row_security == (True, True)


@pytest.mark.anyio
async def test_admitted_evidence_primary_key_is_the_citation_lookup_index(
    seeded_database: AsyncEngine,
) -> None:
    async with seeded_database.connect() as connection:
        primary_key_columns = tuple((await connection.scalars(
            text(
                "SELECT attribute.attname FROM pg_index AS idx "
                "JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS key(attnum, ordinal) "
                "ON true JOIN pg_attribute AS attribute "
                "ON attribute.attrelid = idx.indrelid AND attribute.attnum = key.attnum "
                "WHERE idx.indrelid = 'xagent_admitted_evidence'::regclass "
                "AND idx.indisprimary ORDER BY key.ordinal"
            )
        )).all())

    assert primary_key_columns == ("session_id", "citation_id")


@pytest.mark.anyio
async def test_text_chunks_enforce_generation_coordinates_and_embedding_limits(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    await _require_retrieval_schema(seeded_database)
    artifact_id, version_id = await _insert_artifact_version(seeded_database, alice.id)
    index_id = await _insert_index(seeded_database, artifact_id, version_id)
    values = {
        "id": uuid4(),
        "index_id": index_id,
        "embedding": "[0" + ",0" * 1023 + "]",
        "sha256": "3" * 64,
    }
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifact_text_chunks "
                "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                "VALUES (:id, :index_id, 0, 1, 1, 'one', 1, :sha256, CAST(:embedding AS vector))"
            ),
            values,
        )

    with pytest.raises(IntegrityError, match="uq_artifact_text_chunks_index_ordinal"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO artifact_text_chunks "
                    "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                    "VALUES (:id, :index_id, 0, 1, 1, 'duplicate', 1, :sha256, CAST(:embedding AS vector))"
                ),
                {**values, "id": uuid4()},
            )

    with pytest.raises(DBAPIError, match="expected 1024 dimensions"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO artifact_text_chunks "
                    "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                    "VALUES (:id, :index_id, 1, 1, 1, 'wrong dimensions', 1, :sha256, '[0]'::vector)"
                ),
                {**values, "id": uuid4()},
            )

    with pytest.raises(IntegrityError, match="ck_artifact_text_chunk_token_count"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO artifact_text_chunks "
                    "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                    "VALUES (:id, :index_id, 1, 1, 1, 'oversized token count', 513, :sha256, "
                    "CAST(:embedding AS vector))"
                ),
                {**values, "id": uuid4()},
            )

    with pytest.raises(IntegrityError, match="ck_artifact_text_chunk_bytes"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO artifact_text_chunks "
                    "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                    "VALUES (:id, :index_id, 1, 1, 1, :oversized_text, 1, :sha256, "
                    "CAST(:embedding AS vector))"
                ),
                {**values, "id": uuid4(), "oversized_text": "x" * 8193},
            )


@pytest.mark.anyio
async def test_search_heads_require_ready_indexes_and_one_head_per_artifact(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    await _require_retrieval_schema(seeded_database)
    artifact_id, version_id = await _insert_artifact_version(seeded_database, alice.id)
    index_id = await _insert_index(seeded_database, artifact_id, version_id)

    with pytest.raises(DBAPIError, match="search heads require a ready index"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO artifact_search_heads (artifact_id, index_id, version_id) "
                    "VALUES (:artifact_id, :index_id, :version_id)"
                ),
                {"artifact_id": artifact_id, "index_id": index_id, "version_id": version_id},
            )

    async with seeded_database.begin() as connection:
        await connection.execute(
            text("UPDATE artifact_text_indexes SET status = 'ready' WHERE id = :index_id"),
            {"index_id": index_id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_search_heads (artifact_id, index_id, version_id) "
                "VALUES (:artifact_id, :index_id, :version_id)"
            ),
            {"artifact_id": artifact_id, "index_id": index_id, "version_id": version_id},
        )

    with pytest.raises(IntegrityError, match="artifact_search_heads_pkey"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO artifact_search_heads (artifact_id, index_id, version_id) "
                    "VALUES (:artifact_id, :index_id, :version_id)"
                ),
                {"artifact_id": artifact_id, "index_id": index_id, "version_id": version_id},
            )


@pytest.mark.anyio
async def test_index_status_cannot_leave_ready_or_failed_terminal_states(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    await _require_retrieval_schema(seeded_database)
    artifact_id, version_id = await _insert_artifact_version(seeded_database, alice.id)
    index_id = await _insert_index(seeded_database, artifact_id, version_id)
    async with seeded_database.begin() as connection:
        await connection.execute(
            text("UPDATE artifact_text_indexes SET status = 'ready' WHERE id = :index_id"),
            {"index_id": index_id},
        )

    with pytest.raises(DBAPIError, match="invalid artifact text index status transition"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text("UPDATE artifact_text_indexes SET status = 'failed' WHERE id = :index_id"),
                {"index_id": index_id},
            )


@pytest.mark.anyio
async def test_indexes_require_their_artifacts_own_version(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    artifact_id, version_id = await _insert_artifact_version(seeded_database, alice.id)
    _, other_version_id = await _insert_artifact_version(seeded_database, alice.id)
    with pytest.raises(IntegrityError, match="fk_artifact_text_index_version_artifact"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO artifact_text_indexes "
                    "(id, artifact_id, version_id, generation, content_sha256, parser_revision, "
                    "embedding_model, embedding_revision, vector_dimensions, configuration_fingerprint, status) "
                    "VALUES (:id, :artifact_id, :version_id, 2, :sha256, 'parser-1', 'bge-m3', "
                    "'revision-1', 1024, :fingerprint, 'building')"
                ),
                {
                    "id": uuid4(),
                    "artifact_id": artifact_id,
                    "version_id": other_version_id,
                    "sha256": "1" * 64,
                    "fingerprint": "2" * 64,
                },
            )


@pytest.mark.anyio
async def test_index_identity_is_immutable(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    artifact_id, version_id = await _insert_artifact_version(seeded_database, alice.id)
    other_artifact_id, other_version_id = await _insert_artifact_version(seeded_database, alice.id)
    index_id = await _insert_index(seeded_database, artifact_id, version_id)

    with pytest.raises(DBAPIError, match="artifact text index identity is immutable"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE artifact_text_indexes SET artifact_id = :artifact_id, version_id = :version_id "
                    "WHERE id = :index_id"
                ),
                {
                    "index_id": index_id,
                    "artifact_id": other_artifact_id,
                    "version_id": other_version_id,
                },
            )


@pytest.mark.anyio
async def test_receipts_expire_after_five_minutes_and_keep_positive_citation_ranges(
    seeded_database: AsyncEngine,
    alice,
    alice_private_xagent_session,
) -> None:
    await _require_retrieval_schema(seeded_database)
    issued_at = datetime.now(UTC)
    values = {
        "id": uuid4(),
        "actor_id": alice.id,
        "session_id": alice_private_xagent_session.id,
        "issued_at": issued_at,
        "expires_at": issued_at + timedelta(minutes=5),
        "invalid_expires_at": issued_at + timedelta(minutes=4),
        "query_sha256": "4" * 64,
        "payload_sha256": "5" * 64,
    }
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO xagent_retrieval_receipts "
                "(id, kind, actor_id, session_id, tool_call_id, query_sha256, scope, "
                "permission_revision, project_ids, index_generations, chunk_ids, payload_sha256, "
                "issued_at, expires_at, citation_ordinal_start, citation_ordinal_end) "
                "VALUES (:id, 'artifact_search', :actor_id, :session_id, 'call-1', :query_sha256, "
                "'{}'::jsonb, 1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, :payload_sha256, "
                ":issued_at, :expires_at, 1, 1)"
            ),
            values,
        )

    with pytest.raises(IntegrityError, match="ck_xagent_retrieval_receipt_expiry"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO xagent_retrieval_receipts "
                    "(id, kind, actor_id, session_id, tool_call_id, query_sha256, scope, "
                    "permission_revision, project_ids, index_generations, chunk_ids, payload_sha256, "
                    "issued_at, expires_at, citation_ordinal_start, citation_ordinal_end) "
                    "VALUES (:id, 'artifact_search', :actor_id, :session_id, 'call-2', :query_sha256, "
                    "'{}'::jsonb, 1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, :payload_sha256, "
                    ":issued_at, :invalid_expires_at, 1, 1)"
                ),
                {**values, "id": uuid4()},
            )

    with pytest.raises(IntegrityError, match="ck_xagent_retrieval_receipt_consumption"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO xagent_retrieval_receipts "
                    "(id, kind, actor_id, session_id, tool_call_id, query_sha256, scope, "
                    "permission_revision, project_ids, index_generations, chunk_ids, payload_sha256, "
                    "issued_at, expires_at, consumed_at) "
                    "VALUES (:id, 'artifact_search', :actor_id, :session_id, 'call-3', :query_sha256, "
                    "'{}'::jsonb, 1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, :payload_sha256, "
                    ":issued_at, :expires_at, :issued_at)"
                ),
                {**values, "id": uuid4()},
            )

    with pytest.raises(IntegrityError, match="ck_xagent_retrieval_receipt_citation_ordinals"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO xagent_retrieval_receipts "
                    "(id, kind, actor_id, session_id, tool_call_id, query_sha256, scope, "
                    "permission_revision, project_ids, index_generations, chunk_ids, payload_sha256, "
                    "issued_at, expires_at, citation_ordinal_start, citation_ordinal_end) "
                    "VALUES (:id, 'artifact_search', :actor_id, :session_id, 'call-4', :query_sha256, "
                    "'{}'::jsonb, 1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, :payload_sha256, "
                    ":issued_at, :expires_at, 0, 1)"
                ),
                {**values, "id": uuid4()},
            )


async def _insert_receipt(
    engine: AsyncEngine,
    *,
    actor_id: UUID,
    session_id: UUID,
    consumed: bool = False,
) -> tuple[UUID, datetime]:
    receipt_id = uuid4()
    issued_at = datetime.now(UTC)
    columns = (
        "id, kind, actor_id, session_id, tool_call_id, query_sha256, scope, permission_revision, "
        "project_ids, index_generations, chunk_ids, payload_sha256, issued_at, expires_at"
    )
    values = (
        ":id, 'artifact_search', :actor_id, :session_id, 'call-immutable', :query_sha256, "
        "'{}'::jsonb, 1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, :payload_sha256, :issued_at, :expires_at"
    )
    parameters = {
        "id": receipt_id,
        "actor_id": actor_id,
        "session_id": session_id,
        "query_sha256": "4" * 64,
        "payload_sha256": "5" * 64,
        "issued_at": issued_at,
        "expires_at": issued_at + timedelta(minutes=5),
    }
    if consumed:
        columns += ", consumed_at, consumed_event_sequence, consumed_payload_sha256"
        values += ", :consumed_at, 7, :consumed_payload_sha256"
        parameters.update(
            {
                "consumed_at": issued_at,
                "consumed_payload_sha256": "6" * 64,
            }
        )
    async with engine.begin() as connection:
        await connection.execute(
            text(f"INSERT INTO xagent_retrieval_receipts ({columns}) VALUES ({values})"), parameters
        )
    return receipt_id, issued_at


@pytest.mark.anyio
async def test_application_role_cannot_renew_a_retrieval_receipt(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    alice_private_xagent_session,
) -> None:
    receipt_id, issued_at = await _insert_receipt(
        seeded_database,
        actor_id=alice.id,
        session_id=alice_private_xagent_session.id,
    )
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))

    with pytest.raises(ProgrammingError) as rejected:
        await actor_session.execute(
            text(
                "UPDATE xagent_retrieval_receipts SET issued_at = :issued_at, expires_at = :expires_at "
                "WHERE id = :id"
            ),
            {
                "id": receipt_id,
                "issued_at": issued_at + timedelta(minutes=1),
                "expires_at": issued_at + timedelta(minutes=6),
            },
        )

    assert rejected.value.orig.sqlstate == "42501"


@pytest.mark.anyio
async def test_application_role_cannot_insert_an_already_consumed_receipt(
    actor_session: AsyncSession,
    alice,
    alice_private_xagent_session,
) -> None:
    issued_at = datetime.now(UTC)
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))

    with pytest.raises(ProgrammingError) as rejected:
        await actor_session.execute(
            text(
                "INSERT INTO xagent_retrieval_receipts "
                "(id, kind, actor_id, session_id, tool_call_id, query_sha256, scope, permission_revision, "
                "project_ids, index_generations, chunk_ids, payload_sha256, issued_at, expires_at, consumed_at, "
                "consumed_event_sequence, consumed_payload_sha256) "
                "VALUES (:id, 'artifact_search', :actor_id, :session_id, 'call-consumed', :query_sha256, "
                "'{}'::jsonb, 1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, :payload_sha256, :issued_at, "
                ":expires_at, :consumed_at, 1, :consumed_payload_sha256)"
            ),
            {
                "id": uuid4(),
                "actor_id": alice.id,
                "session_id": alice_private_xagent_session.id,
                "query_sha256": "4" * 64,
                "payload_sha256": "5" * 64,
                "issued_at": issued_at,
                "expires_at": issued_at + timedelta(minutes=5),
                "consumed_at": issued_at,
                "consumed_payload_sha256": "6" * 64,
            },
        )

    assert rejected.value.orig.sqlstate == "42501"


@pytest.mark.anyio
async def test_application_role_cannot_consume_a_receipt_twice(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    alice_private_xagent_session,
) -> None:
    receipt_id, _ = await _insert_receipt(
        seeded_database,
        actor_id=alice.id,
        session_id=alice_private_xagent_session.id,
        consumed=True,
    )
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))

    with pytest.raises(DBAPIError, match="retrieval receipt is already consumed"):
        await actor_session.execute(
            text(
                "UPDATE xagent_retrieval_receipts SET consumed_at = CURRENT_TIMESTAMP, "
                "consumed_event_sequence = 8, consumed_payload_sha256 = :payload_sha256 WHERE id = :id"
            ),
            {"id": receipt_id, "payload_sha256": "7" * 64},
        )
