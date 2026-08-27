import os
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.db import create_database_engine


def _run_roles_cli(
    *,
    administrator_password: str | None = None,
    application_role: str,
    application_password: str,
    worker_role: str,
    worker_password: str,
) -> subprocess.CompletedProcess[str]:
    administrator_url = make_url(os.environ["JX_TEST_DATABASE_URL"])
    if administrator_password is not None:
        administrator_url = administrator_url.set(password=None)
    environment = {
        "PATH": os.environ["PATH"],
        "DATABASE_ADMIN_URL": administrator_url.render_as_string(hide_password=False),
        "POSTGRES_APP_USER": application_role,
        "POSTGRES_APP_PASSWORD": application_password,
        "POSTGRES_WORKER_USER": worker_role,
        "POSTGRES_WORKER_PASSWORD": worker_password,
    }
    if administrator_password is not None:
        environment["POSTGRES_PASSWORD"] = administrator_password
    return subprocess.run(
        ["uv", "run", "--project", "services/api", "xagent-api", "roles", "ensure"],
        cwd=Path(__file__).resolve().parents[3],
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )


def _run_migrations(
    *,
    administrator_url: str,
    administrator_password: str | None,
    application_role: str,
    worker_role: str,
) -> subprocess.CompletedProcess[str]:
    environment = {
        "PATH": os.environ["PATH"],
        "DATABASE_ADMIN_URL": administrator_url,
        "POSTGRES_APP_USER": application_role,
        "POSTGRES_WORKER_USER": worker_role,
    }
    if administrator_password is not None:
        environment["POSTGRES_PASSWORD"] = administrator_password
    return subprocess.run(
        ["uv", "run", "--project", ".", "alembic", "upgrade", "head"],
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )


def _run_api_database_sessions(
    *,
    application_url: str,
    application_password: str,
    application_role: str,
    administrator_url: str,
    administrator_password: str,
) -> subprocess.CompletedProcess[str]:
    script = """
import asyncio
from sqlalchemy import text
from app.core.db import AdminSessionLocal, SessionLocal, admin_engine, engine

async def main():
    async with SessionLocal() as session:
        assert await session.scalar(text("SELECT current_user")) == "APPLICATION_ROLE"
    async with AdminSessionLocal() as session:
        assert await session.scalar(text("SELECT current_user")) == "ADMINISTRATOR_ROLE"
    await engine.dispose()
    await admin_engine.dispose()

asyncio.run(main())
""".replace("APPLICATION_ROLE", application_role).replace(
        "ADMINISTRATOR_ROLE",
        make_url(os.environ["JX_TEST_DATABASE_URL"]).username or "",
    )
    return subprocess.run(
        ["uv", "run", "--project", "services/api", "python", "-c", script],
        cwd=Path(__file__).resolve().parents[3],
        env={
            "PATH": os.environ["PATH"],
            "DATABASE_URL": application_url,
            "DATABASE_ADMIN_URL": administrator_url,
            "POSTGRES_APP_USER": application_role,
            "POSTGRES_APP_PASSWORD": application_password,
            "POSTGRES_PASSWORD": administrator_password,
            "JWT_SECRET_KEY": "database-session-test-signing-key",
            "JWT_ISSUER": "database-session-test",
            "JWT_AUDIENCE": "database-session-test",
            "XAGENT_SERVICE_TOKEN": "database-session-test-service-token",
            "MINIO_ENDPOINT": "127.0.0.1:1",
            "MINIO_PUBLIC_ENDPOINT": "127.0.0.1:1",
            "MINIO_ACCESS_KEY": "database-session-test",
            "MINIO_SECRET_KEY": "database-session-test",
            "MINIO_SECURE": "false",
            "CLAMAV_TIMEOUT": "1",
        },
        text=True,
        capture_output=True,
        check=False,
    )


@pytest.mark.anyio
async def test_roles_ensure_creates_missing_role_and_resets_existing_password(
    seeded_database: AsyncEngine,
) -> None:
    suffix = uuid4().hex
    application_role = f"xagent_app_{suffix}"
    worker_role = f"xagent_worker_{suffix}"
    application_password = "app@p:ss/word%raw"
    worker_password = "p@ss:word/%-worker"
    administrator_password = "p@ss:word/%-admin"
    administrator_role = make_url(os.environ["JX_TEST_DATABASE_URL"]).username
    original_administrator_password = make_url(os.environ["JX_TEST_DATABASE_URL"]).password
    assert administrator_role is not None and original_administrator_password is not None

    async def set_password(role: str, password: str) -> None:
        async with seeded_database.begin() as connection:
            statement = await connection.scalar(
                text(
                    "SELECT format('ALTER ROLE %I PASSWORD %L', "
                    "CAST(:role AS text), CAST(:password AS text))"
                ),
                {"role": role, "password": password},
            )
            await connection.execute(text(statement))

    async with seeded_database.begin() as connection:
        create_worker = await connection.scalar(
            text(
                "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', "
                "CAST(:role AS text), CAST(:password AS text))"
            ),
            {"role": worker_role, "password": "obsolete-password"},
        )
        await connection.execute(text(create_worker))

    await set_password(administrator_role, administrator_password)
    try:
        completed = _run_roles_cli(
            administrator_password=administrator_password,
            application_role=application_role,
            application_password=application_password,
            worker_role=worker_role,
            worker_password=worker_password,
        )
        assert completed.returncode == 0
        assert completed.stdout == "" and completed.stderr == ""
        administrator_url = (
            make_url(os.environ["JX_TEST_DATABASE_URL"])
            .set(password=None)
            .render_as_string(hide_password=False)
        )
        migration = _run_migrations(
            administrator_url=administrator_url,
            administrator_password=administrator_password,
            application_role=application_role,
            worker_role=worker_role,
        )
        assert migration.returncode == 0
        assert administrator_password not in migration.stdout + migration.stderr
        encoded_url_migration = _run_migrations(
            administrator_url=make_url(administrator_url)
            .set(password=administrator_password)
            .render_as_string(hide_password=False),
            administrator_password=None,
            application_role=application_role,
            worker_role=worker_role,
        )
        assert encoded_url_migration.returncode == 0
        assert administrator_password not in (
            encoded_url_migration.stdout + encoded_url_migration.stderr
        )
        application_url = (
            make_url(os.environ["JX_TEST_DATABASE_URL"])
            .set(username=application_role, password=None)
            .render_as_string(hide_password=False)
        )
        api_sessions = _run_api_database_sessions(
            application_url=application_url,
            application_password=application_password,
            application_role=application_role,
            administrator_url=make_url(administrator_url)
            .set(password="wrong-inline-password")
            .render_as_string(hide_password=False),
            administrator_password=administrator_password,
        )
        assert api_sessions.returncode == 0
        assert api_sessions.stdout == "" and api_sessions.stderr == ""

        worker_url = (
            make_url(os.environ["JX_TEST_DATABASE_URL"])
            .set(username=worker_role, password=None)
            .render_as_string(hide_password=False)
        )
        worker_engine = create_database_engine(worker_url, password=worker_password)
        try:
            async with worker_engine.connect() as connection:
                assert await connection.scalar(text("SELECT current_user")) == worker_role
        finally:
            await worker_engine.dispose()

        compatible_url_engine = create_database_engine(
            make_url(os.environ["JX_TEST_DATABASE_URL"])
            .set(username=application_role, password=application_password)
            .render_as_string(hide_password=False)
        )
        try:
            async with compatible_url_engine.connect() as connection:
                assert await connection.scalar(text("SELECT current_user")) == application_role
        finally:
            await compatible_url_engine.dispose()
    finally:
        await set_password(administrator_role, original_administrator_password)
        async with seeded_database.begin() as connection:
            for role in (worker_role, application_role):
                role_exists = await connection.scalar(
                    text("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :role)"),
                    {"role": role},
                )
                if role_exists:
                    drop_role = await connection.scalar(
                        text("SELECT format('DROP ROLE %I', CAST(:role AS text))"),
                        {"role": role},
                    )
                    await connection.execute(text(drop_role))
