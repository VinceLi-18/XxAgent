"""Project-owned Business Skill content, immutable publications, and test evidence."""

from datetime import datetime
from enum import Enum
from uuid import UUID, uuid4

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, ForeignKeyConstraint, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class BusinessSkillStatus(str, Enum):
    """Retirement permanently closes a stable Skill."""

    ACTIVE = "active"
    RETIRED = "retired"


class BusinessSkillTestRunStatus(str, Enum):
    """Execution outcome, independent of the human verdict."""

    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class BusinessSkillTestVerdict(str, Enum):
    """Human review of a completed test."""

    PASS = "pass"
    REJECT = "reject"


BUSINESS_SKILL_SLUG_PATTERN = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
BUSINESS_SKILL_MAX_INSTRUCTIONS_BYTES = 64 * 1024
BUSINESS_SKILL_MAX_DESCRIPTION_BYTES = 2 * 1024
BUSINESS_SKILL_TOOL_POLICY_VERSION = 1
BUSINESS_SKILL_PRIMARY_TOOLS = frozenset({
    "list_accessible_projects", "search_artifacts", "propose_fact",
})


class BusinessSkill(Base):
    """Stable project identity; current_version_id selects immutable history."""

    __tablename__ = "business_skills"
    __table_args__ = (
        UniqueConstraint("project_id", "slug", name="uq_business_skill_slug"),
        UniqueConstraint("id", "project_id", name="uq_business_skill_project_identity"),
        CheckConstraint("slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'", name="ck_business_skill_slug"),
        CheckConstraint("octet_length(display_name) BETWEEN 1 AND 255", name="ck_business_skill_display_name"),
        CheckConstraint("status IN ('active', 'retired')", name="ck_business_skill_status"),
        ForeignKeyConstraint(
            ("current_version_id", "id", "project_id"),
            ("business_skill_versions.id", "business_skill_versions.skill_id", "business_skill_versions.project_id"),
            name="fk_business_skill_current_version", use_alter=True, ondelete="RESTRICT",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    project_id: Mapped[UUID] = mapped_column(ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False)
    slug: Mapped[str] = mapped_column(String(128), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    current_version_id: Mapped[UUID | None] = mapped_column()
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="active")
    created_by_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class BusinessSkillDraft(Base):
    """One editable revision per Skill; edits invalidate earlier test digests."""

    __tablename__ = "business_skill_drafts"
    __table_args__ = (
        ForeignKeyConstraint(("skill_id", "project_id"), ("business_skills.id", "business_skills.project_id"), ondelete="RESTRICT"),
        CheckConstraint("revision >= 1", name="ck_business_skill_draft_revision"),
        CheckConstraint("octet_length(description) BETWEEN 1 AND 2048 AND length(btrim(description)) > 0", name="ck_business_skill_draft_description"),
        CheckConstraint("octet_length(instructions) BETWEEN 1 AND 65536 AND length(btrim(instructions)) > 0", name="ck_business_skill_draft_instructions"),
        CheckConstraint("content_digest ~ '^[0-9a-f]{64}$'", name="ck_business_skill_draft_digest"),
        CheckConstraint("public.xagent_valid_business_skill_tools(primary_tools, false)", name="ck_business_skill_draft_tools"),
    )

    skill_id: Mapped[UUID] = mapped_column(primary_key=True)
    project_id: Mapped[UUID] = mapped_column(nullable=False)
    revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    instructions: Mapped[str] = mapped_column(Text, nullable=False)
    primary_tools: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    content_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    edited_by_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class BusinessSkillVersion(Base):
    """An immutable publication with a project-monotonic public version number."""

    __tablename__ = "business_skill_versions"
    __table_args__ = (
        ForeignKeyConstraint(("skill_id", "project_id"), ("business_skills.id", "business_skills.project_id"), ondelete="RESTRICT"),
        UniqueConstraint("id", "skill_id", "project_id", name="uq_business_skill_version_identity"),
        UniqueConstraint("project_id", "version_number", name="uq_business_skill_project_version"),
        CheckConstraint("version_number >= 1 AND source_draft_revision >= 1", name="ck_business_skill_version_revisions"),
        CheckConstraint("octet_length(description) BETWEEN 1 AND 2048 AND length(btrim(description)) > 0", name="ck_business_skill_version_description"),
        CheckConstraint("octet_length(instructions) BETWEEN 1 AND 65536 AND length(btrim(instructions)) > 0", name="ck_business_skill_version_instructions"),
        CheckConstraint("content_digest ~ '^[0-9a-f]{64}$' AND tool_policy_digest ~ '^[0-9a-f]{64}$'", name="ck_business_skill_version_digests"),
        CheckConstraint("public.xagent_valid_business_skill_tools(primary_tools, false) AND public.xagent_valid_business_skill_tools(complete_tools, true)", name="ck_business_skill_version_tools"),
        CheckConstraint("complete_tools - 'skill' - 'submit_cited_answer' = primary_tools AND (complete_tools ? 'submit_cited_answer') = (primary_tools ? 'search_artifacts')", name="ck_business_skill_version_tool_closure"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    skill_id: Mapped[UUID] = mapped_column(nullable=False)
    project_id: Mapped[UUID] = mapped_column(nullable=False)
    version_number: Mapped[int] = mapped_column(BigInteger, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    instructions: Mapped[str] = mapped_column(Text, nullable=False)
    primary_tools: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    complete_tools: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    content_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    tool_policy_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    source_draft_revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    published_by_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class BusinessSkillTestRun(Base):
    """Exact test input identities survive draft editing and terminal settlement."""

    __tablename__ = "business_skill_test_runs"
    __table_args__ = (
        ForeignKeyConstraint(("skill_id", "project_id"), ("business_skills.id", "business_skills.project_id"), ondelete="RESTRICT"),
        ForeignKeyConstraint(("session_id", "project_id"), ("xagent_sessions.id", "xagent_sessions.project_id"), ondelete="RESTRICT"),
        UniqueConstraint("project_id", "run_number", name="uq_business_skill_project_run"),
        UniqueConstraint("session_id", name="uq_business_skill_test_session"),
        CheckConstraint("run_number >= 1 AND draft_revision >= 1", name="ck_business_skill_test_revisions"),
        CheckConstraint("content_digest ~ '^[0-9a-f]{64}$' AND tool_policy_digest ~ '^[0-9a-f]{64}$'", name="ck_business_skill_test_digests"),
        CheckConstraint("status IN ('running','completed','failed','cancelled')", name="ck_business_skill_test_status"),
        CheckConstraint("verdict IS NULL OR verdict IN ('pass','reject')", name="ck_business_skill_test_verdict"),
        CheckConstraint("(status = 'running' AND settled_at IS NULL AND termination_reason IS NULL) OR (status <> 'running' AND settled_at IS NOT NULL AND termination_reason IS NOT NULL)", name="ck_business_skill_test_settlement"),
        CheckConstraint("(verdict IS NULL AND verdict_by_id IS NULL AND verdict_at IS NULL) OR (verdict IS NOT NULL AND verdict_by_id IS NOT NULL AND verdict_at IS NOT NULL AND status <> 'running' AND (verdict <> 'pass' OR status = 'completed'))", name="ck_business_skill_test_verdict_identity"),
        CheckConstraint("termination_reason IS NULL OR termination_reason IN ('completed','failed','cancelled','tool-denied','authorization-denied','skill-not-loaded','service-unavailable')", name="ck_business_skill_test_termination_reason"),
        CheckConstraint("status <> 'completed' OR termination_reason = 'completed'", name="ck_business_skill_test_completed"),
        CheckConstraint("unexecuted_write_tools IN ('[]'::jsonb, '[\"propose_fact\"]'::jsonb)", name="ck_business_skill_test_write_tools"),
        CheckConstraint("public.xagent_valid_business_skill_tools(test_tools, true) AND NOT test_tools ? 'propose_fact' AND (test_tools ? 'search_artifacts') = (test_tools ? 'submit_cited_answer')", name="ck_business_skill_test_tools"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    skill_id: Mapped[UUID] = mapped_column(nullable=False)
    project_id: Mapped[UUID] = mapped_column(nullable=False)
    run_number: Mapped[int] = mapped_column(BigInteger, nullable=False)
    draft_revision: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    tool_policy_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    session_id: Mapped[UUID] = mapped_column(nullable=False)
    unexecuted_write_tools: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    test_tools: Mapped[list[str]] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="running")
    termination_reason: Mapped[str | None] = mapped_column(String(32))
    verdict: Mapped[str | None] = mapped_column(String(16))
    started_by_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False)
    verdict_by_id: Mapped[UUID | None] = mapped_column(ForeignKey("accounts.id", ondelete="RESTRICT"))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    verdict_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class BusinessSkillAuthorization(Base):
    """Effective authorization belongs to a stable Skill, never one version."""

    __tablename__ = "business_skill_authorizations"
    __table_args__ = (
        ForeignKeyConstraint(("skill_id", "project_id"), ("business_skills.id", "business_skills.project_id"), ondelete="RESTRICT"),
        UniqueConstraint("skill_id", name="uq_business_skill_authorization"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    skill_id: Mapped[UUID] = mapped_column(nullable=False)
    project_id: Mapped[UUID] = mapped_column(nullable=False)
    authorized_by_id: Mapped[UUID] = mapped_column(ForeignKey("accounts.id", ondelete="RESTRICT"), nullable=False)
    authorized_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
