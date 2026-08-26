import asyncio
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.artifact import Artifact, ArtifactProcessingJob, ArtifactVersion
from app.models.xagent_session import XAgentIdempotencyKey
from app.storage.minio_gateway import ObjectMetadata
from tests.api.test_artifact_queries import _headers, _login, _version
from tests.api.test_artifact_uploads import _authenticate


class RetryGateway:
    def __init__(self, versions: tuple[ArtifactVersion, ...]) -> None:
        self._metadata = {
            version.staging_key: ObjectMetadata(
                size=version.actual_size or 0,
                content_type=version.detected_content_type,
                etag=version.staging_etag,
            )
            for version in versions
        }

    def stat(self, key: str) -> ObjectMetadata:
        return self._metadata[key]


async def _seed_failed_versions(
    engine,
    actor_id: UUID,
    count: int,
) -> tuple[ArtifactVersion, ...]:
    artifacts = [
        Artifact(
            id=uuid4(),
            filename=f"retry-{index}.txt",
            created_by_id=actor_id,
            owner_id=actor_id,
        )
        for index in range(count)
    ]
    versions = tuple(
        _version(artifact, actor_id, number=1, status="failed")
        for artifact in artifacts
    )
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            session.add_all(artifacts)
            await session.flush()
            session.add_all(versions)
            await session.flush()
            session.add_all(
                ArtifactProcessingJob(
                    version_id=version.id,
                    status="dead",
                    attempts=5,
                    next_attempt_at=datetime.now(UTC),
                    failure_code="inspection-unavailable",
                )
                for version in versions
            )
    return versions


async def _retry(client, token: str, version_id: UUID, key: str):
    return await client.post(
        f"/internal/xagent/artifact-versions/{version_id}/retry",
        headers=_headers(token),
        json={"idempotency_key": key},
    )


@pytest.mark.anyio
async def test_concurrent_retry_same_key_replays_one_transition(
    client,
    seeded_database,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    second_token = await _authenticate(client, "alice@example.test")
    (version,) = await _seed_failed_versions(seeded_database, alice.id, 1)
    monkeypatch.setattr(
        "app.services.artifacts._runtime_gateway",
        lambda: RetryGateway((version,)),
    )

    responses = await asyncio.gather(
        _retry(client, token, version.id, "same-key"),
        _retry(client, second_token, version.id, "same-key"),
    )

    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].json() == responses[1].json()
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        jobs = await session.scalar(
            select(func.count())
            .select_from(ArtifactProcessingJob)
            .where(ArtifactProcessingJob.version_id == version.id)
        )
    assert jobs == 1


@pytest.mark.anyio
async def test_concurrent_retry_same_key_with_different_versions_conflicts(
    client,
    seeded_database,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    second_token = await _authenticate(client, "alice@example.test")
    versions = await _seed_failed_versions(seeded_database, alice.id, 2)
    monkeypatch.setattr(
        "app.services.artifacts._runtime_gateway",
        lambda: RetryGateway(versions),
    )

    responses = await asyncio.gather(
        _retry(client, token, versions[0].id, "shared-key"),
        _retry(client, second_token, versions[1].id, "shared-key"),
    )

    assert sorted(response.status_code for response in responses) == [200, 409]
    conflict = next(response for response in responses if response.status_code == 409)
    assert conflict.json() == {"detail": {"code": "idempotency-conflict"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        stored = await session.scalar(
            select(func.count())
            .select_from(XAgentIdempotencyKey)
            .where(XAgentIdempotencyKey.operation == "artifact.version.retry")
        )
    assert stored == 1


@pytest.mark.anyio
async def test_concurrent_retry_different_keys_allows_only_one_version_transition(
    client,
    seeded_database,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    second_token = await _authenticate(client, "alice@example.test")
    (version,) = await _seed_failed_versions(seeded_database, alice.id, 1)
    monkeypatch.setattr(
        "app.services.artifacts._runtime_gateway",
        lambda: RetryGateway((version,)),
    )

    responses = await asyncio.gather(
        _retry(client, token, version.id, "key-one"),
        _retry(client, second_token, version.id, "key-two"),
    )

    assert sorted(response.status_code for response in responses) == [200, 404]
    rejected = next(response for response in responses if response.status_code == 404)
    assert rejected.json() == {"detail": {"code": "not-found"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        stored = await session.scalar(
            select(func.count())
            .select_from(XAgentIdempotencyKey)
            .where(XAgentIdempotencyKey.operation == "artifact.version.retry")
        )
    assert stored == 1


@pytest.mark.anyio
async def test_retry_replay_returns_the_original_detail_after_worker_progress(
    client,
    seeded_database,
    alice,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    (version,) = await _seed_failed_versions(seeded_database, alice.id, 1)
    monkeypatch.setattr(
        "app.services.artifacts._runtime_gateway",
        lambda: RetryGateway((version,)),
    )

    first = await _retry(client, token, version.id, "durable-replay")
    assert first.status_code == 200
    assert first.json()["latest_status"] == "pending"
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "UPDATE artifact_versions SET scan_status = 'scanning' "
                "WHERE id = :version_id"
            ),
            {"version_id": version.id},
        )

    replay = await _retry(client, token, version.id, "durable-replay")

    assert replay.status_code == 200
    assert replay.json() == first.json()
