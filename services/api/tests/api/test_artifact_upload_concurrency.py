import asyncio
from uuid import UUID

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.artifact import ArtifactProcessingJob, ArtifactVersion
from app.storage.minio_gateway import ObjectMetadata
from tests.api.test_artifact_uploads import (
    UploadUrlGateway,
    _authenticate,
    _complete_upload,
    _create_upload,
    _login,
    artifact_gateway,
)


async def _install_version_insert_overlap_trigger(engine) -> None:
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "CREATE FUNCTION test_delay_artifact_version_insert() RETURNS trigger "
                "LANGUAGE plpgsql AS $$ BEGIN "
                "IF NEW.version_number > 1 THEN PERFORM pg_sleep(0.2); END IF; "
                "RETURN NEW; END $$"
            )
        )
        await connection.execute(
            text(
                "CREATE TRIGGER test_delay_artifact_version_insert "
                "BEFORE INSERT ON artifact_versions FOR EACH ROW "
                "EXECUTE FUNCTION test_delay_artifact_version_insert()"
            )
        )


@pytest.mark.anyio
async def test_concurrent_same_completion_key_creates_one_version_and_one_job(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    second_token = await _authenticate(client, "alice@example.test")
    created = await _create_upload(
        client,
        token,
        filename="并发完成.txt",
        size=10,
        key="concurrent-create",
    )
    upload_id = UUID(created.json()["upload_id"])
    staging_key = f"staging/{upload_id}"
    artifact_gateway.objects[staging_key] = ObjectMetadata(
        10,
        "text/plain",
        "etag-concurrent",
    )

    first, second = await asyncio.gather(
        _complete_upload(
            client,
            second_token,
            upload_id,
            actual_size=10,
            sha256="d" * 64,
            key="concurrent-complete",
        ),
        _complete_upload(
            client,
            token,
            upload_id,
            actual_size=10,
            sha256="d" * 64,
            key="concurrent-complete",
        ),
    )

    assert (first.status_code, second.status_code) == (201, 201)
    assert first.json() == second.json()
    assert artifact_gateway.stat_calls == [staging_key]
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        version_count = await session.scalar(select(func.count()).select_from(ArtifactVersion))
        job_count = await session.scalar(select(func.count()).select_from(ArtifactProcessingJob))
    assert (version_count, job_count) == (1, 1)


@pytest.mark.anyio
async def test_concurrent_explicit_uploads_allocate_distinct_sequential_version_numbers(
    client,
    seeded_database,
    alice,
    artifact_gateway: UploadUrlGateway,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    second_token = await _authenticate(client, "alice@example.test")
    initial_upload = await _create_upload(
        client,
        token,
        filename="基线.txt",
        size=1,
        key="initial-create",
    )
    initial_upload_id = UUID(initial_upload.json()["upload_id"])
    artifact_gateway.objects[f"staging/{initial_upload_id}"] = ObjectMetadata(
        1,
        "text/plain",
        "etag-0",
    )
    initial = await _complete_upload(
        client,
        token,
        initial_upload_id,
        actual_size=1,
        sha256="0" * 64,
        key="initial-complete",
    )
    artifact_id = UUID(initial.json()["id"])
    await _install_version_insert_overlap_trigger(seeded_database)

    uploads: list[tuple[str, UUID]] = []
    for suffix in ("one", "two"):
        created = await _create_upload(
            client,
            token,
            filename=f"并发-{suffix}.txt",
            size=2,
            key=f"version-create-{suffix}",
            artifact_id=artifact_id,
        )
        upload_id = UUID(created.json()["upload_id"])
        artifact_gateway.objects[f"staging/{upload_id}"] = ObjectMetadata(
            2,
            "text/plain",
            f"etag-{suffix}",
        )
        uploads.append((suffix, upload_id))

    responses = await asyncio.gather(
        _complete_upload(
            client,
            token,
            uploads[0][1],
            actual_size=2,
            sha256="1" * 64,
            key="version-complete-one",
        ),
        _complete_upload(
            client,
            second_token,
            uploads[1][1],
            actual_size=2,
            sha256="2" * 64,
            key="version-complete-two",
        ),
    )

    assert [response.status_code for response in responses] == [201, 201]
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        versions = (
            await session.scalars(
                select(ArtifactVersion)
                .where(ArtifactVersion.artifact_id == artifact_id)
                .order_by(ArtifactVersion.version_number)
            )
        ).all()
    assert [version.version_number for version in versions] == [1, 2, 3]
    assert len({version.id for version in versions}) == 3
