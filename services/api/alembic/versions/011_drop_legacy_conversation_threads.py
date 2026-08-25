"""Remove the legacy conversation thread storage.

Revision ID: 011_drop_legacy_threads
Revises: 010_xagent_ref_copy
Create Date: 2026-08-25
"""

from alembic import op
import sqlalchemy as sa

revision = "011_drop_legacy_threads"
down_revision = "010_xagent_ref_copy"
branch_labels = None
depends_on = None


def _application_role() -> str:
    role = op.get_context().config.get_main_option("application_role")
    if not role:
        raise RuntimeError("Alembic application_role configuration is required")
    return op.get_bind().dialect.identifier_preparer.quote(role)


def upgrade() -> None:
    op.drop_table("conversation_threads")


def downgrade() -> None:
    application_role = _application_role()
    op.create_table(
        "conversation_threads",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=True),
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint(
            "(owner_id IS NOT NULL) <> (project_id IS NOT NULL)",
            name="ck_conversation_thread_scope",
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_conversation_threads_owner_id",
        "conversation_threads",
        ["owner_id"],
    )
    op.create_index(
        "ix_conversation_threads_project_id",
        "conversation_threads",
        ["project_id"],
    )
    op.execute("ALTER TABLE conversation_threads ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE conversation_threads FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY conversation_thread_read ON conversation_threads
        FOR SELECT USING (
            owner_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
            OR project_id IN (SELECT public.authorized_project_ids())
        )
        """
    )
    op.execute(f"GRANT SELECT ON conversation_threads TO {application_role}")
