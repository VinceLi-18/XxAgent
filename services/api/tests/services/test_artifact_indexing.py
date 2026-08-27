import hashlib
from collections.abc import Iterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.models.artifact import Artifact, ArtifactVersion
from app.models.audit import AuditEvent
from app.models.retrieval import ArtifactIndexJob, ArtifactSearchHead, ArtifactTextChunk, ArtifactTextIndex
from app.services import artifact_indexing
from app.services.artifact_index_jobs import claim_due_index_job, enqueue_index_job
from app.services.artifact_indexing import process_artifact_index_job
from app.retrieval.embedding_client import RetrievalUnavailableError
from app.storage.minio_gateway import ObjectMetadata
from app.worker import _run_worker_loop


class WordTokenizer:
    def encode_with_offsets(self, text: str) -> list[tuple[int, int]]:
        offsets: list[tuple[int, int]] = []
        position = 0
        for word in text.split():
            start = text.index(word, position)
            offsets.append((start, start + len(word)))
            position = start + len(word)
        return offsets


class MemoryGateway:
    def __init__(self, key: str, body: bytes) -> None:
        self.key = key
        self.body = body
        self.streamed = 0

    def stat(self, key: str) -> ObjectMetadata:
        assert key == self.key
        return ObjectMetadata(size=len(self.body), content_type="text/plain", etag="etag")

    def stream(self, key: str) -> Iterator[bytes]:
        assert key == self.key
        self.streamed += 1
        yield self.body[:3]
        yield self.body[3:]

    def stream_bounded(self, key: str, *, max_bytes: int) -> Iterator[bytes]:
        total = 0
        for chunk in self.stream(key):
            total += len(chunk)
            if total > max_bytes:
                raise ValueError("too large")
            yield chunk


class DeterministicEmbedder:
    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [[1.0] + [0.0] * 1023 for _ in texts]


async def _seed_leased_index(
    database: AsyncEngine, worker_engine: AsyncEngine, *, actor_id: UUID, body: bytes
):
    artifact = Artifact(id=uuid4(), filename="indexed.txt", created_by_id=actor_id, owner_id=actor_id)
    version = ArtifactVersion(
        id=uuid4(), artifact_id=artifact.id, owner_id=actor_id, version_number=1,
        original_filename="indexed.txt", uploaded_by_id=actor_id, declared_size=len(body),
        actual_size=len(body), detected_content_type="text/plain", scan_status="clean",
        object_key=f"artifacts/{artifact.id}/{uuid4()}", size=len(body),
        sha256=hashlib.sha256(body).hexdigest(),
    )
    async with AsyncSession(database, expire_on_commit=False) as session:
        async with session.begin():
            session.add_all((artifact, version))
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)
    now = datetime.now(UTC)
    async with sessions() as session:
        async with session.begin():
            await enqueue_index_job(session, version, now=now)
            lease = await claim_due_index_job(session, now=now, lease_seconds=60)
    assert lease is not None
    return artifact, version, lease


def _install_dependencies(monkeypatch, worker_engine, gateway, embedder=None) -> None:
    @asynccontextmanager
    async def dependencies():
        yield artifact_indexing._ArtifactIndexingDependencies(
            sessions=async_sessionmaker(worker_engine, expire_on_commit=False),
            gateway=gateway,
            tokenizer=WordTokenizer(),
            embedder=embedder or DeterministicEmbedder(),
            clock=lambda: datetime.now(UTC),
        )

    monkeypatch.setattr(artifact_indexing, "_runtime_dependencies", dependencies)


@pytest.mark.anyio
async def test_index_worker_streams_validates_embeds_and_publishes_atomically(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice, monkeypatch
) -> None:
    body = b"alpha beta\ngamma delta\n"
    artifact, version, lease = await _seed_leased_index(
        seeded_database, worker_engine, actor_id=alice.id, body=body
    )
    gateway = MemoryGateway(version.object_key, body)
    _install_dependencies(monkeypatch, worker_engine, gateway)

    await process_artifact_index_job(lease)

    async with AsyncSession(seeded_database) as session:
        index = await session.get(ArtifactTextIndex, lease.generation_id)
        job = await session.get(ArtifactIndexJob, lease.job_id)
        head = await session.get(ArtifactSearchHead, artifact.id)
        chunks = list(
            (await session.scalars(select(ArtifactTextChunk).where(ArtifactTextChunk.index_id == index.id))).all()
        )
        audits = list((await session.scalars(select(AuditEvent).where(AuditEvent.request_id == lease.job_id))).all())
    assert gateway.streamed == 1
    assert index is not None and index.status == "ready" and index.chunk_count == len(chunks)
    assert chunks
    assert job is not None and job.status == "succeeded"
    assert head is not None and head.index_id == index.id and head.version_id == version.id
    assert chunks[-1].text == body.decode().rstrip()
    assert all(chunk.text_sha256 == hashlib.sha256(chunk.text.encode()).hexdigest() for chunk in chunks)
    assert [audit.action for audit in audits] == ["artifact.index.start", "artifact.index.ready"]
    assert all(body.decode() not in repr(audit.__dict__) for audit in audits)


@pytest.mark.anyio
async def test_retry_after_chunk_insert_does_not_duplicate_chunks(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice, monkeypatch
) -> None:
    body = b"alpha beta gamma"
    _artifact, version, first = await _seed_leased_index(
        seeded_database, worker_engine, actor_id=alice.id, body=body
    )
    gateway = MemoryGateway(version.object_key, body)
    _install_dependencies(monkeypatch, worker_engine, gateway)
    original_publish = artifact_indexing.publish_index
    calls = 0

    async def fail_first_publish(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("database connection lost after chunks")
        return await original_publish(*args, **kwargs)

    monkeypatch.setattr(artifact_indexing, "publish_index", fail_first_publish)
    await process_artifact_index_job(first)
    async with async_sessionmaker(worker_engine, expire_on_commit=False)() as session:
        async with session.begin():
            job = await session.get(ArtifactIndexJob, first.job_id, with_for_update=True)
            job.next_attempt_at = datetime.now(UTC)
            second = await claim_due_index_job(session, now=datetime.now(UTC), lease_seconds=60)
    assert second is not None
    await process_artifact_index_job(second)

    async with AsyncSession(seeded_database) as session:
        count = await session.scalar(
            select(func.count()).select_from(ArtifactTextChunk).where(ArtifactTextChunk.index_id == first.generation_id)
        )
    assert count == 1


@pytest.mark.anyio
async def test_invalid_utf8_fails_generation_without_publishing_head(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice, monkeypatch
) -> None:
    body = b"valid-prefix\xff"
    artifact, version, lease = await _seed_leased_index(
        seeded_database, worker_engine, actor_id=alice.id, body=body
    )
    _install_dependencies(monkeypatch, worker_engine, MemoryGateway(version.object_key, body))

    await process_artifact_index_job(lease)

    async with AsyncSession(seeded_database) as session:
        index = await session.get(ArtifactTextIndex, lease.generation_id)
        job = await session.get(ArtifactIndexJob, lease.job_id)
        head = await session.get(ArtifactSearchHead, artifact.id)
        audits = list((await session.scalars(select(AuditEvent).where(AuditEvent.request_id == lease.job_id))).all())
    assert index is not None and index.status == "failed" and index.failure_code == "invalid-utf8"
    assert job is not None and job.status == "dead" and job.failure_code == "invalid-utf8"
    assert head is None
    assert [audit.action for audit in audits] == ["artifact.index.start", "artifact.index.failed"]
    assert all("valid-prefix" not in repr(audit.__dict__) for audit in audits)


@pytest.mark.anyio
async def test_object_identity_drift_and_embedding_unavailability_are_retryable(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice, monkeypatch
) -> None:
    body = b"alpha beta"
    _artifact, version, lease = await _seed_leased_index(
        seeded_database, worker_engine, actor_id=alice.id, body=body
    )
    _install_dependencies(
        monkeypatch,
        worker_engine,
        MemoryGateway(version.object_key, body + b" changed"),
    )

    await process_artifact_index_job(lease)

    async with AsyncSession(seeded_database) as session:
        first_job = await session.get(ArtifactIndexJob, lease.job_id)
        first_index = await session.get(ArtifactTextIndex, lease.generation_id)
    assert first_job is not None and first_job.status == "ready" and first_job.failure_code == "indexing-failed"
    assert first_index is not None and first_index.status == "building"

    async with seeded_database.begin() as connection:
        await connection.execute(
            ArtifactIndexJob.__table__.update()
            .where(ArtifactIndexJob.id == lease.job_id)
            .values(next_attempt_at=datetime.now(UTC))
        )
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)
    async with sessions() as session:
        async with session.begin():
            second = await claim_due_index_job(session, now=datetime.now(UTC), lease_seconds=60)
    assert second is not None

    class UnavailableEmbedder:
        async def embed(self, texts: list[str]) -> list[list[float]]:
            raise RetrievalUnavailableError

    _install_dependencies(
        monkeypatch,
        worker_engine,
        MemoryGateway(version.object_key, body),
        UnavailableEmbedder(),
    )
    await process_artifact_index_job(second)

    async with AsyncSession(seeded_database) as session:
        second_job = await session.get(ArtifactIndexJob, lease.job_id)
        second_index = await session.get(ArtifactTextIndex, lease.generation_id)
    assert second_job is not None and second_job.status == "ready" and second_job.attempts == 2
    assert second_job.failure_code == "indexing-failed"
    assert second_index is not None and second_index.status == "building"


@pytest.mark.anyio
async def test_worker_loop_claims_and_dispatches_index_jobs(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice
) -> None:
    body = b"worker dispatch"
    _artifact, _version, initial = await _seed_leased_index(
        seeded_database, worker_engine, actor_id=alice.id, body=body
    )
    async with seeded_database.begin() as connection:
        await connection.execute(
            ArtifactIndexJob.__table__.update()
            .where(ArtifactIndexJob.id == initial.job_id)
            .values(
                status="ready",
                attempts=0,
                next_attempt_at=datetime.now(UTC),
                lease_token=None,
                lease_expires_at=None,
            )
        )
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)
    dispatched = []

    async def index_processor(lease) -> None:
        dispatched.append(lease)
        async with sessions() as session:
            async with session.begin():
                assert await artifact_indexing.publish_index(
                    session,
                    lease,
                    now=datetime.now(UTC),
                    chunk_count=0,
                )

    await _run_worker_loop(
        sessions,
        once=True,
        index_processor=index_processor,
        lease_seconds=60,
        heartbeat_seconds=20,
        poll_seconds=0,
    )

    async with AsyncSession(seeded_database) as session:
        job = await session.get(ArtifactIndexJob, initial.job_id)
    assert len(dispatched) == 1 and dispatched[0].generation_id == initial.generation_id
    assert job is not None and job.status == "succeeded"
