from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, ProgrammingError
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
async def test_application_role_cannot_claim_artifact_jobs(
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
            await connection.execute(
                text(
                    "SELECT id FROM artifact_processing_jobs "
                    "WHERE next_attempt_at <= CURRENT_TIMESTAMP "
                    "FOR UPDATE SKIP LOCKED LIMIT 1"
                )
            )

    assert rejected.value.orig.sqlstate == "42501"


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
                "UPDATE artifact_processing_jobs SET status = 'running', attempts = 1, "
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
