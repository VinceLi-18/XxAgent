from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.models.retrieval import ArtifactIndexJob, ArtifactSearchHead, ArtifactTextIndex
from app.retrieval.embedding_client import MODEL_REVISION
from app.services.artifact_index_jobs import (
    CONFIGURATION_FINGERPRINT,
    PARSER_REVISION,
    ArtifactIndexLease,
    claim_due_index_job,
    retry_index_job,
)
from app.services.artifact_indexing import publish_index


async def _seed_two_generations(database: AsyncEngine, *, actor_id):
    artifact_id, old_version_id, new_version_id = uuid4(), uuid4(), uuid4()
    old_index_id, new_index_id, job_id = uuid4(), uuid4(), uuid4()
    now = datetime.now(UTC)
    async with database.begin() as connection:
        await connection.execute(text("INSERT INTO artifacts (id, filename, owner_id, created_by_id) VALUES (:id, 'c.txt', :actor, :actor)"), {"id": artifact_id, "actor": actor_id})
        for number, version_id in enumerate((old_version_id, new_version_id), 1):
            await connection.execute(text("INSERT INTO artifact_versions (id, artifact_id, owner_id, version_number, original_filename, uploaded_by_id, declared_size, actual_size, scan_status, object_key, size, sha256, detected_content_type) VALUES (:id, :artifact, :actor, :number, 'c.txt', :actor, 1, 1, 'clean', :key, 1, :sha, 'text/plain')"), {"id": version_id, "artifact": artifact_id, "actor": actor_id, "number": number, "key": f"artifacts/{artifact_id}/{version_id}", "sha": str(number) * 64})
        values = {"artifact": artifact_id, "old_version": old_version_id, "new_version": new_version_id, "old_index": old_index_id, "new_index": new_index_id, "job": job_id, "now": now}
        await connection.execute(text("INSERT INTO artifact_text_indexes (id, artifact_id, version_id, generation, content_sha256, parser_revision, embedding_model, embedding_revision, configuration_fingerprint, status, chunk_count) VALUES (:old_index, :artifact, :old_version, 1, :old_sha, :parser, 'BAAI/bge-m3', :revision, :fp, 'ready', 1), (:new_index, :artifact, :new_version, 2, :new_sha, :parser, 'BAAI/bge-m3', :revision, :fp, 'building', 0)"), {**values, "old_sha": "1" * 64, "new_sha": "2" * 64, "parser": PARSER_REVISION, "revision": MODEL_REVISION, "fp": CONFIGURATION_FINGERPRINT})
        await connection.execute(text("INSERT INTO artifact_search_heads (artifact_id, index_id, version_id) VALUES (:artifact, :old_index, :old_version)"), values)
        await connection.execute(text("INSERT INTO artifact_index_jobs (id, index_id, status, attempts, next_attempt_at) VALUES (:job, :new_index, 'ready', 0, :now)"), values)
    return values


@pytest.mark.anyio
async def test_old_head_remains_until_new_generation_publishes(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice
) -> None:
    ids = await _seed_two_generations(seeded_database, actor_id=alice.id)
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)
    async with sessions() as session:
        async with session.begin():
            lease = await claim_due_index_job(session, now=ids["now"], lease_seconds=60)
    assert lease is not None
    async with AsyncSession(seeded_database) as session:
        assert (await session.get(ArtifactSearchHead, ids["artifact"])).index_id == ids["old_index"]
    async with sessions() as session:
        async with session.begin():
            assert await publish_index(session, lease, now=ids["now"] + timedelta(seconds=1), chunk_count=0)
    async with AsyncSession(seeded_database) as session:
        head = await session.get(ArtifactSearchHead, ids["artifact"])
        assert head is not None and head.index_id == ids["new_index"]


@pytest.mark.anyio
async def test_stale_lease_cannot_publish_or_replace_current_head(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice
) -> None:
    ids = await _seed_two_generations(seeded_database, actor_id=alice.id)
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)
    async with sessions() as session:
        async with session.begin():
            first = await claim_due_index_job(session, now=ids["now"], lease_seconds=1)
    assert first is not None
    async with sessions() as session:
        async with session.begin():
            second = await claim_due_index_job(session, now=ids["now"] + timedelta(seconds=2), lease_seconds=60)
    assert second is not None
    async with sessions() as session:
        async with session.begin():
            assert not await publish_index(session, first, now=ids["now"] + timedelta(seconds=3), chunk_count=0)
    async with AsyncSession(seeded_database) as session:
        head = await session.get(ArtifactSearchHead, ids["artifact"])
        new_index = await session.get(ArtifactTextIndex, ids["new_index"])
        job = await session.get(ArtifactIndexJob, ids["job"])
    assert head is not None and head.index_id == ids["old_index"]
    assert new_index is not None and new_index.status == "building"
    assert job is not None and job.lease_token == second.lease_token


@pytest.mark.anyio
async def test_terminal_replacement_failure_preserves_old_head(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice
) -> None:
    ids = await _seed_two_generations(seeded_database, actor_id=alice.id)
    async with seeded_database.begin() as connection:
        await connection.execute(
            text("UPDATE artifact_index_jobs SET attempts = 4 WHERE id = :job"),
            {"job": ids["job"]},
        )
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)
    async with sessions() as session:
        async with session.begin():
            lease = await claim_due_index_job(session, now=ids["now"], lease_seconds=60)
    assert lease is not None and lease.attempt == 5
    async with sessions() as session:
        async with session.begin():
            assert await retry_index_job(
                session,
                lease,
                now=ids["now"] + timedelta(seconds=1),
                failure_code="indexing-failed",
            )

    async with AsyncSession(seeded_database) as session:
        head = await session.get(ArtifactSearchHead, ids["artifact"])
        replacement = await session.get(ArtifactTextIndex, ids["new_index"])
    assert head is not None and head.index_id == ids["old_index"]
    assert replacement is not None and replacement.status == "failed"


@pytest.mark.anyio
async def test_late_older_generation_cannot_replace_newer_head(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice
) -> None:
    ids = await _seed_two_generations(seeded_database, actor_id=alice.id)
    newest_version, newest_index, newest_job, newest_token = uuid4(), uuid4(), uuid4(), uuid4()
    older_token = uuid4()
    live_until = ids["now"] + timedelta(minutes=1)
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, uploaded_by_id, "
                "declared_size, actual_size, scan_status, object_key, size, sha256, detected_content_type) "
                "VALUES (:id, :artifact, :actor, 3, 'c.txt', :actor, 1, 1, 'clean', :key, 1, :sha, 'text/plain')"
            ),
            {"id": newest_version, "artifact": ids["artifact"], "actor": alice.id, "key": f"artifacts/{ids['artifact']}/{newest_version}", "sha": "3" * 64},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_text_indexes "
                "(id, artifact_id, version_id, generation, content_sha256, parser_revision, embedding_model, "
                "embedding_revision, configuration_fingerprint, status, chunk_count) "
                "VALUES (:id, :artifact, :version, 3, :sha, :parser, 'BAAI/bge-m3', :revision, :fp, 'building', 0)"
            ),
            {"id": newest_index, "artifact": ids["artifact"], "version": newest_version, "sha": "3" * 64, "parser": PARSER_REVISION, "revision": MODEL_REVISION, "fp": CONFIGURATION_FINGERPRINT},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_index_jobs "
                "(id, index_id, status, attempts, next_attempt_at, lease_token, lease_expires_at) "
                "VALUES (:id, :index, 'leased', 1, :now, :token, :expires)"
            ),
            {"id": newest_job, "index": newest_index, "now": ids["now"], "token": newest_token, "expires": live_until},
        )
        await connection.execute(
            text(
                "UPDATE artifact_index_jobs SET status = 'leased', attempts = 1, lease_token = :token, "
                "lease_expires_at = :expires WHERE id = :job"
            ),
            {"token": older_token, "expires": live_until, "job": ids["job"]},
        )
    newer = ArtifactIndexLease(newest_job, newest_version, newest_index, newest_token, 1)
    older = ArtifactIndexLease(ids["job"], ids["new_version"], ids["new_index"], older_token, 1)
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)
    async with sessions() as session:
        async with session.begin():
            assert await publish_index(session, newer, now=ids["now"], chunk_count=0)
    async with sessions() as session:
        async with session.begin():
            assert await publish_index(session, older, now=ids["now"], chunk_count=0)

    async with AsyncSession(seeded_database) as session:
        head = await session.get(ArtifactSearchHead, ids["artifact"])
        older_index = await session.get(ArtifactTextIndex, ids["new_index"])
    assert head is not None and head.index_id == newest_index
    assert older_index is not None and older_index.status == "ready"
