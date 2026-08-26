from pydantic_settings import BaseSettings, SettingsConfigDict


class MigrationSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file="../.env",
        env_ignore_empty=True,
        extra="ignore",
    )

    DATABASE_ADMIN_URL: str
    POSTGRES_PASSWORD: str | None = None
    POSTGRES_APP_USER: str
    POSTGRES_WORKER_USER: str


migration_settings = MigrationSettings()
