import asyncio

import pytest
from argon2 import PasswordHasher
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project
from app.models.workbench import XAgentWorkbenchPreference
from app.models.xagent_session import XAgentIdempotencyKey
from app.services import workbench as workbench_service

PASSWORD = "correct horse battery staple"
SERVICE_TOKEN = "xagent-test-service-token-00000001"


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


@pytest.mark.anyio
async def test_project_create_rejects_same_key_with_a_different_digest(
    client,
    seeded_database,
    manager,
) -> None:
    token = await _login(client, seeded_database, manager, "manager@example.test")
    first = await client.post(
        "/internal/xagent/projects",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "name": "First name",
            "idempotency_key": "digest-conflict",
        },
    )
    conflict = await client.post(
        "/internal/xagent/projects",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "name": "Different name",
            "idempotency_key": "digest-conflict",
        },
    )

    assert first.status_code == 201
    assert conflict.status_code == 409
    assert conflict.json() == {"detail": {"code": "idempotency-conflict"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        project_count = await session.scalar(select(func.count()).select_from(Project))
    assert project_count == 1


@pytest.mark.anyio
async def test_concurrent_same_key_creates_one_project_and_replays_one_result(
    client,
    seeded_database,
    manager,
) -> None:
    token = await _login(client, seeded_database, manager, "manager@example.test")
    payload = {
        "schema_version": 1,
        "name": "Concurrent project",
        "idempotency_key": "concurrent-project",
    }

    first, second = await asyncio.gather(
        client.post(
            "/internal/xagent/projects",
            headers=_headers(token),
            json=payload,
        ),
        client.post(
            "/internal/xagent/projects",
            headers=_headers(token),
            json=payload,
        ),
    )

    assert sorted((first.status_code, second.status_code)) == [200, 201]
    assert first.json() == second.json()
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        project_count = await session.scalar(select(func.count()).select_from(Project))
        key_count = await session.scalar(
            select(func.count()).select_from(XAgentIdempotencyKey)
        )
    assert project_count == 1
    assert key_count == 1


@pytest.mark.anyio
async def test_project_create_rolls_back_everything_when_context_save_fails(
    client,
    seeded_database,
    manager,
    monkeypatch,
) -> None:
    token = await _login(client, seeded_database, manager, "manager@example.test")

    async def fail_context_save(*args, **kwargs):
        raise RuntimeError("injected context failure")

    monkeypatch.setattr(workbench_service, "normalize_context", fail_context_save)
    with pytest.raises(RuntimeError, match="injected context failure"):
        await client.post(
            "/internal/xagent/projects",
            headers=_headers(token),
            json={
                "schema_version": 1,
                "name": "Rolled back project",
                "idempotency_key": "rollback-project",
            },
        )

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        counts = (
            await session.scalar(select(func.count()).select_from(Project)),
            await session.scalar(
                select(func.count()).select_from(XAgentWorkbenchPreference)
            ),
            await session.scalar(
                select(func.count()).select_from(XAgentIdempotencyKey)
            ),
        )
    assert counts == (0, 0, 0)


@pytest.mark.anyio
async def test_missing_create_capability_does_not_modify_projects_or_context(
    client,
    seeded_database,
    alice,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")

    forbidden = await client.post(
        "/internal/xagent/projects",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "name": "Forbidden project",
            "idempotency_key": "forbidden-project",
        },
    )

    assert forbidden.status_code == 403
    assert forbidden.json() == {"detail": {"code": "forbidden"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        counts = (
            await session.scalar(select(func.count()).select_from(Project)),
            await session.scalar(
                select(func.count()).select_from(XAgentWorkbenchPreference)
            ),
            await session.scalar(
                select(func.count()).select_from(XAgentIdempotencyKey)
            ),
        )
    assert counts == (0, 0, 0)
