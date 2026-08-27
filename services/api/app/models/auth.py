from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class XAgentAccountCredential(Base):
    __tablename__ = "xagent_account_credentials"

    account_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), primary_key=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    password_changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class XAgentAuthSession(Base):
    __tablename__ = "xagent_auth_sessions"
    __table_args__ = (
        CheckConstraint("expires_at > created_at", name="ck_xagent_auth_session_expiry"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    account_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), nullable=False, index=True)
    jti_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class XAgentPermissionRevision(Base):
    __tablename__ = "xagent_permission_revisions"
    __table_args__ = (
        CheckConstraint("revision >= 1", name="ck_xagent_permission_revision_positive"),
    )

    account_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), primary_key=True)
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False, default=1)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
