import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine


FACT_TABLE_DML = {
    "project_fact_revisions": (True, True, False, False),
    "project_fact_heads": (True, True, True, False),
    "fact_proposals": (True, True, True, False),
    "fact_proposal_evidence": (True, True, False, False),
    "fact_proposal_receipts": (True, True, True, False),
    "fact_operation_idempotency": (True, True, False, False),
    "business_outbox": (True, True, True, False),
}


@pytest.mark.anyio
async def test_application_role_has_only_required_fact_dml(
    seeded_database: AsyncEngine,
    application_role: str,
) -> None:
    async with seeded_database.connect() as connection:
        for table, expected in FACT_TABLE_DML.items():
            privileges = tuple(
                (
                    await connection.execute(
                        text(
                            "SELECT has_table_privilege(:role, :table, 'SELECT'), "
                            "has_table_privilege(:role, :table, 'INSERT'), "
                            "has_any_column_privilege(:role, :table, 'UPDATE'), "
                            "has_table_privilege(:role, :table, 'DELETE')"
                        ),
                        {"role": application_role, "table": table},
                    )
                ).one()
            )
            assert privileges == expected, table


@pytest.mark.anyio
async def test_application_role_cannot_update_immutable_fact_columns(
    seeded_database: AsyncEngine,
    application_role: str,
) -> None:
    immutable_columns = {
        "project_fact_revisions": "value",
        "project_fact_heads": "project_id",
        "fact_proposals": "value",
        "fact_proposal_evidence": "chunk_id",
        "fact_proposal_receipts": "receipt_digest_id",
        "fact_operation_idempotency": "request_sha256",
        "business_outbox": "payload_sha256",
    }
    async with seeded_database.connect() as connection:
        for table, column in immutable_columns.items():
            permitted = await connection.scalar(
                text("SELECT has_column_privilege(:role, :table, :column, 'UPDATE')"),
                {"role": application_role, "table": table, "column": column},
            )
            assert permitted is False, f"{table}.{column}"


@pytest.mark.anyio
async def test_worker_role_has_no_fact_relation_access(
    seeded_database: AsyncEngine,
    worker_role: str,
) -> None:
    async with seeded_database.connect() as connection:
        for table in FACT_TABLE_DML:
            privileges = tuple(
                (
                    await connection.execute(
                        text(
                            "SELECT has_table_privilege(:role, :table, 'SELECT'), "
                            "has_table_privilege(:role, :table, 'INSERT'), "
                            "has_any_column_privilege(:role, :table, 'UPDATE'), "
                            "has_table_privilege(:role, :table, 'DELETE')"
                        ),
                        {"role": worker_role, "table": table},
                    )
                ).one()
            )
            assert privileges == (False, False, False, False), table
