"""Add durable XAgent sessions and append-only events.

Revision ID: 007_xagent_sessions
Revises: 006_xagent_auth
Create Date: 2026-08-24
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "007_xagent_sessions"
down_revision = "006_xagent_auth"
branch_labels = None
depends_on = None


def _application_role() -> str:
    role = op.get_context().config.get_main_option("application_role")
    if not role:
        raise RuntimeError("Alembic application_role configuration is required")
    return op.get_bind().dialect.identifier_preparer.quote(role)


def upgrade() -> None:
    op.create_table(
        "xagent_sessions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=False),
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column("visibility", sa.String(length=16), nullable=False),
        sa.Column("permission_revision_created", sa.BigInteger(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("last_event_sequence", sa.BigInteger(), nullable=False, server_default="-1"),
        sa.Column("version", sa.BigInteger(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint(
            "(visibility = 'private' AND project_id IS NULL) "
            "OR (visibility = 'project' AND project_id IS NOT NULL)",
            name="ck_xagent_session_scope",
        ),
        sa.CheckConstraint("permission_revision_created >= 1", name="ck_xagent_session_permission_revision"),
        sa.CheckConstraint("last_event_sequence >= -1", name="ck_xagent_session_last_event_sequence"),
        sa.CheckConstraint("version >= 1", name="ck_xagent_session_version"),
        sa.ForeignKeyConstraint(["owner_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_xagent_sessions_owner_id", "xagent_sessions", ["owner_id"])
    op.create_index("ix_xagent_sessions_project_id", "xagent_sessions", ["project_id"])
    op.create_table(
        "xagent_session_events",
        sa.Column("session_id", sa.UUID(), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("event_type", sa.String(length=100), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("tool_call_id", sa.String(length=255), nullable=True),
        sa.Column("audit_id", sa.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint("sequence >= 0", name="ck_xagent_session_event_sequence"),
        sa.CheckConstraint("schema_version >= 1", name="ck_xagent_session_event_schema_version"),
        sa.ForeignKeyConstraint(["actor_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["audit_id"], ["audit_events.id"]),
        sa.ForeignKeyConstraint(["session_id"], ["xagent_sessions.id"]),
        sa.PrimaryKeyConstraint("session_id", "sequence"),
    )
    op.create_table(
        "xagent_idempotency_keys",
        sa.Column("actor_id", sa.UUID(), nullable=False),
        sa.Column("operation", sa.String(length=100), nullable=False),
        sa.Column("idempotency_key", sa.String(length=255), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["actor_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("actor_id", "operation", "idempotency_key"),
    )

    op.execute(
        """
        CREATE FUNCTION public.xagent_authorized_project_edit_ids()
        RETURNS SETOF uuid
        LANGUAGE sql
        STABLE
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
            SELECT projects.id
            FROM public.projects
            WHERE current_setting('app.actor_role', true) = 'manager'
               OR projects.owner_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
               OR EXISTS (
                    SELECT 1 FROM public.project_memberships
                    WHERE project_memberships.project_id = projects.id
                      AND project_memberships.account_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
               )
               OR EXISTS (
                    SELECT 1 FROM public.temporary_project_grants
                    WHERE temporary_project_grants.project_id = projects.id
                      AND temporary_project_grants.account_id = NULLIF(current_setting('app.actor_id', true), '')::uuid
                      AND temporary_project_grants.action = 'edit'
                      AND temporary_project_grants.expires_at > CURRENT_TIMESTAMP
               )
        $$
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.xagent_session_scope_immutable()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        BEGIN
            IF OLD.owner_id IS DISTINCT FROM NEW.owner_id
               OR OLD.project_id IS DISTINCT FROM NEW.project_id
               OR OLD.visibility IS DISTINCT FROM NEW.visibility THEN
                RAISE EXCEPTION 'xagent session scope is immutable' USING ERRCODE = '23514';
            END IF;
            NEW.updated_at := CURRENT_TIMESTAMP;
            RETURN NEW;
        END
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER xagent_session_scope_immutable "
        "BEFORE UPDATE ON xagent_sessions FOR EACH ROW "
        "EXECUTE FUNCTION public.xagent_session_scope_immutable()"
    )

    for table in ("xagent_sessions", "xagent_session_events", "xagent_idempotency_keys"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")

    actor_id = "NULLIF(current_setting('app.actor_id', true), '')::uuid"
    session_read = (
        f"(visibility = 'private' AND owner_id = {actor_id}) OR "
        "(visibility = 'project' AND project_id IN (SELECT public.authorized_project_ids()))"
    )
    session_insert = (
        f"owner_id = {actor_id} AND ((visibility = 'private' AND project_id IS NULL) OR "
        "(visibility = 'project' AND project_id IN (SELECT public.xagent_authorized_project_edit_ids())))"
    )
    session_write = (
        f"(visibility = 'private' AND owner_id = {actor_id}) OR "
        "(visibility = 'project' AND project_id IN (SELECT public.xagent_authorized_project_edit_ids()))"
    )
    event_read = "session_id IN (SELECT id FROM public.xagent_sessions)"
    event_write = (
        f"actor_id = {actor_id} AND session_id IN ("
        "SELECT id FROM public.xagent_sessions WHERE "
        f"(visibility = 'private' AND owner_id = {actor_id}) OR "
        "(visibility = 'project' AND project_id IN (SELECT public.xagent_authorized_project_edit_ids())))"
    )
    idempotency_scope = f"actor_id = {actor_id}"

    op.execute(f"CREATE POLICY xagent_session_read ON xagent_sessions FOR SELECT USING ({session_read})")
    op.execute(f"CREATE POLICY xagent_session_insert ON xagent_sessions FOR INSERT WITH CHECK ({session_insert})")
    op.execute(f"CREATE POLICY xagent_session_update ON xagent_sessions FOR UPDATE USING ({session_write}) WITH CHECK ({session_write})")
    op.execute(f"CREATE POLICY xagent_session_event_read ON xagent_session_events FOR SELECT USING ({event_read})")
    op.execute(f"CREATE POLICY xagent_session_event_insert ON xagent_session_events FOR INSERT WITH CHECK ({event_write})")
    op.execute(f"CREATE POLICY xagent_idempotency_read ON xagent_idempotency_keys FOR SELECT USING ({idempotency_scope})")
    op.execute(f"CREATE POLICY xagent_idempotency_insert ON xagent_idempotency_keys FOR INSERT WITH CHECK ({idempotency_scope})")
    op.execute(f"CREATE POLICY xagent_idempotency_update ON xagent_idempotency_keys FOR UPDATE USING ({idempotency_scope}) WITH CHECK ({idempotency_scope})")

    application_role = _application_role()
    op.execute("REVOKE ALL ON FUNCTION public.xagent_authorized_project_edit_ids() FROM PUBLIC")
    op.execute(f"GRANT EXECUTE ON FUNCTION public.xagent_authorized_project_edit_ids() TO {application_role}")
    op.execute(f"GRANT SELECT, INSERT, UPDATE ON xagent_sessions TO {application_role}")
    op.execute(f"GRANT SELECT, INSERT ON xagent_session_events TO {application_role}")
    op.execute(f"GRANT SELECT, INSERT, UPDATE ON xagent_idempotency_keys TO {application_role}")


def downgrade() -> None:
    application_role = _application_role()
    op.execute(
        f"REVOKE ALL PRIVILEGES ON xagent_sessions, xagent_session_events, "
        f"xagent_idempotency_keys FROM {application_role}"
    )
    op.execute(f"REVOKE ALL ON FUNCTION public.xagent_authorized_project_edit_ids() FROM {application_role}")
    for table, policies in (
        ("xagent_idempotency_keys", ("xagent_idempotency_update", "xagent_idempotency_insert", "xagent_idempotency_read")),
        ("xagent_session_events", ("xagent_session_event_insert", "xagent_session_event_read")),
        ("xagent_sessions", ("xagent_session_update", "xagent_session_insert", "xagent_session_read")),
    ):
        for policy in policies:
            op.execute(f"DROP POLICY {policy} ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
    op.execute("DROP TRIGGER xagent_session_scope_immutable ON xagent_sessions")
    op.execute("DROP FUNCTION public.xagent_session_scope_immutable()")
    op.execute("DROP FUNCTION public.xagent_authorized_project_edit_ids()")
    op.drop_table("xagent_idempotency_keys")
    op.drop_table("xagent_session_events")
    op.drop_index("ix_xagent_sessions_project_id", table_name="xagent_sessions")
    op.drop_index("ix_xagent_sessions_owner_id", table_name="xagent_sessions")
    op.drop_table("xagent_sessions")
