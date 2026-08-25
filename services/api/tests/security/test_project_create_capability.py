import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workbench import XAgentAccountCapabilityGrant, XAgentCapability
from app.services.capabilities import grant_capability, revoke_capability


@pytest.mark.anyio
async def test_specialist_without_capability_cannot_create_a_project(
    api_client,
    alice_token,
) -> None:
    response = await api_client.post(
        "/api/v1/projects",
        headers={"Authorization": f"Bearer {alice_token}"},
        json={"name": "Forbidden specialist project"},
    )

    assert response.status_code == 403
    assert response.json() == {"detail": {"code": "forbidden"}}


@pytest.mark.anyio
async def test_manager_has_default_create_capability_without_a_grant_row(
    api_client,
    manager_token,
    seeded_database,
) -> None:
    response = await api_client.post(
        "/api/v1/projects",
        headers={"Authorization": f"Bearer {manager_token}"},
        json={"name": "Manager project"},
    )

    assert response.status_code == 201
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        grant_count = await session.scalar(
            select(func.count()).select_from(XAgentAccountCapabilityGrant)
        )
    assert grant_count == 0


@pytest.mark.anyio
async def test_specialist_create_access_follows_grant_and_revoke_immediately(
    api_client,
    alice_token,
    seeded_database,
) -> None:
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            changed = await grant_capability(
                session,
                email="alice@example.test",
                capability=XAgentCapability.PROJECT_CREATE,
                granted_by="manager@example.test",
            )
    assert changed is True

    allowed = await api_client.post(
        "/api/v1/projects",
        headers={"Authorization": f"Bearer {alice_token}"},
        json={"name": "Granted specialist project"},
    )
    assert allowed.status_code == 201

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            changed = await revoke_capability(
                session,
                email="alice@example.test",
                capability=XAgentCapability.PROJECT_CREATE,
            )
    assert changed is True

    forbidden = await api_client.post(
        "/api/v1/projects",
        headers={"Authorization": f"Bearer {alice_token}"},
        json={"name": "Revoked specialist project"},
    )
    assert forbidden.status_code == 403
    assert forbidden.json() == {"detail": {"code": "forbidden"}}
