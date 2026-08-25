from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from argon2 import PasswordHasher
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.artifact import (
    Artifact,
    ArtifactProcessingJob,
    ArtifactVersion,
    StagingUpload,
)
from app.models.project import ProjectAction, ProjectMembership, TemporaryProjectGrant
from app.models.xagent_session import XAgentIdempotencyKey
from app.storage.minio_gateway import ObjectMetadata

PASSWORD = "correct horse battery staple"
SERVICE_TOKEN = "xagent-test-service-token-00000001"
MAX_ARTIFACT_SIZE = 50 * 1024 * 1024


class UploadUrlGateway:
    def __init__(self) -> None:
        self.put_calls: list[tuple[str, timedelta]] = []
        self.objects: dict[str, ObjectMetadata] = {}
        self.stat_calls: list[str] = []
        self.forbidden_calls: list[tuple[str, str]] = []
        self.scanner_calls: list[str] = []

    def create_staging_put_url(self, key: str, expires: timedelta) -> str:
        self.put_calls.append((key, expires))
        return f"https://storage.test/put/{key}"

    def stat(self, key: str) -> ObjectMetadata:
        self.stat_calls.append(key)
        return self.objects[key]

    def stream(self, key: str):
        self.forbidden_calls.append(("stream", key))
        raise AssertionError("完成上传不得读取对象正文")

    def copy(self, source: str, target: str, etag: str | None = None) -> None:
        self.forbidden_calls.append(("copy", source))
        raise AssertionError("完成上传不得复制对象")

    def remove(self, key: str) -> None:
        self.forbidden_calls.append(("remove", key))
        raise AssertionError("完成上传不得删除暂存对象")


@pytest.fixture
def artifact_gateway(monkeypatch: pytest.MonkeyPatch) -> UploadUrlGateway:
    gateway = UploadUrlGateway()

    def reject_scanner_start(*_args, **_kwargs):
        gateway.scanner_calls.append("from_settings")
        raise AssertionError("完成上传不得启动病毒扫描")

    monkeypatch.setattr(
        "app.services.artifacts._runtime_gateway",
        lambda: gateway,
        raising=False,
    )
    monkeypatch.setattr(
        "app.services.malware.ClamAvScanner.from_settings",
        reject_scanner_start,
    )
    return gateway


async def _login(client, engine, account, email: str) -> str:
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO xagent_account_credentials "
                    "(account_id, password_hash, password_changed_at) "
                    "VALUES (:account_id, :password_hash, CURRENT_TIMESTAMP)"
                ),
                {
                    "account_id": account.id,
                    "password_hash": PasswordHasher().hash(PASSWORD),
                },
            )
    return await _authenticate(client, email)


async def _authenticate(client, email: str) -> str:
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": PASSWORD},
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def _headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "X-XAgent-Service-Token": SERVICE_TOKEN,
    }


async def _create_upload(
    client,
    token: str,
    *,
    filename: str,
    size: int,
    key: str,
    artifact_id: UUID | None = None,
):
    path = (
        f"/internal/xagent/artifacts/{artifact_id}/uploads"
        if artifact_id is not None
        else "/internal/xagent/artifacts/uploads"
    )
    return await client.post(
        path,
        headers=_headers(token),
        json={"filename": filename, "size": size, "idempotency_key": key},
    )


async def _complete_upload(
    client,
    token: str,
    upload_id: UUID | str,
    *,
    actual_size: int,
    sha256: str,
    key: str,
    **extra: object,
):
    return await client.post(
        f"/internal/xagent/artifacts/uploads/{upload_id}/complete",
        headers=_headers(token),
        json={
            "actual_size": actual_size,
            "sha256": sha256,
            "idempotency_key": key,
            **extra,
        },
    )


async def _select_project_with_temporary_edit(
    client,
    engine,
    alice,
    bob,
    project,
) -> tuple[str, TemporaryProjectGrant]:
    grant = TemporaryProjectGrant(
        project_id=project.id,
        account_id=alice.id,
        action=ProjectAction.EDIT,
        granted_by_id=bob.id,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            session.add(grant)
    token = await _login(client, engine, alice, "alice@example.test")
    selected = await client.post(
        "/internal/xagent/workbench/context",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "kind": "project",
            "project_id": str(project.id),
        },
    )
    assert selected.status_code == 200
    return token, grant


async def _downgrade_grant_to_read(client, engine, grant_id: UUID) -> str:
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            grant = await session.get(TemporaryProjectGrant, grant_id)
            assert grant is not None
            grant.action = ProjectAction.READ
    return await _authenticate(client, "alice@example.test")


@pytest.mark.anyio
async def test_internal_artifact_route_rejects_a_missing_host_or_user_identity(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    payload = {"filename": "双重认证.txt", "size": 1, "idempotency_key": "auth"}

    missing_host = await client.post(
        "/internal/xagent/artifacts/uploads",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
    )
    missing_user = await client.post(
        "/internal/xagent/artifacts/uploads",
        headers={"X-XAgent-Service-Token": SERVICE_TOKEN},
        json=payload,
    )

    assert missing_host.status_code == 403
    assert missing_host.json() == {"detail": {"code": "service-unauthorized"}}
    assert missing_user.status_code == 401
    assert missing_user.json() == {"detail": {"code": "unauthenticated"}}


@pytest.mark.anyio
async def test_create_upload_persists_the_server_accepted_size_and_ten_minute_window(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    before = datetime.now(UTC)

    response = await _create_upload(
        client,
        token,
        filename="边界.bin",
        size=MAX_ARTIFACT_SIZE,
        key="private-max-size",
    )
    after = datetime.now(UTC)

    assert response.status_code == 201
    assert set(response.json()) == {"upload_id", "put_url", "expires_at"}
    upload_id = UUID(response.json()["upload_id"])
    expires_at = datetime.fromisoformat(response.json()["expires_at"])
    assert before + timedelta(minutes=10) <= expires_at <= after + timedelta(minutes=10)
    assert len(artifact_gateway.put_calls) == 1
    signed_key, signed_for = artifact_gateway.put_calls[0]
    assert signed_key == f"staging/{upload_id}"
    assert timedelta(minutes=9, seconds=50) <= signed_for <= timedelta(minutes=10)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        upload = await session.get(StagingUpload, upload_id)
        idempotency = await session.get(
            XAgentIdempotencyKey,
            (alice.id, "artifact.upload.create", "private-max-size"),
        )
    assert upload is not None
    assert idempotency is not None
    assert idempotency.result == {
        "upload_id": str(upload_id),
        "put_url": response.json()["put_url"],
    }
    assert (
        upload.expected_size,
        upload.artifact_id,
        upload.owner_id,
        upload.project_id,
        upload.staging_key,
    ) == (
        MAX_ARTIFACT_SIZE,
        None,
        alice.id,
        None,
        f"staging/{upload_id}",
    )


@pytest.mark.parametrize(
    "changes",
    (
        {"filename": ""},
        {"filename": "字" * 256},
        {"size": -1},
        {"size": MAX_ARTIFACT_SIZE + 1},
        {"idempotency_key": ""},
        {"idempotency_key": "k" * 129},
        {"owner_id": "00000000-0000-0000-0000-000000000001"},
    ),
)
@pytest.mark.anyio
async def test_create_upload_rejects_fields_outside_the_fixed_interface(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
    changes: dict[str, object],
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    payload: dict[str, object] = {
        "filename": "边界.txt",
        "size": 1,
        "idempotency_key": "fixed-create",
        **changes,
    }

    response = await client.post(
        "/internal/xagent/artifacts/uploads",
        headers=_headers(token),
        json=payload,
    )

    assert response.status_code == 422
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        count = await session.scalar(select(func.count()).select_from(StagingUpload))
    assert count == 0
    assert artifact_gateway.put_calls == []


@pytest.mark.anyio
async def test_create_upload_replays_same_request_and_rejects_same_key_with_new_input(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")

    first = await _create_upload(
        client,
        token,
        filename="幂等.txt",
        size=8,
        key="same-create-key",
    )
    replayed = await _create_upload(
        client,
        token,
        filename="幂等.txt",
        size=8,
        key="same-create-key",
    )
    conflict = await _create_upload(
        client,
        token,
        filename="不同.txt",
        size=8,
        key="same-create-key",
    )

    assert first.status_code == 201
    assert replayed.status_code == 201
    assert replayed.json() == first.json()
    assert conflict.status_code == 409
    assert conflict.json() == {"detail": {"code": "idempotency-conflict"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        count = await session.scalar(select(func.count()).select_from(StagingUpload))
    assert count == 1


@pytest.mark.anyio
async def test_create_upload_replay_returns_the_original_url_near_expiry(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial_time = datetime.now(UTC)

    class MutableDatetime(datetime):
        current = initial_time

        @classmethod
        def now(cls, tz=None):
            return cls.current if tz is not None else cls.current.replace(tzinfo=None)

    signed: list[tuple[str, timedelta]] = []

    def sign_with_time(key: str, expires: timedelta) -> str:
        signed.append((key, expires))
        return f"https://storage.test/put/{key}?signature={len(signed)}"

    monkeypatch.setattr("app.services.artifacts.datetime", MutableDatetime)
    monkeypatch.setattr(
        artifact_gateway,
        "create_staging_put_url",
        sign_with_time,
    )
    token = await _login(client, seeded_database, alice, "alice@example.test")
    first = await _create_upload(
        client,
        token,
        filename="临近到期.txt",
        size=2,
        key="near-expiry-create",
    )
    MutableDatetime.current = initial_time + timedelta(minutes=9, seconds=59)

    replayed = await _create_upload(
        client,
        token,
        filename="临近到期.txt",
        size=2,
        key="near-expiry-create",
    )

    assert replayed.status_code == 201
    assert replayed.json() == first.json()
    assert signed == [
        (f"staging/{first.json()['upload_id']}", timedelta(minutes=10))
    ]


@pytest.mark.anyio
async def test_create_upload_with_an_expired_key_allocates_a_fresh_upload(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial_time = datetime.now(UTC)

    class MutableDatetime(datetime):
        current = initial_time

        @classmethod
        def now(cls, tz=None):
            return cls.current if tz is not None else cls.current.replace(tzinfo=None)

    signed: list[tuple[str, timedelta]] = []

    def sign_with_time(key: str, expires: timedelta) -> str:
        signed.append((key, expires))
        return f"https://storage.test/put/{key}?signature={len(signed)}"

    monkeypatch.setattr("app.services.artifacts.datetime", MutableDatetime)
    monkeypatch.setattr(
        artifact_gateway,
        "create_staging_put_url",
        sign_with_time,
    )
    token = await _login(client, seeded_database, alice, "alice@example.test")
    first = await _create_upload(
        client,
        token,
        filename="已过期.txt",
        size=2,
        key="expired-create",
    )
    MutableDatetime.current = initial_time + timedelta(minutes=10, seconds=1)

    replacement = await _create_upload(
        client,
        token,
        filename="已过期.txt",
        size=2,
        key="expired-create",
    )

    assert replacement.status_code == 201
    assert replacement.json()["upload_id"] != first.json()["upload_id"]
    assert replacement.json()["put_url"] != first.json()["put_url"]
    assert datetime.fromisoformat(replacement.json()["expires_at"]) == (
        MutableDatetime.current + timedelta(minutes=10)
    )
    assert len(signed) == 2


@pytest.mark.anyio
async def test_same_filename_new_uploads_create_distinct_artifacts(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    artifact_ids: list[str] = []

    for ordinal in (1, 2):
        created = await _create_upload(
            client,
            token,
            filename="同名.txt",
            size=3,
            key=f"same-name-create-{ordinal}",
        )
        upload_id = UUID(created.json()["upload_id"])
        artifact_gateway.objects[f"staging/{upload_id}"] = ObjectMetadata(
            3, "text/plain", f"etag-{ordinal}"
        )
        completed = await _complete_upload(
            client,
            token,
            upload_id,
            actual_size=3,
            sha256=str(ordinal) * 64,
            key=f"same-name-complete-{ordinal}",
        )
        assert completed.status_code == 201
        artifact_ids.append(completed.json()["artifact_id"])

    assert artifact_ids[0] != artifact_ids[1]
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        artifacts = (await session.scalars(select(Artifact))).all()
    assert len(artifacts) == 2
    assert {artifact.filename for artifact in artifacts} == {"同名.txt"}


@pytest.mark.anyio
async def test_project_upload_requires_edit_in_the_normalized_workbench_context(
    client,
    seeded_database,
    alice,
    bob,
    bob_project,
    artifact_gateway: UploadUrlGateway,
) -> None:
    grant = TemporaryProjectGrant(
        project_id=bob_project.id,
        account_id=alice.id,
        action=ProjectAction.READ,
        granted_by_id=bob.id,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(grant)
    token = await _login(client, seeded_database, alice, "alice@example.test")

    selected = await client.post(
        "/internal/xagent/workbench/context",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "kind": "project",
            "project_id": str(bob_project.id),
        },
    )
    denied = await _create_upload(
        client,
        token,
        filename="只读.txt",
        size=8,
        key="read-grant",
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            stored_grant = await session.get(TemporaryProjectGrant, grant.id)
            assert stored_grant is not None
            stored_grant.action = ProjectAction.EDIT
    token = await _authenticate(client, "alice@example.test")
    allowed = await _create_upload(
        client,
        token,
        filename="可编辑.txt",
        size=9,
        key="edit-grant",
    )

    assert selected.status_code == 200
    assert denied.status_code == 404
    assert denied.json() == {"detail": {"code": "not-found"}}
    assert allowed.status_code == 201
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        upload = await session.get(StagingUpload, UUID(allowed.json()["upload_id"]))
    assert upload is not None
    assert (upload.owner_id, upload.project_id) == (None, bob_project.id)


@pytest.mark.anyio
async def test_explicit_upload_target_copies_the_existing_artifact_scope(
    client,
    seeded_database,
    alice,
    alice_project,
    artifact_gateway: UploadUrlGateway,
) -> None:
    artifact = Artifact(
        filename="项目资料.txt",
        created_by_id=alice.id,
        project_id=alice_project.id,
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(artifact)
    token = await _login(client, seeded_database, alice, "alice@example.test")

    response = await _create_upload(
        client,
        token,
        filename="项目资料修订.txt",
        size=11,
        key="explicit-project-version",
        artifact_id=artifact.id,
    )

    assert response.status_code == 201
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        upload = await session.get(StagingUpload, UUID(response.json()["upload_id"]))
    assert upload is not None
    assert (
        upload.artifact_id,
        upload.owner_id,
        upload.project_id,
        upload.expected_size,
    ) == (artifact.id, None, alice_project.id, 11)


@pytest.mark.anyio
async def test_explicit_upload_hides_an_inaccessible_artifact_target(
    client,
    seeded_database,
    alice,
    bob,
    artifact_gateway: UploadUrlGateway,
) -> None:
    artifact = Artifact(
        filename="Bob 私人资料.txt",
        created_by_id=bob.id,
        owner_id=bob.id,
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(artifact)
    token = await _login(client, seeded_database, alice, "alice@example.test")

    response = await _create_upload(
        client,
        token,
        filename="越权版本.txt",
        size=1,
        key="hidden-target",
        artifact_id=artifact.id,
    )

    assert response.status_code == 404
    assert response.json() == {"detail": {"code": "not-found"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        count = await session.scalar(select(func.count()).select_from(StagingUpload))
    assert count == 0


@pytest.mark.anyio
async def test_completion_fails_closed_after_project_membership_is_revoked(
    client,
    seeded_database,
    alice,
    bob_project,
    artifact_gateway: UploadUrlGateway,
) -> None:
    membership = ProjectMembership(
        id=uuid4(), project_id=bob_project.id, account_id=alice.id
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(membership)
    token = await _login(client, seeded_database, alice, "alice@example.test")
    selected = await client.post(
        "/internal/xagent/workbench/context",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "kind": "project",
            "project_id": str(bob_project.id),
        },
    )
    created = await _create_upload(
        client,
        token,
        filename="失权.txt",
        size=4,
        key="revoked-create",
    )
    upload_id = UUID(created.json()["upload_id"])
    artifact_gateway.objects[f"staging/{upload_id}"] = ObjectMetadata(
        4, "text/plain", "etag-revoked"
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            stored = await session.get(ProjectMembership, membership.id)
            assert stored is not None
            await session.delete(stored)
    token = await _authenticate(client, "alice@example.test")

    completed = await _complete_upload(
        client,
        token,
        upload_id,
        actual_size=4,
        sha256="d" * 64,
        key="revoked-complete",
    )

    assert selected.status_code == 200
    assert created.status_code == 201
    assert completed.status_code == 404
    assert completed.json() == {"detail": {"code": "not-found"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        version_count = await session.scalar(
            select(func.count()).select_from(ArtifactVersion)
        )
    assert version_count == 0


@pytest.mark.parametrize(
    "metadata",
    (
        ObjectMetadata(4, "text/plain", "etag-valid"),
        None,
        ObjectMetadata(3, "text/plain", "etag-wrong-size"),
    ),
)
@pytest.mark.anyio
async def test_first_completion_checks_current_project_edit_before_object_stat(
    client,
    seeded_database,
    alice,
    bob,
    bob_project,
    artifact_gateway: UploadUrlGateway,
    metadata: ObjectMetadata | None,
) -> None:
    token, grant = await _select_project_with_temporary_edit(
        client,
        seeded_database,
        alice,
        bob,
        bob_project,
    )
    created = await _create_upload(
        client,
        token,
        filename="降权首次完成.txt",
        size=4,
        key="downgraded-first-create",
    )
    upload_id = UUID(created.json()["upload_id"])
    if metadata is not None:
        artifact_gateway.objects[f"staging/{upload_id}"] = metadata
    token = await _downgrade_grant_to_read(client, seeded_database, grant.id)

    completed = await _complete_upload(
        client,
        token,
        upload_id,
        actual_size=4,
        sha256="a" * 64,
        key="downgraded-first-complete",
    )

    assert completed.status_code == 404
    assert completed.json() == {"detail": {"code": "not-found"}}
    assert artifact_gateway.stat_calls == []
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        version_count = await session.scalar(
            select(func.count()).select_from(ArtifactVersion)
        )
        job_count = await session.scalar(
            select(func.count()).select_from(ArtifactProcessingJob)
        )
    assert (version_count, job_count) == (0, 0)


@pytest.mark.anyio
async def test_completion_replay_and_conflict_check_current_project_edit_first(
    client,
    seeded_database,
    alice,
    bob,
    bob_project,
    artifact_gateway: UploadUrlGateway,
) -> None:
    token, grant = await _select_project_with_temporary_edit(
        client,
        seeded_database,
        alice,
        bob,
        bob_project,
    )
    created = await _create_upload(
        client,
        token,
        filename="降权幂等完成.txt",
        size=6,
        key="downgraded-replay-create",
    )
    upload_id = UUID(created.json()["upload_id"])
    artifact_gateway.objects[f"staging/{upload_id}"] = ObjectMetadata(
        6, "text/plain", "etag-replay"
    )
    first = await _complete_upload(
        client,
        token,
        upload_id,
        actual_size=6,
        sha256="b" * 64,
        key="downgraded-replay-complete",
    )
    assert first.status_code == 201
    artifact_gateway.stat_calls.clear()
    token = await _downgrade_grant_to_read(client, seeded_database, grant.id)

    replayed = await _complete_upload(
        client,
        token,
        upload_id,
        actual_size=6,
        sha256="b" * 64,
        key="downgraded-replay-complete",
    )
    conflict = await _complete_upload(
        client,
        token,
        upload_id,
        actual_size=6,
        sha256="c" * 64,
        key="downgraded-replay-complete",
    )

    assert replayed.status_code == conflict.status_code == 404
    assert replayed.json() == conflict.json() == {
        "detail": {"code": "not-found"}
    }
    assert artifact_gateway.stat_calls == []
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        version_count = await session.scalar(
            select(func.count()).select_from(ArtifactVersion)
        )
        job_count = await session.scalar(
            select(func.count()).select_from(ArtifactProcessingJob)
        )
    assert (version_count, job_count) == (1, 1)


@pytest.mark.anyio
async def test_complete_upload_enqueues_pending_work_without_synchronous_processing(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    created = await _create_upload(
        client,
        token,
        filename="异步.txt",
        size=7,
        key="async-create",
    )
    upload_id = UUID(created.json()["upload_id"])
    staging_key = f"staging/{upload_id}"
    artifact_gateway.objects[staging_key] = ObjectMetadata(
        size=7,
        content_type="text/plain",
        etag="etag-7",
    )
    before = datetime.now(UTC)

    completed = await _complete_upload(
        client,
        token,
        upload_id,
        actual_size=7,
        sha256="a" * 64,
        key="async-complete",
    )
    after = datetime.now(UTC)

    assert completed.status_code == 201
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        versions = (await session.scalars(select(ArtifactVersion))).all()
        jobs = (await session.scalars(select(ArtifactProcessingJob))).all()
        upload = await session.get(StagingUpload, upload_id)
    assert len(versions) == len(jobs) == 1
    version = versions[0]
    assert completed.json() == {
        "artifact_id": str(version.artifact_id),
        "version_id": str(version.id),
    }
    assert (
        version.version_number,
        version.declared_size,
        version.actual_size,
        version.detected_content_type,
        version.scan_status,
        version.staging_key,
        version.staging_etag,
        version.object_key,
        version.size,
        version.sha256,
    ) == (1, 7, 7, None, "pending", staging_key, "etag-7", None, 7, "a" * 64)
    assert version.staging_expires_at is not None
    assert before + timedelta(days=1) <= version.staging_expires_at <= after + timedelta(days=1)
    assert (jobs[0].version_id, jobs[0].status, jobs[0].attempts) == (
        version.id,
        "ready",
        0,
    )
    assert upload is not None
    assert artifact_gateway.stat_calls == [staging_key]
    assert artifact_gateway.forbidden_calls == []
    assert artifact_gateway.scanner_calls == []


@pytest.mark.anyio
async def test_complete_upload_rejects_a_missing_staging_object_as_invalid_upload(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    created = await _create_upload(
        client,
        token,
        filename="未上传.txt",
        size=5,
        key="missing-object-create",
    )
    upload_id = UUID(created.json()["upload_id"])

    completed = await _complete_upload(
        client,
        token,
        upload_id,
        actual_size=5,
        sha256="e" * 64,
        key="missing-object-complete",
    )

    assert completed.status_code == 422
    assert completed.json() == {"detail": {"code": "upload-rejected"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        version_count = await session.scalar(
            select(func.count()).select_from(ArtifactVersion)
        )
        upload = await session.get(StagingUpload, upload_id)
    assert version_count == 0
    assert upload is not None
    assert artifact_gateway.stat_calls == [f"staging/{upload_id}"]
    assert artifact_gateway.forbidden_calls == []


@pytest.mark.anyio
async def test_complete_upload_hides_an_unknown_or_inaccessible_upload(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")

    completed = await _complete_upload(
        client,
        token,
        uuid4(),
        actual_size=1,
        sha256="e" * 64,
        key="unknown-complete",
    )

    assert completed.status_code == 404
    assert completed.json() == {"detail": {"code": "not-found"}}
    assert artifact_gateway.stat_calls == []


@pytest.mark.parametrize(
    ("metadata", "actual_size"),
    (
        (ObjectMetadata(4, "text/plain", "etag-size"), 5),
        (ObjectMetadata(5, "text/plain", "etag-actual"), 4),
        (ObjectMetadata(5, "text/plain", "  "), 5),
    ),
)
@pytest.mark.anyio
async def test_complete_upload_rejects_size_mismatch_or_empty_etag_before_enqueue(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
    metadata: ObjectMetadata,
    actual_size: int,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    created = await _create_upload(
        client,
        token,
        filename="对象校验.txt",
        size=5,
        key="metadata-create",
    )
    upload_id = UUID(created.json()["upload_id"])
    artifact_gateway.objects[f"staging/{upload_id}"] = metadata

    completed = await _complete_upload(
        client,
        token,
        upload_id,
        actual_size=actual_size,
        sha256="f" * 64,
        key="metadata-complete",
    )

    assert completed.status_code == 422
    assert completed.json() == {"detail": {"code": "upload-rejected"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        version_count = await session.scalar(
            select(func.count()).select_from(ArtifactVersion)
        )
        job_count = await session.scalar(
            select(func.count()).select_from(ArtifactProcessingJob)
        )
    assert (version_count, job_count) == (0, 0)
    assert artifact_gateway.forbidden_calls == []


@pytest.mark.parametrize(
    "changes",
    (
        {"actual_size": -1},
        {"actual_size": MAX_ARTIFACT_SIZE + 1},
        {"sha256": "not-a-sha256"},
        {"idempotency_key": ""},
        {"idempotency_key": "k" * 129},
        {"artifact_id": "00000000-0000-0000-0000-000000000001"},
    ),
)
@pytest.mark.anyio
async def test_complete_upload_rejects_fields_outside_the_fixed_interface(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
    changes: dict[str, object],
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    created = await _create_upload(
        client,
        token,
        filename="完成边界.txt",
        size=1,
        key="fixed-complete-create",
    )
    upload_id = UUID(created.json()["upload_id"])
    artifact_gateway.objects[f"staging/{upload_id}"] = ObjectMetadata(
        1, "text/plain", "etag-fixed"
    )

    completed = await client.post(
        f"/internal/xagent/artifacts/uploads/{upload_id}/complete",
        headers=_headers(token),
        json={
            "actual_size": 1,
            "sha256": "a" * 64,
            "idempotency_key": "fixed-complete",
            **changes,
        },
    )

    assert completed.status_code == 422
    assert artifact_gateway.stat_calls == []
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        version_count = await session.scalar(
            select(func.count()).select_from(ArtifactVersion)
        )
    assert version_count == 0


@pytest.mark.anyio
async def test_complete_upload_replays_same_request_and_rejects_same_key_with_new_digest(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    created = await _create_upload(
        client,
        token,
        filename="完成幂等.txt",
        size=6,
        key="complete-idempotency-create",
    )
    upload_id = UUID(created.json()["upload_id"])
    staging_key = f"staging/{upload_id}"
    artifact_gateway.objects[staging_key] = ObjectMetadata(6, "text/plain", "etag-6")

    first = await _complete_upload(
        client,
        token,
        upload_id,
        actual_size=6,
        sha256="b" * 64,
        key="same-complete-key",
    )
    replayed = await _complete_upload(
        client,
        token,
        upload_id,
        actual_size=6,
        sha256="b" * 64,
        key="same-complete-key",
    )
    conflict = await _complete_upload(
        client,
        token,
        upload_id,
        actual_size=6,
        sha256="c" * 64,
        key="same-complete-key",
    )

    assert first.status_code == 201
    assert replayed.status_code == 201
    assert replayed.json() == first.json()
    assert conflict.status_code == 409
    assert conflict.json() == {"detail": {"code": "idempotency-conflict"}}
    assert artifact_gateway.stat_calls == [staging_key]
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        version_count = await session.scalar(select(func.count()).select_from(ArtifactVersion))
        job_count = await session.scalar(select(func.count()).select_from(ArtifactProcessingJob))
        complete_key_count = await session.scalar(
            select(func.count())
            .select_from(XAgentIdempotencyKey)
            .where(XAgentIdempotencyKey.operation == "artifact.upload.complete")
        )
    assert (version_count, job_count, complete_key_count) == (1, 1, 1)
