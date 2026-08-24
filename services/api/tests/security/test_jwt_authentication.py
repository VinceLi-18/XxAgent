import os
from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.identity import Role


def _signed_token(
    subject: object = "00000000-0000-0000-0000-000000000001",
    signing_key: str | None = None,
    **claims: object,
) -> str:
    now = datetime.now(UTC)
    payload: dict[str, object] = {
        "sub": subject,
        "iss": os.environ["JWT_ISSUER"],
        "aud": os.environ["JWT_AUDIENCE"],
        "iat": now,
        "exp": now + timedelta(minutes=5),
        "jti": "test-token-id",
    }
    payload.update(claims)
    return jwt.encode(payload, signing_key or os.environ["JWT_SECRET_KEY"], algorithm="HS256")


@pytest.mark.anyio
async def test_secure_whoami_rejects_a_missing_bearer_token(application) -> None:
    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/v1/secure/whoami")
    assert response.status_code == 401


@pytest.mark.anyio
async def test_verified_token_uses_database_role_not_role_header(client, alice, alice_token) -> None:
    response = await client.get(
        "/api/v1/secure/whoami",
        headers={
            "Authorization": f"Bearer {alice_token}",
            "X-Actor-Role": "manager",
        },
    )

    assert response.status_code == 200
    assert response.json() == {"actor_id": str(alice.id), "role": "specialist"}


@pytest.mark.anyio
async def test_same_origin_session_bootstrap_accepts_a_signed_session_cookie(client, alice, alice_token) -> None:
    client.cookies.set("jiaxin_agent_session", alice_token)

    response = await client.get("/api/v1/session")

    assert response.status_code == 200
    assert response.json() == {"scope": str(alice.id)}


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("claims", "signing_key"),
    [
        ({}, "another-test-signing-key-long-enough"),
        ({"iss": "wrong-issuer"}, None),
        ({"aud": "wrong-audience"}, None),
        ({"iat": datetime.now(UTC) + timedelta(days=1)}, None),
        ({"exp": datetime.now(UTC) - timedelta(days=1)}, None),
        ({"jti": 42}, None),
        ({"sub": "not-a-uuid"}, None),
        ({"sub": 42}, None),
    ],
    ids=(
        "invalid-signature",
        "wrong-issuer",
        "wrong-audience",
        "future-issued-at",
        "expired",
        "non-string-jti",
        "malformed-subject",
        "non-string-subject",
    ),
)
async def test_secure_whoami_rejects_invalid_token_claims(client, claims, signing_key) -> None:
    response = await client.get(
        "/api/v1/secure/whoami",
        headers={"Authorization": f"Bearer {_signed_token(signing_key=signing_key, **claims)}"},
    )

    assert response.status_code == 401


@pytest.mark.anyio
async def test_secure_whoami_rejects_a_token_for_a_missing_account(client) -> None:
    response = await client.get(
        "/api/v1/secure/whoami",
        headers={"Authorization": f"Bearer {_signed_token(str(UUID('00000000-0000-0000-0000-000000000099')))}"},
    )

    assert response.status_code == 401


@pytest.mark.anyio
async def test_secure_whoami_rejects_an_inactive_account(client, alice, alice_token, seeded_database) -> None:
    async with AsyncSession(seeded_database) as session:
        async with session.begin():
            await session.execute(text("UPDATE accounts SET is_active = false WHERE id = :id"), {"id": alice.id})

    response = await client.get(
        "/api/v1/secure/whoami",
        headers={"Authorization": f"Bearer {alice_token}"},
    )

    assert response.status_code == 401


@pytest.mark.anyio
async def test_actor_context_is_limited_to_its_transaction(seeded_database, alice) -> None:
    async with AsyncSession(seeded_database) as session:
        async with session.begin():
            await set_actor_context(session, Actor(id=alice.id, role=Role.SPECIALIST))
            actor_id = await session.scalar(text("SELECT current_setting('app.actor_id', true)"))
            actor_role = await session.scalar(text("SELECT current_setting('app.actor_role', true)"))

    assert actor_id == str(alice.id)
    assert actor_role == "specialist"

    async with AsyncSession(seeded_database) as session:
        async with session.begin():
            next_actor_id = await session.scalar(text("SELECT current_setting('app.actor_id', true)"))
            next_actor_role = await session.scalar(text("SELECT current_setting('app.actor_role', true)"))

    assert next_actor_id == ""
    assert next_actor_role == ""
