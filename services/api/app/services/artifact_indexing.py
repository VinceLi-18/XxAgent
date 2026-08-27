"""Build unpublished text indexes and atomically replace searchable heads."""

import asyncio
import hashlib
from collections.abc import AsyncIterator, Callable, Iterable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol
from uuid import UUID, uuid4

import httpx
from minio.error import S3Error
from pydantic import Field
from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from urllib3.exceptions import HTTPError

from app.core.worker_config import ArtifactWorkerSettings, create_worker_database_engine
from app.models.artifact import ArtifactVersion
from app.models.retrieval import (
    ArtifactIndexJob,
    ArtifactSearchHead,
    ArtifactTextChunk,
    ArtifactTextIndex,
)
from app.retrieval.chunking import (
    MAX_PAYLOAD_BYTES,
    RetrievalInputError,
    TextChunk,
    Tokenizer,
    chunk_text,
)
from app.retrieval.embedding_client import (
    EMBEDDING_DIMENSION,
    MODEL_ID,
    MODEL_REVISION,
    EmbeddingClient,
    RetrievalUnavailableError,
)
from app.services.artifact_index_jobs import (
    CONFIGURATION_FINGERPRINT,
    PARSER_REVISION,
    ArtifactIndexLease,
    _audit_index_transition,
    fail_index_job,
    retry_index_job,
)
from app.storage.minio_gateway import MinioGateway, ObjectMetadata

_INDEX_FAILURE = "indexing-failed"
_EMBED_BATCH_SIZE = 64
_CHUNK_INSERT_BATCH_SIZE = 500


class _ArtifactIndexingSettings(ArtifactWorkerSettings):
    MINIO_ENDPOINT: str
    MINIO_ACCESS_KEY: str
    MINIO_SECRET_KEY: str
    MINIO_SECURE: bool
    MINIO_BUCKET: str = "xagent-private"
    MINIO_TIMEOUT: float = Field(default=10, gt=0)
    EMBEDDING_URL: str = "http://embedding:8000"
    EMBEDDING_TIMEOUT: float = Field(default=10, gt=0)


class _ArtifactGateway(Protocol):
    def stat(self, key: str) -> ObjectMetadata: ...

    def stream_bounded(self, key: str, *, max_bytes: int) -> Iterable[bytes]: ...


class _Embedder(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...


@dataclass(frozen=True)
class _ArtifactIndexingDependencies:
    sessions: async_sessionmaker[AsyncSession]
    gateway: _ArtifactGateway
    tokenizer: Tokenizer
    embedder: _Embedder
    clock: Callable[[], datetime]


@dataclass(frozen=True)
class _IndexWork:
    object_key: str
    actual_size: int
    content_type: str
    sha256: str


class _ContentIdentityMismatch(RuntimeError):
    pass


class _BgeTokenizer:
    """Pinned fast tokenizer used only for deterministic source offsets."""

    def __init__(self) -> None:
        from tokenizers import Tokenizer as FastTokenizer

        from app.retrieval.embedding_client import MODEL_ID, MODEL_REVISION

        self._tokenizer = FastTokenizer.from_pretrained(MODEL_ID, revision=MODEL_REVISION)

    def encode_with_offsets(self, text: str) -> Sequence[tuple[int, int]]:
        """Return BGE token character offsets without special tokens."""

        encoding = self._tokenizer.encode(text, add_special_tokens=False)
        return encoding.offsets


async def _load_work(
    dependencies: _ArtifactIndexingDependencies,
    lease: ArtifactIndexLease,
) -> _IndexWork | None:
    async with dependencies.sessions() as session:
        row = (
            await session.execute(
                select(
                    ArtifactVersion.object_key,
                    ArtifactVersion.actual_size,
                    ArtifactVersion.detected_content_type,
                    ArtifactVersion.sha256,
                )
                .join(ArtifactTextIndex, ArtifactTextIndex.version_id == ArtifactVersion.id)
                .where(
                    ArtifactVersion.id == lease.version_id,
                    ArtifactVersion.scan_status == "clean",
                    ArtifactTextIndex.id == lease.generation_id,
                    ArtifactTextIndex.status == "building",
                    ArtifactTextIndex.content_sha256 == ArtifactVersion.sha256,
                    ArtifactTextIndex.parser_revision == PARSER_REVISION,
                    ArtifactTextIndex.embedding_model == MODEL_ID,
                    ArtifactTextIndex.embedding_revision == MODEL_REVISION,
                    ArtifactTextIndex.vector_dimensions == EMBEDDING_DIMENSION,
                    ArtifactTextIndex.configuration_fingerprint == CONFIGURATION_FINGERPRINT,
                )
            )
        ).one_or_none()
    if row is None:
        return None
    object_key, actual_size, content_type, sha256 = row
    if (
        not isinstance(object_key, str)
        or not isinstance(actual_size, int)
        or not isinstance(content_type, str)
        or not isinstance(sha256, str)
    ):
        return None
    return _IndexWork(object_key, actual_size, content_type, sha256)


def _read_exact(gateway: _ArtifactGateway, work: _IndexWork) -> bytes:
    before = gateway.stat(work.object_key)
    if before.size != work.actual_size:
        raise _ContentIdentityMismatch
    digest = hashlib.sha256()
    payload = bytearray()
    try:
        for chunk in gateway.stream_bounded(work.object_key, max_bytes=MAX_PAYLOAD_BYTES):
            digest.update(chunk)
            payload.extend(chunk)
    except ValueError as error:
        raise _ContentIdentityMismatch from error
    after = gateway.stat(work.object_key)
    if (
        len(payload) != work.actual_size
        or digest.hexdigest() != work.sha256
        or before.size != after.size
        or before.etag != after.etag
    ):
        raise _ContentIdentityMismatch
    return bytes(payload)


async def _embed_chunks(embedder: _Embedder, chunks: list[TextChunk]) -> list[list[float]]:
    vectors: list[list[float]] = []
    for offset in range(0, len(chunks), _EMBED_BATCH_SIZE):
        vectors.extend(
            await embedder.embed([chunk.text for chunk in chunks[offset : offset + _EMBED_BATCH_SIZE]])
        )
    return vectors


async def _persist_chunks(
    session: AsyncSession,
    lease: ArtifactIndexLease,
    chunks: list[TextChunk],
    vectors: list[list[float]],
    *,
    now: datetime,
) -> bool:
    job = await session.scalar(
        select(ArtifactIndexJob)
        .where(
            ArtifactIndexJob.id == lease.job_id,
            ArtifactIndexJob.index_id == lease.generation_id,
            ArtifactIndexJob.status == "leased",
            ArtifactIndexJob.lease_token == lease.lease_token,
            ArtifactIndexJob.lease_expires_at > now,
        )
        .with_for_update()
    )
    if job is None:
        return False
    if len(chunks) != len(vectors):
        raise RuntimeError("embedding vector count differs from chunks")
    for offset in range(0, len(chunks), _CHUNK_INSERT_BATCH_SIZE):
        chunk_batch = chunks[offset : offset + _CHUNK_INSERT_BATCH_SIZE]
        vector_batch = vectors[offset : offset + _CHUNK_INSERT_BATCH_SIZE]
        await session.execute(
            insert(ArtifactTextChunk)
            .values(
                [
                    {
                        "id": uuid4(),
                        "index_id": lease.generation_id,
                        "ordinal": chunk.ordinal,
                        "line_start": chunk.line_start,
                        "line_end": chunk.line_end,
                        "text": chunk.text,
                        "token_count": chunk.token_count,
                        "text_sha256": hashlib.sha256(chunk.text.encode()).hexdigest(),
                        "embedding": vector,
                    }
                    for chunk, vector in zip(chunk_batch, vector_batch, strict=True)
                ]
            )
            .on_conflict_do_nothing()
        )
    return True


async def publish_index(
    session: AsyncSession,
    lease: ArtifactIndexLease,
    *,
    now: datetime,
    chunk_count: int,
) -> bool:
    """Atomically ready a generation, switch its Artifact head, and close its job."""

    job = await session.scalar(
        select(ArtifactIndexJob)
        .where(
            ArtifactIndexJob.id == lease.job_id,
            ArtifactIndexJob.index_id == lease.generation_id,
            ArtifactIndexJob.status == "leased",
            ArtifactIndexJob.lease_token == lease.lease_token,
            ArtifactIndexJob.lease_expires_at > now,
        )
        .with_for_update()
    )
    if job is None:
        return False
    index = await session.scalar(
        select(ArtifactTextIndex)
        .where(
            ArtifactTextIndex.id == lease.generation_id,
            ArtifactTextIndex.version_id == lease.version_id,
            ArtifactTextIndex.status == "building",
            ArtifactTextIndex.parser_revision == PARSER_REVISION,
            ArtifactTextIndex.embedding_model == MODEL_ID,
            ArtifactTextIndex.embedding_revision == MODEL_REVISION,
            ArtifactTextIndex.vector_dimensions == EMBEDDING_DIMENSION,
            ArtifactTextIndex.configuration_fingerprint == CONFIGURATION_FINGERPRINT,
        )
        .with_for_update()
    )
    if index is None:
        return False
    version_status = await session.scalar(
        select(ArtifactVersion.scan_status).where(ArtifactVersion.id == lease.version_id)
    )
    if version_status != "clean":
        return False
    await session.execute(
        text(
            "SELECT pg_advisory_xact_lock("
            "hashtextextended(CAST(:artifact_id AS text), 0))"
        ),
        {"artifact_id": str(index.artifact_id)},
    )
    current_index_id = await session.scalar(
        select(ArtifactSearchHead.index_id).where(
            ArtifactSearchHead.artifact_id == index.artifact_id
        )
    )
    current_generation = None
    if current_index_id is not None:
        current_generation = await session.scalar(
            select(ArtifactTextIndex.generation).where(
                ArtifactTextIndex.id == current_index_id
            )
        )
    await session.execute(
        update(ArtifactTextIndex)
        .where(ArtifactTextIndex.id == lease.generation_id)
        .values(status="ready", chunk_count=chunk_count, failure_code=None, updated_at=now)
    )
    if current_generation is None or current_generation < index.generation:
        await session.execute(
            insert(ArtifactSearchHead)
            .values(
                artifact_id=index.artifact_id,
                index_id=index.id,
                version_id=index.version_id,
                updated_at=now,
            )
            .on_conflict_do_update(
                index_elements=["artifact_id"],
                set_={"index_id": index.id, "version_id": index.version_id, "updated_at": now},
            )
        )
    await session.execute(
        update(ArtifactIndexJob)
        .where(ArtifactIndexJob.id == lease.job_id)
        .values(
            status="succeeded",
            lease_token=None,
            lease_expires_at=None,
            failure_code=None,
            updated_at=now,
        )
    )
    await _audit_index_transition(session, lease, "artifact.index.ready", "ready")
    return True


async def _retry(
    dependencies: _ArtifactIndexingDependencies,
    lease: ArtifactIndexLease,
) -> None:
    async with dependencies.sessions() as session:
        async with session.begin():
            await retry_index_job(
                session,
                lease,
                now=dependencies.clock(),
                failure_code=_INDEX_FAILURE,
            )


async def _fail_input(
    dependencies: _ArtifactIndexingDependencies,
    lease: ArtifactIndexLease,
    code: str,
) -> None:
    async with dependencies.sessions() as session:
        async with session.begin():
            await fail_index_job(session, lease, now=dependencies.clock(), failure_code=code)


async def _process_with_dependencies(
    lease: ArtifactIndexLease,
    dependencies: _ArtifactIndexingDependencies,
) -> None:
    work = await _load_work(dependencies, lease)
    if work is None:
        await _fail_input(dependencies, lease, _INDEX_FAILURE)
        return
    try:
        payload = await asyncio.to_thread(_read_exact, dependencies.gateway, work)
        chunks = await asyncio.to_thread(
            chunk_text, payload, work.content_type, dependencies.tokenizer
        )
        vectors = await _embed_chunks(dependencies.embedder, chunks)
    except RetrievalInputError as error:
        await _fail_input(dependencies, lease, str(error))
        return
    except (RetrievalUnavailableError, _ContentIdentityMismatch, HTTPError, OSError, TimeoutError, S3Error):
        await _retry(dependencies, lease)
        return

    try:
        async with dependencies.sessions() as session:
            async with session.begin():
                owned = await _persist_chunks(
                    session,
                    lease,
                    chunks,
                    vectors,
                    now=dependencies.clock(),
                )
        if not owned:
            return
        async with dependencies.sessions() as session:
            async with session.begin():
                await publish_index(
                    session,
                    lease,
                    now=dependencies.clock(),
                    chunk_count=len(chunks),
                )
    except (HTTPError, OSError, TimeoutError, S3Error, RuntimeError, SQLAlchemyError):
        await _retry(dependencies, lease)


@asynccontextmanager
async def _runtime_dependencies() -> AsyncIterator[_ArtifactIndexingDependencies]:
    configured = _ArtifactIndexingSettings()
    engine = create_worker_database_engine(configured)
    http_client = httpx.AsyncClient(
        base_url=configured.EMBEDDING_URL,
        timeout=configured.EMBEDDING_TIMEOUT,
    )
    try:
        yield _ArtifactIndexingDependencies(
            sessions=async_sessionmaker(engine, expire_on_commit=False),
            gateway=MinioGateway.from_worker_settings(configured),
            tokenizer=await asyncio.to_thread(_BgeTokenizer),
            embedder=EmbeddingClient(http_client),
            clock=lambda: datetime.now(UTC),
        )
    finally:
        await http_client.aclose()
        await engine.dispose()


async def process_artifact_index_job(lease: ArtifactIndexLease) -> None:
    """Process one leased generation without retaining content after completion."""

    async with _runtime_dependencies() as dependencies:
        await _process_with_dependencies(lease, dependencies)
