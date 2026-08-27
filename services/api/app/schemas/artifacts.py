from datetime import datetime
from typing import Literal
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


class EmptyArtifactRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RetryArtifactVersionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: str = Field(min_length=1, max_length=128)


class PrivateArtifactScopeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["private"]


class ProjectArtifactScopeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["project"]
    project_id: UUID


class ArtifactSummaryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    display_name: str
    scope: PrivateArtifactScopeResponse | ProjectArtifactScopeResponse
    latest_version: int = Field(ge=1)
    latest_status: Literal["pending", "scanning", "clean", "quarantined", "failed"]
    latest_clean_version: int | None = Field(default=None, ge=1)


class ArtifactVersionSummaryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    version: int = Field(ge=1)
    original_filename: str
    uploaded_by: UUID
    size: int | None = Field(default=None, ge=0, le=50 * 1024 * 1024)
    content_type: str | None = None
    sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    status: Literal["pending", "scanning", "clean", "quarantined", "failed"]
    created_at: datetime


class ArtifactDetailResponse(ArtifactSummaryResponse):
    can_edit: bool
    versions: list[ArtifactVersionSummaryResponse]


class ArtifactReadResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str
