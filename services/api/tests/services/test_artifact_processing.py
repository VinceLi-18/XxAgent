import asyncio
import hashlib
import sys
import threading
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.models.artifact import ArtifactProcessingJob, ArtifactVersion
from app.services import artifact_processing
from app.services.artifact_jobs import ArtifactJobLease, claim_due_job
from app.services.artifact_processing import ArtifactInspection, process_artifact_job
from app.services.malware import MalwareServiceUnavailable, MalwareVerdict
from app.storage.minio_gateway import ObjectMetadata

EICAR = (
    b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!"
    b"$H+H*"
)


@dataclass(frozen=True)
class SeededArtifactJob:
    artifact_id: UUID
    version_id: UUID
    job_id: UUID
    staging_key: str
    etag: str
    body: bytes


class ControlledGateway:
    def __init__(self, seeded: SeededArtifactJob) -> None:
        self.objects = {seeded.staging_key: seeded.body}
        self.etags = {seeded.staging_key: seeded.etag}
        self.stream_calls = 0
        self.copy_calls: list[tuple[str, str, str | None]] = []
        self.removed: list[str] = []
        self.removal_versions: list[tuple[str, str | None]] = []
        self.after_stream = None
        self.copy_started: threading.Event | None = None
        self.copy_release: threading.Event | None = None
        self.stream_error: Exception | None = None

    def require_versioning(self) -> None:
        pass

    def stat(self, key: str) -> ObjectMetadata:
        body = self.objects[key]
        return ObjectMetadata(size=len(body), content_type=None, etag=self.etags[key])

    def stream(self, key: str) -> Iterator[bytes]:
        self.stream_calls += 1
        body = self.objects[key]
        midpoint = max(1, len(body) // 2)
        yield body[:midpoint]
        if self.stream_error is not None:
            raise self.stream_error
        yield body[midpoint:]
        if self.after_stream is not None:
            self.after_stream()

    def copy(
        self,
        source: str,
        target: str,
        etag: str | None = None,
    ) -> str:
        self.copy_calls.append((source, target, etag))
        if self.copy_started is not None:
            self.copy_started.set()
        if self.copy_release is not None:
            assert self.copy_release.wait(timeout=2)
        if self.etags[source] != etag:
            raise RuntimeError("source precondition failed")
        self.objects[target] = self.objects[source]
        self.etags[target] = self.etags[source]
        return "target-version-1"

    def remove(self, key: str, version_id: str | None = None) -> None:
        self.removed.append(key)
        self.removal_versions.append((key, version_id))
        self.objects.pop(key, None)
        self.etags.pop(key, None)


class ConsumingScanner:
    def __init__(self, verdict: MalwareVerdict = MalwareVerdict.CLEAN) -> None:
        self.verdict = verdict
        self.payloads: list[bytes] = []

    def scan_stream(self, chunks) -> MalwareVerdict:
        self.payloads.append(b"".join(chunks))
        return self.verdict


@pytest.mark.parametrize(
    ("sample", "expected"),
    [
        (b"safe text\n", "text/plain"),
        (b"<!doctype html><title>x</title>", "text/html"),
        (b"<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml"),
        (b"#!/bin/sh\necho x\n", "text/x-shellscript"),
    ],
)
def test_deterministic_text_signatures_do_not_depend_on_magic(
    monkeypatch: pytest.MonkeyPatch,
    sample: bytes,
    expected: str,
) -> None:
    class BrokenMagic:
        @staticmethod
        def from_buffer(_sample: bytes, *, mime: bool) -> str:
            del mime
            raise RuntimeError("libmagic unavailable")

    monkeypatch.setitem(sys.modules, "magic", BrokenMagic)

    assert artifact_processing._detect_content_type(sample) == expected


def test_magic_failure_does_not_classify_control_bytes_as_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class BrokenMagic:
        @staticmethod
        def from_buffer(_sample: bytes, *, mime: bool) -> str:
            del mime
            raise RuntimeError("libmagic unavailable")

    monkeypatch.setitem(sys.modules, "magic", BrokenMagic)

    assert artifact_processing._detect_content_type(b"\x01\x02\x03\x04") == (
        "application/octet-stream"
    )


class VersionedPromotionGateway(ControlledGateway):
    def __init__(self, seeded: SeededArtifactJob, *, first_copy: str) -> None:
        super().__init__(seeded)
        self.first_copy = first_copy
        self.first_copy_reached = threading.Event()
        self.release_first_copy = threading.Event()
        self.final_versions: dict[str, list[tuple[str, bytes]]] = {}
        self.copy_versions: dict[int, str] = {}
        self.versioned_removals: list[tuple[str, str | None]] = []
        self._copy_lock = threading.Lock()
        self._copy_count = 0

    def require_versioning(self) -> None:
        pass

    def copy(
        self,
        source: str,
        target: str,
        etag: str | None = None,
    ) -> str:
        body = self.objects[source]
        with self._copy_lock:
            self._copy_count += 1
            ordinal = self._copy_count
        version_id = f"target-version-{ordinal}"
        if ordinal == 1 and self.first_copy == "late":
            self.first_copy_reached.set()
            assert self.release_first_copy.wait(timeout=2)
        self.final_versions.setdefault(target, []).append((version_id, body))
        self.copy_versions[ordinal] = version_id
        if ordinal == 1 and self.first_copy == "early":
            self.first_copy_reached.set()
            assert self.release_first_copy.wait(timeout=2)
        return version_id

    def remove(self, key: str, version_id: str | None = None) -> None:
        if key.startswith("staging/"):
            super().remove(key)
            return
        self.versioned_removals.append((key, version_id))
        versions = self.final_versions[key]
        if version_id is None:
            versions.pop()
            return
        self.final_versions[key] = [
            version for version in versions if version[0] != version_id
        ]

    def current_version(self, key: str) -> str:
        return self.final_versions[key][-1][0]

    def read_version(self, key: str, version_id: str) -> bytes:
        for candidate, body in self.final_versions[key]:
            if candidate == version_id:
                return body
        raise KeyError(version_id)


async def _seed_claimed_job(
    database: AsyncEngine,
    worker_engine: AsyncEngine,
    *,
    actor_id: UUID,
    body: bytes,
    sha256: str | None = None,
    attempts: int = 0,
) -> tuple[SeededArtifactJob, ArtifactJobLease]:
    now = datetime.now(UTC)
    artifact_id = uuid4()
    version_id = uuid4()
    job_id = uuid4()
    staging_key = f"staging/{uuid4()}"
    etag = f"etag-{uuid4()}"
    async with database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                "VALUES (:id, 'processing-test', :actor_id, :actor_id)"
            ),
            {"id": artifact_id, "actor_id": actor_id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, "
                "uploaded_by_id, declared_size, actual_size, scan_status, staging_key, "
                "staging_etag, staging_expires_at, object_key, size, sha256) "
                "VALUES (:id, :artifact_id, :actor_id, 1, 'processing-test', :actor_id, "
                ":size, :size, 'pending', :staging_key, :etag, :expires_at, NULL, :size, :sha256)"
            ),
            {
                "id": version_id,
                "artifact_id": artifact_id,
                "actor_id": actor_id,
                "size": len(body),
                "staging_key": staging_key,
                "etag": etag,
                "expires_at": now + timedelta(days=1),
                "sha256": sha256 or hashlib.sha256(body).hexdigest(),
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_processing_jobs "
                "(id, version_id, status, attempts, next_attempt_at) "
                "VALUES (:id, :version_id, 'ready', :attempts, :now)"
            ),
            {"id": job_id, "version_id": version_id, "attempts": attempts, "now": now},
        )
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)
    async with sessions() as session:
        async with session.begin():
            lease = await claim_due_job(session, now=now, lease_seconds=60)
    assert lease is not None and lease.job_id == job_id
    return SeededArtifactJob(artifact_id, version_id, job_id, staging_key, etag, body), lease


def _install_dependencies(
    monkeypatch: pytest.MonkeyPatch,
    worker_engine: AsyncEngine,
    gateway: ControlledGateway,
    scanner: object,
) -> None:
    sessions = async_sessionmaker(worker_engine, expire_on_commit=False)

    @asynccontextmanager
    async def dependencies() -> AsyncIterator[object]:
        yield artifact_processing._ArtifactProcessingDependencies(
            sessions=sessions,
            gateway=gateway,
            scanner=scanner,
            clock=lambda: datetime.now(UTC),
        )

    monkeypatch.setattr(artifact_processing, "_runtime_dependencies", dependencies)


async def _replace_lease(
    database: AsyncEngine,
    lease: ArtifactJobLease,
) -> ArtifactJobLease:
    replacement_token = uuid4()
    async with database.begin() as connection:
        await connection.execute(
            text(
                "UPDATE artifact_processing_jobs SET attempts = attempts + 1, "
                "lease_token = :token, lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '1 minute' "
                "WHERE id = :id"
            ),
            {"token": replacement_token, "id": lease.job_id},
        )
    return ArtifactJobLease(
        job_id=lease.job_id,
        version_id=lease.version_id,
        lease_token=replacement_token,
        attempt=lease.attempt + 1,
    )


async def _load_state(
    database: AsyncEngine,
    seeded: SeededArtifactJob,
) -> tuple[ArtifactVersion, ArtifactProcessingJob]:
    async with AsyncSession(database, expire_on_commit=False) as session:
        version = await session.get(ArtifactVersion, seeded.version_id)
        job = await session.get(ArtifactProcessingJob, seeded.job_id)
    assert version is not None and job is not None
    return version, job


@pytest.mark.anyio
async def test_clean_artifact_is_streamed_once_and_published_atomically(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice, monkeypatch: pytest.MonkeyPatch
) -> None:
    seeded, lease = await _seed_claimed_job(
        seeded_database, worker_engine, actor_id=alice.id, body=b"plain text\n"
    )
    gateway = ControlledGateway(seeded)
    scanner = ConsumingScanner()
    _install_dependencies(monkeypatch, worker_engine, gateway, scanner)

    await process_artifact_job(lease)

    version, job = await _load_state(seeded_database, seeded)
    final_key = f"artifacts/{seeded.artifact_id}/{seeded.version_id}"
    assert gateway.stream_calls == 1
    assert scanner.payloads == [seeded.body]
    assert gateway.copy_calls == [
        (seeded.staging_key, final_key, seeded.etag)
    ]
    assert gateway.objects[final_key] == seeded.body
    assert gateway.removed == [seeded.staging_key]
    assert version.scan_status == "clean" and version.object_key == final_key
    assert version.actual_size == len(seeded.body)
    assert version.sha256 == hashlib.sha256(seeded.body).hexdigest()
    assert version.detected_content_type == "text/plain"
    assert job.status == "succeeded" and job.lease_token is None


@pytest.mark.anyio
async def test_eicar_artifact_is_quarantined_without_creating_a_final_object(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice, monkeypatch: pytest.MonkeyPatch
) -> None:
    seeded, lease = await _seed_claimed_job(
        seeded_database, worker_engine, actor_id=alice.id, body=EICAR
    )
    gateway = ControlledGateway(seeded)
    _install_dependencies(monkeypatch, worker_engine, gateway, ConsumingScanner(MalwareVerdict.INFECTED))

    await process_artifact_job(lease)

    version, job = await _load_state(seeded_database, seeded)
    assert version.scan_status == "quarantined" and version.object_key is None
    assert job.status == "succeeded"
    assert gateway.copy_calls == []
    assert gateway.removed == [seeded.staging_key]


@pytest.mark.anyio
@pytest.mark.parametrize("attempts", (0, 4))
async def test_scanner_unavailability_retries_then_fails_on_attempt_five(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
    monkeypatch: pytest.MonkeyPatch,
    attempts: int,
) -> None:
    seeded, lease = await _seed_claimed_job(
        seeded_database, worker_engine, actor_id=alice.id, body=b"content", attempts=attempts
    )
    gateway = ControlledGateway(seeded)

    class UnavailableScanner:
        def scan_stream(self, chunks):
            list(chunks)
            raise MalwareServiceUnavailable("clamav unavailable")

    _install_dependencies(monkeypatch, worker_engine, gateway, UnavailableScanner())
    await process_artifact_job(lease)

    version, job = await _load_state(seeded_database, seeded)
    assert job.status == ("ready" if attempts == 0 else "dead")
    assert job.failure_code == "inspection-unavailable"
    assert version.scan_status == ("scanning" if attempts == 0 else "failed")
    assert gateway.copy_calls == [] and gateway.removed == []


@pytest.mark.anyio
async def test_interrupted_object_stream_is_retryable(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice, monkeypatch: pytest.MonkeyPatch
) -> None:
    seeded, lease = await _seed_claimed_job(
        seeded_database, worker_engine, actor_id=alice.id, body=b"content"
    )
    gateway = ControlledGateway(seeded)
    gateway.stream_error = OSError("stream interrupted")

    class WrappingScanner:
        def scan_stream(self, chunks):
            try:
                b"".join(chunks)
            except OSError as error:
                raise MalwareServiceUnavailable from error
            return MalwareVerdict.CLEAN

    _install_dependencies(monkeypatch, worker_engine, gateway, WrappingScanner())
    await process_artifact_job(lease)

    version, job = await _load_state(seeded_database, seeded)
    assert version.scan_status == "scanning"
    assert job.status == "ready" and job.failure_code == "inspection-unavailable"
    assert gateway.stream_calls == 1 and gateway.copy_calls == []


@pytest.mark.anyio
@pytest.mark.parametrize("mutation", ("hash", "replacement"))
async def test_content_identity_drift_fails_closed_without_promotion(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
    monkeypatch: pytest.MonkeyPatch,
    mutation: str,
) -> None:
    seeded, lease = await _seed_claimed_job(
        seeded_database,
        worker_engine,
        actor_id=alice.id,
        body=b"trusted",
        sha256=("0" * 64 if mutation == "hash" else None),
    )
    gateway = ControlledGateway(seeded)
    if mutation == "replacement":
        def replace() -> None:
            gateway.objects[seeded.staging_key] = b"replaced"
            gateway.etags[seeded.staging_key] = "replacement-etag"

        gateway.after_stream = replace
    _install_dependencies(monkeypatch, worker_engine, gateway, ConsumingScanner())
    await process_artifact_job(lease)

    version, job = await _load_state(seeded_database, seeded)
    assert version.scan_status == "failed" and version.object_key is None
    assert job.status == "dead" and job.failure_code == "content-identity-mismatch"
    assert gateway.copy_calls == [] and gateway.removed == []


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("body", "expected_type"),
    (
        (b"<!doctype html><html><body>x</body></html>", "text/html"),
        (b'<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>', "image/svg+xml"),
        (b"#!/bin/sh\necho unsafe\n", "text/x-shellscript"),
        (bytes(range(256)), "application/octet-stream"),
    ),
)
async def test_content_type_is_detected_from_a_finite_body_sample(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
    monkeypatch: pytest.MonkeyPatch,
    body: bytes,
    expected_type: str,
) -> None:
    seeded, lease = await _seed_claimed_job(
        seeded_database, worker_engine, actor_id=alice.id, body=body
    )
    gateway = ControlledGateway(seeded)
    _install_dependencies(monkeypatch, worker_engine, gateway, ConsumingScanner())
    await process_artifact_job(lease)

    version, _job = await _load_state(seeded_database, seeded)
    assert version.detected_content_type == expected_type
    assert gateway.stream_calls == 1


@pytest.mark.anyio
@pytest.mark.parametrize("lease_loss", ("token", "expiry"))
async def test_lost_lease_after_copy_removes_only_this_workers_final_object(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
    monkeypatch: pytest.MonkeyPatch,
    lease_loss: str,
) -> None:
    seeded, lease = await _seed_claimed_job(
        seeded_database, worker_engine, actor_id=alice.id, body=b"content"
    )
    gateway = ControlledGateway(seeded)
    gateway.copy_started = threading.Event()
    gateway.copy_release = threading.Event()
    _install_dependencies(monkeypatch, worker_engine, gateway, ConsumingScanner())

    processing = asyncio.create_task(process_artifact_job(lease))
    assert await asyncio.to_thread(gateway.copy_started.wait, 2)
    expected_token = lease.lease_token
    async with seeded_database.begin() as connection:
        if lease_loss == "token":
            expected_token = uuid4()
            await connection.execute(
                text(
                    "UPDATE artifact_processing_jobs SET lease_token = :token, "
                    "lease_expires_at = CURRENT_TIMESTAMP + INTERVAL '1 minute' WHERE id = :id"
                ),
                {"token": expected_token, "id": seeded.job_id},
            )
        else:
            await connection.execute(
                text(
                    "UPDATE artifact_processing_jobs SET "
                    "lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = :id"
                ),
                {"id": seeded.job_id},
            )
    gateway.copy_release.set()
    await processing

    version, job = await _load_state(seeded_database, seeded)
    final_key = f"artifacts/{seeded.artifact_id}/{seeded.version_id}"
    assert version.scan_status == "scanning" and version.object_key is None
    assert job.status == "leased" and job.lease_token == expected_token
    assert gateway.removed == [final_key]
    assert gateway.removal_versions == [(final_key, "target-version-1")]
    assert seeded.staging_key in gateway.objects


@pytest.mark.anyio
async def test_database_publication_failure_removes_the_created_final_object(
    seeded_database: AsyncEngine, worker_engine: AsyncEngine, alice, monkeypatch: pytest.MonkeyPatch
) -> None:
    seeded, lease = await _seed_claimed_job(
        seeded_database, worker_engine, actor_id=alice.id, body=b"content"
    )
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "CREATE FUNCTION reject_test_publication() RETURNS trigger LANGUAGE plpgsql AS $$ "
                "BEGIN RAISE EXCEPTION 'forced publication failure'; END $$"
            )
        )
        await connection.execute(
            text(
                "CREATE TRIGGER reject_test_publication BEFORE UPDATE ON artifact_versions "
                "FOR EACH ROW WHEN (NEW.id = '" + str(seeded.version_id) + "') "
                "EXECUTE FUNCTION reject_test_publication()"
            )
        )
    gateway = ControlledGateway(seeded)
    _install_dependencies(monkeypatch, worker_engine, gateway, ConsumingScanner())

    with pytest.raises(Exception, match="forced publication failure"):
        await process_artifact_job(lease)

    version, job = await _load_state(seeded_database, seeded)
    final_key = f"artifacts/{seeded.artifact_id}/{seeded.version_id}"
    assert version.scan_status == "scanning" and version.object_key is None
    assert job.status == "leased" and job.lease_token == lease.lease_token
    assert gateway.removed == [final_key]
    assert gateway.removal_versions == [(final_key, "target-version-1")]
    assert seeded.staging_key in gateway.objects


@pytest.mark.anyio
@pytest.mark.parametrize("first_copy", ("early", "late"))
async def test_stale_worker_removes_only_its_target_version_after_new_worker_publishes(
    seeded_database: AsyncEngine,
    worker_engine: AsyncEngine,
    alice,
    monkeypatch: pytest.MonkeyPatch,
    first_copy: str,
) -> None:
    seeded, first_lease = await _seed_claimed_job(
        seeded_database,
        worker_engine,
        actor_id=alice.id,
        body=b"version-owned-content",
    )
    gateway = VersionedPromotionGateway(seeded, first_copy=first_copy)
    _install_dependencies(monkeypatch, worker_engine, gateway, ConsumingScanner())

    first_worker = asyncio.create_task(process_artifact_job(first_lease))
    assert await asyncio.to_thread(gateway.first_copy_reached.wait, 2)
    second_lease = await _replace_lease(seeded_database, first_lease)
    await process_artifact_job(second_lease)
    second_version = gateway.copy_versions[2]
    gateway.release_first_copy.set()
    await first_worker

    version, job = await _load_state(seeded_database, seeded)
    final_key = f"artifacts/{seeded.artifact_id}/{seeded.version_id}"
    first_version = gateway.copy_versions[1]
    assert version.scan_status == "clean" and version.object_key == final_key
    assert job.status == "succeeded" and job.lease_token is None
    assert gateway.current_version(final_key) == second_version
    assert gateway.read_version(final_key, second_version) == seeded.body
    with pytest.raises(KeyError):
        gateway.read_version(final_key, first_version)
    assert gateway.versioned_removals == [(final_key, first_version)]


def test_artifact_inspection_is_immutable_processing_output() -> None:
    inspection = ArtifactInspection(
        size=7,
        sha256="0" * 64,
        content_type="text/plain",
        malware="clean",
    )
    assert inspection == ArtifactInspection(7, "0" * 64, "text/plain", "clean")
