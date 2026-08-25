from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Artifact(Base):
    __tablename__ = "artifacts"
    __table_args__ = (
        CheckConstraint("(owner_id IS NOT NULL) <> (project_id IS NOT NULL)", name="ck_artifact_scope"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    created_by_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    owner_id: Mapped[UUID | None] = mapped_column(ForeignKey("accounts.id"))
    project_id: Mapped[UUID | None] = mapped_column(ForeignKey("projects.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ArtifactVersion(Base):
    __tablename__ = "artifact_versions"
    __table_args__ = (
        CheckConstraint("(owner_id IS NOT NULL) <> (project_id IS NOT NULL)", name="ck_artifact_version_scope"),
        CheckConstraint(
            "scan_status IN ('pending', 'scanning', 'clean', 'quarantined', 'failed')",
            name="ck_artifact_version_scan_status",
        ),
        CheckConstraint(
            "(scan_status = 'clean') = (object_key IS NOT NULL)",
            name="ck_artifact_version_clean_object",
        ),
        CheckConstraint("version_number > 0", name="ck_artifact_version_number"),
        CheckConstraint(
            "declared_size BETWEEN 0 AND 52428800",
            name="ck_artifact_version_declared_size",
        ),
        CheckConstraint(
            "actual_size IS NULL OR actual_size BETWEEN 0 AND 52428800",
            name="ck_artifact_version_actual_size",
        ),
        UniqueConstraint("artifact_id", "version_number", name="uq_artifact_version_number"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    artifact_id: Mapped[UUID] = mapped_column(ForeignKey("artifacts.id"), nullable=False)
    owner_id: Mapped[UUID | None] = mapped_column(ForeignKey("accounts.id"))
    project_id: Mapped[UUID | None] = mapped_column(ForeignKey("projects.id"))
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    uploaded_by_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    declared_size: Mapped[int] = mapped_column(Integer, nullable=False)
    actual_size: Mapped[int | None] = mapped_column(Integer)
    detected_content_type: Mapped[str | None] = mapped_column(String(255))
    scan_status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    staging_key: Mapped[str | None] = mapped_column(String(512))
    staging_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    object_key: Mapped[str | None] = mapped_column(String(512), unique=True)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(255))
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ArtifactProcessingJob(Base):
    __tablename__ = "artifact_processing_jobs"
    __table_args__ = (
        CheckConstraint("attempts >= 0", name="ck_artifact_processing_job_attempts"),
        CheckConstraint(
            "status IN ('ready', 'leased', 'succeeded', 'dead')",
            name="ck_artifact_processing_job_status",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    version_id: Mapped[UUID] = mapped_column(ForeignKey("artifact_versions.id"), unique=True, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="ready", nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
    )
    lease_token: Mapped[UUID | None] = mapped_column()
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_code: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class StagingUpload(Base):
    __tablename__ = "staging_uploads"
    __table_args__ = (
        CheckConstraint("(owner_id IS NOT NULL) <> (project_id IS NOT NULL)", name="ck_staging_upload_scope"),
        CheckConstraint(
            "expected_size IS NULL OR expected_size BETWEEN 0 AND 52428800",
            name="ck_staging_upload_expected_size",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    artifact_id: Mapped[UUID | None] = mapped_column(ForeignKey("artifacts.id"))
    created_by_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    expected_size: Mapped[int | None] = mapped_column(Integer)
    owner_id: Mapped[UUID | None] = mapped_column(ForeignKey("accounts.id"))
    project_id: Mapped[UUID | None] = mapped_column(ForeignKey("projects.id"))
    staging_key: Mapped[str] = mapped_column(String(512), unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
