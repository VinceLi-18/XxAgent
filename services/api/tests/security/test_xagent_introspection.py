import os

import pytest
from argon2 import PasswordHasher
from sqlalchemy import event, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import admin_engine
from app.models.auth import XAgentAuthSession

PASSWORD = "correct horse battery staple"
SERVICE_HEADERS = {"X-XAgent-Service-Token": "xagent-test-service-token-00000001"}


async def _login(client, engine, account_id) -> str:
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO xagent_account_credentials "
                    "(account_id, password_hash, password_changed_at) "
                    "VALUES (:account_id, :password_hash, CURRENT_TIMESTAMP)"
                ),
                {"account_id": account_id, "password_hash": PasswordHasher().hash(PASSWORD)},
            )
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.test", "password": PASSWORD},
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def _headers(token: str) -> dict[str, str]:
    return {**SERVICE_HEADERS, "Authorization": f"Bearer {token}"}


@pytest.mark.anyio
async def test_introspection_requires_service_identity_and_returns_current_principal(
    client,
    seeded_database,
    alice,
) -> None:
    token = await _login(client, seeded_database, alice.id)

    without_service = await client.post(
        "/internal/xagent/auth/introspect",
        headers={"Authorization": f"Bearer {token}"},
    )
    principal = await client.post(
        "/internal/xagent/auth/introspect",
        headers=_headers(token),
    )

    assert without_service.status_code == 403
    assert without_service.json() == {"detail": {"code": "service-unauthorized"}}
    assert principal.status_code == 200
    assert principal.json() == {
        "actor_id": str(alice.id),
        "role": "specialist",
        "permission_revision": 1,
        "auth_session_id": principal.json()["auth_session_id"],
    }
    assert token not in principal.text
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        auth_session = await session.scalar(select(XAgentAuthSession))
    assert auth_session is not None and auth_session.last_verified_at is not None


@pytest.mark.anyio
async def test_introspection_locks_only_the_auth_session_it_updates(
    client,
    seeded_database,
    alice,
) -> None:
    token = await _login(client, seeded_database, alice.id)
    statements: list[str] = []

    def capture_statement(_connection, _cursor, statement, _parameters, _context, _executemany) -> None:
        statements.append(statement)

    event.listen(admin_engine.sync_engine, "before_cursor_execute", capture_statement)
    try:
        response = await client.post(
            "/internal/xagent/auth/introspect",
            headers=_headers(token),
        )
    finally:
        event.remove(admin_engine.sync_engine, "before_cursor_execute", capture_statement)

    assert response.status_code == 200
    locking_statements = [statement for statement in statements if "FOR UPDATE" in statement]
    assert len(locking_statements) == 1
    assert "FOR UPDATE OF xagent_auth_sessions" in locking_statements[0]


@pytest.mark.anyio
async def test_introspection_rejects_tampering_and_stale_permission_revision(
    client,
    seeded_database,
    alice,
) -> None:
    token = await _login(client, seeded_database, alice.id)
    token_parts = token.split(".")
    token_parts[2] = f"{'A' if token_parts[2][0] != 'A' else 'B'}{token_parts[2][1:]}"
    tampered = ".".join(token_parts)

    bad_signature = await client.post(
        "/internal/xagent/auth/introspect",
        headers=_headers(tampered),
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text("UPDATE accounts SET role = 'manager' WHERE id = :account_id"),
                {"account_id": alice.id},
            )
    stale = await client.post(
        "/internal/xagent/auth/introspect",
        headers=_headers(token),
    )

    assert bad_signature.status_code == 401
    assert stale.status_code == 401
    assert bad_signature.json() == stale.json() == {"detail": {"code": "unauthenticated"}}
    assert token not in stale.text


@pytest.mark.anyio
async def test_revoke_invalidates_the_server_session_before_logout_returns(
    client,
    seeded_database,
    alice,
) -> None:
    token = await _login(client, seeded_database, alice.id)

    revoked = await client.post(
        "/internal/xagent/auth/revoke",
        headers=_headers(token),
    )
    after = await client.post(
        "/internal/xagent/auth/introspect",
        headers=_headers(token),
    )

    assert revoked.status_code == 204
    assert after.status_code == 401
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        auth_session = await session.scalar(select(XAgentAuthSession))
    assert auth_session is not None and auth_session.revoked_at is not None
    assert token not in revoked.text


@pytest.mark.anyio
async def test_wrong_service_token_never_reaches_user_token_validation(
    client,
) -> None:
    forged_user_token = "not-a-jwt"
    response = await client.post(
        "/internal/xagent/auth/introspect",
        headers={
            "X-XAgent-Service-Token": f"{os.environ['XAGENT_SERVICE_TOKEN']}x",
            "Authorization": f"Bearer {forged_user_token}",
        },
    )

    assert response.status_code == 403
    assert response.json() == {"detail": {"code": "service-unauthorized"}}
    assert forged_user_token not in response.text
