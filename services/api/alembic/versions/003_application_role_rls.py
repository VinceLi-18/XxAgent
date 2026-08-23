"""Harden project access policies for the application database role.

Revision ID: 003_application_role_rls
Revises: 002_project_rls_policies
Create Date: 2026-08-15
"""

from alembic import op

revision = "003_application_role_rls"
down_revision = "002_project_rls_policies"
branch_labels = None
depends_on = None


def _application_role() -> str:
    role = op.get_context().config.get_main_option("application_role")
    if not role:
        raise RuntimeError("Alembic application_role configuration is required")
    return op.get_bind().dialect.identifier_preparer.quote(role)


def upgrade() -> None:
    application_role = _application_role()
    op.execute(
        """
        CREATE OR REPLACE FUNCTION public.authorized_project_ids()
        RETURNS SETOF uuid
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
            SELECT projects.id
            FROM public.projects
            WHERE current_setting('app.actor_role', true) = 'manager'
               OR (
                    projects.owner_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
                    OR EXISTS (
                        SELECT 1
                        FROM public.project_memberships
                        WHERE project_memberships.project_id = projects.id
                          AND project_memberships.account_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM public.temporary_project_grants
                        WHERE temporary_project_grants.project_id = projects.id
                          AND temporary_project_grants.account_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
                          AND temporary_project_grants.action IN ('read', 'edit')
                          AND temporary_project_grants.expires_at > CURRENT_TIMESTAMP
                    )
               )
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION public.authorized_project_ids() FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION public.authorized_project_ids() TO {application_role}")

    for table in ("projects", "project_memberships", "temporary_project_grants"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE audit_events FORCE ROW LEVEL SECURITY")

    op.execute(
        """
        CREATE POLICY project_read ON projects
        FOR SELECT USING (id IN (SELECT public.authorized_project_ids()))
        """
    )
    op.execute(
        """
        CREATE POLICY project_membership_read ON project_memberships
        FOR SELECT USING (project_id IN (SELECT public.authorized_project_ids()))
        """
    )
    op.execute(
        """
        CREATE POLICY temporary_project_grant_read ON temporary_project_grants
        FOR SELECT USING (project_id IN (SELECT public.authorized_project_ids()))
        """
    )
    op.execute(
        """
        CREATE POLICY audit_event_read ON audit_events
        FOR SELECT USING (
            actor_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
        )
        """
    )
    op.execute(
        """
        CREATE POLICY audit_event_insert ON audit_events
        FOR INSERT WITH CHECK (
            actor_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
        )
        """
    )

    op.execute(f"REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM {application_role}")
    op.execute(f"REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM {application_role}")
    op.execute(f"GRANT USAGE ON SCHEMA public TO {application_role}")
    op.execute(f"GRANT SELECT (id, role, is_active) ON accounts TO {application_role}")
    op.execute(
        "GRANT SELECT ON projects, project_memberships, temporary_project_grants, "
        f"conversation_threads, audit_events TO {application_role}"
    )
    op.execute(f"GRANT INSERT ON audit_events TO {application_role}")
    op.execute(f"REVOKE UPDATE, DELETE ON audit_events FROM {application_role}")


def downgrade() -> None:
    application_role = _application_role()
    op.execute(f"REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM {application_role}")
    op.execute(f"REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM {application_role}")
    for policy, table in (
        ("audit_event_insert", "audit_events"),
        ("audit_event_read", "audit_events"),
        ("temporary_project_grant_read", "temporary_project_grants"),
        ("project_membership_read", "project_memberships"),
        ("project_read", "projects"),
    ):
        op.execute(f"DROP POLICY {policy} ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
    op.execute(f"REVOKE ALL ON FUNCTION public.authorized_project_ids() FROM {application_role}")
    op.execute("ALTER FUNCTION public.authorized_project_ids() SECURITY INVOKER")
    op.execute("ALTER FUNCTION public.authorized_project_ids() RESET ALL")
    op.execute("GRANT EXECUTE ON FUNCTION public.authorized_project_ids() TO PUBLIC")
