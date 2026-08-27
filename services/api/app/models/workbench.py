from datetime import datetime
from enum import StrEnum
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class XAgentCapability(StrEnum):
    PROJECT_CREATE = "project.create"


class XAgentAccountCapabilityGrant(Base):
    __tablename__ = "xagent_account_capability_grants"
    __table_args__ = (
        CheckConstraint(
            "capability = 'project.create'",
            name="ck_xagent_account_capability_grant_capability",
        ),
    )

    account_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), primary_key=True)
    capability: Mapped[str] = mapped_column(String(64), primary_key=True)
    granted_by_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class XAgentWorkbenchPreference(Base):
    __tablename__ = "xagent_workbench_preferences"
    __table_args__ = (
        CheckConstraint(
            "(context_kind = 'workbench' AND project_id IS NULL) "
            "OR (context_kind = 'project' AND project_id IS NOT NULL)",
            name="ck_xagent_workbench_preference_context",
        ),
    )

    account_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), primary_key=True)
    context_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    project_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("projects.id"), nullable=True, index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class XAgentSessionProjectRef(Base):
    __tablename__ = "xagent_session_project_refs"

    session_id: Mapped[UUID] = mapped_column(ForeignKey("xagent_sessions.id"), primary_key=True)
    project_id: Mapped[UUID] = mapped_column(
        ForeignKey("projects.id"), primary_key=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
