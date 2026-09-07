from pathlib import Path
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from anyio import to_thread
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine


def _alembic_config(database_url: str) -> Config:
    backend_directory = Path(__file__).resolve().parents[2]
    config = Config(str(backend_directory / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


@pytest.mark.anyio
async def test_workbench_migration_creates_required_tables(
    seeded_database: AsyncEngine,
) -> None:
    expected_tables = {
        "xagent_account_capability_grants",
        "xagent_session_project_refs",
        "xagent_workbench_preferences",
    }

    async with seeded_database.connect() as connection:
        actual_tables = set(
            (
                await connection.scalars(
                    text(
                        "SELECT tablename FROM pg_catalog.pg_tables "
                        "WHERE schemaname = 'public' AND tablename = ANY(:table_names)"
                    ),
                    {"table_names": sorted(expected_tables)},
                )
            ).all()
        )

    assert actual_tables == expected_tables


@pytest.mark.anyio
async def test_workbench_migration_round_trip(
    seeded_database: AsyncEngine,
) -> None:
    config = _alembic_config(
        seeded_database.url.render_as_string(hide_password=False)
    )

    await seeded_database.dispose()
    await to_thread.run_sync(command.downgrade, config, "008_xagent_runtime_header")
    async with seeded_database.connect() as connection:
        downgraded_tables = set(
            (
                await connection.scalars(
                    text(
                        "SELECT tablename FROM pg_catalog.pg_tables "
                        "WHERE schemaname = 'public' "
                        "AND tablename = ANY(:table_names)"
                    ),
                    {
                        "table_names": [
                            "xagent_account_capability_grants",
                            "xagent_session_project_refs",
                            "xagent_workbench_preferences",
                        ]
                    },
                )
            ).all()
        )
    assert downgraded_tables == set()

    await seeded_database.dispose()
    await to_thread.run_sync(command.upgrade, config, "head")
    async with seeded_database.connect() as connection:
        revision = await connection.scalar(
            text("SELECT version_num FROM alembic_version")
        )
    assert revision == "015_citation_authorization"


async def _insert_session(
    engine: AsyncEngine,
    *,
    session_id: UUID,
    owner_id: UUID,
    visibility: str,
    project_id: UUID | None,
) -> None:
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO xagent_sessions "
                "(id, owner_id, project_id, visibility, permission_revision_created, title, "
                "next_citation_ordinal) "
                "VALUES (:id, :owner_id, :project_id, :visibility, 1, "
                "'Workbench schema test', 1)"
            ),
            {
                "id": session_id,
                "owner_id": owner_id,
                "project_id": project_id,
                "visibility": visibility,
            },
        )


@pytest.mark.anyio
async def test_project_refs_accept_private_sessions_and_reject_project_sessions(
    seeded_database: AsyncEngine,
    alice,
    alice_project,
) -> None:
    private_session_id = UUID("00000000-0000-0000-0000-000000000901")
    project_session_id = UUID("00000000-0000-0000-0000-000000000902")
    await _insert_session(
        seeded_database,
        session_id=private_session_id,
        owner_id=alice.id,
        visibility="private",
        project_id=None,
    )
    await _insert_session(
        seeded_database,
        session_id=project_session_id,
        owner_id=alice.id,
        visibility="project",
        project_id=alice_project.id,
    )

    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO xagent_session_project_refs (session_id, project_id) "
                "VALUES (:session_id, :project_id)"
            ),
            {"session_id": private_session_id, "project_id": alice_project.id},
        )

    with pytest.raises(IntegrityError, match="xagent_session_project_refs_pkey"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO xagent_session_project_refs (session_id, project_id) "
                    "VALUES (:session_id, :project_id)"
                ),
                {"session_id": private_session_id, "project_id": alice_project.id},
            )

    with pytest.raises(DBAPIError, match="xagent project references require a private session"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO xagent_session_project_refs (session_id, project_id) "
                    "VALUES (:session_id, :project_id)"
                ),
                {"session_id": project_session_id, "project_id": alice_project.id},
            )


@pytest.mark.anyio
async def test_capability_grants_require_a_manager_grantor(
    seeded_database: AsyncEngine,
    alice,
    manager,
) -> None:
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO xagent_account_capability_grants "
                "(account_id, capability, granted_by_id) "
                "VALUES (:account_id, 'project.create', :granted_by_id)"
            ),
            {"account_id": alice.id, "granted_by_id": manager.id},
        )

    with pytest.raises(DBAPIError, match="xagent capability grants require a manager grantor"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE xagent_account_capability_grants "
                    "SET granted_by_id = :granted_by_id "
                    "WHERE account_id = :account_id AND capability = 'project.create'"
                ),
                {"account_id": alice.id, "granted_by_id": alice.id},
            )


@pytest.mark.anyio
async def test_capability_grants_reject_unknown_and_duplicate_capabilities(
    seeded_database: AsyncEngine,
    alice,
    bob,
    manager,
) -> None:
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO xagent_account_capability_grants "
                "(account_id, capability, granted_by_id) "
                "VALUES (:account_id, 'project.create', :granted_by_id)"
            ),
            {"account_id": alice.id, "granted_by_id": manager.id},
        )

    with pytest.raises(IntegrityError, match="xagent_account_capability_grants_pkey"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO xagent_account_capability_grants "
                    "(account_id, capability, granted_by_id) "
                    "VALUES (:account_id, 'project.create', :granted_by_id)"
                ),
                {"account_id": alice.id, "granted_by_id": manager.id},
            )

    with pytest.raises(
        IntegrityError,
        match="ck_xagent_account_capability_grant_capability",
    ):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO xagent_account_capability_grants "
                    "(account_id, capability, granted_by_id) "
                    "VALUES (:account_id, 'project.delete', :granted_by_id)"
                ),
                {"account_id": bob.id, "granted_by_id": manager.id},
            )


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("context_kind", "include_project"),
    (
        ("workbench", True),
        ("project", False),
        ("portfolio", False),
    ),
)
async def test_workbench_preferences_reject_invalid_context_combinations(
    seeded_database: AsyncEngine,
    alice,
    alice_project,
    context_kind: str,
    include_project: bool,
) -> None:
    with pytest.raises(IntegrityError, match="ck_xagent_workbench_preference_context"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO xagent_workbench_preferences "
                    "(account_id, context_kind, project_id) "
                    "VALUES (:account_id, :context_kind, :project_id)"
                ),
                {
                    "account_id": alice.id,
                    "context_kind": context_kind,
                    "project_id": alice_project.id if include_project else None,
                },
            )


@pytest.mark.anyio
async def test_workbench_foreign_keys_prevent_deleting_referenced_rows(
    seeded_database: AsyncEngine,
    alice,
    manager,
    alice_project,
) -> None:
    session_id = UUID("00000000-0000-0000-0000-000000000903")
    await _insert_session(
        seeded_database,
        session_id=session_id,
        owner_id=alice.id,
        visibility="private",
        project_id=None,
    )
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO xagent_account_capability_grants "
                "(account_id, capability, granted_by_id) "
                "VALUES (:account_id, 'project.create', :granted_by_id)"
            ),
            {"account_id": alice.id, "granted_by_id": manager.id},
        )
        await connection.execute(
            text(
                "INSERT INTO xagent_workbench_preferences "
                "(account_id, context_kind, project_id) "
                "VALUES (:account_id, 'project', :project_id)"
            ),
            {"account_id": alice.id, "project_id": alice_project.id},
        )
        await connection.execute(
            text(
                "INSERT INTO xagent_session_project_refs (session_id, project_id) "
                "VALUES (:session_id, :project_id)"
            ),
            {"session_id": session_id, "project_id": alice_project.id},
        )

    for statement, parameters in (
        ("DELETE FROM xagent_sessions WHERE id = :id", {"id": session_id}),
        ("DELETE FROM projects WHERE id = :id", {"id": alice_project.id}),
        ("DELETE FROM accounts WHERE id = :id", {"id": alice.id}),
    ):
        with pytest.raises(IntegrityError):
            async with seeded_database.begin() as connection:
                await connection.execute(text(statement), parameters)
