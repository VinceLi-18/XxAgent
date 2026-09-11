"""Closed Business Skill wire inputs; database identities remain private."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.business_skills import (
    BUSINESS_SKILL_MAX_DESCRIPTION_BYTES,
    BUSINESS_SKILL_MAX_INSTRUCTIONS_BYTES,
    BUSINESS_SKILL_PRIMARY_TOOLS,
    BUSINESS_SKILL_SLUG_PATTERN,
)

PositiveNumber = Annotated[int, Field(strict=True, ge=1)]
Slug = Annotated[str, Field(min_length=1, max_length=128, pattern=BUSINESS_SKILL_SLUG_PATTERN)]


class BusinessSkillRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: Literal[1]

    @field_validator("schema_version", mode="before")
    @classmethod
    def integer_version(cls, value):
        if type(value) is not int:
            raise ValueError("schema_version must be an integer")
        return value


class BusinessSkillMutationRequest(BusinessSkillRequest):
    idempotency_key: str = Field(min_length=1, max_length=255)


class BusinessSkillContent(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    @field_validator("description", "instructions", "display_name", check_fields=False)
    @classmethod
    def bounded_text(cls, value, info):
        if value is None:
            return value
        maximum = {"description": BUSINESS_SKILL_MAX_DESCRIPTION_BYTES,
                   "instructions": BUSINESS_SKILL_MAX_INSTRUCTIONS_BYTES, "display_name": 255}[info.field_name]
        if not value.strip() or len(value.encode("utf-8")) > maximum:
            raise ValueError("text must be nonempty and within its UTF-8 byte limit")
        return value.replace("\r\n", "\n").replace("\r", "\n")

    @field_validator("primary_tools", check_fields=False)
    @classmethod
    def closed_tools(cls, value):
        if value is not None and (value != sorted(set(value)) or not set(value) <= BUSINESS_SKILL_PRIMARY_TOOLS):
            raise ValueError("primary_tools must be sorted, unique, and supported")
        return value


class BusinessSkillCreateRequest(BusinessSkillMutationRequest, BusinessSkillContent):
    slug: Slug
    display_name: str
    description: str
    instructions: str
    primary_tools: list[str]


class BusinessSkillDraftRequest(BusinessSkillMutationRequest, BusinessSkillContent):
    expected_draft_revision: PositiveNumber
    source_version_number: PositiveNumber | None = None
    display_name: str | None = None
    description: str | None = None
    instructions: str | None = None
    primary_tools: list[str] | None = None

    @model_validator(mode="after")
    def has_edit(self):
        changes = self.model_fields_set - {"schema_version", "idempotency_key", "expected_draft_revision"}
        if not changes or any(getattr(self, key) is None for key in changes):
            raise ValueError("draft edit requires a non-null change")
        return self


class BusinessSkillPublishRequest(BusinessSkillMutationRequest):
    expected_draft_revision: PositiveNumber


class BusinessSkillAuthorizationRequest(BusinessSkillMutationRequest):
    authorized: bool


class BusinessSkillVersionRequest(BusinessSkillMutationRequest):
    version_number: PositiveNumber


class BusinessSkillVerdictRequest(BusinessSkillMutationRequest):
    verdict: Literal["pass", "reject"]


class BusinessSkillPageRequest(BusinessSkillRequest):
    limit: int = Field(default=50, ge=1, le=100)
    cursor: Slug | None = None


class BusinessSkillDetailRequest(BusinessSkillRequest):
    limit: int = Field(default=50, ge=1, le=100)
    version_cursor: PositiveNumber | None = None
    run_cursor: PositiveNumber | None = None


class BusinessSkillTestResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    run_number: PositiveNumber
    draft_revision: PositiveNumber
    content_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    tool_policy_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    status: Literal["running", "completed", "failed", "cancelled"]
    termination_reason: Literal["completed", "failed", "cancelled", "tool-denied", "authorization-denied", "skill-not-loaded", "service-unavailable"] | None
    verdict: Literal["pass", "reject"] | None
    started_at: str
    settled_at: str | None
    verdict_at: str | None


class BusinessSkillSummaryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    slug: Slug
    display_name: str
    status: Literal["active", "retired"]
    authorized: bool
    current_version: PositiveNumber | None
    draft_revision: PositiveNumber | None
    latest_test: BusinessSkillTestResponse | None
    updated_at: str


class BusinessSkillDraftResponse(BusinessSkillContent):
    revision: PositiveNumber
    description: str
    instructions: str
    primary_tools: list[str]
    content_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    tool_policy_digest: str = Field(pattern=r"^[0-9a-f]{64}$")


class BusinessSkillVersionResponse(BusinessSkillContent):
    version_number: PositiveNumber
    description: str
    instructions: str
    primary_tools: list[str]
    complete_tools: list[Literal["list_accessible_projects", "search_artifacts", "propose_fact", "skill", "submit_cited_answer"]]
    content_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    tool_policy_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_draft_revision: PositiveNumber
    published_at: str


class BusinessSkillAuditSummaryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action: str
    result: str
    version_number: PositiveNumber | None
    created_at: str


class BusinessSkillDetailResponse(BusinessSkillSummaryResponse):
    schema_version: Literal[1]
    draft: BusinessSkillDraftResponse | None
    versions: list[BusinessSkillVersionResponse] = Field(max_length=100)
    tests: list[BusinessSkillTestResponse] = Field(max_length=100)
    next_version_cursor: PositiveNumber | None
    next_run_cursor: PositiveNumber | None
    audit_summary: list[BusinessSkillAuditSummaryResponse] = Field(max_length=100)


class BusinessSkillPageResponse(BusinessSkillRequest):
    items: list[BusinessSkillSummaryResponse] = Field(max_length=100)
    next_cursor: Slug | None
