"""Verification and durable single-use consumption for Host delegation tokens."""

import base64
import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.retrieval import XAgentDelegationNonce


class DelegationError(RuntimeError):
    """A delegation token failed closed without exposing its rejected claim."""

    code = "service-unavailable"

    def __init__(self) -> None:
        super().__init__(self.code)


@dataclass(frozen=True)
class DelegationExpectation:
    actor_id: UUID
    session_id: UUID
    project_id: UUID | None
    tool_call_id: str
    tool_name: str
    permission_revision: int


@dataclass(frozen=True)
class DelegationClaims:
    nonce: str
    expires_at: datetime


def nonce_digest(nonce: str) -> str:
    return hashlib.sha256(nonce.encode()).hexdigest()


def delegation_public_key(encoded_key: str | None) -> Ed25519PublicKey:
    if not encoded_key:
        raise DelegationError
    try:
        return Ed25519PublicKey.from_public_bytes(base64.b64decode(encoded_key, validate=True))
    except ValueError:
        raise DelegationError from None


def decode_and_validate_delegation(
    token: str | None,
    expected: DelegationExpectation,
    *,
    public_key: Ed25519PublicKey | None,
    issuer: str = "xagent-host",
    audience: str = "xagent-api",
    now: datetime | None = None,
) -> DelegationClaims:
    if not isinstance(token, str) or not token or public_key is None:
        raise DelegationError
    current = now or datetime.now(UTC)
    try:
        payload = jwt.decode(
            token,
            public_key,
            algorithms=["EdDSA"],
            issuer=issuer,
            audience=audience,
            options={
                "verify_exp": False,
                "verify_iat": False,
                "require": [
                    "iss", "aud", "iat", "exp", "actor_id", "session_id",
                    "tool_call_id", "tool_name", "permission_revision", "nonce",
                ],
            },
        )
        if set(payload) != {
            "iss", "aud", "iat", "exp", "actor_id", "project_id", "session_id",
            "tool_call_id", "tool_name", "permission_revision", "nonce",
        }:
            raise ValueError
        issued_at = payload["iat"]
        expires_at = payload["exp"]
        project_id = payload["project_id"]
        revision = payload["permission_revision"]
        nonce = payload["nonce"]
        if (
            isinstance(issued_at, bool) or not isinstance(issued_at, int)
            or isinstance(expires_at, bool) or not isinstance(expires_at, int)
            or expires_at - issued_at < 1 or expires_at - issued_at > 60
            or issued_at > int(current.timestamp()) or expires_at <= int(current.timestamp())
            or not isinstance(nonce, str) or not nonce
            or isinstance(revision, bool) or not isinstance(revision, int)
            or UUID(payload["actor_id"]) != expected.actor_id
            or UUID(payload["session_id"]) != expected.session_id
            or (UUID(project_id) if project_id is not None else None) != expected.project_id
            or payload["tool_call_id"] != expected.tool_call_id
            or payload["tool_name"] != expected.tool_name
            or revision != expected.permission_revision
        ):
            raise ValueError
        return DelegationClaims(
            nonce=nonce,
            expires_at=datetime.fromtimestamp(expires_at, UTC),
        )
    except (jwt.PyJWTError, KeyError, TypeError, ValueError):
        raise DelegationError from None


async def consume_delegation_nonce(
    session: AsyncSession,
    *,
    actor_id: UUID,
    claims: DelegationClaims,
) -> None:
    result = await session.execute(
        insert(XAgentDelegationNonce)
        .values(
            nonce_sha256=nonce_digest(claims.nonce),
            actor_id=actor_id,
            expires_at=claims.expires_at,
        )
        .on_conflict_do_nothing()
        .returning(XAgentDelegationNonce.nonce_sha256)
    )
    if result.scalar_one_or_none() is None:
        raise DelegationError
