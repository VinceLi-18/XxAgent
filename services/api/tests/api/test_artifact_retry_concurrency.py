import asyncio
from copy import deepcopy
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
from tests.api.test_artifact_uploads import _downgrade_grant_to_read, _select_project_with_temporary_edit


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
    project_id: UUID | None = None,
) -> tuple[ArtifactVersion, ...]:
    artifacts = [
        Artifact(
            id=uuid4(),
            filename=f"retry-{index}.txt",
            created_by_id=actor_id,
            owner_id=actor_id if project_id is None else None,
            project_id=project_id,
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
        json={"schema_version": 2, "idempotency_key": key},
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
    assert first.json()["versions"][0]["status"] == "pending"
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


@pytest.mark.anyio
async def test_retry_replay_rejects_corrupt_details_without_mutation(
    client, seeded_database, alice, monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    (version,) = await _seed_failed_versions(seeded_database, alice.id, 1)
    monkeypatch.setattr("app.services.artifacts._runtime_gateway", lambda: RetryGateway((version,)))
    first = await _retry(client, token, version.id, "corrupt-replay")
    assert first.status_code == 200
    await _assert_corrupt_replays(
        client, seeded_database, alice.id, token,
        "artifact.version.retry", "corrupt-replay",
        f"/internal/xagent/artifact-versions/{version.id}/retry",
        {"schema_version": 2, "idempotency_key": "corrupt-replay"},
    )


@pytest.mark.anyio
async def test_retry_replay_rechecks_current_project_edit_before_saved_detail(
    client, seeded_database, alice, bob, bob_project, monkeypatch: pytest.MonkeyPatch,
) -> None:
    token, grant = await _select_project_with_temporary_edit(client, seeded_database, alice, bob, bob_project)
    (version,) = await _seed_failed_versions(seeded_database, alice.id, 1, bob_project.id)
    monkeypatch.setattr("app.services.artifacts._runtime_gateway", lambda: RetryGateway((version,)))
    first = await _retry(client, token, version.id, "revoked-retry")
    assert first.status_code == 200
    assert first.json()["scope"] == {"kind": "project", "project_id": str(bob_project.id)}
    async with AsyncSession(seeded_database) as session, session.begin():
        stored = await session.get(XAgentIdempotencyKey, (alice.id, "artifact.version.retry", "revoked-retry"))
        stored.result = {**stored.result, "detail": {"private": "corruption-must-not-bypass-authorization"}}
    token = await _downgrade_grant_to_read(client, seeded_database, grant.id)
    replay = await _retry(client, token, version.id, "revoked-retry")
    assert replay.status_code == 404
    assert replay.json() == {"detail": {"code": "not-found"}}


async def _assert_corrupt_replays(client, engine, actor_id, token, operation, key, path, body):
    async def state():
        async with engine.connect() as connection:
            return [
                (await connection.execute(text(f"SELECT to_jsonb(t) FROM {table} t ORDER BY id"))).scalars().all()
                for table in ("artifact_versions", "artifact_processing_jobs", "staging_uploads")
            ]

    baseline = await state()
    async with AsyncSession(engine) as session:
        stored = await session.get(XAgentIdempotencyKey, (actor_id, operation, key))
        original = deepcopy(stored.result)
    detail = original["detail"]
    corruptions = [
        None, {}, {key: value for key, value in detail.items() if key != "schema_version"},
        {**detail, "schema_version": 1}, {**detail, "schema_version": 3},
        {**detail, "latest_version": 1}, {**detail, "can_edit": "true"},
        {**detail, "scope": {"kind": "private", "owner_id": "private-secret"}},
        {**detail, "scope": {"kind": "project", "project_id": "invalid"}},
        {**detail, "versions": []}, {**detail, "versions": None},
        {**detail, "versions": detail["versions"] * 2},
        {**detail, "versions": [
            {**detail["versions"][0], "id": str(uuid4()), "version": number}
            for number in range(1001, 0, -1)
        ]},
    ]
    version = detail["versions"][0]
    corruptions.extend({**detail, "versions": [{**version, field: value}]} for field, value in (
        ("id", "invalid"), ("version", 0), ("version", "1"), ("size", -1),
        ("size", 50 * 1024 * 1024 + 1), ("size", None),
        ("sha256", "A" * 64), ("sha256", "a" * 64), ("status", "unknown"),
        ("created_at", "invalid"), ("original_filename", ""), ("content_type", ""),
    ))
    corruptions.append({**detail, "versions": [version, {**version, "id": str(uuid4()), "version": 2}]})
    corruptions.append({**detail, "versions": [{**version, "id": str(uuid4())}, version]})
    corruptions.append({**detail, "versions": [{**version, "version": 2}, version]})
    for corrupt in corruptions:
        saved = {**original, "detail": corrupt}
        async with AsyncSession(engine) as session, session.begin():
            stored = await session.get(XAgentIdempotencyKey, (actor_id, operation, key))
            stored.result = saved
        async with engine.connect() as connection:
            keys_before = (await connection.execute(text(
                "SELECT to_jsonb(k) FROM xagent_idempotency_keys k ORDER BY actor_id, operation, idempotency_key"
            ))).scalars().all()
        response = await client.post(path, headers=_headers(token), json=body)
        assert response.status_code == 503
        assert response.json() == {"detail": {"code": "service-unavailable"}}
        assert await state() == baseline
        async with engine.connect() as connection:
            keys_after = (await connection.execute(text(
                "SELECT to_jsonb(k) FROM xagent_idempotency_keys k ORDER BY actor_id, operation, idempotency_key"
            ))).scalars().all()
        assert keys_after == keys_before


@pytest.mark.anyio
async def test_detail_and_retry_require_version_before_initial_work_or_replay(
    client, seeded_database, alice, monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    (version,) = await _seed_failed_versions(seeded_database, alice.id, 1)
    monkeypatch.setattr("app.services.artifacts._runtime_gateway", lambda: RetryGateway((version,)))
    for replay in (False, True):
        for transport in ({}, {"schema_version": 1}, {"schema_version": 3}):
            for path, body in (
                (f"/internal/xagent/artifacts/{version.artifact_id}", transport),
                (f"/internal/xagent/artifact-versions/{version.id}/retry", {**transport, "idempotency_key": "version-required"}),
            ):
                response = await client.post(path, headers=_headers(token), json=body)
                assert response.status_code == 422
        async with AsyncSession(seeded_database) as session:
            stored_version = await session.get(ArtifactVersion, version.id)
            assert stored_version.scan_status == ("pending" if replay else "failed")
            count = await session.scalar(select(func.count()).select_from(XAgentIdempotencyKey).where(
                XAgentIdempotencyKey.operation == "artifact.version.retry",
            ))
            assert count == int(replay)
        if not replay:
            assert (await _retry(client, token, version.id, "version-required")).status_code == 200
