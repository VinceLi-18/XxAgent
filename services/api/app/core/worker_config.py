from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


class ArtifactWorkerSettings(BaseSettings):
    """Configuration read exclusively by the artifact worker command."""

    model_config = SettingsConfigDict(
        env_file="../.env",
        env_ignore_empty=True,
        extra="ignore",
    )

    DATABASE_WORKER_URL: str
    POSTGRES_WORKER_PASSWORD: str | None = None


def create_worker_database_engine(
    settings: ArtifactWorkerSettings,
) -> AsyncEngine:
    """Create a worker engine with an optional raw asyncpg password."""

    connect_args = (
        {"password": settings.POSTGRES_WORKER_PASSWORD}
        if settings.POSTGRES_WORKER_PASSWORD is not None
        else {}
    )
    return create_async_engine(
        settings.DATABASE_WORKER_URL,
        pool_pre_ping=True,
        connect_args=connect_args,
    )
