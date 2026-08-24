import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import jwt
import pytest
from anyio import to_thread
from alembic import command
from alembic.config import Config
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.engine import make_url

_test_database_url = os.environ["JX_TEST_DATABASE_URL"]
os.environ.update(
    {
        "DATABASE_URL": _test_database_url,
        "DATABASE_ADMIN_URL": _test_database_url,
        "POSTGRES_APP_USER": "jiaxin_task2_test_app",
        "POSTGRES_APP_PASSWORD": "jiaxin-task2-test-app-password",
        "JWT_SECRET_KEY": "test-signing-key-not-for-production",
        "JWT_ISSUER": "jiaxin-agent-tests",
        "JWT_AUDIENCE": "jiaxin-agent-api-tests",
        "MINIO_ENDPOINT": "minio.test:9000",
        "MINIO_PUBLIC_ENDPOINT": "storage.test:9000",
        "MINIO_ACCESS_KEY": "test-minio-access-key",
        "MINIO_SECRET_KEY": "test-minio-secret-key",
        "MINIO_SECURE": "false",
        "MINIO_PUBLIC_SECURE": "false",
        "CLAMAV_TIMEOUT": "1",
    }
)

from app.core.db import SessionLocal, engine as app_engine
from app.main import app


@dataclass(frozen=True)
class SeededAccount:
    id: UUID
    role: str


ALICE = SeededAccount(UUID("00000000-0000-0000-0000-000000000001"), "specialist")
BOB = SeededAccount(UUID("00000000-0000-0000-0000-000000000002"), "specialist")
MANAGER = SeededAccount(UUID("00000000-0000-0000-0000-000000000003"), "manager")


def _alembic_config() -> Config:
    backend_directory = Path(__file__).resolve().parents[1]
    config = Config(str(backend_directory / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", _test_database_url)
    return config


def _require_disposable_database() -> None:
    database_url = make_url(_test_database_url)
    if (
        os.environ.get("JX_ALLOW_SCHEMA_DROP") != "yes"
        or database_url.get_backend_name() != "postgresql"
        or not (database_url.database or "").endswith("_test")
    ):
        raise RuntimeError(
            "Schema reset requires JX_ALLOW_SCHEMA_DROP=yes and a PostgreSQL "
            "JX_TEST_DATABASE_URL whose database name ends in _test"
        )


async def _create_temporary_application_role(engine: AsyncEngine) -> bool:
    application_role = os.environ["POSTGRES_APP_USER"]
    application_password = os.environ["POSTGRES_APP_PASSWORD"]
    async with engine.begin() as connection:
        role_exists = await connection.scalar(
            text("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :role)"),
            {"role": application_role},
        )
        if role_exists:
            return False
        create_role = await connection.scalar(
            text(
                "SELECT format("
                "'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', "
                "CAST(:role AS text), CAST(:password AS text))"
            ),
            {"role": application_role, "password": application_password},
        )
        await connection.execute(text(create_role))
    return True


async def _drop_temporary_application_role(engine: AsyncEngine) -> None:
    application_role = os.environ["POSTGRES_APP_USER"]
    async with engine.begin() as connection:
        drop_owned = await connection.scalar(
            text("SELECT format('DROP OWNED BY %I', CAST(:role AS text))"),
            {"role": application_role},
        )
        drop_role = await connection.scalar(
            text("SELECT format('DROP ROLE %I', CAST(:role AS text))"),
            {"role": application_role},
        )
        await connection.execute(text(drop_owned))
        await connection.execute(text(drop_role))


@asynccontextmanager
async def _seeded_test_database() -> AsyncIterator[AsyncEngine]:
    _require_disposable_database()
    engine = create_async_engine(_test_database_url)
    created_application_role = False
    try:
        created_application_role = await _create_temporary_application_role(engine)
        async with engine.begin() as connection:
            await connection.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
            await connection.execute(text("CREATE SCHEMA public"))

        await to_thread.run_sync(command.upgrade, _alembic_config(), "head")

        async with engine.begin() as connection:
            for account, email in (
                (ALICE, "alice@example.test"),
                (BOB, "bob@example.test"),
                (MANAGER, "manager@example.test"),
            ):
                await connection.execute(
                    text(
                        "INSERT INTO accounts (id, email, role, is_active) "
                        "VALUES (:id, :email, :role, true)"
                    ),
                    {"id": account.id, "email": email, "role": account.role},
                )

        yield engine
    finally:
        if created_application_role:
            await _drop_temporary_application_role(engine)
        await engine.dispose()


@pytest.fixture
async def seeded_database() -> AsyncIterator[AsyncEngine]:
    async with _seeded_test_database() as engine:
        yield engine


@pytest.fixture
async def client(seeded_database: AsyncEngine) -> AsyncClient:
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://testserver") as test_client:
            yield test_client
    finally:
        await app_engine.dispose()


@pytest.fixture
async def api_client(seeded_database: AsyncEngine, application_role: str) -> AsyncIterator[AsyncClient]:
    runtime_url = make_url(_test_database_url).set(
        username=application_role,
        password=os.environ["POSTGRES_APP_PASSWORD"],
    )
    runtime_engine = create_async_engine(runtime_url, pool_pre_ping=True)
    SessionLocal.configure(bind=runtime_engine)
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://testserver") as test_client:
            yield test_client
    finally:
        SessionLocal.configure(bind=app_engine)
        await runtime_engine.dispose()


@pytest.fixture
async def audit_session(seeded_database: AsyncEngine) -> AsyncIterator[AsyncSession]:
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        yield session


@pytest.fixture
def alice() -> SeededAccount:
    return ALICE


@pytest.fixture
def bob() -> SeededAccount:
    return BOB


@pytest.fixture
def application_role() -> str:
    return os.environ["POSTGRES_APP_USER"]


@pytest.fixture
def alice_token(alice: SeededAccount) -> str:
    return _token_for(alice)


def _token_for(account: SeededAccount) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "sub": str(account.id),
            "iss": os.environ["JWT_ISSUER"],
            "aud": os.environ["JWT_AUDIENCE"],
            "iat": now,
            "exp": now + timedelta(minutes=5),
            "jti": "alice-test-token",
        },
        os.environ["JWT_SECRET_KEY"],
        algorithm="HS256",
    )


@pytest.fixture
def manager_token() -> str:
    return _token_for(MANAGER)


@pytest.fixture
def application():
    return app


@pytest.fixture
async def alice_private_thread(seeded_database: AsyncEngine):
    from app.models.conversation import ConversationThread

    thread = ConversationThread(
        id=UUID("00000000-0000-0000-0000-000000000110"),
        title="Alice API private thread",
        owner_id=ALICE.id,
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(thread)
    return thread


@pytest.fixture
async def alice_project(seeded_database: AsyncEngine):
    from app.models.project import Project

    project = Project(
        id=UUID("00000000-0000-0000-0000-000000000401"),
        name="Alice project",
        owner_id=ALICE.id,
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(project)
    return project


@pytest.fixture
async def bob_project(seeded_database: AsyncEngine):
    from app.models.project import Project

    project = Project(
        id=UUID("00000000-0000-0000-0000-000000000402"),
        name="Bob project",
        owner_id=BOB.id,
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(project)
    return project


@pytest.fixture
async def bob_private_thread(seeded_database: AsyncEngine):
    from app.models.conversation import ConversationThread

    thread = ConversationThread(
        id=UUID("00000000-0000-0000-0000-000000000111"),
        title="Bob API private thread",
        owner_id=BOB.id,
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(thread)
    return thread


@pytest.fixture
async def shared_thread(seeded_database: AsyncEngine):
    from app.models.conversation import ConversationThread
    from app.models.project import Project, ProjectMembership

    project = Project(
        id=UUID("00000000-0000-0000-0000-000000000201"),
        name="Shared project",
        owner_id=BOB.id,
    )
    thread = ConversationThread(
        id=UUID("00000000-0000-0000-0000-000000000202"),
        title="Shared project thread",
        project_id=project.id,
    )
    membership = ProjectMembership(
        id=UUID("00000000-0000-0000-0000-000000000203"),
        project_id=project.id,
        account_id=ALICE.id,
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(project)
            await session.flush()
            session.add_all((thread, membership))
    return thread


@pytest.fixture
async def actor_session(seeded_database: AsyncEngine, application_role: str):
    from sqlalchemy import text

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
