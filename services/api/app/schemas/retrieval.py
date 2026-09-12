"""Strict request and response models for the internal retrieval API."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt


class _ClosedModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _OperationRequest(_ClosedModel):
    schema_version: StrictInt = Field(ge=1, le=1)
    session_id: UUID
    tool_call_id: str = Field(min_length=1, max_length=255)
    permission_revision: StrictInt = Field(ge=1)


class PublishedSkillDiscovery(_ClosedModel):
    """Host-only immutable production pin; the retrieval transaction reauthorizes it."""

    kind: Literal["published"]
    slug: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$", max_length=128)
    version_key: UUID
    tool_policy_digest: str = Field(pattern=r"^[0-9a-f]{64}$")


class TestSkillDiscovery(_ClosedModel):
    """Host-only mounted run whose immutable read policy authorizes discovery."""

    kind: Literal["test"]
    slug: str = Field(pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$", max_length=128)
    run_number: StrictInt = Field(ge=1)
    tool_policy_digest: str = Field(pattern=r"^[0-9a-f]{64}$")


class ProjectDiscoveryRequest(_OperationRequest):
    query: str | None = Field(default=None, min_length=1, max_length=255)
    business_skill: Annotated[PublishedSkillDiscovery | TestSkillDiscovery, Field(discriminator="kind")] | None = None


class SearchRequest(_OperationRequest):
    query: str = Field(min_length=1, max_length=8192)
    project_ids: list[UUID] | None = None
    include_private: StrictBool = False


class ProjectResult(_ClosedModel):
    project_id: UUID
    name: str


class CitationResult(_ClosedModel):
    id: str
    artifact_id: UUID
    version_id: UUID
    chunk_id: UUID
    display_name: str
    version_number: int
    line_start: int
    line_end: int
    text: str
    scope: Literal["private", "project"]


class ProjectDiscoveryResponse(_ClosedModel):
    schema_version: Literal[1] = 1
    projects: list[ProjectResult]
    receipt: str
    payload_sha256: str


class SearchResponse(_ClosedModel):
    schema_version: Literal[1] = 1
    citations: list[CitationResult]
    receipt: str
    payload_sha256: str


class CitationIdentity(_ClosedModel):
    id: str = Field(pattern=r"^\[资料[1-9][0-9]*\]$")
    artifact_id: UUID
    version_id: UUID
    chunk_id: UUID


class CitationAuthorizeRequest(_OperationRequest):
    citations: list[CitationIdentity] = Field(min_length=1, max_length=64)


class CitationAuthorizeResponse(_ClosedModel):
    schema_version: Literal[1] = 1
    authorized: bool


class CitationResolveRequest(_OperationRequest):
    citation_id: str = Field(pattern=r"^\[资料[1-9][0-9]*\]$", max_length=32)


class CitationResolveResponse(_ClosedModel):
    schema_version: Literal[1] = 1
    artifact_id: UUID
    version_id: UUID
    chunk_id: UUID
    line_start: int
    line_end: int
