"""Add revocable XAgent authentication state.

Revision ID: 006_xagent_auth
Revises: 005_project_create_policy
Create Date: 2026-08-24
"""

import sqlalchemy as sa
from alembic import op

revision = "006_xagent_auth"
down_revision = "005_project_create_policy"
branch_labels = None
depends_on = None


def _application_role() -> str:
    role = op.get_context().config.get_main_option("application_role")
    if not role:
        raise RuntimeError("Alembic application_role configuration is required")
    return op.get_bind().dialect.identifier_preparer.quote(role)


def upgrade() -> None:
    op.execute("CREATE UNIQUE INDEX ux_accounts_email_casefold ON accounts (lower(email))")
    op.create_table(
        "xagent_account_credentials",
        sa.Column("account_id", sa.UUID(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("account_id"),
    )
    op.create_table(
        "xagent_auth_sessions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("account_id", sa.UUID(), nullable=False),
        sa.Column("jti_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("expires_at > created_at", name="ck_xagent_auth_session_expiry"),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("jti_hash"),
    )
    op.create_index("ix_xagent_auth_sessions_account_id", "xagent_auth_sessions", ["account_id"])
    op.create_table(
        "xagent_permission_revisions",
        sa.Column("account_id", sa.UUID(), nullable=False),
        sa.Column("revision", sa.BigInteger(), nullable=False, server_default="1"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint("revision >= 1", name="ck_xagent_permission_revision_positive"),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"]),
        sa.PrimaryKeyConstraint("account_id"),
    )
    op.execute(
        "INSERT INTO xagent_permission_revisions (account_id) "
        "SELECT id FROM accounts"
    )

    op.execute(
        """
        CREATE FUNCTION public.xagent_seed_permission_revision()
        RETURNS trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
        BEGIN
            INSERT INTO public.xagent_permission_revisions (account_id)
            VALUES (NEW.id)
            ON CONFLICT (account_id) DO NOTHING;
            RETURN NEW;
        END
        $$
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.xagent_bump_account_revision()
        RETURNS trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
        BEGIN
            UPDATE public.xagent_permission_revisions
            SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
            WHERE account_id = NEW.id;
            RETURN NEW;
        END
        $$
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.xagent_bump_subject_revision()
        RETURNS trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            old_account_id uuid;
            new_account_id uuid;
        BEGIN
            IF TG_OP <> 'INSERT' THEN
                old_account_id := OLD.account_id;
            END IF;
            IF TG_OP <> 'DELETE' THEN
                new_account_id := NEW.account_id;
            END IF;

            IF old_account_id IS NOT NULL THEN
                UPDATE public.xagent_permission_revisions
                SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
                WHERE account_id = old_account_id;
            END IF;
            IF new_account_id IS NOT NULL AND new_account_id IS DISTINCT FROM old_account_id THEN
                UPDATE public.xagent_permission_revisions
                SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
                WHERE account_id = new_account_id;
            END IF;
            RETURN COALESCE(NEW, OLD);
        END
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER xagent_account_revision_seed
        AFTER INSERT ON accounts
        FOR EACH ROW EXECUTE FUNCTION public.xagent_seed_permission_revision()
        """
    )
    op.execute(
        """
        CREATE TRIGGER xagent_account_revision_update
        AFTER UPDATE OF role, is_active ON accounts
        FOR EACH ROW
        WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.is_active IS DISTINCT FROM NEW.is_active)
        EXECUTE FUNCTION public.xagent_bump_account_revision()
        """
    )
    for table in ("project_memberships", "temporary_project_grants"):
        op.execute(
            f"CREATE TRIGGER xagent_{table}_revision_change "
            f"AFTER INSERT OR UPDATE OR DELETE ON {table} "
            "FOR EACH ROW EXECUTE FUNCTION public.xagent_bump_subject_revision()"
        )

    application_role = _application_role()
    op.execute(f"GRANT SELECT ON xagent_permission_revisions TO {application_role}")
    op.execute(f"REVOKE ALL ON xagent_account_credentials, xagent_auth_sessions FROM {application_role}")


def downgrade() -> None:
    application_role = _application_role()
    op.execute(f"REVOKE ALL ON xagent_permission_revisions FROM {application_role}")
    for table in ("temporary_project_grants", "project_memberships"):
        op.execute(f"DROP TRIGGER xagent_{table}_revision_change ON {table}")
    op.execute("DROP TRIGGER xagent_account_revision_update ON accounts")
    op.execute("DROP TRIGGER xagent_account_revision_seed ON accounts")
    op.execute("DROP FUNCTION public.xagent_bump_subject_revision()")
    op.execute("DROP FUNCTION public.xagent_bump_account_revision()")
    op.execute("DROP FUNCTION public.xagent_seed_permission_revision()")
    op.drop_table("xagent_permission_revisions")
    op.drop_index("ix_xagent_auth_sessions_account_id", table_name="xagent_auth_sessions")
    op.drop_table("xagent_auth_sessions")
    op.drop_table("xagent_account_credentials")
    op.execute("DROP INDEX ux_accounts_email_casefold")
