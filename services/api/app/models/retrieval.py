"""Durable retrieval generations, chunks, jobs, heads, and receipts."""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Computed,
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
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ArtifactTextIndex(Base):
    """One complete retrieval generation for an immutable artifact version."""

    __tablename__ = "artifact_text_indexes"
    __table_args__ = (
        CheckConstraint("generation >= 1", name="ck_artifact_text_index_generation"),
        CheckConstraint("vector_dimensions = 1024", name="ck_artifact_text_index_vector_dimensions"),
        CheckConstraint(
            "status IN ('building', 'ready', 'failed')",
            name="ck_artifact_text_index_status",
        ),
        CheckConstraint("chunk_count >= 0", name="ck_artifact_text_index_chunk_count"),
        ForeignKeyConstraint(
            ("version_id", "artifact_id"),
            ("artifact_versions.id", "artifact_versions.artifact_id"),
            name="fk_artifact_text_index_version_artifact",
            ondelete="CASCADE",
        ),
        UniqueConstraint("artifact_id", "generation", name="uq_artifact_text_index_artifact_generation"),
        UniqueConstraint("id", "artifact_id", "version_id", name="uq_artifact_text_index_identity"),
        UniqueConstraint(
            "id", "artifact_id", "version_id", "generation",
            name="uq_artifact_text_index_complete_identity",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    artifact_id: Mapped[UUID] = mapped_column(nullable=False)
    version_id: Mapped[UUID] = mapped_column(nullable=False)
    generation: Mapped[int] = mapped_column(Integer, nullable=False)
    content_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    parser_revision: Mapped[str] = mapped_column(String(128), nullable=False)
    embedding_model: Mapped[str] = mapped_column(String(255), nullable=False)
    embedding_revision: Mapped[str] = mapped_column(String(255), nullable=False)
    vector_dimensions: Mapped[int] = mapped_column(Integer, nullable=False, default=1024)
    configuration_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="building")
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failure_code: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ArtifactTextChunk(Base):
    """A bounded text segment and its dense and lexical retrieval representations."""

    __tablename__ = "artifact_text_chunks"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ck_artifact_text_chunk_ordinal"),
        CheckConstraint("line_start >= 1 AND line_end >= line_start", name="ck_artifact_text_chunk_lines"),
        CheckConstraint("token_count BETWEEN 1 AND 512", name="ck_artifact_text_chunk_token_count"),
        CheckConstraint("octet_length(text) <= 8192", name="ck_artifact_text_chunk_bytes"),
        UniqueConstraint("index_id", "ordinal", name="uq_artifact_text_chunks_index_ordinal"),
        UniqueConstraint("id", "index_id", name="uq_artifact_text_chunk_id_index"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    index_id: Mapped[UUID] = mapped_column(
        ForeignKey("artifact_text_indexes.id", ondelete="CASCADE"), nullable=False
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    line_start: Mapped[int] = mapped_column(Integer, nullable=False)
    line_end: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    token_count: Mapped[int] = mapped_column(Integer, nullable=False)
    text_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    embedding: Mapped[list[float]] = mapped_column(Vector(1024), nullable=False)
    lexical_document: Mapped[Any] = mapped_column(
        TSVECTOR,
        Computed("to_tsvector('simple'::regconfig, text)", persisted=True),
        nullable=False,
    )
    normalized_text: Mapped[str] = mapped_column(Text, Computed("lower(text)", persisted=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ArtifactIndexJob(Base):
    """A durable worker lease for building one retrieval generation."""

    __tablename__ = "artifact_index_jobs"
    __table_args__ = (
        CheckConstraint("attempts BETWEEN 0 AND 5", name="ck_artifact_index_job_attempts"),
        CheckConstraint(
            "status IN ('ready', 'leased', 'succeeded', 'dead')",
            name="ck_artifact_index_job_status",
        ),
        CheckConstraint(
            "(status = 'leased') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)",
            name="ck_artifact_index_job_lease",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    index_id: Mapped[UUID] = mapped_column(
        ForeignKey("artifact_text_indexes.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="ready")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False
    )
    lease_token: Mapped[UUID | None] = mapped_column()
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_code: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ArtifactSearchHead(Base):
    """The one ready retrieval generation currently searchable for an artifact."""

    __tablename__ = "artifact_search_heads"
    __table_args__ = (
        ForeignKeyConstraint(
            ("index_id", "artifact_id", "version_id"),
            (
                "artifact_text_indexes.id",
                "artifact_text_indexes.artifact_id",
                "artifact_text_indexes.version_id",
            ),
            name="fk_artifact_search_head_index_identity",
            ondelete="RESTRICT",
        ),
    )

    artifact_id: Mapped[UUID] = mapped_column(ForeignKey("artifacts.id", ondelete="CASCADE"), primary_key=True)
    index_id: Mapped[UUID] = mapped_column(unique=True, nullable=False)
    version_id: Mapped[UUID] = mapped_column(nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class XAgentRetrievalReceipt(Base):
    """A short-lived record linking retrieval output to one session tool call."""

    __tablename__ = "xagent_retrieval_receipts"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('project_discovery', 'artifact_search')",
            name="ck_xagent_retrieval_receipt_kind",
        ),
        CheckConstraint("permission_revision >= 1", name="ck_xagent_retrieval_receipt_permission_revision"),
        CheckConstraint(
            "expires_at = issued_at + INTERVAL '5 minutes'",
            name="ck_xagent_retrieval_receipt_expiry",
        ),
        CheckConstraint(
            "(citation_ordinal_start IS NULL AND citation_ordinal_end IS NULL) OR "
            "(citation_ordinal_start >= 1 AND citation_ordinal_end >= citation_ordinal_start)",
            name="ck_xagent_retrieval_receipt_citation_ordinals",
        ),
        CheckConstraint(
            "(consumed_at IS NULL AND consumed_event_sequence IS NULL AND consumed_payload_sha256 IS NULL) OR "
            "(consumed_at IS NOT NULL AND consumed_event_sequence IS NOT NULL AND consumed_payload_sha256 IS NOT NULL)",
            name="ck_xagent_retrieval_receipt_consumption",
        ),
        UniqueConstraint("session_id", "consumed_event_sequence", name="uq_xagent_retrieval_receipt_consumption"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    session_id: Mapped[UUID] = mapped_column(ForeignKey("xagent_sessions.id"), nullable=False)
    tool_call_id: Mapped[str] = mapped_column(String(255), nullable=False)
    query_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    scope: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    permission_revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    project_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    index_generations: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False)
    chunk_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    payload_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consumed_event_sequence: Mapped[int | None] = mapped_column(BigInteger)
    consumed_payload_sha256: Mapped[str | None] = mapped_column(String(64))
    citation_ordinal_start: Mapped[int | None] = mapped_column(Integer)
    citation_ordinal_end: Mapped[int | None] = mapped_column(Integer)


class XAgentAdmittedEvidence(Base):
    """One immutable citation identity admitted through a verified retrieval receipt."""

    __tablename__ = "xagent_admitted_evidence"
    __table_args__ = (
        CheckConstraint(
            "citation_id ~ '^\\[资料[1-9][0-9]*\\]$'",
            name="ck_xagent_admitted_evidence_citation_id",
        ),
        CheckConstraint(
            "admission_event_sequence >= 0",
            name="ck_xagent_admitted_evidence_event",
        ),
        CheckConstraint(
            "index_generation >= 1",
            name="ck_xagent_admitted_evidence_index_generation",
        ),
        ForeignKeyConstraint(
            ("session_id", "admission_event_sequence"),
            ("xagent_session_events.session_id", "xagent_session_events.sequence"),
            name="fk_xagent_admitted_evidence_event",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ("index_id", "artifact_id", "version_id", "index_generation"),
            (
                "artifact_text_indexes.id",
                "artifact_text_indexes.artifact_id",
                "artifact_text_indexes.version_id",
                "artifact_text_indexes.generation",
            ),
            name="fk_xagent_admitted_evidence_index_identity",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ("chunk_id", "index_id"),
            ("artifact_text_chunks.id", "artifact_text_chunks.index_id"),
            name="fk_xagent_admitted_evidence_chunk_identity",
            ondelete="RESTRICT",
        ),
        UniqueConstraint(
            "session_id",
            "citation_id",
            "admission_event_sequence",
            "artifact_id",
            "version_id",
            "index_id",
            "index_generation",
            "chunk_id",
            name="uq_xagent_admitted_evidence_identity",
        ),
    )

    session_id: Mapped[UUID] = mapped_column(primary_key=True)
    citation_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    admission_event_sequence: Mapped[int] = mapped_column(BigInteger, nullable=False)
    artifact_id: Mapped[UUID] = mapped_column(nullable=False)
    version_id: Mapped[UUID] = mapped_column(nullable=False)
    index_id: Mapped[UUID] = mapped_column(nullable=False)
    index_generation: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_id: Mapped[UUID] = mapped_column(nullable=False)


class XAgentCitedAnswerEvidence(Base):
    """An immutable link from one cited answer to one admitted citation identity."""

    __tablename__ = "xagent_cited_answer_evidence"
    __table_args__ = (
        CheckConstraint(
            "citation_id ~ '^\\[资料[1-9][0-9]*\\]$'",
            name="ck_xagent_cited_answer_evidence_citation_id",
        ),
        CheckConstraint(
            "admission_event_sequence >= 0 AND answer_event_sequence > admission_event_sequence",
            name="ck_xagent_cited_answer_evidence_event_order",
        ),
        CheckConstraint(
            "index_generation >= 1",
            name="ck_xagent_cited_answer_evidence_index_generation",
        ),
        ForeignKeyConstraint(
            ("session_id", "answer_event_sequence"),
            ("xagent_session_events.session_id", "xagent_session_events.sequence"),
            name="fk_xagent_cited_answer_evidence_answer_event",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            (
                "session_id",
                "citation_id",
                "admission_event_sequence",
                "artifact_id",
                "version_id",
                "index_id",
                "index_generation",
                "chunk_id",
            ),
            (
                "xagent_admitted_evidence.session_id",
                "xagent_admitted_evidence.citation_id",
                "xagent_admitted_evidence.admission_event_sequence",
                "xagent_admitted_evidence.artifact_id",
                "xagent_admitted_evidence.version_id",
                "xagent_admitted_evidence.index_id",
                "xagent_admitted_evidence.index_generation",
                "xagent_admitted_evidence.chunk_id",
            ),
            name="fk_xagent_cited_answer_admitted_evidence",
            ondelete="CASCADE",
        ),
        Index("ix_xagent_cited_answer_evidence_lookup", "session_id", "citation_id"),
    )

    session_id: Mapped[UUID] = mapped_column(primary_key=True)
    answer_event_sequence: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    citation_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    admission_event_sequence: Mapped[int] = mapped_column(BigInteger, nullable=False)
    artifact_id: Mapped[UUID] = mapped_column(nullable=False)
    version_id: Mapped[UUID] = mapped_column(nullable=False)
    index_id: Mapped[UUID] = mapped_column(nullable=False)
    index_generation: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_id: Mapped[UUID] = mapped_column(nullable=False)


class XAgentDelegationNonce(Base):
    """A durable digest proving one delegation nonce was consumed once."""

    __tablename__ = "xagent_delegation_nonces"
    __table_args__ = (
        CheckConstraint(
            "nonce_sha256 ~ '^[0-9a-f]{64}$'",
            name="ck_xagent_delegation_nonce_digest",
        ),
        CheckConstraint(
            "expires_at > consumed_at",
            name="ck_xagent_delegation_nonce_expiry",
        ),
    )

    nonce_sha256: Mapped[str] = mapped_column(String(64), primary_key=True)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
