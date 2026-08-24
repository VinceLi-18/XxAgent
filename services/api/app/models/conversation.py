from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ConversationThread(Base):
    __tablename__ = "conversation_threads"
    __table_args__ = (
        CheckConstraint(
            "(owner_id IS NOT NULL) <> (project_id IS NOT NULL)",
            name="ck_conversation_thread_scope",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    owner_id: Mapped[UUID | None] = mapped_column(ForeignKey("accounts.id"), nullable=True)
    project_id: Mapped[UUID | None] = mapped_column(ForeignKey("projects.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
