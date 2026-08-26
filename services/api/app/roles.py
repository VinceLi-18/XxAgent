from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine


class DatabaseRoleSettings(BaseSettings):
    """Administrator connection and raw credentials for runtime database roles."""

    model_config = SettingsConfigDict(
        env_file="../.env",
        env_ignore_empty=True,
        extra="ignore",
    )

    DATABASE_ADMIN_URL: str
    POSTGRES_APP_USER: str = Field(min_length=1)
    POSTGRES_APP_PASSWORD: str = Field(min_length=1)
    POSTGRES_WORKER_USER: str = Field(min_length=1)
    POSTGRES_WORKER_PASSWORD: str = Field(min_length=1)


async def _ensure_role(connection: AsyncConnection, role: str, password: str) -> None:
    role_exists = await connection.scalar(
        text("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :role)"),
        {"role": role},
    )
    operation = "ALTER" if role_exists else "CREATE"
    statement = await connection.scalar(
        text(
            "SELECT format("
            f"'{operation} ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
            "NOINHERIT NOBYPASSRLS PASSWORD %L', "
            "CAST(:role AS text), CAST(:password AS text))"
        ),
        {"role": role, "password": password},
    )
    await connection.execute(text(statement))


async def ensure_database_roles() -> None:
    """Create or repair both runtime roles from raw deployment credentials."""

    settings = DatabaseRoleSettings()
    engine = create_async_engine(settings.DATABASE_ADMIN_URL, pool_pre_ping=True)
    try:
        async with engine.begin() as connection:
            await _ensure_role(
                connection,
                settings.POSTGRES_APP_USER,
                settings.POSTGRES_APP_PASSWORD,
            )
            await _ensure_role(
                connection,
                settings.POSTGRES_WORKER_USER,
                settings.POSTGRES_WORKER_PASSWORD,
            )
    finally:
        await engine.dispose()
