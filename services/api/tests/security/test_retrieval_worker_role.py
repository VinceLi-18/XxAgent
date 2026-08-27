from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncEngine


async def _seed_index(engine: AsyncEngine, account_id: UUID) -> tuple[UUID, UUID, UUID]:
    artifact_id = uuid4()
    version_id = uuid4()
    index_id = uuid4()
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                "VALUES (:artifact_id, 'worker.txt', :account_id, :account_id)"
            ),
            {"artifact_id": artifact_id, "account_id": account_id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, uploaded_by_id, "
                "declared_size, actual_size, detected_content_type, scan_status, object_key, size, "
                "content_type, sha256) "
                "VALUES (:version_id, :artifact_id, :account_id, 1, 'worker.txt', :account_id, "
                "1, 1, 'text/plain', 'clean', :object_key, 1, 'text/plain', :sha256)"
            ),
            {
                "artifact_id": artifact_id,
                "version_id": version_id,
                "account_id": account_id,
                "object_key": f"artifacts/{artifact_id}/{version_id}",
                "sha256": "0" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_text_indexes "
                "(id, artifact_id, version_id, generation, content_sha256, parser_revision, "
                "embedding_model, embedding_revision, vector_dimensions, configuration_fingerprint, status) "
                "VALUES (:index_id, :artifact_id, :version_id, 1, :sha256, 'parser-1', 'bge-m3', "
                "'revision-1', 1024, :fingerprint, 'building')"
            ),
            {
                "index_id": index_id,
                "artifact_id": artifact_id,
                "version_id": version_id,
                "sha256": "1" * 64,
                "fingerprint": "2" * 64,
            },
        )
    return artifact_id, version_id, index_id


@pytest.mark.anyio
@pytest.mark.parametrize(
    "statement",
    (
        "SELECT email FROM accounts",
        "SELECT password_hash FROM xagent_account_credentials",
        "SELECT * FROM xagent_auth_sessions",
        "SELECT * FROM xagent_sessions",
        "SELECT * FROM project_memberships",
        "SELECT * FROM xagent_retrieval_receipts",
    ),
)
async def test_worker_cannot_read_identity_session_or_receipt_data(
    worker_engine: AsyncEngine,
    statement: str,
) -> None:
    with pytest.raises(ProgrammingError) as rejected:
        async with worker_engine.connect() as connection:
            await connection.execute(text(statement))

    assert rejected.value.orig.sqlstate == "42501"


@pytest.mark.anyio
async def test_application_role_cannot_write_chunk_embeddings(
    seeded_database: AsyncEngine,
    application_role: str,
) -> None:
    embedding = "[0" + ",0" * 1023 + "]"
    async with seeded_database.begin() as connection:
        set_role = await connection.scalar(
            text("SELECT format('SET LOCAL ROLE %I', CAST(:role AS text))"),
            {"role": application_role},
        )

    with pytest.raises(ProgrammingError) as rejected:
        async with seeded_database.begin() as connection:
            await connection.execute(text(set_role))
            await connection.execute(
                text(
                    "INSERT INTO artifact_text_chunks "
                    "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                    "VALUES (:id, :index_id, 0, 1, 1, 'forged', 1, :sha256, CAST(:embedding AS vector))"
                ),
                {"id": uuid4(), "index_id": uuid4(), "sha256": "0" * 64, "embedding": embedding},
            )

    assert rejected.value.orig.sqlstate == "42501"


@pytest.mark.anyio
async def test_worker_cannot_create_an_index_for_another_artifacts_version(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    artifact_id, _, _ = await _seed_index(seeded_database, alice.id)
    _, other_version_id, _ = await _seed_index(seeded_database, alice.id)

    with pytest.raises(IntegrityError) as rejected:
        async with worker_engine.begin() as connection:
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
                    "fingerprint": "3" * 64,
                },
            )

    assert rejected.value.orig.sqlstate == "23503"


@pytest.mark.anyio
async def test_worker_can_update_only_retrieval_processing_columns(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    artifact_id, version_id, index_id = await _seed_index(seeded_database, alice.id)
    job_id = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text("INSERT INTO artifact_index_jobs (id, index_id) VALUES (:id, :index_id)"),
            {"id": job_id, "index_id": index_id},
        )

    lease_token = uuid4()
    async with worker_engine.begin() as connection:
        await connection.execute(
            text(
                "UPDATE artifact_text_indexes SET status = 'ready', chunk_count = 1, "
                "failure_code = NULL WHERE id = :index_id"
            ),
            {"index_id": index_id},
        )
        await connection.execute(
            text(
                "UPDATE artifact_index_jobs SET status = 'leased', attempts = 1, lease_token = :lease_token, "
                "lease_expires_at = :lease_expires_at WHERE id = :job_id"
            ),
            {
                "job_id": job_id,
                "lease_token": lease_token,
                "lease_expires_at": datetime.now(UTC) + timedelta(minutes=1),
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_search_heads (artifact_id, index_id, version_id) "
                "VALUES (:artifact_id, :index_id, :version_id)"
            ),
            {"artifact_id": artifact_id, "index_id": index_id, "version_id": version_id},
        )

    with pytest.raises(ProgrammingError) as rejected:
        async with worker_engine.begin() as connection:
            await connection.execute(
                text("UPDATE artifact_text_indexes SET content_sha256 = :sha256 WHERE id = :index_id"),
                {"index_id": index_id, "sha256": "9" * 64},
            )

    assert rejected.value.orig.sqlstate == "42501"

    with pytest.raises(ProgrammingError) as rejected:
        async with worker_engine.begin() as connection:
            await connection.execute(
                text("UPDATE artifact_index_jobs SET id = :replacement_id WHERE id = :job_id"),
                {"job_id": job_id, "replacement_id": uuid4()},
            )

    assert rejected.value.orig.sqlstate == "42501"
