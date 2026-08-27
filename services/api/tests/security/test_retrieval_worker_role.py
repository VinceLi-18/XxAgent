from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncEngine


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
