"""Add project-scoped row-level security policies.

Revision ID: 002_project_rls_policies
Revises: 001_identity_projects
Create Date: 2026-08-15
"""

from alembic import op

revision = "002_project_rls_policies"
down_revision = "001_identity_projects"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE FUNCTION authorized_project_ids()
        RETURNS SETOF uuid
        LANGUAGE sql
        STABLE
        AS $$
            SELECT projects.id
            FROM projects
            WHERE current_setting('app.actor_role', true) = 'manager'
               OR (
                    projects.owner_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
                    OR EXISTS (
                        SELECT 1
                        FROM project_memberships
                        WHERE project_memberships.project_id = projects.id
                          AND project_memberships.account_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM temporary_project_grants
                        WHERE temporary_project_grants.project_id = projects.id
                          AND temporary_project_grants.account_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
                          AND temporary_project_grants.action IN ('read', 'edit')
                          AND temporary_project_grants.expires_at > CURRENT_TIMESTAMP
                    )
               )
        $$
        """
    )
    op.execute("ALTER TABLE conversation_threads ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE conversation_threads FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY conversation_thread_read ON conversation_threads
        FOR SELECT USING (
            owner_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
            OR project_id IN (SELECT authorized_project_ids())
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP POLICY conversation_thread_read ON conversation_threads")
    op.execute("ALTER TABLE conversation_threads NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE conversation_threads DISABLE ROW LEVEL SECURITY")
    op.execute("DROP FUNCTION authorized_project_ids()")
