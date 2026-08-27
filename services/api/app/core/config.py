from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.core.worker_config import ArtifactWorkerSettings

__all__ = ("ArtifactWorkerSettings", "Settings", "settings")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file="../.env",
        env_ignore_empty=True,
        extra="ignore",
    )

    API_V1_STR: str = "/api/v1"
    PROJECT_NAME: str = "XAgent"
    DATABASE_URL: str
    DATABASE_ADMIN_URL: str | None = None
    POSTGRES_APP_USER: str
    POSTGRES_APP_PASSWORD: str | None = None
    POSTGRES_PASSWORD: str | None = None
    JWT_SECRET_KEY: str
    JWT_ISSUER: str
    JWT_AUDIENCE: str
    XAGENT_SERVICE_TOKEN: str = Field(min_length=32)
    XAGENT_AUTH_SESSION_HOURS: int = Field(default=8, ge=1, le=24)
    MINIO_ENDPOINT: str
    MINIO_PUBLIC_ENDPOINT: str
    MINIO_ACCESS_KEY: str
    MINIO_SECRET_KEY: str
    MINIO_SECURE: bool
    MINIO_PUBLIC_SECURE: bool = False
    MINIO_REGION: str = "us-east-1"
    MINIO_BUCKET: str = "xagent-private"
    MAX_ARTIFACT_SIZE_BYTES: int = Field(default=50 * 1024 * 1024, gt=0)
    STAGING_EXPIRY_DAYS: int = Field(default=1, ge=1)
    CLAMAV_HOST: str = "clamav"
    CLAMAV_PORT: int = 3310
    CLAMAV_TIMEOUT: float = Field(gt=0)
    EMBEDDING_URL: str = "http://embedding:8000"
    EMBEDDING_TIMEOUT: float = Field(default=10, gt=0)


settings = Settings()
