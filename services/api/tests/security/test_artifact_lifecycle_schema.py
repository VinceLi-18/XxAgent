from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from anyio import to_thread
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine


def _alembic_config(database_url: str) -> Config:
    backend_directory = Path(__file__).resolve().parents[2]
    config = Config(str(backend_directory / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


async def _require_lifecycle_schema(engine: AsyncEngine) -> None:
    required = {
        "artifact_object_cleanup_jobs",
        "artifact_object_cleanup_jobs.object_key",
        "artifact_object_cleanup_jobs.version_id",
        "artifact_processing_jobs",
        "artifact_versions.actual_size",
        "artifact_versions.declared_size",
        "artifact_versions.detected_content_type",
        "artifact_versions.original_filename",
        "artifact_versions.scan_status",
        "artifact_versions.staging_expires_at",
        "artifact_versions.staging_key",
        "artifact_versions.uploaded_by_id",
        "artifact_versions.version_number",
        "artifacts.created_by_id",
        "audit_events.executor_kind",
        "staging_uploads.artifact_id",
        "staging_uploads.expected_size",
    }
    async with engine.connect() as connection:
        rows = await connection.execute(
            text(
                "SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = 'public'"
            )
        )
        actual = {f"{table}.{column}" for table, column in rows}
        tables = set(
            await connection.scalars(
                text(
                    "SELECT tablename FROM pg_catalog.pg_tables "
                    "WHERE schemaname = 'public'"
                )
            )
        )
    actual.update(tables)
    assert required <= actual


async def _insert_artifact(engine: AsyncEngine, account_id: UUID) -> UUID:
    artifact_id = uuid4()
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                "VALUES (:id, 'schema.txt', :account_id, :account_id)"
            ),
            {"id": artifact_id, "account_id": account_id},
        )
    return artifact_id


async def _insert_version(
    engine: AsyncEngine,
    *,
    artifact_id: UUID,
    account_id: UUID,
    version_number: int,
    scan_status: str,
    object_key: str | None,
) -> UUID:
    version_id = uuid4()
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, "
                "uploaded_by_id, declared_size, actual_size, detected_content_type, "
                "scan_status, staging_key, staging_expires_at, object_key, size, "
                "content_type, sha256) "
                "VALUES (:id, :artifact_id, :account_id, :version_number, 'schema.txt', "
                ":account_id, 6, 6, 'text/plain', :scan_status, NULL, NULL, "
                ":object_key, 6, 'text/plain', :sha256)"
            ),
            {
                "id": version_id,
                "artifact_id": artifact_id,
                "account_id": account_id,
                "version_number": version_number,
                "scan_status": scan_status,
                "object_key": object_key,
                "sha256": "0" * 64,
            },
        )
    return version_id


@pytest.mark.anyio
async def test_artifact_lifecycle_schema_has_required_tables_and_columns(
    seeded_database: AsyncEngine,
) -> None:
    await _require_lifecycle_schema(seeded_database)


@pytest.mark.anyio
async def test_staging_upload_rejects_a_missing_artifact_target(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    await _require_lifecycle_schema(seeded_database)

    with pytest.raises(IntegrityError, match="fk_staging_uploads_artifact_id_artifacts"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO staging_uploads "
                    "(id, artifact_id, created_by_id, filename, expected_size, owner_id, "
                    "staging_key, expires_at) VALUES "
                    "(:id, :artifact_id, :account_id, 'target.txt', 1, :account_id, "
                    "'staging/missing-target', CURRENT_TIMESTAMP + INTERVAL '10 minutes')"
                ),
                {
                    "id": uuid4(),
                    "artifact_id": uuid4(),
                    "account_id": alice.id,
                },
            )


@pytest.mark.anyio
async def test_staging_upload_rejects_a_negative_expected_size(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    await _require_lifecycle_schema(seeded_database)

    with pytest.raises(IntegrityError, match="ck_staging_upload_expected_size"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO staging_uploads "
                    "(id, created_by_id, filename, expected_size, owner_id, staging_key, expires_at) "
                    "VALUES (:id, :account_id, 'negative.txt', -1, :account_id, "
                    "'staging/negative-size', CURRENT_TIMESTAMP + INTERVAL '10 minutes')"
                ),
                {"id": uuid4(), "account_id": alice.id},
            )


@pytest.mark.anyio
async def test_artifact_version_number_is_unique_per_artifact(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    await _require_lifecycle_schema(seeded_database)
    artifact_id = await _insert_artifact(seeded_database, alice.id)
    await _insert_version(
        seeded_database,
        artifact_id=artifact_id,
        account_id=alice.id,
        version_number=1,
        scan_status="clean",
        object_key=f"artifacts/{artifact_id}/one",
    )

    with pytest.raises(IntegrityError, match="uq_artifact_version_number"):
        await _insert_version(
            seeded_database,
            artifact_id=artifact_id,
            account_id=alice.id,
            version_number=1,
            scan_status="clean",
            object_key=f"artifacts/{artifact_id}/duplicate",
        )


@pytest.mark.anyio
async def test_artifact_version_rejects_unknown_scan_status(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    await _require_lifecycle_schema(seeded_database)
    artifact_id = await _insert_artifact(seeded_database, alice.id)

    with pytest.raises(IntegrityError, match="ck_artifact_version_scan_status"):
        await _insert_version(
            seeded_database,
            artifact_id=artifact_id,
            account_id=alice.id,
            version_number=1,
            scan_status="unsafe",
            object_key=None,
        )


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("scan_status", "object_key"),
    (
        ("clean", None),
        ("pending", "artifacts/invalid/pending"),
        ("scanning", "artifacts/invalid/scanning"),
        ("quarantined", "artifacts/invalid/quarantined"),
        ("failed", "artifacts/invalid/failed"),
    ),
)
async def test_artifact_version_final_object_matches_clean_status(
    seeded_database: AsyncEngine,
    alice,
    scan_status: str,
    object_key: str | None,
) -> None:
    await _require_lifecycle_schema(seeded_database)
    artifact_id = await _insert_artifact(seeded_database, alice.id)

    with pytest.raises(IntegrityError, match="ck_artifact_version_clean_object"):
        await _insert_version(
            seeded_database,
            artifact_id=artifact_id,
            account_id=alice.id,
            version_number=1,
            scan_status=scan_status,
            object_key=object_key,
        )


@pytest.mark.anyio
async def test_artifact_processing_job_is_unique_per_version(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    await _require_lifecycle_schema(seeded_database)
    artifact_id = await _insert_artifact(seeded_database, alice.id)
    version_id = await _insert_version(
        seeded_database,
        artifact_id=artifact_id,
        account_id=alice.id,
        version_number=1,
        scan_status="pending",
        object_key=None,
    )
    now = datetime.now(UTC)
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifact_processing_jobs "
                "(id, version_id, status, attempts, next_attempt_at) "
                "VALUES (:id, :version_id, 'ready', 0, :now)"
            ),
            {"id": uuid4(), "version_id": version_id, "now": now},
        )

    with pytest.raises(IntegrityError, match="artifact_processing_jobs_version_id_key"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO artifact_processing_jobs "
                    "(id, version_id, status, attempts, next_attempt_at) "
                    "VALUES (:id, :version_id, 'ready', 0, :now)"
                ),
                {"id": uuid4(), "version_id": version_id, "now": now},
            )


@pytest.mark.anyio
async def test_artifact_processing_job_rejects_negative_attempts(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    await _require_lifecycle_schema(seeded_database)
    artifact_id = await _insert_artifact(seeded_database, alice.id)
    version_id = await _insert_version(
        seeded_database,
        artifact_id=artifact_id,
        account_id=alice.id,
        version_number=1,
        scan_status="pending",
        object_key=None,
    )

    with pytest.raises(IntegrityError, match="ck_artifact_processing_job_attempts"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO artifact_processing_jobs "
                    "(id, version_id, status, attempts, next_attempt_at) "
                    "VALUES (:id, :version_id, 'ready', -1, CURRENT_TIMESTAMP)"
                ),
                {"id": uuid4(), "version_id": version_id},
            )


@pytest.mark.anyio
async def test_artifact_processing_job_rejects_unknown_status(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    await _require_lifecycle_schema(seeded_database)
    artifact_id = await _insert_artifact(seeded_database, alice.id)
    version_id = await _insert_version(
        seeded_database,
        artifact_id=artifact_id,
        account_id=alice.id,
        version_number=1,
        scan_status="pending",
        object_key=None,
    )

    with pytest.raises(IntegrityError, match="ck_artifact_processing_job_status"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO artifact_processing_jobs "
                    "(id, version_id, status, attempts, next_attempt_at) "
                    "VALUES (:id, :version_id, 'unknown', 0, CURRENT_TIMESTAMP)"
                ),
                {"id": uuid4(), "version_id": version_id},
            )


@pytest.mark.anyio
async def test_artifact_version_allows_only_declared_scan_transitions(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    await _require_lifecycle_schema(seeded_database)
    artifact_id = await _insert_artifact(seeded_database, alice.id)
    version_id = await _insert_version(
        seeded_database,
        artifact_id=artifact_id,
        account_id=alice.id,
        version_number=1,
        scan_status="pending",
        object_key=None,
    )

    with pytest.raises(DBAPIError, match="invalid artifact scan status transition"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE artifact_versions SET scan_status = 'clean', "
                    "object_key = :object_key WHERE id = :id"
                ),
                {
                    "id": version_id,
                    "object_key": f"artifacts/{artifact_id}/{version_id}",
                },
            )

    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "UPDATE artifact_versions SET scan_status = 'scanning' "
                "WHERE id = :id"
            ),
            {"id": version_id},
        )
        await connection.execute(
            text(
                "UPDATE artifact_versions SET scan_status = 'failed' "
                "WHERE id = :id"
            ),
            {"id": version_id},
        )


@pytest.mark.anyio
async def test_audit_event_rejects_unknown_executor_kind(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    await _require_lifecycle_schema(seeded_database)

    with pytest.raises(IntegrityError, match="ck_audit_events_executor_kind"):
        async with seeded_database.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO audit_events "
                    "(id, actor_id, action, resource_type, resource_id, request_id, result, executor_kind) "
                    "VALUES (:id, :actor_id, 'artifact.scan', 'artifact_version', "
                    ":resource_id, :request_id, 'failed', 'system')"
                ),
                {
                    "id": uuid4(),
                    "actor_id": alice.id,
                    "resource_id": uuid4(),
                    "request_id": uuid4(),
                },
            )


@pytest.mark.anyio
async def test_downgrade_rejects_pending_versions_without_changing_data(
    seeded_database: AsyncEngine,
    alice,
) -> None:
    artifact_id = await _insert_artifact(seeded_database, alice.id)
    version_id = await _insert_version(
        seeded_database,
        artifact_id=artifact_id,
        account_id=alice.id,
        version_number=1,
        scan_status="pending",
        object_key=None,
    )
    config = _alembic_config(
        seeded_database.url.render_as_string(hide_password=False)
    )
    await seeded_database.dispose()

    with pytest.raises(DBAPIError, match="cannot downgrade artifact lifecycle"):
        await to_thread.run_sync(
            command.downgrade,
            config,
            "011_drop_legacy_threads",
        )

    await seeded_database.dispose()
    async with seeded_database.connect() as connection:
        row = (
            await connection.execute(
                text(
                    "SELECT scan_status, object_key FROM artifact_versions "
                    "WHERE id = :id"
                ),
                {"id": version_id},
            )
        ).one()
        revision = await connection.scalar(
            text("SELECT version_num FROM alembic_version")
        )

    assert row == ("pending", None)
    assert revision == "016_xagent_fact_approval"


@pytest.mark.anyio
async def test_artifact_lifecycle_migration_round_trip_backfills_legacy_rows(
    seeded_database: AsyncEngine,
    alice,
    bob,
) -> None:
    config = _alembic_config(
        seeded_database.url.render_as_string(hide_password=False)
    )
    await seeded_database.dispose()
    await to_thread.run_sync(
        command.downgrade,
        config,
        "011_drop_legacy_threads",
    )

    project_id = uuid4()
    private_artifact_id = uuid4()
    project_artifact_id = uuid4()
    private_version_id = uuid4()
    project_version_id = uuid4()
    audit_id = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO projects (id, name, owner_id) "
                "VALUES (:id, 'Legacy project', :owner_id)"
            ),
            {"id": project_id, "owner_id": bob.id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, project_id) VALUES "
                "(:private_id, 'private.txt', :alice_id, NULL), "
                "(:project_id_value, 'project.txt', NULL, :project_id)"
            ),
            {
                "private_id": private_artifact_id,
                "alice_id": alice.id,
                "project_id_value": project_artifact_id,
                "project_id": project_id,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, project_id, object_key, size, content_type, sha256) VALUES "
                "(:private_version_id, :private_artifact_id, :alice_id, NULL, "
                "'artifacts/private/legacy', 7, 'text/plain', :sha256), "
                "(:project_version_id, :project_artifact_id, NULL, :project_id, "
                "'artifacts/project/legacy', 9, 'application/pdf', :sha256)"
            ),
            {
                "private_version_id": private_version_id,
                "private_artifact_id": private_artifact_id,
                "alice_id": alice.id,
                "project_version_id": project_version_id,
                "project_artifact_id": project_artifact_id,
                "project_id": project_id,
                "sha256": "1" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO audit_events "
                "(id, actor_id, action, resource_type, resource_id, request_id, result) "
                "VALUES (:id, :actor_id, 'artifact.read', 'artifact', "
                ":resource_id, :request_id, 'allowed')"
            ),
            {
                "id": audit_id,
                "actor_id": alice.id,
                "resource_id": private_artifact_id,
                "request_id": uuid4(),
            },
        )

    await seeded_database.dispose()
    await to_thread.run_sync(command.upgrade, config, "head")

    async with seeded_database.connect() as connection:
        artifacts = (
            await connection.execute(
                text(
                    "SELECT id, created_by_id FROM artifacts "
                    "WHERE id IN (:private_id, :project_id) ORDER BY filename"
                ),
                {
                    "private_id": private_artifact_id,
                    "project_id": project_artifact_id,
                },
            )
        ).all()
        versions = (
            await connection.execute(
                text(
                    "SELECT id, version_number, original_filename, uploaded_by_id, "
                    "declared_size, actual_size, detected_content_type, scan_status, "
                    "staging_key, staging_expires_at, object_key "
                    "FROM artifact_versions WHERE id IN (:private_id, :project_id) "
                    "ORDER BY original_filename"
                ),
                {
                    "private_id": private_version_id,
                    "project_id": project_version_id,
                },
            )
        ).all()
        executor_kind = await connection.scalar(
            text("SELECT executor_kind FROM audit_events WHERE id = :id"),
            {"id": audit_id},
        )
        revision = await connection.scalar(
            text("SELECT version_num FROM alembic_version")
        )

    assert artifacts == [
        (private_artifact_id, alice.id),
        (project_artifact_id, bob.id),
    ]
    assert versions == [
        (
            private_version_id,
            1,
            "private.txt",
            alice.id,
            7,
            7,
            "text/plain",
            "clean",
            None,
            None,
            "artifacts/private/legacy",
        ),
        (
            project_version_id,
            1,
            "project.txt",
            bob.id,
            9,
            9,
            "application/pdf",
            "clean",
            None,
            None,
            "artifacts/project/legacy",
        ),
    ]
    assert executor_kind == "account"
    assert revision == "016_xagent_fact_approval"
