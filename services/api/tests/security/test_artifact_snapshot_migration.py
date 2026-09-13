"""Artifact snapshot migrations preserve saved responses and roll back invalid batches."""

import copy
import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from anyio import to_thread
from fastapi.encoders import jsonable_encoder
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.artifact import Artifact, ArtifactVersion
from app.services.artifacts import artifact_detail
from app.services.auth import Principal


PARENT = "020_skill_test_policy"
REVISION = "021_artifact_detail_snapshots"
COMPLETE = "artifact.upload.complete"
RETRY = "artifact.version.retry"
ARTIFACT_ID = "a0000000-0000-0000-0000-000000000001"
LATEST_ID = "b0000000-0000-0000-0000-000000000003"
OLDER_ID = "b0000000-0000-0000-0000-000000000001"
ACTOR_ID = "00000000-0000-0000-0000-000000000001"
PROJECT_ID = "c0000000-0000-0000-0000-000000000001"


def _legacy_detail(*, clean=True, project=False):
    detail = {
        "id": ARTIFACT_ID,
        "display_name": "保留 e\u0301  文档.txt",
        "scope": {"kind": "project", "project_id": PROJECT_ID} if project else {"kind": "private"},
        "can_edit": True,
        "latest_version": 3,
        "latest_status": "pending",
        "versions": [
            {
                "id": LATEST_ID, "version": 3, "original_filename": "最新.txt",
                "uploaded_by": ACTOR_ID, "size": 0, "status": "pending",
                "created_at": "2026-09-13T01:02:03.123456+08:00",
            },
            {
                "id": OLDER_ID, "version": 1, "original_filename": "older.txt",
                "uploaded_by": ACTOR_ID, "size": 52428800,
                "content_type": "text/plain", "status": "clean" if clean else "quarantined",
                "sha256": "a" * 64, "created_at": "2026-09-12T01:02:03Z",
            },
        ],
    }
    if clean:
        detail["latest_clean_version"] = 1
    return detail


def _result(operation, detail):
    result = {
        "version_id": LATEST_ID if operation == COMPLETE else OLDER_ID,
        "detail": detail,
        "retained_extension": {"nested": [None, False, 7, " unchanged "]},
    }
    if operation == RETRY:
        result["artifact_id"] = detail["id"]
    return result


async def _migrate(engine, direction, revision):
    config = Config(str(Path(__file__).resolve().parents[2] / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", engine.url.render_as_string(hide_password=False))
    await engine.dispose()
    await to_thread.run_sync(getattr(command, direction), config, revision)


async def _insert(engine, actor, operation, key, result, *, expired=False):
    async with engine.begin() as connection:
        await connection.execute(text(
            "INSERT INTO xagent_idempotency_keys "
            "(actor_id, operation, idempotency_key, request_hash, result, created_at, expires_at) "
            "VALUES (:actor, :operation, :key, :hash, CAST(:result AS jsonb), :created, :expires)"
        ), {
            "actor": actor, "operation": operation, "key": key, "hash": "f" * 64,
            "result": json.dumps(result), "created": datetime(2026, 1, 1, tzinfo=UTC),
            "expires": datetime(2000 if expired else 2099, 1, 1, tzinfo=UTC),
        })


async def _state(engine):
    async with engine.connect() as connection:
        rows = (await connection.execute(text(
            "SELECT * FROM xagent_idempotency_keys ORDER BY operation, actor_id, idempotency_key"
        ))).mappings().all()
        revision = await connection.scalar(text("SELECT version_num FROM alembic_version"))
    return [dict(row) for row in rows], revision


@pytest.mark.anyio
async def test_upgrade_and_reverse_preserve_every_saved_value(seeded_database, alice, bob):
    await _migrate(seeded_database, "downgrade", PARENT)
    for operation in (COMPLETE, RETRY):
        for index, status in enumerate(("pending", "scanning", "failed", "quarantined", "clean")):
            actor = alice if index % 2 == 0 else bob
            detail = _legacy_detail(clean=index % 2 == 0, project=index % 2 == 1)
            detail["latest_status"] = status
            detail["versions"][0]["status"] = status
            if status == "clean":
                detail["latest_clean_version"] = 3
            if index % 2 == 1:
                detail["can_edit"] = False
                del detail["versions"][0]["size"]
            await _insert(seeded_database, actor.id, operation, f"round-trip-{index}", _result(operation, detail), expired=index % 2 == 1)
    bounded = _legacy_detail(clean=False)
    bounded["versions"] = [
        {**bounded["versions"][0], "id": str(UUID(int=index + 1)), "version": 2**53 - 1 - index}
        for index in range(1000)
    ]
    bounded["latest_version"] = 2**53 - 1
    bounded_result = _result(RETRY, bounded)
    bounded_result["version_id"] = bounded["versions"][-1]["id"]
    await _insert(seeded_database, bob.id, RETRY, "bounded-history", bounded_result)
    await _insert(seeded_database, alice.id, "artifact.upload.create", "unrelated", {"detail": "opaque", "upload_id": str(uuid4())})
    before, revision = await _state(seeded_database)
    assert revision == PARENT

    await _migrate(seeded_database, "upgrade", REVISION)
    expected = copy.deepcopy(before)
    for row in expected:
        if row["operation"] in (COMPLETE, RETRY):
            detail = row["result"]["detail"]
            del detail["latest_version"]
            del detail["latest_status"]
            detail.pop("latest_clean_version", None)
            detail["schema_version"] = 2
    assert await _state(seeded_database) == (expected, REVISION)
    await _migrate(seeded_database, "downgrade", PARENT)
    assert await _state(seeded_database) == (before, PARENT)


@pytest.mark.anyio
async def test_downgrade_accepts_newly_emitted_v2_detail(seeded_database, alice):
    artifact = Artifact(id=UUID(ARTIFACT_ID), filename="new.txt", created_by_id=alice.id, owner_id=alice.id)
    principal = Principal(actor_id=alice.id, role=alice.role, permission_revision=1, auth_session_id=uuid4(), email="alice@example.test")
    async with AsyncSession(seeded_database) as session, session.begin():
        session.add(artifact)
        await session.flush()
        session.add(ArtifactVersion(
            id=UUID(LATEST_ID), artifact_id=artifact.id, owner_id=alice.id,
            version_number=3, original_filename="new.txt", uploaded_by_id=alice.id,
            declared_size=0, actual_size=0, scan_status="pending", size=0, sha256="a" * 64,
        ))
        await session.flush()
        detail = jsonable_encoder(await artifact_detail(session, principal, artifact.id), exclude_none=True)
    assert set(detail) == {"schema_version", "id", "display_name", "scope", "can_edit", "versions"}
    for operation in (COMPLETE, RETRY):
        result = _result(operation, detail)
        result["version_id"] = LATEST_ID
        await _insert(seeded_database, alice.id, operation, "new-v2", result)
    before, revision = await _state(seeded_database)
    assert revision == REVISION
    expected = copy.deepcopy(before)
    for row in expected:
        saved = row["result"]["detail"]
        del saved["schema_version"]
        saved.update(latest_version=3, latest_status="pending")
    await _migrate(seeded_database, "downgrade", PARENT)
    assert await _state(seeded_database) == (expected, PARENT)
    await _migrate(seeded_database, "upgrade", REVISION)
    assert await _state(seeded_database) == (before, REVISION)


def _invalid_cases(direction, operation):
    cases = [
        ((), [], "result.fields"),
        (("detail",), None, "detail.fields"),
        (("detail", "schema_version"), 99, "detail.fields" if direction == "upgrade" else "detail.schema_version"),
        (("detail", "owner_id"), "snapshot-secret", "detail.fields"),
        (("detail", "id"), ARTIFACT_ID.replace("-", ""), "detail.id"),
        (("detail", "display_name"), "", "detail.display_name"),
        (("detail", "display_name"), "x" * 256, "detail.display_name"),
        (("detail", "can_edit"), 1, "detail.can_edit"),
        (("detail", "scope"), {"kind": "private", "owner_id": "snapshot-secret"}, "detail.scope.fields"),
        (("detail", "scope"), {"kind": "project"}, "detail.scope.fields"),
        (("detail", "scope"), {"kind": "project", "project_id": 9}, "detail.scope.project_id"),
        (("detail", "scope"), {"kind": "unknown"}, "detail.scope.kind"),
        (("detail", "versions"), [], "detail.versions.count"),
        (("detail", "versions"), {}, "detail.versions.count"),
        (("detail", "versions", 0), None, "detail.versions.fields"),
        (("detail", "versions"), [_legacy_detail()["versions"][0]] * 1001, "detail.versions.count"),
        (("detail", "versions", 1, "id"), LATEST_ID.upper(), "detail.versions.unique_ids"),
        (("detail", "versions", 1, "version"), 3, "detail.versions.order"),
        (("detail", "versions", 1, "version"), 4, "detail.versions.order"),
        (("detail", "versions", 0, "version"), 0, "detail.versions.version"),
        (("detail", "versions", 0, "version"), True, "detail.versions.version"),
        (("detail", "versions", 0, "version"), 3.0, "detail.versions.version"),
        (("detail", "versions", 0, "version"), 2**53, "detail.versions.version"),
        (("detail", "versions", 0, "size"), -1, "detail.versions.size"),
        (("detail", "versions", 0, "size"), 52428801, "detail.versions.size"),
        (("detail", "versions", 0, "size"), None, "detail.versions.size"),
        (("detail", "versions", 0, "size"), False, "detail.versions.size"),
        (("detail", "versions", 0, "size"), 1.5, "detail.versions.size"),
        (("detail", "versions", 0, "content_type"), None, "detail.versions.content_type"),
        (("detail", "versions", 0, "content_type"), "", "detail.versions.content_type"),
        (("detail", "versions", 0, "content_type"), "x" * 256, "detail.versions.content_type"),
        (("detail", "versions", 0, "original_filename"), "", "detail.versions.original_filename"),
        (("detail", "versions", 0, "original_filename"), "x" * 256, "detail.versions.original_filename"),
        (("detail", "versions", 0, "uploaded_by"), "urn:uuid:" + ACTOR_ID, "detail.versions.uploaded_by"),
        (("detail", "versions", 0, "id"), "snapshot-secret", "detail.versions.id"),
        (("detail", "versions", 0, "status"), "unknown", "detail.versions.status"),
        (("detail", "versions", 0, "created_at"), 1789257600, "detail.versions.created_at"),
        (("detail", "versions", 0, "created_at"), "2026-02-30T00:00:00Z", "detail.versions.created_at"),
        (("detail", "versions", 0, "created_at"), "2026-09-13 00:00:00Z", "detail.versions.created_at"),
        (("detail", "versions", 0, "created_at"), "2026-09-13T00:00:00", "detail.versions.created_at"),
        (("detail", "versions", 0, "sha256"), "a" * 64, "detail.versions.sha256_disclosure"),
        (("detail", "versions", 1, "sha256"), "A" * 64, "detail.versions.sha256"),
        (("detail", "versions", 1, "sha256"), None, "detail.versions.sha256"),
        (("detail", "versions", 0, "object_key"), "snapshot-secret", "detail.versions.fields"),
        (("version_id",), "snapshot-secret", "result.version_id"),
        (("version_id",), PROJECT_ID, "result.version_id_relation"),
    ]
    if operation == RETRY:
        cases.extend([
            (("artifact_id",), "snapshot-secret", "result.artifact_id"),
            (("artifact_id",), PROJECT_ID, "result.artifact_id_relation"),
        ])
    else:
        cases.append((("version_id",), OLDER_ID, "result.version_id_relation"))
    if direction == "upgrade":
        cases.extend([
            (("detail", "latest_version"), 2, "detail.latest_version"),
            (("detail", "latest_version"), True, "detail.latest_version"),
            (("detail", "latest_status"), "clean", "detail.latest_status"),
            (("detail", "latest_clean_version"), None, "detail.latest_clean_version"),
            (("detail", "latest_clean_version"), True, "detail.latest_clean_version"),
            (("detail", "latest_clean_version"), 3, "detail.latest_clean_version"),
        ])
    else:
        cases.extend([
            (("detail", "schema_version"), True, "detail.schema_version"),
            (("detail", "schema_version"), 2.0, "detail.schema_version"),
            (("detail", "latest_version"), 3, "detail.fields"),
        ])
    return cases


@pytest.mark.anyio
@pytest.mark.parametrize("direction", ["upgrade", "downgrade"])
@pytest.mark.parametrize("operation", [COMPLETE, RETRY])
async def test_invalid_expired_record_rolls_back_all_rows_and_revision(seeded_database, alice, bob, direction, operation):
    start = PARENT if direction == "upgrade" else REVISION
    target = REVISION if direction == "upgrade" else PARENT
    if direction == "upgrade":
        await _migrate(seeded_database, "downgrade", PARENT)
    valid = _result(operation, _legacy_detail())
    if direction == "downgrade":
        for field in ("latest_version", "latest_status", "latest_clean_version"):
            del valid["detail"][field]
        valid["detail"]["schema_version"] = 2
    await _insert(seeded_database, alice.id, operation, "a-valid", valid)
    await _insert(seeded_database, bob.id, operation, "z-invalid", valid, expired=True)
    other_operation = RETRY if operation == COMPLETE else COMPLETE
    await _insert(seeded_database, alice.id, other_operation, "other-target", _result(other_operation, valid["detail"]))
    await _insert(seeded_database, alice.id, "artifact.upload.create", "unrelated", {"opaque": "snapshot-secret"})
    cases = _invalid_cases(direction, operation)
    # Missing required fields must fail too; omitted optional version fields stay valid.
    for field in valid["detail"]:
        missing = copy.deepcopy(valid["detail"])
        del missing[field]
        rule = "detail.latest_clean_version" if field == "latest_clean_version" else "detail.fields"
        cases.append((("detail",), missing, rule))
    for field in ("id", "version", "original_filename", "uploaded_by", "status", "created_at"):
        missing = copy.deepcopy(valid["detail"]["versions"][0])
        del missing[field]
        cases.append((("detail", "versions", 0), missing, "detail.versions.fields"))
    for field in ("version_id", "artifact_id") if operation == RETRY else ("version_id",):
        missing = copy.deepcopy(valid)
        del missing[field]
        cases.append(((), missing, f"result.{field}"))
    if direction == "upgrade":
        no_clean = _legacy_detail(clean=False)
        no_clean["latest_clean_version"] = 1
        cases.append((("detail",), no_clean, "detail.latest_clean_version"))
    for path, value, rule in cases:
        malformed = copy.deepcopy(valid)
        if path:
            cursor = malformed
            for key in path[:-1]:
                cursor = cursor[key]
            cursor[path[-1]] = value
        else:
            malformed = value
        async with seeded_database.begin() as connection:
            await connection.execute(text(
                "UPDATE xagent_idempotency_keys SET result = CAST(:result AS jsonb) "
                "WHERE actor_id = :actor AND operation = :operation"
            ), {"result": json.dumps(malformed), "actor": bob.id, "operation": operation})
        before = await _state(seeded_database)
        assert before[1] == start
        with pytest.raises(ValueError) as failure:
            await _migrate(seeded_database, direction, target)
        assert str(failure.value) == f"Artifact snapshot migration: {operation}: {rule}", path
        assert await _state(seeded_database) == before, path
