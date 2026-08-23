from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Artifact(Base):
    __tablename__ = "artifacts"
    __table_args__ = (
        CheckConstraint("(owner_id IS NOT NULL) <> (project_id IS NOT NULL)", name="ck_artifact_scope"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    owner_id: Mapped[UUID | None] = mapped_column(ForeignKey("accounts.id"))
    project_id: Mapped[UUID | None] = mapped_column(ForeignKey("projects.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ArtifactVersion(Base):
    __tablename__ = "artifact_versions"
    __table_args__ = (
        CheckConstraint("(owner_id IS NOT NULL) <> (project_id IS NOT NULL)", name="ck_artifact_version_scope"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    artifact_id: Mapped[UUID] = mapped_column(ForeignKey("artifacts.id"), nullable=False)
    owner_id: Mapped[UUID | None] = mapped_column(ForeignKey("accounts.id"))
    project_id: Mapped[UUID | None] = mapped_column(ForeignKey("projects.id"))
    object_key: Mapped[str] = mapped_column(String(512), unique=True, nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(255))
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class StagingUpload(Base):
    __tablename__ = "staging_uploads"
    __table_args__ = (
        CheckConstraint("(owner_id IS NOT NULL) <> (project_id IS NOT NULL)", name="ck_staging_upload_scope"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    created_by_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    owner_id: Mapped[UUID | None] = mapped_column(ForeignKey("accounts.id"))
    project_id: Mapped[UUID | None] = mapped_column(ForeignKey("projects.id"))
    staging_key: Mapped[str] = mapped_column(String(512), unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
