from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        CheckConstraint(
            "executor_kind IN ('account', 'artifact_worker')",
            name="ck_audit_events_executor_kind",
        ),
        CheckConstraint(
            "index_generation IS NULL OR index_generation >= 1",
            name="ck_audit_event_index_generation",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    action: Mapped[str] = mapped_column(String(255), nullable=False)
    resource_type: Mapped[str] = mapped_column(String(100), nullable=False)
    resource_id: Mapped[UUID] = mapped_column(nullable=False)
    request_id: Mapped[UUID] = mapped_column(nullable=False)
    result: Mapped[str] = mapped_column(String(32), nullable=False)
    executor_kind: Mapped[str] = mapped_column(String(32), default="account", nullable=False)
    artifact_id: Mapped[UUID | None] = mapped_column(nullable=True)
    version_id: Mapped[UUID | None] = mapped_column(nullable=True)
    index_id: Mapped[UUID | None] = mapped_column(nullable=True)
    index_generation: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
