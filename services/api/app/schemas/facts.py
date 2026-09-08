"""Closed request and response models for the internal Fact API."""

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
