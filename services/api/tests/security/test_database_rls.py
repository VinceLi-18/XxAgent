from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import conftest as test_fixtures
import pytest
from sqlalchemy import insert, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine

from app.core.db_context import set_actor_context
from app.core.config import Settings
from app.core.security import Actor
from app.models.audit import AuditEvent
from app.models.conversation import ConversationThread
from app.models.identity import Role
from app.models.project import Project, ProjectMembership, TemporaryProjectGrant


def _api_root() -> Path:
    return Path(__file__).resolve().parents[2]


def test_compose_uses_dedicated_non_superuser_application_credentials():
    environment_example = (_api_root() / ".env.example").read_text()
    compose_configuration = (_api_root() / "compose.yml").read_text()

    assert "POSTGRES_APP_USER=jiaxin_app" in environment_example
    assert "POSTGRES_APP_PASSWORD=" in environment_example
    assert (
        "DATABASE_URL=postgresql+asyncpg://${POSTGRES_APP_USER}:${POSTGRES_APP_PASSWORD}"
        "@postgres:5432/${POSTGRES_DB}"
    ) in environment_example
    assert "./postgres/init:/docker-entrypoint-initdb.d:ro" in compose_configuration
    assert "${JWT_SECRET_KEY:?Set JWT_SECRET_KEY in .env to a high-entropy value}" in compose_configuration
    assert "${JWT_ISSUER:?Set JWT_ISSUER in .env}" in compose_configuration
    assert "${JWT_AUDIENCE:?Set JWT_AUDIENCE in .env}" in compose_configuration


def test_environment_example_constructs_api_settings_without_host_environment(monkeypatch):
    for name in (
        "DATABASE_URL",
        "DATABASE_ADMIN_URL",
        "POSTGRES_APP_USER",
        "JWT_SECRET_KEY",
        "JWT_ISSUER",
        "JWT_AUDIENCE",
    ):
        monkeypatch.delenv(name, raising=False)

    settings = Settings(_env_file=_api_root() / ".env.example")

    assert settings.JWT_SECRET_KEY
    assert settings.JWT_ISSUER
    assert settings.JWT_AUDIENCE


def test_alembic_uses_a_separate_admin_database_url():
    environment_example = (_api_root() / ".env.example").read_text()
    alembic_environment = (_api_root() / "alembic/env.py").read_text()
    compose_configuration = (_api_root() / "compose.yml").read_text()

    assert "DATABASE_ADMIN_URL=postgresql+asyncpg://${POSTGRES_USER}:${POSTGRES_PASSWORD}" in environment_example
    assert "settings.DATABASE_ADMIN_URL" in alembic_environment
    assert "DATABASE_ADMIN_URL: ${DATABASE_ADMIN_URL}" in compose_configuration


def test_compose_runs_admin_migrations_before_runtime_services():
    compose_configuration = (_api_root() / "compose.yml").read_text()
    readme = (_api_root() / "README.md").read_text()

    assert "  migrate:\n" in compose_configuration
    assert "command: [\"alembic\", \"upgrade\", \"head\"]" in compose_configuration
    assert compose_configuration.count("condition: service_completed_successfully") >= 2
    assert "cd backend && .venv/bin/alembic upgrade head" not in readme
    assert "docker compose up -d --build" in readme


@pytest.mark.anyio
async def test_seeded_database_cleans_temporary_role_when_migration_fails(monkeypatch):
    def migration_failure(*_args, **_kwargs):
        raise RuntimeError("intentional migration failure")

    monkeypatch.setattr(test_fixtures.command, "upgrade", migration_failure)

    with pytest.raises(RuntimeError, match="intentional migration failure"):
        async with test_fixtures._seeded_test_database():
            pass

    engine = create_async_engine(test_fixtures._test_database_url)
    try:
        async with engine.connect() as connection:
            role_exists = await connection.scalar(
                text("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :role)"),
                {"role": test_fixtures.os.environ["POSTGRES_APP_USER"]},
            )
    finally:
        await engine.dispose()

    assert role_exists is False


@pytest.fixture
async def actor_session(seeded_database: AsyncEngine, application_role: str):
    async with seeded_database.begin() as connection:
        bypasses_rls = await connection.scalar(
            text("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")
        )
        set_role = await connection.scalar(
            text("SELECT format('SET LOCAL ROLE %I', CAST(:role AS text))"),
            {"role": application_role},
        )

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            if bypasses_rls:
                await session.execute(text(set_role))
            yield session


@pytest.fixture
async def bob_thread(seeded_database: AsyncEngine) -> ConversationThread:
    thread = ConversationThread(
        id=UUID("00000000-0000-0000-0000-000000000101"),
        title="Bob private thread",
        owner_id=UUID("00000000-0000-0000-0000-000000000002"),
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(thread)
    return thread


@pytest.fixture
async def shared_thread(seeded_database: AsyncEngine) -> ConversationThread:
    project = Project(
        id=UUID("00000000-0000-0000-0000-000000000201"),
        name="Shared project",
        owner_id=UUID("00000000-0000-0000-0000-000000000002"),
    )
    thread = ConversationThread(
        id=UUID("00000000-0000-0000-0000-000000000202"),
        title="Shared project thread",
        project_id=project.id,
    )
    membership = ProjectMembership(
        id=UUID("00000000-0000-0000-0000-000000000203"),
        project_id=project.id,
        account_id=UUID("00000000-0000-0000-0000-000000000001"),
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(project)
            await session.flush()
            session.add_all((thread, membership))
    return thread


@pytest.fixture
async def unrelated_project_rows(seeded_database: AsyncEngine):
    project = Project(
        id=UUID("00000000-0000-0000-0000-000000000301"),
        name="Bob-only project",
        owner_id=UUID("00000000-0000-0000-0000-000000000002"),
    )
    membership = ProjectMembership(
        id=UUID("00000000-0000-0000-0000-000000000302"),
        project_id=project.id,
        account_id=UUID("00000000-0000-0000-0000-000000000002"),
    )
    grant = TemporaryProjectGrant(
        id=UUID("00000000-0000-0000-0000-000000000303"),
        project_id=project.id,
        account_id=UUID("00000000-0000-0000-0000-000000000002"),
        action="read",
        granted_by_id=UUID("00000000-0000-0000-0000-000000000003"),
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    audit_event = AuditEvent(
        id=UUID("00000000-0000-0000-0000-000000000304"),
        actor_id=UUID("00000000-0000-0000-0000-000000000002"),
        action="read",
        resource_type="conversation_thread",
        resource_id=UUID("00000000-0000-0000-0000-000000000101"),
        request_id=UUID("00000000-0000-0000-0000-000000000305"),
        result="allowed",
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add_all((project, membership, grant, audit_event))
    return project, membership, grant, audit_event


@pytest.mark.anyio
async def test_rls_hides_another_specialists_private_thread(actor_session, alice, bob_thread):
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    row = await actor_session.scalar(select(ConversationThread).where(ConversationThread.id == bob_thread.id))
    assert row is None


@pytest.mark.anyio
async def test_application_role_cannot_bypass_rls(actor_session):
    bypasses_rls = await actor_session.scalar(
        text("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")
    )
    assert bypasses_rls is False


@pytest.mark.anyio
async def test_migration_grants_the_configured_application_role(
    seeded_database: AsyncEngine,
    application_role: str,
):
    async with seeded_database.connect() as connection:
        has_project_read = await connection.scalar(
            text("SELECT has_table_privilege(:role, 'projects', 'SELECT')"),
            {"role": application_role},
        )
        has_project_insert = await connection.scalar(
            text("SELECT has_table_privilege(:role, 'projects', 'INSERT')"),
            {"role": application_role},
        )
        has_project_update = await connection.scalar(
            text("SELECT has_table_privilege(:role, 'projects', 'UPDATE')"),
            {"role": application_role},
        )
        has_project_delete = await connection.scalar(
            text("SELECT has_table_privilege(:role, 'projects', 'DELETE')"),
            {"role": application_role},
        )
    assert has_project_read is True
    assert has_project_insert is True
    assert has_project_update is False
    assert has_project_delete is False


@pytest.mark.anyio
async def test_rls_rejects_project_creation_for_another_owner(actor_session, alice, bob):
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    project = Project(name="Wrong owner", owner_id=bob.id)
    actor_session.add(project)

    with pytest.raises(DBAPIError):
        await actor_session.flush()


@pytest.mark.anyio
async def test_rls_allows_project_creation_for_the_current_actor(actor_session, alice):
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    result = await actor_session.execute(
        insert(Project).values(id=uuid4(), name="Alice-owned", owner_id=alice.id)
    )

    assert result.rowcount == 1


@pytest.mark.anyio
async def test_rls_allows_a_project_member_to_read_shared_thread(actor_session, alice, shared_thread):
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    row = await actor_session.scalar(select(ConversationThread).where(ConversationThread.id == shared_thread.id))
    assert row is not None


@pytest.mark.anyio
async def test_rls_allows_manager_to_read_a_project_shared_thread(actor_session, shared_thread):
    await set_actor_context(
        actor_session,
        Actor(id=UUID("00000000-0000-0000-0000-000000000003"), role=Role.MANAGER),
    )
    row = await actor_session.scalar(select(ConversationThread).where(ConversationThread.id == shared_thread.id))
    assert row is not None


@pytest.mark.anyio
async def test_rls_hides_another_specialists_private_thread_from_manager(actor_session, bob_thread):
    await set_actor_context(
        actor_session,
        Actor(id=UUID("00000000-0000-0000-0000-000000000003"), role=Role.MANAGER),
    )
    row = await actor_session.scalar(select(ConversationThread).where(ConversationThread.id == bob_thread.id))
    assert row is None


@pytest.mark.anyio
async def test_rls_hides_unrelated_project_and_audit_rows(
    actor_session,
    alice,
    unrelated_project_rows,
):
    project, membership, grant, audit_event = unrelated_project_rows
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))

    rows = [
        await actor_session.scalar(select(Project).where(Project.id == project.id)),
        await actor_session.scalar(select(ProjectMembership).where(ProjectMembership.id == membership.id)),
        await actor_session.scalar(select(TemporaryProjectGrant).where(TemporaryProjectGrant.id == grant.id)),
        await actor_session.scalar(select(AuditEvent).where(AuditEvent.id == audit_event.id)),
    ]

    assert rows == [None, None, None, None]
