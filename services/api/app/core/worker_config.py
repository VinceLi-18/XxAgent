from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.database_engine import create_database_engine


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

    return create_database_engine(
        settings.DATABASE_WORKER_URL,
        password=settings.POSTGRES_WORKER_PASSWORD,
    )
