import hashlib
import os
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import jwt
import pytest
from argon2 import PasswordHasher
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes import auth as auth_routes
from app.models.auth import XAgentAuthSession
from app.services.auth import IssuedLogin

PASSWORD = "correct horse battery staple"


@pytest.mark.anyio
async def test_login_commits_the_auth_session_before_returning_the_token(monkeypatch) -> None:
    expires_at = datetime(2026, 8, 25, 18, tzinfo=UTC)
    issued = IssuedLogin(access_token="signed-token", expires_at=expires_at, csrf_token="csrf-token")
    authenticate = AsyncMock(return_value=issued)
    monkeypatch.setattr(auth_routes, "authenticate", authenticate)
    session = AsyncMock(spec=AsyncSession)

    response = await auth_routes.login(
        auth_routes.LoginRequest(email="alice@example.test", password=PASSWORD),
        session,
    )

    session.commit.assert_awaited_once_with()
    assert response.access_token == "signed-token"


async def _set_password(engine, account_id, password: str = PASSWORD) -> None:
    password_hash = PasswordHasher().hash(password)
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO xagent_account_credentials "
                    "(account_id, password_hash, password_changed_at) "
                    "VALUES (:account_id, :password_hash, CURRENT_TIMESTAMP)"
                ),
                {"account_id": account_id, "password_hash": password_hash},
            )


@pytest.mark.anyio
async def test_login_issues_an_eight_hour_revocable_session(
    client,
    seeded_database,
    alice,
) -> None:
    await _set_password(seeded_database, alice.id)

    response = await client.post(
        "/api/v1/auth/login",
        json={"email": "  ALICE@example.test ", "password": PASSWORD},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["token_type"] == "bearer"
    assert isinstance(payload["csrf_token"], str) and len(payload["csrf_token"]) >= 32
    token = payload["access_token"]
    claims = jwt.decode(
        token,
        os.environ["JWT_SECRET_KEY"],
        algorithms=["HS256"],
        issuer=os.environ["JWT_ISSUER"],
        audience=os.environ["JWT_AUDIENCE"],
    )
    assert claims["sub"] == str(alice.id)
    assert claims["role"] == "specialist"
    assert claims["permission_revision"] == 1
    assert isinstance(claims["sid"], str)
    assert claims["exp"] - claims["iat"] == 8 * 60 * 60
    assert datetime.fromisoformat(payload["expires_at"]) == datetime.fromtimestamp(claims["exp"], UTC)

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        stored = await session.scalar(
            select(XAgentAuthSession).where(XAgentAuthSession.id == claims["sid"])
        )
    assert stored is not None
    assert stored.account_id == alice.id
    assert stored.jti_hash == hashlib.sha256(claims["jti"].encode()).hexdigest()
    assert stored.jti_hash != claims["jti"]
    assert stored.revoked_at is None
    assert PASSWORD not in response.text
    assert stored.jti_hash not in response.text


@pytest.mark.anyio
async def test_unknown_email_and_wrong_password_have_the_same_failure(
    client,
    seeded_database,
    alice,
) -> None:
    await _set_password(seeded_database, alice.id)

    unknown = await client.post(
        "/api/v1/auth/login",
        json={"email": "nobody@example.test", "password": "wrong-password"},
    )
    wrong = await client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.test", "password": "wrong-password"},
    )

    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json() == {"detail": {"code": "unauthenticated"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        assert await session.scalar(select(func.count()).select_from(XAgentAuthSession)) == 0


@pytest.mark.anyio
async def test_inactive_account_cannot_create_an_auth_session(
    client,
    seeded_database,
    alice,
) -> None:
    await _set_password(seeded_database, alice.id)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text("UPDATE accounts SET is_active = false WHERE id = :account_id"),
                {"account_id": alice.id},
            )

    response = await client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.test", "password": PASSWORD},
    )

    assert response.status_code == 401
    assert response.json() == {"detail": {"code": "unauthenticated"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        assert await session.scalar(select(func.count()).select_from(XAgentAuthSession)) == 0
