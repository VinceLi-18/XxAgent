"""Governed project Fact proposals, immutable revisions, and delivery state."""

from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ProjectFactValueType(str, Enum):
    """The closed set of persisted Fact value tags."""

    TEXT = "text"
    NUMBER = "number"
    BOOLEAN = "boolean"
    DATE = "date"


class FactProposalStatus(str, Enum):
    """The internal preparation and public decision states of a Fact proposal."""

    PREPARED = "prepared"
    PENDING = "pending"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    WITHDRAWN = "withdrawn"
    CONFLICTED = "conflicted"
    EXPIRED = "expired"


FACT_FIELD_KEY_MAX_BYTES = 128
FACT_LABEL_MAX_BYTES = 255
FACT_TEXT_MAX_BYTES = 16 * 1024
FACT_REASON_MAX_BYTES = 4 * 1024
FACT_MAX_EVIDENCE = 64
FACT_LIST_PAGE_MAX = 100
FACT_OUTBOX_PAGE_MAX = 32
FACT_RECEIPT_TTL_SECONDS = 5 * 60

_FIELD_KEY_CHECK = (
    "field_key ~ '^[a-z0-9]+([._-][a-z0-9]+)*$' "
    f"AND octet_length(field_key) <= {FACT_FIELD_KEY_MAX_BYTES}"
)
_LABEL_CHECK = f"octet_length(label) BETWEEN 1 AND {FACT_LABEL_MAX_BYTES}"
_VALUE_CHECK = (
    f"(value_type = 'text' AND jsonb_typeof(value) = 'string' "
    f"AND octet_length(value #>> '{{}}') <= {FACT_TEXT_MAX_BYTES}) OR "
    "(value_type = 'number' AND jsonb_typeof(value) = 'number') OR "
    "(value_type = 'boolean' AND jsonb_typeof(value) = 'boolean') OR "
    "(value_type = 'date' AND jsonb_typeof(value) = 'string' "
    "AND (value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' "
    "AND to_char(to_date(value #>> '{}', 'YYYY-MM-DD'), 'YYYY-MM-DD') = (value #>> '{}'))"
)


class FactProposal(Base):
    """An immutable candidate whose state records durable admission and review."""

    __tablename__ = "fact_proposals"
    __table_args__ = (
        CheckConstraint(_FIELD_KEY_CHECK, name="ck_fact_proposal_field_key"),
        CheckConstraint(_LABEL_CHECK, name="ck_fact_proposal_label"),
        CheckConstraint(_VALUE_CHECK, name="ck_fact_proposal_value"),
        CheckConstraint("base_revision >= 0", name="ck_fact_proposal_base_revision"),
        CheckConstraint("permission_revision >= 1", name="ck_fact_proposal_permission_revision"),
        CheckConstraint(
            "assertion_reason IS NULL OR octet_length(assertion_reason) BETWEEN 1 AND 4096",
            name="ck_fact_proposal_assertion_reason",
        ),
        CheckConstraint(
            "decision_reason IS NULL OR octet_length(decision_reason) BETWEEN 1 AND 4096",
            name="ck_fact_proposal_decision_reason",
        ),
        CheckConstraint("payload_sha256 ~ '^[0-9a-f]{64}$'", name="ck_fact_proposal_payload_hash"),
        CheckConstraint(
            "status IN ('prepared', 'pending', 'confirmed', 'rejected', 'withdrawn', 'conflicted', 'expired')",
            name="ck_fact_proposal_status",
        ),
        CheckConstraint(
            "admission_expires_at = created_at + INTERVAL '5 minutes'",
            name="ck_fact_proposal_admission_expiry",
        ),
        CheckConstraint(
            "(status = 'prepared' AND admitted_at IS NULL AND decided_at IS NULL "
            "AND decision_actor_id IS NULL AND decision_reason IS NULL) OR "
            "(status = 'pending' AND admitted_at IS NOT NULL AND decided_at IS NULL "
            "AND decision_actor_id IS NULL AND decision_reason IS NULL) OR "
            "(status = 'expired' AND admitted_at IS NULL AND decided_at IS NOT NULL "
            "AND decision_actor_id IS NULL AND decision_reason IS NULL) OR "
            "(status IN ('confirmed', 'rejected', 'withdrawn', 'conflicted') "
            "AND admitted_at IS NOT NULL AND decided_at IS NOT NULL AND decision_actor_id IS NOT NULL "
            "AND (status <> 'rejected' OR decision_reason IS NOT NULL))",
            name="ck_fact_proposal_lifecycle_fields",
        ),
        ForeignKeyConstraint(
            ("source_session_id", "project_id"),
            ("xagent_sessions.id", "xagent_sessions.project_id"),
            name="fk_fact_proposal_project_session",
            ondelete="RESTRICT",
        ),
        UniqueConstraint("id", "project_id", name="uq_fact_proposal_project_identity"),
        UniqueConstraint(
            "id", "project_id", "field_key",
            name="uq_fact_proposal_field_identity",
        ),
        UniqueConstraint("id", "source_session_id", name="uq_fact_proposal_session_identity"),
        UniqueConstraint(
            "id", "project_id", "source_session_id",
            name="uq_fact_proposal_project_session_identity",
        ),
        UniqueConstraint(
            "id", "project_id", "field_key", "base_revision",
            name="uq_fact_proposal_revision_identity",
        ),
        UniqueConstraint(
            "id", "project_id", "proposer_id", "source_session_id", "source_tool_call_id",
            "permission_revision", "payload_sha256",
            name="uq_fact_proposal_receipt_claims",
        ),
        UniqueConstraint(
            "proposer_id", "source_session_id", "idempotency_key",
            name="uq_fact_proposal_prepare_idempotency",
        ),
        Index(
            "ix_fact_proposals_project_status_created",
            "project_id",
            "status",
            "created_at",
            "id",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False)
    field_key: Mapped[str] = mapped_column(String(128), nullable=False)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    value_type: Mapped[str] = mapped_column(String(16), nullable=False)
    value: Mapped[Any] = mapped_column(JSONB, nullable=False)
    proposer_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False)
    source_session_id: Mapped[UUID] = mapped_column(nullable=False)
    source_tool_call_id: Mapped[str] = mapped_column(String(255), nullable=False)
    base_revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    assertion_reason: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=FactProposalStatus.PREPARED.value)
    decision_actor_id: Mapped[UUID | None] = mapped_column(ForeignKey("accounts.id", ondelete="RESTRICT"))
    decision_reason: Mapped[str | None] = mapped_column(Text)
    payload_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(255), nullable=False)
    permission_revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    admission_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    admitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ProjectFactRevision(Base):
    """One immutable confirmed value for a typed project field."""

    __tablename__ = "project_fact_revisions"
    __table_args__ = (
        CheckConstraint(_FIELD_KEY_CHECK, name="ck_project_fact_revision_field_key"),
        CheckConstraint(_LABEL_CHECK, name="ck_project_fact_revision_label"),
        CheckConstraint(_VALUE_CHECK, name="ck_project_fact_revision_value"),
        CheckConstraint("content_revision >= 1", name="ck_project_fact_revision_content_revision"),
        ForeignKeyConstraint(
            ("proposal_id", "project_id", "field_key"),
            ("fact_proposals.id", "fact_proposals.project_id", "fact_proposals.field_key"),
            name="fk_project_fact_revision_proposal_identity",
            ondelete="RESTRICT",
        ),
        UniqueConstraint(
            "project_id", "field_key", "content_revision",
            name="uq_project_fact_revision_content_revision",
        ),
        UniqueConstraint("proposal_id", name="uq_project_fact_revision_proposal"),
        UniqueConstraint("id", "project_id", name="uq_project_fact_revision_project_identity"),
        UniqueConstraint(
            "id", "proposal_id", "project_id",
            name="uq_project_fact_revision_proposal_identity",
        ),
        UniqueConstraint(
            "id", "project_id", "field_key", "content_revision",
            name="uq_project_fact_revision_head_identity",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False)
    field_key: Mapped[str] = mapped_column(String(128), nullable=False)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    value_type: Mapped[str] = mapped_column(String(16), nullable=False)
    value: Mapped[Any] = mapped_column(JSONB, nullable=False)
    content_revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    proposal_id: Mapped[UUID] = mapped_column(nullable=False)
    confirmed_by_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ProjectFactHead(Base):
    """The current immutable revision identity for one project field."""

    __tablename__ = "project_fact_heads"
    __table_args__ = (
        CheckConstraint(_FIELD_KEY_CHECK, name="ck_project_fact_head_field_key"),
        CheckConstraint("content_revision >= 1", name="ck_project_fact_head_content_revision"),
        ForeignKeyConstraint(
            ("revision_id", "project_id", "field_key", "content_revision"),
            (
                "project_fact_revisions.id",
                "project_fact_revisions.project_id",
                "project_fact_revisions.field_key",
                "project_fact_revisions.content_revision",
            ),
            name="fk_project_fact_head_revision_identity",
            ondelete="RESTRICT",
        ),
        UniqueConstraint("revision_id", name="uq_project_fact_head_revision"),
    )

    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    field_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    revision_id: Mapped[UUID] = mapped_column(nullable=False)
    content_revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class FactProposalEvidence(Base):
    """An exact admitted citation and immutable chunk range supporting a proposal."""

    __tablename__ = "fact_proposal_evidence"
    __table_args__ = (
        CheckConstraint("citation_id ~ '^\\[资料[1-9][0-9]*\\]$'", name="ck_fact_proposal_evidence_citation_id"),
        CheckConstraint("admission_event_sequence >= 0", name="ck_fact_proposal_evidence_event"),
        CheckConstraint("index_generation >= 1", name="ck_fact_proposal_evidence_generation"),
        CheckConstraint("line_start >= 1 AND line_end >= line_start", name="ck_fact_proposal_evidence_lines"),
        ForeignKeyConstraint(
            ("proposal_id", "project_id", "session_id"),
            ("fact_proposals.id", "fact_proposals.project_id", "fact_proposals.source_session_id"),
            name="fk_fact_proposal_evidence_proposal_identity",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            (
                "session_id", "citation_id", "admission_event_sequence", "artifact_id", "version_id",
                "index_id", "index_generation", "chunk_id",
            ),
            (
                "xagent_admitted_evidence.session_id", "xagent_admitted_evidence.citation_id",
                "xagent_admitted_evidence.admission_event_sequence", "xagent_admitted_evidence.artifact_id",
                "xagent_admitted_evidence.version_id", "xagent_admitted_evidence.index_id",
                "xagent_admitted_evidence.index_generation", "xagent_admitted_evidence.chunk_id",
            ),
            name="fk_fact_proposal_evidence_admitted_identity",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ("chunk_id", "index_id", "line_start", "line_end"),
            (
                "artifact_text_chunks.id", "artifact_text_chunks.index_id",
                "artifact_text_chunks.line_start", "artifact_text_chunks.line_end",
            ),
            name="fk_fact_proposal_evidence_chunk_range",
            ondelete="RESTRICT",
        ),
    )

    proposal_id: Mapped[UUID] = mapped_column(primary_key=True)
    citation_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    project_id: Mapped[UUID] = mapped_column(nullable=False)
    session_id: Mapped[UUID] = mapped_column(nullable=False)
    admission_event_sequence: Mapped[int] = mapped_column(BigInteger, nullable=False)
    artifact_id: Mapped[UUID] = mapped_column(nullable=False)
    version_id: Mapped[UUID] = mapped_column(nullable=False)
    index_id: Mapped[UUID] = mapped_column(nullable=False)
    index_generation: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_id: Mapped[UUID] = mapped_column(nullable=False)
    line_start: Mapped[int] = mapped_column(Integer, nullable=False)
    line_end: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class FactProposalReceipt(Base):
    """A digest-only, short-lived admission receipt bound to exact proposal claims."""

    __tablename__ = "fact_proposal_receipts"
    __table_args__ = (
        CheckConstraint("permission_revision >= 1", name="ck_fact_proposal_receipt_permission_revision"),
        CheckConstraint("source_event_sequence >= 1", name="ck_fact_proposal_receipt_event"),
        CheckConstraint("payload_sha256 ~ '^[0-9a-f]{64}$'", name="ck_fact_proposal_receipt_payload_hash"),
        CheckConstraint(
            "expires_at = issued_at + INTERVAL '5 minutes'",
            name="ck_fact_proposal_receipt_expiry",
        ),
        CheckConstraint(
            "(consumed_at IS NULL AND consumed_event_sequence IS NULL AND consumed_payload_sha256 IS NULL) OR "
            "(consumed_at IS NOT NULL AND consumed_event_sequence IS NOT NULL "
            "AND consumed_event_sequence = source_event_sequence "
            "AND consumed_payload_sha256 = payload_sha256)",
            name="ck_fact_proposal_receipt_consumption",
        ),
        ForeignKeyConstraint(
            (
                "proposal_id", "project_id", "actor_id", "session_id", "tool_call_id",
                "permission_revision", "payload_sha256",
            ),
            (
                "fact_proposals.id", "fact_proposals.project_id", "fact_proposals.proposer_id",
                "fact_proposals.source_session_id", "fact_proposals.source_tool_call_id",
                "fact_proposals.permission_revision", "fact_proposals.payload_sha256",
            ),
            name="fk_fact_proposal_receipt_claims",
            ondelete="CASCADE",
        ),
        UniqueConstraint(
            "session_id", "consumed_event_sequence",
            name="uq_fact_proposal_receipt_consumption",
        ),
    )

    receipt_digest_id: Mapped[UUID] = mapped_column(primary_key=True)
    proposal_id: Mapped[UUID] = mapped_column(nullable=False)
    project_id: Mapped[UUID] = mapped_column(nullable=False)
    actor_id: Mapped[UUID] = mapped_column(nullable=False)
    session_id: Mapped[UUID] = mapped_column(nullable=False)
    tool_call_id: Mapped[str] = mapped_column(String(255), nullable=False)
    permission_revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    source_event_sequence: Mapped[int] = mapped_column(BigInteger, nullable=False)
    payload_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consumed_event_sequence: Mapped[int | None] = mapped_column(BigInteger)
    consumed_payload_sha256: Mapped[str | None] = mapped_column(String(64))


class BusinessOutbox(Base):
    """One replayable Session projection for a terminal Fact proposal."""

    __tablename__ = "business_outbox"
    __table_args__ = (
        CheckConstraint("aggregate_kind = 'fact_proposal'", name="ck_business_outbox_aggregate_kind"),
        CheckConstraint("payload_sha256 ~ '^[0-9a-f]{64}$'", name="ck_business_outbox_payload_hash"),
        CheckConstraint(
            "(consumed_at IS NULL AND consumed_event_sequence IS NULL) OR "
            "(consumed_at IS NOT NULL AND consumed_event_sequence IS NOT NULL AND consumed_event_sequence >= 0)",
            name="ck_business_outbox_consumption",
        ),
        ForeignKeyConstraint(
            ("aggregate_id", "project_id", "source_session_id"),
            ("fact_proposals.id", "fact_proposals.project_id", "fact_proposals.source_session_id"),
            name="fk_business_outbox_fact_proposal_identity",
            ondelete="RESTRICT",
        ),
        UniqueConstraint("aggregate_id", name="uq_business_outbox_fact_proposal"),
        UniqueConstraint("id", "project_id", name="uq_business_outbox_project_identity"),
        UniqueConstraint(
            "id", "aggregate_id", "project_id",
            name="uq_business_outbox_operation_identity",
        ),
        UniqueConstraint(
            "source_session_id", "consumed_event_sequence",
            name="uq_business_outbox_session_event",
        ),
        Index(
            "ix_business_outbox_session_created",
            "source_session_id",
            "created_at",
            "id",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    aggregate_kind: Mapped[str] = mapped_column(String(32), nullable=False, default="fact_proposal")
    aggregate_id: Mapped[UUID] = mapped_column(nullable=False)
    project_id: Mapped[UUID] = mapped_column(nullable=False)
    source_session_id: Mapped[UUID] = mapped_column(nullable=False)
    payload_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consumed_event_sequence: Mapped[int | None] = mapped_column(BigInteger)


class FactOperationIdempotency(Base):
    """An immutable request hash and exact durable identities for one Fact operation."""

    __tablename__ = "fact_operation_idempotency"
    __table_args__ = (
        CheckConstraint(
            "operation IN ('prepare', 'approve', 'reject', 'withdraw', 'outbox_append')",
            name="ck_fact_operation_idempotency_operation",
        ),
        CheckConstraint("request_sha256 ~ '^[0-9a-f]{64}$'", name="ck_fact_operation_idempotency_request_hash"),
        CheckConstraint(
            "response_status IN ('prepared', 'pending', 'confirmed', 'rejected', 'withdrawn', 'conflicted')",
            name="ck_fact_operation_idempotency_response_status",
        ),
        CheckConstraint(
            "operation NOT IN ('prepare', 'approve', 'reject', 'withdraw') OR "
            "(operation = 'prepare' AND response_status = 'prepared') OR "
            "(operation = 'approve' AND response_status IN ('confirmed', 'conflicted')) OR "
            "(operation = 'reject' AND response_status = 'rejected') OR "
            "(operation = 'withdraw' AND response_status = 'withdrawn')",
            name="ck_fact_operation_idempotency_decision_status",
        ),
        CheckConstraint(
            "operation NOT IN ('approve', 'reject', 'withdraw') OR "
            "((response_status = 'confirmed') = (revision_id IS NOT NULL))",
            name="ck_fact_operation_idempotency_revision_identity",
        ),
        CheckConstraint(
            "operation NOT IN ('approve', 'reject', 'withdraw') OR outbox_id IS NOT NULL",
            name="ck_fact_operation_idempotency_outbox_identity",
        ),
        ForeignKeyConstraint(
            ("proposal_id", "project_id"),
            ("fact_proposals.id", "fact_proposals.project_id"),
            name="fk_fact_operation_idempotency_proposal",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ("revision_id", "proposal_id", "project_id"),
            (
                "project_fact_revisions.id",
                "project_fact_revisions.proposal_id",
                "project_fact_revisions.project_id",
            ),
            name="fk_fact_operation_idempotency_revision_proposal",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ("outbox_id", "proposal_id", "project_id"),
            (
                "business_outbox.id",
                "business_outbox.aggregate_id",
                "business_outbox.project_id",
            ),
            name="fk_fact_operation_idempotency_outbox_proposal",
            ondelete="RESTRICT",
        ),
    )

    actor_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id", ondelete="RESTRICT"), primary_key=True)
    operation: Mapped[str] = mapped_column(String(32), primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(255), primary_key=True)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False)
    request_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    proposal_id: Mapped[UUID] = mapped_column(nullable=False)
    response_status: Mapped[str] = mapped_column(String(16), nullable=False)
    revision_id: Mapped[UUID | None] = mapped_column()
    outbox_id: Mapped[UUID | None] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
