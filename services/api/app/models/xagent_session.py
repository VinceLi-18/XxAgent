from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class XAgentSession(Base):
    __tablename__ = "xagent_sessions"
    __table_args__ = (
        CheckConstraint(
            "(visibility = 'private' AND project_id IS NULL) "
            "OR (visibility = 'project' AND project_id IS NOT NULL)",
            name="ck_xagent_session_scope",
        ),
        CheckConstraint("permission_revision_created >= 1", name="ck_xagent_session_permission_revision"),
        CheckConstraint("last_event_sequence >= -1", name="ck_xagent_session_last_event_sequence"),
        CheckConstraint("version >= 1", name="ck_xagent_session_version"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), nullable=False, index=True)
    project_id: Mapped[UUID | None] = mapped_column(ForeignKey("projects.id"), nullable=True, index=True)
    visibility: Mapped[str] = mapped_column(String(16), nullable=False)
    permission_revision_created: Mapped[int] = mapped_column(BigInteger, nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    runtime_header: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_event_sequence: Mapped[int] = mapped_column(BigInteger, nullable=False, default=-1)
    version: Mapped[int] = mapped_column(BigInteger, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class XAgentSessionEvent(Base):
    __tablename__ = "xagent_session_events"
    __table_args__ = (
        CheckConstraint("sequence >= 0", name="ck_xagent_session_event_sequence"),
        CheckConstraint("schema_version >= 1", name="ck_xagent_session_event_schema_version"),
    )

    session_id: Mapped[UUID] = mapped_column(ForeignKey("xagent_sessions.id"), primary_key=True)
    sequence: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    event_type: Mapped[str] = mapped_column(String(100), nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    tool_call_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    audit_id: Mapped[UUID | None] = mapped_column(ForeignKey("audit_events.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class XAgentIdempotencyKey(Base):
    __tablename__ = "xagent_idempotency_keys"

    actor_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), primary_key=True)
    operation: Mapped[str] = mapped_column(String(100), primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(255), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    result: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
