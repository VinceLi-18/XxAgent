from pydantic_settings import BaseSettings, SettingsConfigDict


class ArtifactWorkerSettings(BaseSettings):
    """Configuration read exclusively by the artifact worker command."""

    model_config = SettingsConfigDict(
        env_file="../.env",
        env_ignore_empty=True,
        extra="ignore",
    )

    DATABASE_WORKER_URL: str
