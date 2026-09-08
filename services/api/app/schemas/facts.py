"""Closed request and response models for the internal Fact API."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    field_validator,
    model_validator,
)

from app.models.facts import FACT_MAX_EVIDENCE
from app.services.fact_validation import (
    validate_calendar_date,
    validate_field_key,
    validate_label,
    validate_number,
    validate_reason,
    validate_text_value,
)


class _ClosedModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TextFactValue(_ClosedModel):
    """A bounded text value proposed for a project Fact."""

    type: Literal["text"]
    value: str

    _validate_value = field_validator("value")(validate_text_value)


class NumberFactValue(_ClosedModel):
    """A finite numeric value proposed for a project Fact."""

    type: Literal["number"]
    value: StrictInt | StrictFloat

    _validate_value = field_validator("value")(validate_number)


class BooleanFactValue(_ClosedModel):
    """A strict boolean value proposed for a project Fact."""

    type: Literal["boolean"]
    value: StrictBool


class DateFactValue(_ClosedModel):
    """An exact calendar-date value proposed for a project Fact."""

    type: Literal["date"]
    value: str

    _validate_value = field_validator("value")(validate_calendar_date)


ProjectFactValue = Annotated[
    TextFactValue | NumberFactValue | BooleanFactValue | DateFactValue,
    Field(discriminator="type"),
]
CitationId = Annotated[
    str,
    Field(pattern=r"^\[资料[1-9][0-9]*\]$", max_length=32),
]


class FactPrepareRequest(_ClosedModel):
    """A caller-authored Fact candidate and its evidence references."""

    schema_version: Literal[1]
    session_id: UUID
    tool_call_id: str = Field(min_length=1, max_length=255)
    permission_revision: StrictInt = Field(ge=1)
    idempotency_key: str = Field(min_length=1, max_length=255)
    field_key: str
    label: str
    value: ProjectFactValue
    evidence_ids: list[CitationId] = Field(default_factory=list, max_length=FACT_MAX_EVIDENCE)
    assertion_reason: str | None = None

    _validate_field_key = field_validator("field_key")(validate_field_key)
    _validate_label = field_validator("label")(validate_label)

    @field_validator("assertion_reason")
    @classmethod
    def validate_assertion_reason(cls, value: str | None) -> str | None:
        return validate_reason(value) if value is not None else None

    @model_validator(mode="after")
    def validate_evidence(self) -> "FactPrepareRequest":
        if len(set(self.evidence_ids)) != len(self.evidence_ids):
            raise ValueError("Fact evidence IDs must be distinct")
        if not self.evidence_ids and self.assertion_reason is None:
            raise ValueError("Fact evidence or an assertion reason is required")
        return self


class FactProposalPublicResult(_ClosedModel):
    """The only Fact preparation fields admitted to the public Session event."""

    proposalId: UUID
    status: Literal["pending"] = "pending"


class FactPrepareResponse(_ClosedModel):
    """A public Fact result with private Host admission sidecar fields."""

    schema_version: Literal[1] = 1
    result: FactProposalPublicResult
    receipt: str
    payload_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class FactVersionedRequest(_ClosedModel):
    """A body containing only the Fact wire protocol version."""

    schema_version: Literal[1]


class FactPageRequest(FactVersionedRequest):
    """A bounded page request whose cursor grants no authorization."""

    limit: StrictInt = Field(default=100, ge=1, le=100)
    cursor: str | None = Field(default=None, min_length=1, max_length=512)


class FactOutboxPageRequest(FactVersionedRequest):
    """A bounded Outbox pull request."""

    limit: StrictInt = Field(default=32, ge=1, le=32)
    cursor: str | None = Field(default=None, min_length=1, max_length=512)


class FactEvidenceResponse(_ClosedModel):
    """One exact immutable Artifact evidence identity and line range."""

    citation_id: str
    artifact_id: UUID
    version_id: UUID
    index_id: UUID
    index_generation: StrictInt = Field(ge=1)
    chunk_id: UUID
    line_start: StrictInt = Field(ge=1)
    line_end: StrictInt = Field(ge=1)


FactPublicStatus = Literal["pending", "confirmed", "rejected", "withdrawn", "conflicted"]
FactTerminalStatus = Literal["confirmed", "rejected", "withdrawn", "conflicted"]


class FactProposalResponse(_ClosedModel):
    """The public review fields of one admitted Fact proposal."""

    id: UUID
    project_id: UUID
    field_key: str
    label: str
    value: ProjectFactValue
    proposer_id: UUID
    base_revision: StrictInt = Field(ge=0)
    assertion_reason: str | None
    status: FactPublicStatus
    decision_actor_id: UUID | None
    decision_reason: str | None
    evidence: list[FactEvidenceResponse] = Field(max_length=FACT_MAX_EVIDENCE)
    created_at: datetime
    admitted_at: datetime
    decided_at: datetime | None


class FactRevisionResponse(_ClosedModel):
    """One immutable confirmed Fact revision with its proposal attribution."""

    id: UUID
    project_id: UUID
    field_key: str
    label: str
    value: ProjectFactValue
    content_revision: StrictInt = Field(ge=1)
    proposal_id: UUID
    proposer_id: UUID
    confirmed_by_id: UUID
    assertion_reason: str | None
    evidence: list[FactEvidenceResponse] = Field(max_length=FACT_MAX_EVIDENCE)
    created_at: datetime


class FactProposalPageResponse(_ClosedModel):
    """A stable bounded page of public proposals."""

    schema_version: Literal[1] = 1
    items: list[FactProposalResponse] = Field(max_length=100)
    next_cursor: str | None


class FactHeadPageResponse(_ClosedModel):
    """A stable bounded page of current Fact revisions."""

    schema_version: Literal[1] = 1
    items: list[FactRevisionResponse] = Field(max_length=100)
    next_cursor: str | None


class FactProposalDetailResponse(_ClosedModel):
    """The public detail of one admitted proposal."""

    schema_version: Literal[1] = 1
    proposal: FactProposalResponse


class FactRevisionDetailResponse(_ClosedModel):
    """One selected revision and newest-first history for its field."""

    schema_version: Literal[1] = 1
    revision: FactRevisionResponse
    history: list[FactRevisionResponse] = Field(max_length=100)


class FactApproveRequest(FactVersionedRequest):
    """A manager approval with an optional bounded note and operation identity."""

    idempotency_key: str = Field(min_length=1, max_length=255)
    decision_note: str | None = None

    @field_validator("decision_note")
    @classmethod
    def validate_decision_note(cls, value: str | None) -> str | None:
        return validate_reason(value) if value is not None else None


class FactRejectRequest(FactVersionedRequest):
    """A manager rejection with a required bounded reason."""

    idempotency_key: str = Field(min_length=1, max_length=255)
    reason: str

    _validate_reason = field_validator("reason")(validate_reason)


class FactWithdrawRequest(FactVersionedRequest):
    """A proposer withdrawal operation identity."""

    idempotency_key: str = Field(min_length=1, max_length=255)


class FactProposalDecisionResponse(_ClosedModel):
    """The public terminal result of one idempotent proposal decision."""

    schema_version: Literal[1] = 1
    proposal_id: UUID
    status: FactTerminalStatus
    fact_revision_id: UUID | None = None
    content_revision: StrictInt | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def validate_revision_identity(self) -> "FactProposalDecisionResponse":
        has_revision = (
            self.fact_revision_id is not None and self.content_revision is not None
        )
        if (self.fact_revision_id is None) != (self.content_revision is None):
            raise ValueError("Fact revision identity must be complete")
        if (self.status == "confirmed") != has_revision:
            raise ValueError("Only confirmed decisions identify a Fact revision")
        return self


class FactProposalDecidedData(_ClosedModel):
    """The closed snake-case data projected from a terminal proposal."""

    proposal_id: UUID
    project_id: UUID
    field_key: str
    label: str
    status: FactTerminalStatus
    fact_revision_id: UUID | None = None
    content_revision: StrictInt | None = Field(default=None, ge=1)
    decision_reason: str | None = None

    @model_validator(mode="after")
    def validate_terminal_identity(self) -> "FactProposalDecidedData":
        has_revision = (
            self.fact_revision_id is not None and self.content_revision is not None
        )
        if (self.fact_revision_id is None) != (self.content_revision is None):
            raise ValueError("Fact revision identity must be complete")
        if (self.status == "confirmed") != has_revision:
            raise ValueError("Only confirmed events identify a Fact revision")
        if self.status == "rejected" and self.decision_reason is None:
            raise ValueError("Rejected events require a decision reason")
        return self


class FactProposalDecidedEvent(_ClosedModel):
    """A terminal Fact event awaiting ordinary Session persistence."""

    type: Literal["fact/proposal-decided"]
    data: FactProposalDecidedData


class FactOutboxItemResponse(_ClosedModel):
    """One immutable Outbox identity and its verified public event."""

    outbox_id: UUID
    payload_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    event: FactProposalDecidedEvent


class FactOutboxPageResponse(_ClosedModel):
    """A stable bounded page of unconsumed decision events."""

    schema_version: Literal[1] = 1
    items: list[FactOutboxItemResponse] = Field(max_length=32)
    next_cursor: str | None
