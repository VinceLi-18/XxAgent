"""Create the identity and project access foundation.

Revision ID: 001_identity_projects
Revises:
Create Date: 2026-08-15
"""

from alembic import op
import sqlalchemy as sa

revision = "001_identity_projects"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "accounts",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint("role IN ('manager', 'specialist')", name="ck_accounts_role"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email"),
    )
    op.create_table(
        "projects",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.ForeignKeyConstraint(["owner_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "project_memberships",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("account_id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "account_id", name="uq_project_membership"),
    )
    op.create_table(
        "temporary_project_grants",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("account_id", sa.UUID(), nullable=False),
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column("granted_by_id", sa.UUID(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("action IN ('read', 'edit')", name="ck_temporary_project_grants_action"),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["granted_by_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "conversation_threads",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=True),
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint("(owner_id IS NOT NULL) <> (project_id IS NOT NULL)", name="ck_conversation_thread_scope"),
        sa.ForeignKeyConstraint(["owner_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "audit_events",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("action", sa.String(length=255), nullable=False),
        sa.Column("resource_type", sa.String(length=100), nullable=False),
        sa.Column("resource_id", sa.UUID(), nullable=False),
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column("result", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.ForeignKeyConstraint(["actor_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_projects_owner_id", "projects", ["owner_id"])
    op.create_index("ix_project_memberships_account_id", "project_memberships", ["account_id"])
    op.create_index("ix_temporary_project_grants_account_id", "temporary_project_grants", ["account_id"])
    op.create_index("ix_conversation_threads_owner_id", "conversation_threads", ["owner_id"])
    op.create_index("ix_conversation_threads_project_id", "conversation_threads", ["project_id"])
    op.create_index("ix_audit_events_actor_id", "audit_events", ["actor_id"])


def downgrade() -> None:
    op.drop_index("ix_audit_events_actor_id", table_name="audit_events")
    op.drop_index("ix_conversation_threads_project_id", table_name="conversation_threads")
    op.drop_index("ix_conversation_threads_owner_id", table_name="conversation_threads")
    op.drop_index("ix_temporary_project_grants_account_id", table_name="temporary_project_grants")
    op.drop_index("ix_project_memberships_account_id", table_name="project_memberships")
    op.drop_index("ix_projects_owner_id", table_name="projects")
    op.drop_table("audit_events")
    op.drop_table("conversation_threads")
    op.drop_table("temporary_project_grants")
    op.drop_table("project_memberships")
    op.drop_table("projects")
    op.drop_table("accounts")
