from pathlib import Path
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from anyio import to_thread
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.main import app
from app.models.base import Base


def _alembic_config(database_url: str) -> Config:
    api_directory = Path(__file__).resolve().parents[2]
    config = Config(str(api_directory / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


def test_legacy_conversation_route_and_model_are_not_registered() -> None:
    assert not any(
        path == "/api/v1/conversations" or path.startswith("/api/v1/conversations/")
        for path in app.openapi()["paths"]
    )
    assert "conversation_threads" not in Base.metadata.tables


@pytest.mark.anyio
async def test_legacy_conversation_table_is_absent(
    seeded_database: AsyncEngine,
) -> None:
    async with seeded_database.connect() as connection:
        table_name = await connection.scalar(
            text("SELECT to_regclass('public.conversation_threads')")
        )

    assert table_name is None


@pytest.mark.anyio
async def test_legacy_conversation_migration_discards_rows_and_restores_only_structure(
    seeded_database: AsyncEngine,
    alice,
    application_role: str,
) -> None:
    config = _alembic_config(
        seeded_database.url.render_as_string(hide_password=False)
    )

    await seeded_database.dispose()
    await to_thread.run_sync(command.downgrade, config, "010_xagent_ref_copy")
    try:
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO conversation_threads (id, title, owner_id) "
                    "VALUES (:id, 'legacy row', :owner_id)"
                ),
                {
                    "id": UUID("00000000-0000-0000-0000-000000000119"),
                    "owner_id": alice.id,
                },
            )

        await seeded_database.dispose()
        await to_thread.run_sync(command.upgrade, config, "head")
        async with seeded_database.connect() as connection:
            assert await connection.scalar(
                text("SELECT to_regclass('public.conversation_threads')")
            ) is None

        await seeded_database.dispose()
        await to_thread.run_sync(command.downgrade, config, "010_xagent_ref_copy")
        async with seeded_database.connect() as connection:
            restored_row_count = await connection.scalar(
                text("SELECT count(*) FROM conversation_threads")
            )
            indexes = set(
                (
                    await connection.scalars(
                        text(
                            "SELECT indexname FROM pg_indexes "
                            "WHERE schemaname = 'public' "
                            "AND tablename = 'conversation_threads'"
                        )
                    )
                ).all()
            )
            constraints = set(
                (
                    await connection.scalars(
                        text(
                            "SELECT constraint_name FROM information_schema.table_constraints "
                            "WHERE table_schema = 'public' "
                            "AND table_name = 'conversation_threads'"
                        )
                    )
                ).all()
            )
            rls_enabled, rls_forced = (
                await connection.execute(
                    text(
                        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                        "WHERE oid = 'public.conversation_threads'::regclass"
                    )
                )
            ).one()
            policies = set(
                (
                    await connection.scalars(
                        text(
                            "SELECT policyname FROM pg_policies "
                            "WHERE schemaname = 'public' "
                            "AND tablename = 'conversation_threads'"
                        )
                    )
                ).all()
            )
            application_role_can_select = await connection.scalar(
                text(
                    "SELECT has_table_privilege("
                    ":role, 'conversation_threads', 'SELECT')"
                ),
                {"role": application_role},
            )

        assert restored_row_count == 0
        assert {
            "conversation_threads_pkey",
            "ck_conversation_thread_scope",
            "conversation_threads_owner_id_fkey",
            "conversation_threads_project_id_fkey",
        } <= constraints
        assert {
            "conversation_threads_pkey",
            "ix_conversation_threads_owner_id",
            "ix_conversation_threads_project_id",
        } <= indexes
        assert (rls_enabled, rls_forced) == (True, True)
        assert policies == {"conversation_thread_read"}
        assert application_role_can_select is True
    finally:
        await seeded_database.dispose()
        await to_thread.run_sync(command.upgrade, config, "head")
