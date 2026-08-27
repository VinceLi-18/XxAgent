from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.artifact import Artifact, StagingUpload
from app.models.identity import Role
from app.models.project import Project, ProjectAction, TemporaryProjectGrant


@pytest.mark.anyio
async def test_legacy_browser_artifact_routes_are_not_registered(client) -> None:
    create = await client.post(
        "/api/v1/artifacts/staging-uploads",
        json={"filename": "浏览器直传.txt"},
    )
    read = await client.get(f"/api/v1/artifacts/{uuid4()}/content")

    assert create.status_code == 404
    assert read.status_code == 404


@pytest.mark.anyio
async def test_staging_rls_hides_expired_and_foreign_uploads(
    seeded_database,
    actor_session,
    alice,
    bob,
) -> None:
    now = datetime.now(UTC)
    active = StagingUpload(
        created_by_id=alice.id,
        filename="有效.txt",
        expected_size=1,
        owner_id=alice.id,
        staging_key="staging/alice-active",
        expires_at=now + timedelta(minutes=10),
    )
    expired = StagingUpload(
        created_by_id=alice.id,
        filename="过期.txt",
        expected_size=1,
        owner_id=alice.id,
        staging_key="staging/alice-expired",
        expires_at=now - timedelta(seconds=1),
    )
    foreign = StagingUpload(
        created_by_id=bob.id,
        filename="他人.txt",
        expected_size=1,
        owner_id=bob.id,
        staging_key="staging/bob-active",
        expires_at=now + timedelta(minutes=10),
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as admin_session:
        async with admin_session.begin():
            admin_session.add_all((active, expired, foreign))

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    visible_ids = set(await actor_session.scalars(select(StagingUpload.id)))

    assert visible_ids == {active.id}


@pytest.mark.anyio
async def test_runtime_role_cannot_insert_staging_for_another_scope_or_creator(
    seeded_database,
    actor_session,
    alice,
    bob,
) -> None:
    project = Project(name="Bob project", owner_id=bob.id)
    async with AsyncSession(seeded_database, expire_on_commit=False) as admin_session:
        async with admin_session.begin():
            admin_session.add(project)

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    invalid_uploads = (
        StagingUpload(
            created_by_id=bob.id,
            filename="伪造上传者.txt",
            expected_size=1,
            owner_id=alice.id,
            staging_key="staging/forged-creator",
            expires_at=datetime.now(UTC) + timedelta(minutes=10),
        ),
        StagingUpload(
            created_by_id=alice.id,
            filename="他人私人资料.txt",
            expected_size=1,
            owner_id=bob.id,
            staging_key="staging/other-private",
            expires_at=datetime.now(UTC) + timedelta(minutes=10),
        ),
        StagingUpload(
            created_by_id=alice.id,
            filename="不可见项目.txt",
            expected_size=1,
            project_id=project.id,
            staging_key="staging/other-project",
            expires_at=datetime.now(UTC) + timedelta(minutes=10),
        ),
    )
    for upload in invalid_uploads:
        with pytest.raises(DBAPIError):
            async with actor_session.begin_nested():
                actor_session.add(upload)
                await actor_session.flush()


@pytest.mark.anyio
async def test_runtime_role_cannot_insert_staging_without_expected_size(
    actor_session,
    alice,
) -> None:
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    upload = StagingUpload(
        created_by_id=alice.id,
        filename="缺少大小.txt",
        expected_size=None,
        owner_id=alice.id,
        staging_key="staging/null-expected-size",
        expires_at=datetime.now(UTC) + timedelta(minutes=10),
    )

    with pytest.raises(DBAPIError):
        actor_session.add(upload)
        await actor_session.flush()


@pytest.mark.anyio
async def test_runtime_role_cannot_point_private_staging_at_another_scope_artifact(
    seeded_database,
    actor_session,
    alice,
    bob,
) -> None:
    artifact = Artifact(
        filename="Bob 私人资料.txt",
        created_by_id=bob.id,
        owner_id=bob.id,
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(artifact)
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    upload = StagingUpload(
        artifact_id=artifact.id,
        created_by_id=alice.id,
        filename="伪造范围.txt",
        expected_size=1,
        owner_id=alice.id,
        staging_key="staging/mismatched-artifact",
        expires_at=datetime.now(UTC) + timedelta(minutes=10),
    )

    with pytest.raises(DBAPIError):
        actor_session.add(upload)
        await actor_session.flush()


@pytest.mark.anyio
async def test_runtime_role_cannot_point_staging_at_a_read_only_artifact(
    seeded_database,
    actor_session,
    alice,
    bob,
) -> None:
    project = Project(id=uuid4(), name="只读项目", owner_id=bob.id)
    artifact = Artifact(
        filename="只读资料.txt",
        created_by_id=bob.id,
        project_id=project.id,
    )
    grant = TemporaryProjectGrant(
        project_id=project.id,
        account_id=alice.id,
        action=ProjectAction.READ,
        granted_by_id=bob.id,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(project)
            await session.flush()
            session.add_all((artifact, grant))
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    upload = StagingUpload(
        artifact_id=artifact.id,
        created_by_id=alice.id,
        filename="只读目标.txt",
        expected_size=1,
        project_id=project.id,
        staging_key="staging/read-only-artifact",
        expires_at=datetime.now(UTC) + timedelta(minutes=10),
    )

    with pytest.raises(DBAPIError):
        actor_session.add(upload)
        await actor_session.flush()


@pytest.mark.anyio
async def test_runtime_role_can_insert_valid_new_and_explicit_private_staging(
    seeded_database,
    actor_session,
    alice,
) -> None:
    artifact = Artifact(
        filename="Alice 私人资料.txt",
        created_by_id=alice.id,
        owner_id=alice.id,
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(artifact)
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    uploads = (
        StagingUpload(
            created_by_id=alice.id,
            filename="新资料.txt",
            expected_size=1,
            owner_id=alice.id,
            staging_key="staging/valid-new",
            expires_at=datetime.now(UTC) + timedelta(minutes=10),
        ),
        StagingUpload(
            artifact_id=artifact.id,
            created_by_id=alice.id,
            filename="新版本.txt",
            expected_size=2,
            owner_id=alice.id,
            staging_key="staging/valid-explicit",
            expires_at=datetime.now(UTC) + timedelta(minutes=10),
        ),
    )

    actor_session.add_all(uploads)
    await actor_session.flush()

    assert {upload.id for upload in uploads} == set(
        await actor_session.scalars(
            select(StagingUpload.id).where(
                StagingUpload.id.in_([upload.id for upload in uploads])
            )
        )
    )


@pytest.mark.anyio
async def test_artifact_scope_constraint_and_runtime_permissions_remain_enforced(
    seeded_database,
    actor_session,
    alice,
    application_role,
) -> None:
    async with seeded_database.begin() as connection:
        has_artifact_read = await connection.scalar(
            text("SELECT has_table_privilege(:role, 'artifacts', 'SELECT')"),
            {"role": application_role},
        )
        has_artifact_delete = await connection.scalar(
            text("SELECT has_table_privilege(:role, 'artifacts', 'DELETE')"),
            {"role": application_role},
        )
    assert (has_artifact_read, has_artifact_delete) == (True, False)

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    invalid = Artifact(filename="无范围.txt", created_by_id=alice.id)
    actor_session.add(invalid)
    with pytest.raises((IntegrityError, DBAPIError)):
        await actor_session.flush()
