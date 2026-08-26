"""Add the XAgent artifact processing lifecycle.

Revision ID: 012_xagent_artifact_lifecycle
Revises: 011_drop_legacy_threads
Create Date: 2026-08-25
"""

import sqlalchemy as sa
from alembic import op

revision = "012_xagent_artifact_lifecycle"
down_revision = "011_drop_legacy_threads"
branch_labels = None
depends_on = None


def _configured_role(option: str) -> str:
    role = op.get_context().config.get_main_option(option)
    if not role:
        raise RuntimeError(f"Alembic {option} configuration is required")
    return op.get_bind().dialect.identifier_preparer.quote(role)


def upgrade() -> None:
    application_role = _configured_role("application_role")
    worker_role = _configured_role("worker_role")

    op.add_column("staging_uploads", sa.Column("artifact_id", sa.UUID(), nullable=True))
    op.add_column("staging_uploads", sa.Column("expected_size", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_staging_uploads_artifact_id_artifacts",
        "staging_uploads",
        "artifacts",
        ["artifact_id"],
        ["id"],
    )
    op.create_check_constraint(
        "ck_staging_upload_expected_size",
        "staging_uploads",
        "expected_size IS NULL OR expected_size BETWEEN 0 AND 52428800",
    )
    actor_id = "NULLIF(current_setting('app.actor_id', true), '')::uuid"
    staging_scope = (
        f"staging_uploads.owner_id = {actor_id} OR staging_uploads.project_id IN "
        "(SELECT public.xagent_authorized_project_edit_ids())"
    )
    matching_artifact = (
        "staging_uploads.artifact_id IS NULL OR EXISTS ("
        "SELECT 1 FROM artifacts WHERE artifacts.id = staging_uploads.artifact_id "
        "AND artifacts.owner_id IS NOT DISTINCT FROM staging_uploads.owner_id "
        "AND artifacts.project_id IS NOT DISTINCT FROM staging_uploads.project_id)"
    )
    op.execute("DROP POLICY staging_uploads_insert ON staging_uploads")
    op.execute(
        f"CREATE POLICY staging_uploads_insert ON staging_uploads FOR INSERT "
        f"TO {application_role} WITH CHECK ("
        f"staging_uploads.created_by_id = {actor_id} "
        "AND staging_uploads.expected_size BETWEEN 0 AND 52428800 "
        f"AND ({staging_scope}) AND ({matching_artifact}))"
    )

    op.add_column("artifacts", sa.Column("created_by_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "fk_artifacts_created_by_id_accounts",
        "artifacts",
        "accounts",
        ["created_by_id"],
        ["id"],
    )

    for column in (
        sa.Column("version_number", sa.Integer(), nullable=True),
        sa.Column("original_filename", sa.String(length=255), nullable=True),
        sa.Column("uploaded_by_id", sa.UUID(), nullable=True),
        sa.Column("declared_size", sa.Integer(), nullable=True),
        sa.Column("actual_size", sa.Integer(), nullable=True),
        sa.Column("detected_content_type", sa.String(length=255), nullable=True),
        sa.Column("scan_status", sa.String(length=16), nullable=True),
        sa.Column("staging_key", sa.String(length=512), nullable=True),
        sa.Column("staging_etag", sa.String(length=255), nullable=True),
        sa.Column("staging_expires_at", sa.DateTime(timezone=True), nullable=True),
    ):
        op.add_column("artifact_versions", column)
    op.create_foreign_key(
        "fk_artifact_versions_uploaded_by_id_accounts",
        "artifact_versions",
        "accounts",
        ["uploaded_by_id"],
        ["id"],
    )
    op.alter_column("artifact_versions", "object_key", existing_type=sa.String(length=512), nullable=True)

    op.add_column(
        "audit_events",
        sa.Column("executor_kind", sa.String(length=32), nullable=True),
    )

    op.execute(
        """
        UPDATE artifacts
        SET created_by_id = COALESCE(
            owner_id,
            (SELECT projects.owner_id FROM projects WHERE projects.id = artifacts.project_id)
        )
        """
    )
    op.execute(
        """
        WITH numbered AS (
            SELECT id, row_number() OVER (
                PARTITION BY artifact_id ORDER BY created_at, id
            ) AS version_number
            FROM artifact_versions
        )
        UPDATE artifact_versions AS versions
        SET version_number = numbered.version_number,
            original_filename = artifacts.filename,
            uploaded_by_id = artifacts.created_by_id,
            declared_size = versions.size,
            actual_size = versions.size,
            detected_content_type = versions.content_type,
            scan_status = 'clean'
        FROM numbered, artifacts
        WHERE versions.id = numbered.id
          AND versions.artifact_id = artifacts.id
        """
    )
    op.execute("UPDATE audit_events SET executor_kind = 'account'")
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM artifacts WHERE created_by_id IS NULL) THEN
                RAISE EXCEPTION 'artifact creator backfill left NULL rows';
            END IF;
            IF EXISTS (
                SELECT 1 FROM artifact_versions
                WHERE version_number IS NULL
                   OR original_filename IS NULL
                   OR uploaded_by_id IS NULL
                   OR declared_size IS NULL
                   OR scan_status IS NULL
            ) THEN
                RAISE EXCEPTION 'artifact version lifecycle backfill left NULL rows';
            END IF;
            IF EXISTS (SELECT 1 FROM audit_events WHERE executor_kind IS NULL) THEN
                RAISE EXCEPTION 'audit executor backfill left NULL rows';
            END IF;
        END
        $$
        """
    )

    op.alter_column("artifacts", "created_by_id", existing_type=sa.UUID(), nullable=False)
    for column_name, column_type in (
        ("version_number", sa.Integer()),
        ("original_filename", sa.String(length=255)),
        ("uploaded_by_id", sa.UUID()),
        ("declared_size", sa.Integer()),
        ("scan_status", sa.String(length=16)),
    ):
        op.alter_column(
            "artifact_versions",
            column_name,
            existing_type=column_type,
            nullable=False,
        )
    op.alter_column(
        "audit_events",
        "executor_kind",
        existing_type=sa.String(length=32),
        nullable=False,
        server_default=sa.text("'account'"),
    )

    op.create_unique_constraint(
        "uq_artifact_version_number",
        "artifact_versions",
        ["artifact_id", "version_number"],
    )
    op.create_check_constraint(
        "ck_artifact_version_number",
        "artifact_versions",
        "version_number > 0",
    )
    op.create_check_constraint(
        "ck_artifact_version_declared_size",
        "artifact_versions",
        "declared_size BETWEEN 0 AND 52428800",
    )
    op.create_check_constraint(
        "ck_artifact_version_actual_size",
        "artifact_versions",
        "actual_size IS NULL OR actual_size BETWEEN 0 AND 52428800",
    )
    op.create_check_constraint(
        "ck_artifact_version_scan_status",
        "artifact_versions",
        "scan_status IN ('pending', 'scanning', 'clean', 'quarantined', 'failed')",
    )
    op.create_check_constraint(
        "ck_artifact_version_clean_object",
        "artifact_versions",
        "(scan_status = 'clean') = (object_key IS NOT NULL)",
    )
    op.create_check_constraint(
        "ck_audit_events_executor_kind",
        "audit_events",
        "executor_kind IN ('account', 'artifact_worker')",
    )
    op.execute(
        """
        CREATE FUNCTION public.enforce_artifact_scan_status_transition()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF NEW.scan_status = OLD.scan_status THEN
                RETURN NEW;
            END IF;
            IF OLD.scan_status = 'pending' AND NEW.scan_status = 'scanning' THEN
                RETURN NEW;
            END IF;
            IF OLD.scan_status = 'failed' AND NEW.scan_status = 'pending' THEN
                RETURN NEW;
            END IF;
            IF OLD.scan_status = 'scanning'
               AND NEW.scan_status IN ('clean', 'quarantined', 'failed') THEN
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'invalid artifact scan status transition: % -> %',
                OLD.scan_status, NEW.scan_status;
        END
        $$
        """
    )
    op.execute(
        "CREATE TRIGGER artifact_version_scan_status_transition "
        "BEFORE UPDATE OF scan_status ON artifact_versions FOR EACH ROW "
        "EXECUTE FUNCTION public.enforce_artifact_scan_status_transition()"
    )

    op.create_table(
        "artifact_processing_jobs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("version_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default=sa.text("'ready'")),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_token", sa.UUID(), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_code", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint("attempts >= 0", name="ck_artifact_processing_job_attempts"),
        sa.CheckConstraint(
            "status IN ('ready', 'leased', 'succeeded', 'dead')",
            name="ck_artifact_processing_job_status",
        ),
        sa.ForeignKeyConstraint(["version_id"], ["artifact_versions.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("version_id"),
    )
    op.execute("ALTER TABLE artifact_processing_jobs ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE artifact_processing_jobs FORCE ROW LEVEL SECURITY")
    op.create_table(
        "artifact_object_cleanup_jobs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("object_key", sa.String(length=512), nullable=False),
        sa.Column("version_id", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default=sa.text("'ready'")),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_token", sa.UUID(), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_code", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint(
            "object_key ~ '^artifacts/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
            "[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-"
            "[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'",
            name="ck_artifact_object_cleanup_job_object_key",
        ),
        sa.CheckConstraint(
            "length(btrim(version_id)) > 0",
            name="ck_artifact_object_cleanup_job_version_id",
        ),
        sa.CheckConstraint(
            "attempts BETWEEN 0 AND 5",
            name="ck_artifact_object_cleanup_job_attempts",
        ),
        sa.CheckConstraint(
            "status IN ('ready', 'leased', 'succeeded', 'dead')",
            name="ck_artifact_object_cleanup_job_status",
        ),
        sa.CheckConstraint(
            "(status = 'leased') = "
            "(lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)",
            name="ck_artifact_object_cleanup_job_lease",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "object_key",
            "version_id",
            name="uq_artifact_object_cleanup_job_identity",
        ),
    )
    op.execute("ALTER TABLE artifact_object_cleanup_jobs ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE artifact_object_cleanup_jobs FORCE ROW LEVEL SECURITY")

    artifact_scope = (
        "owner_id = NULLIF(current_setting('app.actor_id', true), '')::uuid "
        "OR project_id IN (SELECT public.authorized_project_ids())"
    )
    artifact_edit_scope = (
        "owner_id = NULLIF(current_setting('app.actor_id', true), '')::uuid "
        "OR project_id IN (SELECT public.xagent_authorized_project_edit_ids())"
    )
    op.execute("DROP POLICY artifacts_insert ON artifacts")
    op.execute(
        f"CREATE POLICY artifacts_insert ON artifacts FOR INSERT TO {application_role} "
        "WITH CHECK (created_by_id = "
        "NULLIF(current_setting('app.actor_id', true), '')::uuid "
        f"AND ({artifact_scope}))"
    )
    op.execute("DROP POLICY artifact_versions_insert ON artifact_versions")
    op.execute(
        f"CREATE POLICY artifact_versions_insert ON artifact_versions "
        f"FOR INSERT TO {application_role} "
        "WITH CHECK (uploaded_by_id = "
        "NULLIF(current_setting('app.actor_id', true), '')::uuid "
        f"AND ({artifact_scope}))"
    )
    op.execute(
        f"CREATE POLICY application_job_insert ON artifact_processing_jobs "
        f"FOR INSERT TO {application_role} WITH CHECK ("
        "status = 'ready' AND attempts = 0 "
        "AND lease_token IS NULL AND lease_expires_at IS NULL "
        "AND failure_code IS NULL AND EXISTS ("
        "SELECT 1 FROM artifact_versions "
        "WHERE artifact_versions.id = artifact_processing_jobs.version_id "
        "AND artifact_versions.scan_status = 'pending' "
        f"AND ({artifact_edit_scope})))"
    )
    op.execute(
        """
        CREATE FUNCTION public.retry_artifact_version(p_version_id uuid)
        RETURNS TABLE(result text, artifact_id uuid, version_id uuid)
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public
        AS $$
        DECLARE
            version_record public.artifact_versions%ROWTYPE;
            actor_id uuid := NULLIF(current_setting('app.actor_id', true), '')::uuid;
        BEGIN
            IF actor_id IS NULL THEN
                RETURN QUERY SELECT 'not-found'::text, NULL::uuid, NULL::uuid;
                RETURN;
            END IF;

            SELECT artifact_versions.*
            INTO version_record
            FROM public.artifact_versions
            WHERE artifact_versions.id = p_version_id
            FOR UPDATE;

            IF NOT FOUND
               OR NOT (
                    version_record.owner_id = actor_id
                    OR version_record.project_id IN (
                        SELECT public.xagent_authorized_project_edit_ids()
                    )
               )
               OR version_record.scan_status <> 'failed' THEN
                RETURN QUERY SELECT 'not-found'::text, NULL::uuid, NULL::uuid;
                RETURN;
            END IF;

            IF version_record.staging_key IS NULL
               OR version_record.staging_etag IS NULL
               OR version_record.staging_expires_at IS NULL
               OR version_record.staging_expires_at <= CURRENT_TIMESTAMP
               OR version_record.actual_size IS NULL THEN
                RETURN QUERY SELECT 'upload-expired'::text, NULL::uuid, NULL::uuid;
                RETURN;
            END IF;

            UPDATE public.artifact_versions
            SET scan_status = 'pending'
            WHERE id = version_record.id;

            UPDATE public.artifact_processing_jobs
            SET status = 'ready',
                attempts = 0,
                next_attempt_at = CURRENT_TIMESTAMP,
                lease_token = NULL,
                lease_expires_at = NULL,
                failure_code = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE artifact_processing_jobs.version_id = version_record.id;

            IF NOT FOUND THEN
                INSERT INTO public.artifact_processing_jobs (
                    id,
                    version_id,
                    status,
                    attempts,
                    next_attempt_at
                ) VALUES (
                    gen_random_uuid(),
                    version_record.id,
                    'ready',
                    0,
                    CURRENT_TIMESTAMP
                );
            END IF;

            RETURN QUERY SELECT
                'allowed'::text,
                version_record.artifact_id,
                version_record.id;
        END
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION public.retry_artifact_version(uuid) FROM PUBLIC")
    op.execute(
        f"GRANT EXECUTE ON FUNCTION public.retry_artifact_version(uuid) TO {application_role}"
    )
    op.execute(
        f"CREATE POLICY artifact_worker_job_read ON artifact_processing_jobs "
        f"FOR SELECT TO {worker_role} USING (true)"
    )
    op.execute(
        f"CREATE POLICY artifact_worker_job_update ON artifact_processing_jobs "
        f"FOR UPDATE TO {worker_role} USING (true) WITH CHECK (true)"
    )
    op.execute(
        f"CREATE POLICY artifact_worker_cleanup_insert ON artifact_object_cleanup_jobs "
        f"FOR INSERT TO {worker_role} WITH CHECK (status = 'ready' AND attempts = 0 "
        "AND lease_token IS NULL AND lease_expires_at IS NULL AND failure_code IS NULL)"
    )
    op.execute(
        f"CREATE POLICY artifact_worker_cleanup_read ON artifact_object_cleanup_jobs "
        f"FOR SELECT TO {worker_role} USING (true)"
    )
    op.execute(
        f"CREATE POLICY artifact_worker_cleanup_update ON artifact_object_cleanup_jobs "
        f"FOR UPDATE TO {worker_role} USING (true) WITH CHECK (true)"
    )
    op.execute(
        f"CREATE POLICY artifact_worker_version_read ON artifact_versions "
        f"FOR SELECT TO {worker_role} USING (true)"
    )
    op.execute(
        f"CREATE POLICY artifact_worker_version_update ON artifact_versions "
        f"FOR UPDATE TO {worker_role} USING (true) WITH CHECK (true)"
    )
    op.execute(
        f"CREATE POLICY artifact_worker_staging_read ON staging_uploads "
        f"FOR SELECT TO {worker_role} USING (true)"
    )
    op.execute(
        f"CREATE POLICY artifact_worker_artifact_read ON artifacts "
        f"FOR SELECT TO {worker_role} USING (true)"
    )

    op.execute("DROP POLICY audit_event_insert ON audit_events")
    op.execute(
        f"CREATE POLICY audit_event_insert ON audit_events FOR INSERT TO {application_role} "
        "WITH CHECK (actor_id = NULLIF(current_setting('app.actor_id', true), '')::uuid "
        "AND executor_kind = 'account')"
    )
    op.execute(
        f"CREATE POLICY artifact_worker_audit_insert ON audit_events FOR INSERT TO {worker_role} "
        "WITH CHECK (executor_kind = 'artifact_worker' "
        "AND resource_type = 'artifact_version' "
        "AND EXISTS (SELECT 1 FROM artifact_versions "
        "WHERE artifact_versions.id = audit_events.resource_id "
        "AND artifact_versions.uploaded_by_id = audit_events.actor_id))"
    )

    op.execute(f"GRANT USAGE ON SCHEMA public TO {worker_role}")
    op.execute(
        f"GRANT INSERT ON artifact_processing_jobs TO {application_role}"
    )
    op.execute(f"GRANT SELECT ON artifact_processing_jobs TO {worker_role}")
    op.execute(
        "GRANT UPDATE (status, attempts, next_attempt_at, lease_token, lease_expires_at, "
        f"failure_code, updated_at) ON artifact_processing_jobs TO {worker_role}"
    )
    op.execute(
        "GRANT INSERT (id, object_key, version_id, status, attempts, next_attempt_at, "
        "lease_token, lease_expires_at, failure_code, updated_at), "
        "SELECT (id, object_key, version_id, status, attempts, next_attempt_at, "
        f"lease_token, lease_expires_at) ON artifact_object_cleanup_jobs TO {worker_role}"
    )
    op.execute(
        "GRANT UPDATE (status, attempts, next_attempt_at, lease_token, lease_expires_at, "
        f"failure_code, updated_at) ON artifact_object_cleanup_jobs TO {worker_role}"
    )
    op.execute(
        "GRANT SELECT (id, artifact_id, uploaded_by_id, declared_size, actual_size, "
        "detected_content_type, sha256, scan_status, staging_key, staging_etag, "
        "staging_expires_at, object_key) "
        f"ON artifact_versions TO {worker_role}"
    )
    op.execute(
        "GRANT UPDATE (actual_size, detected_content_type, sha256, scan_status, object_key) "
        f"ON artifact_versions TO {worker_role}"
    )
    op.execute(
        f"GRANT SELECT (id, created_by_id, staging_key, expires_at) ON staging_uploads TO {worker_role}"
    )
    op.execute(
        f"GRANT SELECT (id, created_by_id, owner_id, project_id) ON artifacts TO {worker_role}"
    )
    op.execute(
        "GRANT INSERT (id, actor_id, action, resource_type, resource_id, request_id, result, executor_kind) "
        f"ON audit_events TO {worker_role}"
    )


def downgrade() -> None:
    application_role = _configured_role("application_role")
    worker_role = _configured_role("worker_role")

    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM artifact_versions WHERE object_key IS NULL
            ) THEN
                RAISE EXCEPTION
                    'cannot downgrade artifact lifecycle: non-clean versions have no final object';
            END IF;
        END
        $$
        """
    )

    op.execute(
        f"REVOKE SELECT, INSERT, UPDATE ON artifact_processing_jobs FROM {application_role}"
    )
    op.execute(
        f"REVOKE ALL ON FUNCTION public.retry_artifact_version(uuid) FROM {application_role}"
    )
    op.execute("DROP FUNCTION public.retry_artifact_version(uuid)")
    op.execute(f"REVOKE ALL PRIVILEGES ON artifact_processing_jobs FROM {worker_role}")
    op.execute(f"REVOKE ALL PRIVILEGES ON artifact_object_cleanup_jobs FROM {worker_role}")
    op.execute(f"REVOKE ALL PRIVILEGES ON artifacts, artifact_versions, staging_uploads, audit_events FROM {worker_role}")
    op.execute(f"REVOKE USAGE ON SCHEMA public FROM {worker_role}")

    op.execute("DROP POLICY artifact_worker_audit_insert ON audit_events")
    op.execute("DROP POLICY audit_event_insert ON audit_events")
    op.execute(
        "CREATE POLICY audit_event_insert ON audit_events FOR INSERT WITH CHECK ("
        "actor_id = NULLIF(current_setting('app.actor_id', true), '')::uuid)"
    )
    for table, policy in (
        ("artifacts", "artifact_worker_artifact_read"),
        ("staging_uploads", "artifact_worker_staging_read"),
        ("artifact_versions", "artifact_worker_version_update"),
        ("artifact_versions", "artifact_worker_version_read"),
    ):
        op.execute(f"DROP POLICY {policy} ON {table}")

    op.execute("DROP POLICY artifact_worker_job_update ON artifact_processing_jobs")
    op.execute("DROP POLICY artifact_worker_job_read ON artifact_processing_jobs")
    op.execute("DROP POLICY application_job_insert ON artifact_processing_jobs")
    op.execute("ALTER TABLE artifact_processing_jobs NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE artifact_processing_jobs DISABLE ROW LEVEL SECURITY")
    op.drop_table("artifact_processing_jobs")
    op.execute("DROP POLICY artifact_worker_cleanup_update ON artifact_object_cleanup_jobs")
    op.execute("DROP POLICY artifact_worker_cleanup_read ON artifact_object_cleanup_jobs")
    op.execute("DROP POLICY artifact_worker_cleanup_insert ON artifact_object_cleanup_jobs")
    op.execute("ALTER TABLE artifact_object_cleanup_jobs NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE artifact_object_cleanup_jobs DISABLE ROW LEVEL SECURITY")
    op.drop_table("artifact_object_cleanup_jobs")

    op.execute("DROP TRIGGER artifact_version_scan_status_transition ON artifact_versions")
    op.execute("DROP FUNCTION public.enforce_artifact_scan_status_transition()")

    op.drop_constraint("ck_audit_events_executor_kind", "audit_events", type_="check")
    op.drop_constraint("ck_artifact_version_clean_object", "artifact_versions", type_="check")
    op.drop_constraint("ck_artifact_version_scan_status", "artifact_versions", type_="check")
    op.drop_constraint("ck_artifact_version_actual_size", "artifact_versions", type_="check")
    op.drop_constraint("ck_artifact_version_declared_size", "artifact_versions", type_="check")
    op.drop_constraint("ck_artifact_version_number", "artifact_versions", type_="check")
    op.drop_constraint("uq_artifact_version_number", "artifact_versions", type_="unique")

    artifact_scope = (
        "owner_id = NULLIF(current_setting('app.actor_id', true), '')::uuid "
        "OR project_id IN (SELECT public.authorized_project_ids())"
    )
    op.execute("DROP POLICY artifact_versions_insert ON artifact_versions")
    op.execute(
        "CREATE POLICY artifact_versions_insert ON artifact_versions "
        f"FOR INSERT WITH CHECK ({artifact_scope})"
    )
    op.execute("DROP POLICY artifacts_insert ON artifacts")
    op.execute(
        "CREATE POLICY artifacts_insert ON artifacts "
        f"FOR INSERT WITH CHECK ({artifact_scope})"
    )

    op.alter_column("artifact_versions", "object_key", existing_type=sa.String(length=512), nullable=False)
    op.drop_constraint(
        "fk_artifact_versions_uploaded_by_id_accounts",
        "artifact_versions",
        type_="foreignkey",
    )
    for column_name in (
        "staging_expires_at",
        "staging_etag",
        "staging_key",
        "scan_status",
        "detected_content_type",
        "actual_size",
        "declared_size",
        "uploaded_by_id",
        "original_filename",
        "version_number",
    ):
        op.drop_column("artifact_versions", column_name)
    op.drop_constraint("fk_artifacts_created_by_id_accounts", "artifacts", type_="foreignkey")
    op.drop_column("artifacts", "created_by_id")
    actor_id = "NULLIF(current_setting('app.actor_id', true), '')::uuid"
    op.execute("DROP POLICY staging_uploads_insert ON staging_uploads")
    op.execute(
        "CREATE POLICY staging_uploads_insert ON staging_uploads FOR INSERT WITH CHECK ("
        f"created_by_id = {actor_id} AND (owner_id = {actor_id} "
        "OR project_id IN (SELECT public.authorized_project_ids())))"
    )
    op.drop_constraint("ck_staging_upload_expected_size", "staging_uploads", type_="check")
    op.drop_constraint(
        "fk_staging_uploads_artifact_id_artifacts",
        "staging_uploads",
        type_="foreignkey",
    )
    op.drop_column("staging_uploads", "expected_size")
    op.drop_column("staging_uploads", "artifact_id")
    op.drop_column("audit_events", "executor_kind")
