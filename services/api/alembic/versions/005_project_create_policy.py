"""Allow runtime actors to create only their own projects.

Revision ID: 005_project_create_policy
Revises: 004_private_artifacts
Create Date: 2026-08-15
"""

from alembic import op

revision = "005_project_create_policy"
down_revision = "004_private_artifacts"
branch_labels = None
depends_on = None


def _application_role() -> str:
    role = op.get_context().config.get_main_option("application_role")
    if not role:
        raise RuntimeError("Alembic application_role configuration is required")
    return op.get_bind().dialect.identifier_preparer.quote(role)


def upgrade() -> None:
    application_role = _application_role()
    op.execute("DROP POLICY project_read ON projects")
    op.execute(
        """
        CREATE POLICY project_read ON projects
        FOR SELECT USING (
            owner_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
            OR id IN (SELECT public.authorized_project_ids())
        )
        """
    )
    op.execute(
        """
        CREATE POLICY project_insert ON projects
        FOR INSERT WITH CHECK (
            owner_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
        )
        """
    )
    op.execute(f"GRANT INSERT ON projects TO {application_role}")
    op.execute(f"REVOKE UPDATE, DELETE ON projects FROM {application_role}")


def downgrade() -> None:
    application_role = _application_role()
    op.execute(f"REVOKE INSERT ON projects FROM {application_role}")
    op.execute("DROP POLICY project_insert ON projects")
    op.execute("DROP POLICY project_read ON projects")
    op.execute(
        """
        CREATE POLICY project_read ON projects
        FOR SELECT USING (id IN (SELECT public.authorized_project_ids()))
        """
    )
