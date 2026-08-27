"""Add XAgent account capabilities and project workbench state.

Revision ID: 009_xagent_project_workbench
Revises: 008_xagent_runtime_header
Create Date: 2026-08-25
"""

import sqlalchemy as sa
from alembic import op

revision = "009_xagent_project_workbench"
down_revision = "008_xagent_runtime_header"
branch_labels = None
depends_on = None


def _application_role() -> str:
    role = op.get_context().config.get_main_option("application_role")
    if not role:
        raise RuntimeError("Alembic application_role configuration is required")
    return op.get_bind().dialect.identifier_preparer.quote(role)


def upgrade() -> None:
    op.create_table(
        "xagent_account_capability_grants",
        sa.Column("account_id", sa.UUID(), nullable=False),
        sa.Column("capability", sa.String(length=64), nullable=False),
        sa.Column("granted_by_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint(
            "capability = 'project.create'",
            name="ck_xagent_account_capability_grant_capability",
        ),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["granted_by_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("account_id", "capability"),
    )
    op.create_table(
        "xagent_workbench_preferences",
        sa.Column("account_id", sa.UUID(), nullable=False),
        sa.Column("context_kind", sa.String(length=16), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint(
            "(context_kind = 'workbench' AND project_id IS NULL) "
            "OR (context_kind = 'project' AND project_id IS NOT NULL)",
            name="ck_xagent_workbench_preference_context",
        ),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("account_id"),
    )
    op.execute(
        """
        CREATE FUNCTION public.xagent_capability_manager_grantor()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            grantor_role text;
        BEGIN
            SELECT role::text INTO grantor_role
            FROM public.accounts
            WHERE id = NEW.granted_by_id;

            IF grantor_role IS DISTINCT FROM 'manager' THEN
                RAISE EXCEPTION 'xagent capability grants require a manager grantor'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER xagent_capability_manager_grantor "
        "BEFORE INSERT OR UPDATE OF granted_by_id "
        "ON xagent_account_capability_grants FOR EACH ROW "
        "EXECUTE FUNCTION public.xagent_capability_manager_grantor()"
    )
    op.create_index(
        "ix_xagent_workbench_preferences_project_id",
        "xagent_workbench_preferences",
        ["project_id"],
    )
    op.create_table(
        "xagent_session_project_refs",
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["session_id"], ["xagent_sessions.id"]),
        sa.PrimaryKeyConstraint("session_id", "project_id"),
    )
    op.create_index(
        "ix_xagent_session_project_refs_project_id",
        "xagent_session_project_refs",
        ["project_id"],
    )
    op.execute(
        """
        CREATE FUNCTION public.xagent_private_session_project_ref()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            session_visibility text;
        BEGIN
            SELECT visibility INTO session_visibility
            FROM public.xagent_sessions
            WHERE id = NEW.session_id;

            IF session_visibility IS DISTINCT FROM 'private' THEN
                RAISE EXCEPTION 'xagent project references require a private session'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER xagent_private_session_project_ref "
        "BEFORE INSERT OR UPDATE ON xagent_session_project_refs FOR EACH ROW "
        "EXECUTE FUNCTION public.xagent_private_session_project_ref()"
    )

    op.execute("ALTER TABLE xagent_account_capability_grants ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE xagent_account_capability_grants FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE xagent_session_project_refs ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE xagent_session_project_refs FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE xagent_workbench_preferences ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE xagent_workbench_preferences FORCE ROW LEVEL SECURITY")
    actor_id = "NULLIF(current_setting('app.actor_id', true), '')::uuid"
    capability_scope = f"account_id = {actor_id}"
    project_ref_read_scope = (
        "session_id IN (SELECT id FROM public.xagent_sessions "
        f"WHERE visibility = 'private' AND owner_id = {actor_id})"
    )
    preference_scope = f"account_id = {actor_id}"
    preference_write_scope = (
        f"{preference_scope} AND (project_id IS NULL OR "
        "project_id IN (SELECT public.authorized_project_ids()))"
    )
    op.execute(
        "CREATE POLICY xagent_account_capability_grant_read "
        "ON xagent_account_capability_grants FOR SELECT "
        f"USING ({capability_scope})"
    )
    op.execute(
        "CREATE POLICY xagent_session_project_ref_read "
        "ON xagent_session_project_refs FOR SELECT "
        f"USING ({project_ref_read_scope})"
    )
    op.execute(
        "CREATE POLICY xagent_workbench_preference_read "
        "ON xagent_workbench_preferences FOR SELECT "
        f"USING ({preference_scope})"
    )
    op.execute(
        "CREATE POLICY xagent_workbench_preference_insert "
        "ON xagent_workbench_preferences FOR INSERT "
        f"WITH CHECK ({preference_write_scope})"
    )
    op.execute(
        "CREATE POLICY xagent_workbench_preference_update "
        "ON xagent_workbench_preferences FOR UPDATE "
        f"USING ({preference_scope}) WITH CHECK ({preference_write_scope})"
    )
    application_role = _application_role()
    op.execute(
        "GRANT SELECT ON xagent_account_capability_grants "
        f"TO {application_role}"
    )
    op.execute(
        "GRANT SELECT ON xagent_session_project_refs "
        f"TO {application_role}"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON xagent_workbench_preferences "
        f"TO {application_role}"
    )


def downgrade() -> None:
    application_role = _application_role()
    op.execute(
        "REVOKE ALL PRIVILEGES ON xagent_account_capability_grants "
        f"FROM {application_role}"
    )
    op.execute(
        "REVOKE ALL PRIVILEGES ON xagent_session_project_refs "
        f"FROM {application_role}"
    )
    op.execute(
        "REVOKE ALL PRIVILEGES ON xagent_workbench_preferences "
        f"FROM {application_role}"
    )
    for policy in (
        "xagent_workbench_preference_update",
        "xagent_workbench_preference_insert",
        "xagent_workbench_preference_read",
    ):
        op.execute(f"DROP POLICY {policy} ON xagent_workbench_preferences")
    op.execute("ALTER TABLE xagent_workbench_preferences NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE xagent_workbench_preferences DISABLE ROW LEVEL SECURITY")
    op.execute(
        "DROP POLICY xagent_session_project_ref_read "
        "ON xagent_session_project_refs"
    )
    op.execute("ALTER TABLE xagent_session_project_refs NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE xagent_session_project_refs DISABLE ROW LEVEL SECURITY")
    op.execute(
        "DROP POLICY xagent_account_capability_grant_read "
        "ON xagent_account_capability_grants"
    )
    op.execute("ALTER TABLE xagent_account_capability_grants NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE xagent_account_capability_grants DISABLE ROW LEVEL SECURITY")
    op.execute(
        "DROP TRIGGER xagent_capability_manager_grantor "
        "ON xagent_account_capability_grants"
    )
    op.execute("DROP FUNCTION public.xagent_capability_manager_grantor()")
    op.execute(
        "DROP TRIGGER xagent_private_session_project_ref "
        "ON xagent_session_project_refs"
    )
    op.execute("DROP FUNCTION public.xagent_private_session_project_ref()")
    op.drop_index(
        "ix_xagent_session_project_refs_project_id",
        table_name="xagent_session_project_refs",
    )
    op.drop_table("xagent_session_project_refs")
    op.drop_index(
        "ix_xagent_workbench_preferences_project_id",
        table_name="xagent_workbench_preferences",
    )
    op.drop_table("xagent_workbench_preferences")
    op.drop_table("xagent_account_capability_grants")
