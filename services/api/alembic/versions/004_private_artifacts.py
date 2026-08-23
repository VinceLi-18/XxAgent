"""Add private artifact staging and versions.

Revision ID: 004_private_artifacts
Revises: 003_application_role_rls
Create Date: 2026-08-15
"""

import sqlalchemy as sa
from alembic import op

revision = "004_private_artifacts"
down_revision = "003_application_role_rls"
branch_labels = None
depends_on = None


def _application_role() -> str:
    role = op.get_context().config.get_main_option("application_role")
    if not role:
        raise RuntimeError("Alembic application_role configuration is required")
    return op.get_bind().dialect.identifier_preparer.quote(role)


def upgrade() -> None:
    op.create_table(
        "artifacts",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=True),
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint("(owner_id IS NOT NULL) <> (project_id IS NOT NULL)", name="ck_artifact_scope"),
        sa.ForeignKeyConstraint(["owner_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "artifact_versions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("artifact_id", sa.UUID(), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=True),
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column("object_key", sa.String(length=512), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("content_type", sa.String(length=255), nullable=True),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint("(owner_id IS NOT NULL) <> (project_id IS NOT NULL)", name="ck_artifact_version_scope"),
        sa.ForeignKeyConstraint(["artifact_id"], ["artifacts.id"]),
        sa.ForeignKeyConstraint(["owner_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("object_key"),
    )
    op.create_table(
        "staging_uploads",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("created_by_id", sa.UUID(), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=True),
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column("staging_key", sa.String(length=512), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.CheckConstraint("(owner_id IS NOT NULL) <> (project_id IS NOT NULL)", name="ck_staging_upload_scope"),
        sa.ForeignKeyConstraint(["created_by_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["owner_id"], ["accounts.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("staging_key"),
    )

    for table in ("artifacts", "artifact_versions", "staging_uploads"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")

    scope = "owner_id = NULLIF(current_setting('app.actor_id', true), '')::uuid OR project_id IN (SELECT public.authorized_project_ids())"
    for table in ("artifacts", "artifact_versions"):
        op.execute(f"CREATE POLICY {table}_read ON {table} FOR SELECT USING ({scope})")
        op.execute(f"CREATE POLICY {table}_insert ON {table} FOR INSERT WITH CHECK ({scope})")
    staging_scope = "created_by_id = NULLIF(current_setting('app.actor_id', true), '')::uuid"
    staging_insert_scope = (
        f"{staging_scope} AND ("
        "owner_id = NULLIF(current_setting('app.actor_id', true), '')::uuid "
        "OR project_id IN (SELECT public.authorized_project_ids())"
        ")"
    )
    op.execute(f"CREATE POLICY staging_uploads_read ON staging_uploads FOR SELECT USING ({staging_scope} AND expires_at > CURRENT_TIMESTAMP)")
    op.execute(f"CREATE POLICY staging_uploads_insert ON staging_uploads FOR INSERT WITH CHECK ({staging_insert_scope})")
    op.execute(f"CREATE POLICY staging_uploads_delete ON staging_uploads FOR DELETE USING ({staging_scope})")

    application_role = _application_role()
    op.execute(f"GRANT SELECT, INSERT ON artifacts, artifact_versions, staging_uploads TO {application_role}")
    op.execute(f"GRANT DELETE ON staging_uploads TO {application_role}")


def downgrade() -> None:
    application_role = _application_role()
    op.execute(f"REVOKE ALL PRIVILEGES ON artifacts, artifact_versions, staging_uploads FROM {application_role}")
    for table, policies in (
        ("staging_uploads", ("staging_uploads_delete", "staging_uploads_insert", "staging_uploads_read")),
        ("artifact_versions", ("artifact_versions_insert", "artifact_versions_read")),
        ("artifacts", ("artifacts_insert", "artifacts_read")),
    ):
        for policy in policies:
            op.execute(f"DROP POLICY {policy} ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
    op.drop_table("staging_uploads")
    op.drop_table("artifact_versions")
    op.drop_table("artifacts")
