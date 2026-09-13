"""Saved Artifact results cross data migration and terminated API processes."""

import json
import os
import signal
import socket
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
import httpx
import pytest
from sqlalchemy import text

from tests.api.test_artifact_uploads import _authenticate, _headers, _select_project_with_temporary_edit
from tests.security.test_artifact_snapshot_migration import PARENT, REVISION, _migrate, _state


API_DIRECTORY = Path(__file__).resolve().parents[2]
BRIDGE = API_DIRECTORY / "tests/artifact_projection_bridge.mjs"


@asynccontextmanager
async def _api_process(log_path: Path, *, replay_only=False):
    # Pass an owned listener to Uvicorn so another process cannot take a probed port.
    with socket.socket() as listener, log_path.open("w+") as log:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        origin = f"http://127.0.0.1:{listener.getsockname()[1]}"
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "tests.artifact_replay_api:app", "--fd", str(listener.fileno()), "--no-access-log"],
            cwd=API_DIRECTORY,
            env={**os.environ, "XAGENT_REPLAY_FORBID_STORAGE": "yes" if replay_only else "no"},
            pass_fds=(listener.fileno(),),
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            async with httpx.AsyncClient(base_url=origin, timeout=10) as client:
                with anyio.fail_after(20):
                    while True:
                        if process.poll() is not None:
                            log.seek(0)
                            pytest.fail(f"API exited during startup: {log.read()}")
                        try:
                            response = await client.get("/api/v1/health")
                            if response.status_code == 200:
                                break
                        except httpx.TransportError:
                            pass  # The child has not accepted its inherited listener yet.
                        await anyio.sleep(0.05)
                yield process, client
        finally:
            process.terminate()
            try:
                await anyio.to_thread.run_sync(lambda: process.wait(timeout=15))
            except subprocess.TimeoutExpired:
                process.kill()
                await anyio.to_thread.run_sync(process.wait)
                pytest.fail("API did not drain before termination")
            assert process.returncode in (0, -signal.SIGTERM)


async def _public(client, token, method, *args):
    result = await anyio.run_process(
        ["node", str(BRIDGE)],
        input=json.dumps({
            "origin": str(client.base_url), "token": token,
            "serviceToken": os.environ["XAGENT_SERVICE_TOKEN"],
            "method": method, "args": args,
        }).encode(),
        cwd=API_DIRECTORY,
    )
    return json.loads(result.stdout)


async def _counts(engine):
    async with engine.connect() as connection:
        return dict((await connection.execute(text(
            "SELECT (SELECT count(*) FROM artifacts) AS artifacts, "
            "(SELECT count(*) FROM artifact_versions) AS versions, "
            "(SELECT count(*) FROM artifact_processing_jobs) AS jobs, "
            "(SELECT count(*) FROM staging_uploads) AS uploads, "
            "(SELECT count(*) FROM xagent_idempotency_keys) AS keys"
        ))).mappings().one())


async def _processing_state(engine):
    async with engine.connect() as connection:
        return (await connection.execute(text(
            "SELECT to_jsonb(v) AS version, to_jsonb(j) AS job "
            "FROM artifact_versions v JOIN artifact_processing_jobs j ON j.version_id = v.id "
            "ORDER BY v.id"
        ))).mappings().all()


@pytest.mark.anyio
async def test_complete_and_retry_replay_saved_public_results_after_migration_and_restart(
    seeded_database, alice, bob, bob_project, tmp_path,
):
    async with _api_process(tmp_path / "original-api.log") as (original, client):
        token, grant = await _select_project_with_temporary_edit(
            client, seeded_database, alice, bob, bob_project,
        )
        created = await client.post("/internal/xagent/artifacts/uploads", headers=_headers(token), json={
            "filename": "replay.txt", "size": 1, "idempotency_key": "restart-create",
        })
        assert created.status_code == 201, created.text
        upload_id = created.json()["upload_id"]
        complete_args = (upload_id, {"size": 1, "sha256": "a" * 64, "idempotencyKey": "restart-complete"})
        completed = await _public(client, token, "completeUpload", *complete_args)
        assert completed["ok"], completed
        assert completed["value"]["latestStatus"] == "pending"
        assert completed["value"]["latestVersion"] == 1
        assert "latestCleanVersion" not in completed["value"]
        version_id = completed["value"]["versions"][0]["id"]
        artifact_id = completed["value"]["id"]
        async with seeded_database.begin() as connection:
            await connection.execute(text("UPDATE artifact_versions SET scan_status = 'scanning' WHERE id = :id"), {"id": version_id})
            await connection.execute(text("UPDATE artifact_versions SET scan_status = 'failed' WHERE id = :id"), {"id": version_id})
            await connection.execute(text("UPDATE artifact_processing_jobs SET status = 'dead', attempts = 5 WHERE version_id = :id"), {"id": version_id})
        retry_args = (version_id, "restart-retry")
        retried = await _public(client, token, "retry", *retry_args)
        assert retried == completed
        saved, revision = await _state(seeded_database)
        counts = await _counts(seeded_database)
        processing = await _processing_state(seeded_database)
        assert revision == REVISION
        assert counts == {"artifacts": 1, "versions": 1, "jobs": 1, "uploads": 1, "keys": 3}
    assert original.poll() in (0, -signal.SIGTERM)

    # The real reverse conversion creates legacy rows from newly accepted v2 writes.
    await _migrate(seeded_database, "downgrade", PARENT)
    legacy, revision = await _state(seeded_database)
    assert revision == PARENT
    for old, new in zip(legacy, saved, strict=True):
        if old["operation"] in {"artifact.upload.complete", "artifact.version.retry"}:
            detail = {key: value for key, value in new["result"]["detail"].items() if key != "schema_version"}
            detail.update(latest_version=1, latest_status="pending")
            assert old == {**new, "result": {**new["result"], "detail": detail}}
        else:
            assert old == new
    await _migrate(seeded_database, "upgrade", REVISION)
    assert await _state(seeded_database) == (saved, REVISION)
    assert await _processing_state(seeded_database) == processing

    async with _api_process(tmp_path / "restarted-api.log", replay_only=True) as (restarted, client):
        assert restarted.pid != original.pid
        async with seeded_database.begin() as connection:
            await connection.execute(text("UPDATE artifact_versions SET scan_status = 'scanning' WHERE id = :id"), {"id": version_id})
            await connection.execute(text(
                "UPDATE artifact_versions SET scan_status = 'clean', "
                "object_key = 'artifacts/' || artifact_id::text || '/' || id::text "
                "WHERE id = :id"
            ), {"id": version_id})
            await connection.execute(text("UPDATE artifact_processing_jobs SET status = 'succeeded' WHERE version_id = :id"), {"id": version_id})
        current = await _public(client, token, "detail", artifact_id)
        assert current["ok"], current
        assert current["value"]["latestStatus"] == "clean"
        assert current["value"]["latestCleanVersion"] == 1
        assert current != completed
        processing = await _processing_state(seeded_database)
        for method, args, expected in (("completeUpload", complete_args, completed), ("retry", retry_args, retried)):
            assert await _public(client, token, method, *args) == expected
        assert await _counts(seeded_database) == counts
        assert await _state(seeded_database) == (saved, REVISION)
        assert await _processing_state(seeded_database) == processing
        async with seeded_database.begin() as connection:
            await connection.execute(text("DELETE FROM temporary_project_grants WHERE id = :id"), {"id": grant.id})
        for method, args in (("completeUpload", complete_args), ("retry", retry_args)):
            assert await _public(client, token, method, *args) == {"ok": False, "code": "unauthenticated"}
        token = await _authenticate(client, "alice@example.test")
        for method, args in (("completeUpload", complete_args), ("retry", retry_args)):
            assert await _public(client, token, method, *args) == {"ok": False, "code": "not-found"}
        assert await _counts(seeded_database) == counts
        assert await _state(seeded_database) == (saved, REVISION)
        assert await _processing_state(seeded_database) == processing
