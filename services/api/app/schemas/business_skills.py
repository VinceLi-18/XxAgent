"""Closed Business Skill wire inputs; database identities remain private."""

from pathlib import PurePosixPath, PureWindowsPath
from typing import Annotated, Literal
from uuid import UUID

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
    unexecuted_write_tools: list[Literal["propose_fact"]] = Field(max_length=1)
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


Digest = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
HostKey = Annotated[UUID, Field(strict=False)]
TerminationReason = Literal["completed", "failed", "cancelled", "tool-denied", "authorization-denied", "skill-not-loaded", "service-unavailable"]


class BusinessSkillTestStartRequest(BusinessSkillMutationRequest):
    """One scenario for the exact draft and current resolver policy."""

    expected_draft_revision: PositiveNumber
    tool_policy_digest: Digest
    scenario: str = Field(min_length=1, max_length=65536)

    @field_validator("scenario")
    @classmethod
    def bounded_scenario(cls, value: str) -> str:
        if not value.strip() or len(value.encode("utf-8")) > 65536:
            raise ValueError("scenario must be nonempty and at most 65536 UTF-8 bytes")
        return value


class BusinessSkillTestSettleRequest(BusinessSkillMutationRequest):
    """The Host settles its exact Session after the execution has stopped."""

    session_id: HostKey
    termination_reason: TerminationReason


class BusinessSkillStartupEvent(BusinessSkillRequest):
    event_type: str = Field(min_length=1, max_length=100)
    payload: dict[str, object]


class BusinessSkillTestCancelRequest(BusinessSkillMutationRequest):
    """Host cleanup may cancel only an unmounted empty Session."""

    session_id: HostKey


class BusinessSkillTestToolRequest(BusinessSkillRequest):
    """Host-only execution pin; historical transcript access cannot authorize a tool."""

    session_id: HostKey
    tool_policy_digest: Digest
    tool_name: str = Field(min_length=1, max_length=255)
    cancelled: bool


class BusinessSkillTestMountRequest(BusinessSkillMutationRequest):
    """Atomically publish a Host factory header and its pre-turn events once."""

    session_id: HostKey
    runtime_header: dict[str, object]
    events: list[BusinessSkillStartupEvent] = Field(max_length=100)

    @model_validator(mode="after")
    def initial_log(self):
        header = self.runtime_header
        cwd = header.get("cwd")
        if (set(header) != {"id", "version", "createdAt", "cwd"}
                or header["id"] != f"session-{self.session_id}" or type(header["version"]) is not int
                or header["version"] != 0 or type(header["createdAt"]) is not int or header["createdAt"] < 0):
            raise ValueError("invalid test runtime header")
        if type(cwd) is not str or not (PurePosixPath(cwd).is_absolute() or PureWindowsPath(cwd).is_absolute()):
            raise ValueError("invalid test runtime cwd")
        for seq, event in enumerate(self.events):
            payload = event.payload
            if (payload.get("seq") != seq or type(payload.get("seq")) is not int
                    or payload.get("type") != event.event_type or type(payload.get("time")) is not int
                    or payload["time"] < 0 or "data" not in payload or "surfaceOp" in payload
                    or event.event_type not in {"config", "session/title"}):
                raise ValueError("test startup events must precede model admission")
        return self


class BusinessSkillTranscriptRequest(BusinessSkillRequest):
    after_sequence: int = Field(default=-1, ge=-1)
    limit: int = Field(default=500, ge=1, le=500)


class BusinessSkillTestResult(BusinessSkillRequest):
    test: BusinessSkillTestResponse


class BusinessSkillTestMountResponse(BusinessSkillTestResult):
    claimed: bool


class BusinessSkillTestStartResponse(BusinessSkillTestResult):
    """Host-only execution input; session_id must not reach Browser or model."""

    session_id: str
    purpose: Literal["business_skill_test"]
    draft: BusinessSkillDraftResponse
    scenario: str
    test_tools: list[str]
    unexecuted_write_tools: list[str]


class BusinessSkillTranscriptEvent(BusinessSkillRequest):
    sequence: int
    event_type: str
    payload: dict[str, object]
    created_at: str


class BusinessSkillTranscriptResponse(BusinessSkillTestResult):
    events: list[BusinessSkillTranscriptEvent]
    next_sequence: int


class BusinessSkillRuntimeRequest(BusinessSkillRequest):
    """Authenticated Host Session identity, never supplied by a Browser Remote body."""

    session_id: HostKey


class BusinessSkillLoadRequest(BusinessSkillRuntimeRequest):
    slug: Slug
    version_key: HostKey


class BusinessSkillToolRequest(BusinessSkillLoadRequest):
    tool_policy_digest: Digest
    tool_name: str = Field(min_length=1, max_length=255)
    cancelled: bool


class BusinessSkillCatalogEntry(BusinessSkillRequest):
    """Version keys are private Host handles; catalogs expose only slug and description."""

    slug: Slug
    description: str
    version_number: PositiveNumber
    version_key: str


class BusinessSkillCatalogResponse(BusinessSkillRequest):
    items: list[BusinessSkillCatalogEntry]


class BusinessSkillLoadResponse(BusinessSkillCatalogEntry):
    instructions: str
    content_digest: Digest
    tool_policy_digest: Digest
    complete_tools: list[str]


class BusinessSkillToolResponse(BusinessSkillRequest):
    allowed: Literal[True]
