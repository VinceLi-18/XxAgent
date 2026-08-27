from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncEngine


@pytest.mark.anyio
async def test_worker_role_is_non_inheriting_and_cannot_bypass_rls(
    seeded_database: AsyncEngine,
    worker_role: str,
) -> None:
    async with seeded_database.connect() as connection:
        attributes = (
            await connection.execute(
                text(
                    "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, "
                    "rolinherit, rolbypassrls FROM pg_roles WHERE rolname = :role"
                ),
                {"role": worker_role},
            )
        ).one()

    assert attributes == (True, False, False, False, False, False)


@pytest.mark.anyio
@pytest.mark.parametrize(
    "statement",
    (
        "SELECT email FROM accounts",
        "SELECT password_hash FROM xagent_account_credentials",
        "SELECT * FROM xagent_auth_sessions",
        "SELECT * FROM xagent_sessions",
        "SELECT * FROM xagent_session_events",
        "SELECT * FROM project_memberships",
    ),
)
async def test_worker_cannot_read_identity_auth_session_or_membership_data(
    worker_engine: AsyncEngine,
    statement: str,
) -> None:
    with pytest.raises(ProgrammingError) as rejected:
        async with worker_engine.connect() as connection:
            await connection.execute(text(statement))

    assert rejected.value.orig.sqlstate == "42501"


@pytest.mark.anyio
async def test_application_role_cannot_read_processing_jobs_directly(
    seeded_database: AsyncEngine,
    application_role: str,
) -> None:
    async with seeded_database.begin() as connection:
        set_role = await connection.scalar(
            text("SELECT format('SET LOCAL ROLE %I', CAST(:role AS text))"),
            {"role": application_role},
        )

    with pytest.raises(ProgrammingError) as rejected:
        async with seeded_database.begin() as connection:
            await connection.execute(text(set_role))
            await connection.scalar(
                text(
                    "SELECT id FROM artifact_processing_jobs "
                    "WHERE next_attempt_at <= CURRENT_TIMESTAMP "
                    "FOR UPDATE SKIP LOCKED LIMIT 1"
                )
            )
    assert rejected.value.orig.sqlstate == "42501"


@pytest.mark.anyio
async def test_only_worker_role_can_manage_cleanup_rows(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    application_role: str,
) -> None:
    cleanup_id = uuid4()
    key = f"artifacts/{uuid4()}/{uuid4()}"
    async with worker_engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifact_object_cleanup_jobs "
                "(id, object_key, version_id, status, attempts, next_attempt_at) "
                "VALUES (:id, :key, 'target-version-1', 'ready', 0, CURRENT_TIMESTAMP)"
            ),
            {"id": cleanup_id, "key": key},
        )
        await connection.execute(
            text(
                "UPDATE artifact_object_cleanup_jobs SET status = 'leased', attempts = 1, "
                "lease_token = :token, lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '1 minute' "
                "WHERE id = :id"
            ),
            {"id": cleanup_id, "token": uuid4()},
        )

    with pytest.raises(ProgrammingError) as identity_update:
        async with worker_engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE artifact_object_cleanup_jobs SET version_id = 'forged' "
                    "WHERE id = :id"
                ),
                {"id": cleanup_id},
            )
    assert identity_update.value.orig.sqlstate == "42501"

    async with seeded_database.begin() as connection:
        set_role = await connection.scalar(
            text("SELECT format('SET LOCAL ROLE %I', CAST(:role AS text))"),
            {"role": application_role},
        )
    with pytest.raises(ProgrammingError) as app_read:
        async with seeded_database.begin() as connection:
            await connection.execute(text(set_role))
            await connection.execute(text("SELECT id FROM artifact_object_cleanup_jobs"))
    assert app_read.value.orig.sqlstate == "42501"


@pytest.mark.anyio
@pytest.mark.parametrize(
    "object_key",
    (
        "backups/account-dump.bin",
        "artifacts/not-a-uuid/also-not-a-uuid",
        "artifacts/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/"
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "artifacts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/"
        "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
        "artifacts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/"
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/extra",
        "artifacts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/"
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-suffix",
        "artifacts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/"
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\n",
    ),
)
async def test_worker_cleanup_insert_rejects_keys_outside_final_artifact_namespace(
    worker_engine: AsyncEngine,
    object_key: str,
) -> None:
    with pytest.raises(IntegrityError, match="ck_artifact_object_cleanup_job_object_key"):
        async with worker_engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO artifact_object_cleanup_jobs "
                    "(id, object_key, version_id, status, attempts, next_attempt_at) "
                    "VALUES (:id, :key, 'opaque-version', 'ready', 0, CURRENT_TIMESTAMP)"
                ),
                {"id": uuid4(), "key": object_key},
            )


@pytest.mark.anyio
async def test_worker_cleanup_insert_accepts_canonical_final_artifact_key(
    worker_engine: AsyncEngine,
) -> None:
    artifact_id = uuid4()
    artifact_version_id = uuid4()

    async with worker_engine.begin() as connection:
        inserted = await connection.scalar(
            text(
                "INSERT INTO artifact_object_cleanup_jobs "
                "(id, object_key, version_id, status, attempts, next_attempt_at) "
                "VALUES (:id, :key, 'opaque-version', 'ready', 0, CURRENT_TIMESTAMP) "
                "RETURNING object_key"
            ),
            {
                "id": uuid4(),
                "key": f"artifacts/{artifact_id}/{artifact_version_id}",
            },
        )

    assert inserted == f"artifacts/{artifact_id}/{artifact_version_id}"


@pytest.mark.anyio
async def test_application_role_can_retry_only_through_the_constrained_function(
    seeded_database: AsyncEngine,
    application_role: str,
    alice,
    bob,
) -> None:
    now = datetime.now(UTC)
    artifact_id = uuid4()
    version_id = uuid4()
    job_id = uuid4()
    foreign_artifact_id = uuid4()
    foreign_version_id = uuid4()
    async with seeded_database.begin() as connection:
        set_role = await connection.scalar(
            text("SELECT format('SET LOCAL ROLE %I', CAST(:role AS text))"),
            {"role": application_role},
        )
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                "VALUES (:id, 'retry.txt', :actor_id, :actor_id), "
                "(:foreign_id, 'foreign.txt', :foreign_actor_id, :foreign_actor_id)"
            ),
            {
                "id": artifact_id,
                "actor_id": alice.id,
                "foreign_id": foreign_artifact_id,
                "foreign_actor_id": bob.id,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, "
                "uploaded_by_id, declared_size, actual_size, scan_status, staging_key, "
                "staging_etag, staging_expires_at, object_key, size, sha256) VALUES "
                "(:id, :artifact_id, :actor_id, 1, 'retry.txt', :actor_id, "
                "7, 7, 'failed', :staging_key, 'etag', :expires_at, NULL, 7, :sha256), "
                "(:foreign_id, :foreign_artifact_id, :foreign_actor_id, 1, "
                "'foreign.txt', :foreign_actor_id, 7, 7, 'failed', "
                ":foreign_staging_key, 'etag', :expires_at, NULL, 7, :sha256)"
            ),
            {
                "id": version_id,
                "artifact_id": artifact_id,
                "actor_id": alice.id,
                "staging_key": f"staging/{uuid4()}",
                "expires_at": now + timedelta(hours=1),
                "foreign_id": foreign_version_id,
                "foreign_artifact_id": foreign_artifact_id,
                "foreign_actor_id": bob.id,
                "foreign_staging_key": f"staging/{uuid4()}",
                "sha256": "0" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_processing_jobs "
                "(id, version_id, status, attempts, next_attempt_at, failure_code) "
                "VALUES (:id, :version_id, 'dead', 5, CURRENT_TIMESTAMP, 'terminal')"
            ),
            {"id": job_id, "version_id": version_id},
        )

    for statement in (
        "SELECT id FROM artifact_processing_jobs WHERE id = :job_id",
        "UPDATE artifact_versions SET scan_status = 'pending' WHERE id = :version_id",
        "UPDATE artifact_processing_jobs SET status = 'ready', attempts = 0, "
        "failure_code = NULL WHERE id = :job_id",
    ):
        with pytest.raises(ProgrammingError) as rejected:
            async with seeded_database.begin() as connection:
                await connection.execute(text(set_role))
                await connection.execute(
                    text("SELECT set_config('app.actor_id', :actor_id, true)"),
                    {"actor_id": str(alice.id)},
                )
                await connection.execute(
                    text(statement),
                    {"job_id": job_id, "version_id": version_id},
                )
        assert rejected.value.orig.sqlstate == "42501"

    async with seeded_database.begin() as connection:
        await connection.execute(text(set_role))
        await connection.execute(
            text("SELECT set_config('app.actor_id', :actor_id, true)"),
            {"actor_id": str(alice.id)},
        )
        allowed = await connection.scalar(
            text("SELECT result FROM public.retry_artifact_version(:version_id)"),
            {"version_id": version_id},
        )
        wrong_scope = await connection.scalar(
            text("SELECT result FROM public.retry_artifact_version(:version_id)"),
            {"version_id": foreign_version_id},
        )
        wrong_status = await connection.scalar(
            text("SELECT result FROM public.retry_artifact_version(:version_id)"),
            {"version_id": version_id},
        )
    assert (allowed, wrong_scope, wrong_status) == ("allowed", "not-found", "not-found")

    async with seeded_database.begin() as connection:
        state = (
            await connection.execute(
                text(
                    "SELECT v.scan_status, j.status, j.attempts, j.failure_code "
                    "FROM artifact_versions v JOIN artifact_processing_jobs j "
                    "ON j.version_id = v.id WHERE v.id = :version_id"
                ),
                {"version_id": version_id},
            )
        ).one()
    assert state == ("pending", "ready", 0, None)


@pytest.mark.anyio
async def test_constrained_retry_function_rejects_expired_staging(
    seeded_database: AsyncEngine,
    application_role: str,
    alice,
) -> None:
    artifact_id = uuid4()
    version_id = uuid4()
    async with seeded_database.begin() as connection:
        set_role = await connection.scalar(
            text("SELECT format('SET LOCAL ROLE %I', CAST(:role AS text))"),
            {"role": application_role},
        )
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                "VALUES (:id, 'expired.txt', :actor_id, :actor_id)"
            ),
            {"id": artifact_id, "actor_id": alice.id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, "
                "uploaded_by_id, declared_size, actual_size, scan_status, staging_key, "
                "staging_etag, staging_expires_at, size, sha256) VALUES "
                "(:id, :artifact_id, :actor_id, 1, 'expired.txt', :actor_id, "
                "1, 1, 'failed', :staging_key, 'etag', :expires_at, 1, :sha256)"
            ),
            {
                "id": version_id,
                "artifact_id": artifact_id,
                "actor_id": alice.id,
                "staging_key": f"staging/{uuid4()}",
                "expires_at": datetime.now(UTC) - timedelta(seconds=1),
                "sha256": "0" * 64,
            },
        )

    async with seeded_database.begin() as connection:
        await connection.execute(text(set_role))
        await connection.execute(
            text("SELECT set_config('app.actor_id', :actor_id, true)"),
            {"actor_id": str(alice.id)},
        )
        result = await connection.scalar(
            text("SELECT result FROM public.retry_artifact_version(:version_id)"),
            {"version_id": version_id},
        )
    assert result == "upload-expired"


@pytest.mark.anyio
async def test_application_role_cannot_attribute_artifacts_or_versions_to_another_account(
    seeded_database: AsyncEngine,
    application_role: str,
    alice,
    bob,
) -> None:
    project_id = uuid4()
    artifact_id = uuid4()
    async with seeded_database.begin() as connection:
        set_role = await connection.scalar(
            text("SELECT format('SET LOCAL ROLE %I', CAST(:role AS text))"),
            {"role": application_role},
        )
        await connection.execute(
            text(
                "INSERT INTO projects (id, name, owner_id) "
                "VALUES (:id, 'Attribution project', :owner_id)"
            ),
            {"id": project_id, "owner_id": alice.id},
        )

    with pytest.raises(DBAPIError):
        async with seeded_database.begin() as connection:
            await connection.execute(text(set_role))
            await connection.execute(
                text("SELECT set_config('app.actor_id', :actor_id, true)"),
                {"actor_id": str(alice.id)},
            )
            await connection.execute(
                text(
                    "INSERT INTO artifacts "
                    "(id, filename, project_id, created_by_id) "
                    "VALUES (:id, 'forged.txt', :project_id, :created_by_id)"
                ),
                {
                    "id": uuid4(),
                    "project_id": project_id,
                    "created_by_id": bob.id,
                },
            )

    async with seeded_database.begin() as connection:
        await connection.execute(text(set_role))
        await connection.execute(
            text("SELECT set_config('app.actor_id', :actor_id, true)"),
            {"actor_id": str(alice.id)},
        )
        await connection.execute(
            text(
                "INSERT INTO artifacts "
                "(id, filename, project_id, created_by_id) "
                "VALUES (:id, 'owned.txt', :project_id, :created_by_id)"
            ),
            {
                "id": artifact_id,
                "project_id": project_id,
                "created_by_id": alice.id,
            },
        )

    with pytest.raises(DBAPIError):
        async with seeded_database.begin() as connection:
            await connection.execute(text(set_role))
            await connection.execute(
                text("SELECT set_config('app.actor_id', :actor_id, true)"),
                {"actor_id": str(alice.id)},
            )
            await connection.execute(
                text(
                    "INSERT INTO artifact_versions "
                    "(id, artifact_id, project_id, version_number, original_filename, "
                    "uploaded_by_id, declared_size, scan_status, object_key, size, sha256) "
                    "VALUES (:id, :artifact_id, :project_id, 1, 'forged.txt', "
                    ":uploaded_by_id, 7, 'pending', NULL, 7, :sha256)"
                ),
                {
                    "id": uuid4(),
                    "artifact_id": artifact_id,
                    "project_id": project_id,
                    "uploaded_by_id": bob.id,
                    "sha256": "0" * 64,
                },
            )


@pytest.mark.anyio
async def test_worker_can_claim_jobs_and_update_only_processing_columns(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
) -> None:
    artifact_id = uuid4()
    version_id = uuid4()
    job_id = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                "VALUES (:id, 'worker.txt', :actor_id, :actor_id)"
            ),
            {"id": artifact_id, "actor_id": alice.id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, "
                "uploaded_by_id, declared_size, scan_status, staging_key, "
                "staging_expires_at, object_key, size, sha256) "
                "VALUES (:id, :artifact_id, :actor_id, 1, 'worker.txt', :actor_id, "
                "6, 'pending', 'staging/worker', :expires_at, NULL, 6, :sha256)"
            ),
            {
                "id": version_id,
                "artifact_id": artifact_id,
                "actor_id": alice.id,
                "expires_at": datetime.now(UTC),
                "sha256": "0" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_processing_jobs "
                "(id, version_id, status, attempts, next_attempt_at) "
                "VALUES (:id, :version_id, 'ready', 0, CURRENT_TIMESTAMP)"
            ),
            {"id": job_id, "version_id": version_id},
        )

    lease_token = uuid4()
    async with worker_engine.begin() as connection:
        claimed = (
            await connection.execute(
                text(
                    "SELECT id, version_id FROM artifact_processing_jobs "
                    "WHERE id = :job_id FOR UPDATE SKIP LOCKED"
                ),
                {"job_id": job_id},
            )
        ).one()
        await connection.execute(
            text(
                "UPDATE artifact_processing_jobs SET status = 'leased', attempts = 1, "
                "lease_token = :lease_token, lease_expires_at = CURRENT_TIMESTAMP, "
                "updated_at = CURRENT_TIMESTAMP WHERE id = :job_id"
            ),
            {"job_id": job_id, "lease_token": lease_token},
        )

    assert claimed == (job_id, version_id)

    with pytest.raises(ProgrammingError) as rejected:
        async with worker_engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE artifact_processing_jobs SET version_id = :version_id "
                    "WHERE id = :job_id"
                ),
                {"job_id": job_id, "version_id": uuid4()},
            )
    assert rejected.value.orig.sqlstate == "42501"


@pytest.mark.anyio
async def test_worker_can_write_only_artifact_worker_audit_events(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
    bob,
) -> None:
    artifact_id = uuid4()
    version_id = uuid4()
    index_id = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                "VALUES (:id, 'audit.txt', :actor_id, :actor_id)"
            ),
            {"id": artifact_id, "actor_id": alice.id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, "
                "uploaded_by_id, declared_size, scan_status, staging_key, "
                "staging_expires_at, object_key, size, sha256) "
                "VALUES (:id, :artifact_id, :actor_id, 1, 'audit.txt', :actor_id, "
                "5, 'pending', 'staging/audit', :expires_at, NULL, 5, :sha256)"
            ),
            {
                "id": version_id,
                "artifact_id": artifact_id,
                "actor_id": alice.id,
                "expires_at": datetime.now(UTC),
                "sha256": "0" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_text_indexes "
                "(id, artifact_id, version_id, generation, content_sha256, parser_revision, "
                "embedding_model, embedding_revision, configuration_fingerprint) VALUES "
                "(:id, :artifact_id, :version_id, 1, :sha256, 'parser', "
                "'BAAI/bge-m3', 'revision', :fingerprint)"
            ),
            {
                "id": index_id,
                "artifact_id": artifact_id,
                "version_id": version_id,
                "sha256": "0" * 64,
                "fingerprint": "1" * 64,
            },
        )
    values = {
        "actor_id": alice.id,
        "resource_id": version_id,
        "request_id": uuid4(),
    }
    with pytest.raises(DBAPIError):
        async with worker_engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO audit_events "
                    "(id, actor_id, action, resource_type, resource_id, request_id, result, executor_kind) "
                    "VALUES (gen_random_uuid(), :actor_id, 'artifact.scan', 'artifact_version', "
                    ":resource_id, :request_id, 'allowed', 'account')"
                ),
                values,
            )

    with pytest.raises(DBAPIError):
        async with worker_engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO audit_events "
                    "(id, actor_id, action, resource_type, resource_id, request_id, result, executor_kind) "
                    "VALUES (gen_random_uuid(), :actor_id, 'artifact.scan', 'artifact_version', "
                    ":resource_id, :request_id, 'allowed', 'artifact_worker')"
                ),
                {**values, "actor_id": bob.id},
            )

    with pytest.raises(DBAPIError):
        async with worker_engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO audit_events "
                    "(id, actor_id, action, resource_type, resource_id, request_id, result, "
                    "executor_kind, artifact_id, version_id, index_id, index_generation) "
                    "VALUES (gen_random_uuid(), :actor_id, 'artifact.index.failed', "
                    "'artifact_version', :resource_id, :request_id, 'allowed', "
                    "'artifact_worker', :artifact_id, :version_id, :index_id, 1)"
                ),
                {
                    **values,
                    "artifact_id": artifact_id,
                    "version_id": version_id,
                    "index_id": index_id,
                },
            )

    async with worker_engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO audit_events "
                "(id, actor_id, action, resource_type, resource_id, request_id, result, executor_kind) "
                "VALUES (gen_random_uuid(), :actor_id, 'artifact.scan', 'artifact_version', "
                ":resource_id, :request_id, 'allowed', 'artifact_worker')"
            ),
            values,
        )
