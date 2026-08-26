import os
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


def _run_roles_cli(
    *,
    application_role: str,
    application_password: str,
    worker_role: str,
    worker_password: str,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["uv", "run", "--project", "services/api", "xagent-api", "roles", "ensure"],
        cwd=Path(__file__).resolve().parents[3],
        env={
            "PATH": os.environ["PATH"],
            "DATABASE_ADMIN_URL": os.environ["JX_TEST_DATABASE_URL"],
            "POSTGRES_APP_USER": application_role,
            "POSTGRES_APP_PASSWORD": application_password,
            "POSTGRES_WORKER_USER": worker_role,
            "POSTGRES_WORKER_PASSWORD": worker_password,
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

    async with seeded_database.begin() as connection:
        create_worker = await connection.scalar(
            text(
                "SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', "
                "CAST(:role AS text), CAST(:password AS text))"
            ),
            {"role": worker_role, "password": "obsolete-password"},
        )
        await connection.execute(text(create_worker))

    completed = _run_roles_cli(
        application_role=application_role,
        application_password=application_password,
        worker_role=worker_role,
        worker_password=worker_password,
    )
    try:
        assert completed.returncode == 0
        assert completed.stdout == "" and completed.stderr == ""
        for role, password in (
            (application_role, application_password),
            (worker_role, worker_password),
        ):
            role_url = make_url(os.environ["JX_TEST_DATABASE_URL"]).set(
                username=role,
                password=password,
            )
            role_engine = create_async_engine(role_url)
            try:
                async with role_engine.connect() as connection:
                    assert await connection.scalar(text("SELECT current_user")) == role
            finally:
                await role_engine.dispose()
    finally:
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
