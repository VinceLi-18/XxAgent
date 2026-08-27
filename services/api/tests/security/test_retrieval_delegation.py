from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.identity import Role
from app.models.retrieval import XAgentDelegationNonce
from app.services.retrieval_delegation import (
    DelegationClaims,
    DelegationError,
    DelegationExpectation,
    consume_delegation_nonce,
    decode_and_validate_delegation,
    nonce_digest,
)
from conftest import DELEGATION_PRIVATE_KEY


def test_nonce_digest_never_contains_the_nonce() -> None:
    assert nonce_digest("opaque-nonce") != "opaque-nonce"
    assert len(nonce_digest("opaque-nonce")) == 64


def test_delegation_rejects_missing_or_malformed_compact_token() -> None:
    expectation = DelegationExpectation(
        actor_id=UUID(int=1), session_id=UUID(int=2), project_id=None,
        tool_call_id="call-1", tool_name="search_artifacts", permission_revision=1,
    )
    for token in (None, "", "not-a-token"):
        with pytest.raises(DelegationError, match="service-unavailable"):
            decode_and_validate_delegation(token, expectation, public_key=None)


def _claims(now: datetime) -> dict[str, object]:
    return {
        "iss": "xagent-host", "aud": "xagent-api",
        "iat": int(now.timestamp()), "exp": int((now + timedelta(seconds=30)).timestamp()),
        "actor_id": str(UUID(int=1)), "project_id": None,
        "session_id": str(UUID(int=2)), "tool_call_id": "call-1",
        "tool_name": "search_artifacts", "permission_revision": 1,
        "nonce": "opaque-nonce",
    }


def test_delegation_verifies_signature_lifetime_and_bound_claims() -> None:
    now = datetime(2026, 8, 28, tzinfo=UTC)
    expected = DelegationExpectation(
        actor_id=UUID(int=1), session_id=UUID(int=2), project_id=None,
        tool_call_id="call-1", tool_name="search_artifacts", permission_revision=1,
    )
    token = jwt.encode(_claims(now), DELEGATION_PRIVATE_KEY, algorithm="EdDSA")

    assert decode_and_validate_delegation(
        token, expected, public_key=DELEGATION_PRIVATE_KEY.public_key(), now=now
    ).nonce == "opaque-nonce"

    for field, value in (
        ("actor_id", str(UUID(int=3))), ("session_id", str(UUID(int=4))),
        ("project_id", str(UUID(int=5))), ("tool_call_id", "other"),
        ("tool_name", "list_accessible_projects"), ("permission_revision", 2),
    ):
        changed = {**_claims(now), field: value}
        rejected = jwt.encode(changed, DELEGATION_PRIVATE_KEY, algorithm="EdDSA")
        with pytest.raises(DelegationError):
            decode_and_validate_delegation(
                rejected, expected, public_key=DELEGATION_PRIVATE_KEY.public_key(), now=now
            )


@pytest.mark.anyio
async def test_delegation_nonce_is_durable_and_single_use(actor_session, alice) -> None:
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    claims = DelegationClaims(
        nonce="single-use-secret",
        expires_at=datetime.now(UTC) + timedelta(minutes=1),
    )
    await consume_delegation_nonce(actor_session, actor_id=alice.id, claims=claims)

    with pytest.raises(DelegationError):
        await consume_delegation_nonce(actor_session, actor_id=alice.id, claims=claims)

    row = await actor_session.scalar(select(XAgentDelegationNonce))
    assert row.nonce_sha256 == nonce_digest("single-use-secret")
    assert "single-use-secret" not in row.nonce_sha256


@pytest.mark.anyio
async def test_delegation_nonce_schema_rejects_raw_or_expired_values(
    seeded_database, alice
) -> None:
    for digest, expires_at in (
        ("raw-nonce", datetime.now(UTC) + timedelta(minutes=1)),
        ("a" * 64, datetime.now(UTC) - timedelta(minutes=1)),
    ):
        with pytest.raises(DBAPIError):
            async with seeded_database.begin() as connection:
                await connection.execute(
                    text(
                        "INSERT INTO xagent_delegation_nonces "
                        "(nonce_sha256, actor_id, expires_at) VALUES (:digest, :actor, :expires)"
                    ),
                    {"digest": digest, "actor": alice.id, "expires": expires_at},
                )
