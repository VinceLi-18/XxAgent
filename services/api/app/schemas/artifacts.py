from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class CreateArtifactUploadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(ge=0, le=50 * 1024 * 1024)
    idempotency_key: str = Field(min_length=1, max_length=128)


class CreateArtifactUploadResponse(BaseModel):
    upload_id: UUID
    put_url: str
    expires_at: datetime


class CompleteArtifactUploadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    actual_size: int = Field(ge=0, le=50 * 1024 * 1024)
    sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")
    idempotency_key: str = Field(min_length=1, max_length=128)


class CompleteArtifactUploadResponse(BaseModel):
    artifact_id: UUID
    version_id: UUID
