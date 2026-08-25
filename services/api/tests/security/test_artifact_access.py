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
from app.models.project import Project


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
