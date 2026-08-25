import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.auth import XAgentAccountCredential, XAgentAuthSession, XAgentPermissionRevision
from app.models.identity import Account, Role

_password_hasher = PasswordHasher()
_dummy_password_hash = (
    "$argon2id$v=19$m=65536,t=3,p=4$Jg2uNVZWWGCIUdueNkvGEg"
    "$9UOYElho2prAWuZzIAbiv6/NZv3A+77I99Za9SjQ0pY"
)


class AuthenticationRejected(Exception):
    pass


class Principal(BaseModel):
    actor_id: UUID
    role: Role
    permission_revision: int
    auth_session_id: UUID
    email: str = Field(exclude=True)


@dataclass(frozen=True)
class IssuedLogin:
    access_token: str
    expires_at: datetime
    csrf_token: str


@dataclass(frozen=True)
class _TokenClaims:
    actor_id: UUID
    auth_session_id: UUID
    role: Role
    permission_revision: int
    jti: str


def _jti_hash(jti: str) -> str:
    return hashlib.sha256(jti.encode()).hexdigest()


def _decode_token(token: str) -> _TokenClaims:
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=["HS256"],
            issuer=settings.JWT_ISSUER,
            audience=settings.JWT_AUDIENCE,
            options={
                "require": [
                    "sub",
                    "sid",
                    "role",
                    "permission_revision",
                    "iss",
                    "aud",
                    "iat",
                    "exp",
                    "jti",
                ]
            },
        )
        subject = payload["sub"]
        session_id = payload["sid"]
        token_id = payload["jti"]
        role = payload["role"]
        permission_revision = payload["permission_revision"]
        if not all(isinstance(value, str) and value for value in (subject, session_id, token_id, role)):
            raise ValueError("token string claims must be non-empty")
        if isinstance(permission_revision, bool) or not isinstance(permission_revision, int):
            raise ValueError("permission revision must be an integer")
        return _TokenClaims(
            actor_id=UUID(subject),
            auth_session_id=UUID(session_id),
            role=Role(role),
            permission_revision=permission_revision,
            jti=token_id,
        )
    except (jwt.PyJWTError, KeyError, TypeError, ValueError):
        raise AuthenticationRejected from None


async def authenticate(email: str, password: str, session: AsyncSession) -> IssuedLogin:
    normalized_email = email.strip().casefold()
    row = (
        await session.execute(
            select(
                Account.id,
                Account.role,
                Account.is_active,
                XAgentAccountCredential.password_hash,
                XAgentPermissionRevision.revision,
            )
            .join(XAgentAccountCredential, XAgentAccountCredential.account_id == Account.id)
            .join(XAgentPermissionRevision, XAgentPermissionRevision.account_id == Account.id)
            .where(func.lower(Account.email) == normalized_email)
        )
    ).one_or_none()
    password_hash = row.password_hash if row is not None else _dummy_password_hash
    try:
        password_matches = _password_hasher.verify(password_hash, password)
    except (InvalidHashError, VerificationError, VerifyMismatchError):
        password_matches = False
    if row is None or not password_matches or not row.is_active:
        raise AuthenticationRejected

    now = datetime.now(UTC).replace(microsecond=0)
    expires_at = now + timedelta(hours=settings.XAGENT_AUTH_SESSION_HOURS)
    auth_session_id = uuid4()
    jti = str(uuid4())
    auth_session = XAgentAuthSession(
        id=auth_session_id,
        account_id=row.id,
        jti_hash=_jti_hash(jti),
        created_at=now,
        expires_at=expires_at,
    )
    session.add(auth_session)
    await session.flush()
    access_token = jwt.encode(
        {
            "sub": str(row.id),
            "sid": str(auth_session_id),
            "role": row.role.value,
            "permission_revision": row.revision,
            "iss": settings.JWT_ISSUER,
            "aud": settings.JWT_AUDIENCE,
            "iat": now,
            "exp": expires_at,
            "jti": jti,
        },
        settings.JWT_SECRET_KEY,
        algorithm="HS256",
    )
    return IssuedLogin(
        access_token=access_token,
        expires_at=expires_at,
        csrf_token=secrets.token_urlsafe(32),
    )


async def introspect(token: str, session: AsyncSession) -> Principal:
    claims = _decode_token(token)
    now = datetime.now(UTC)
    row = (
        await session.execute(
            select(
                XAgentAuthSession,
                Account.email,
                Account.role,
                Account.is_active,
                XAgentPermissionRevision.revision,
            )
            .join(Account, Account.id == XAgentAuthSession.account_id)
            .join(XAgentPermissionRevision, XAgentPermissionRevision.account_id == Account.id)
            .where(XAgentAuthSession.id == claims.auth_session_id)
            .with_for_update(of=XAgentAuthSession)
        )
    ).one_or_none()
    if row is None:
        raise AuthenticationRejected
    auth_session = row.XAgentAuthSession
    if (
        auth_session.account_id != claims.actor_id
        or not secrets.compare_digest(auth_session.jti_hash, _jti_hash(claims.jti))
        or auth_session.revoked_at is not None
        or auth_session.expires_at <= now
        or not row.is_active
        or row.role != claims.role
        or row.revision != claims.permission_revision
    ):
        raise AuthenticationRejected
    auth_session.last_verified_at = now
    await session.flush()
    return Principal(
        actor_id=claims.actor_id,
        role=row.role,
        permission_revision=row.revision,
        auth_session_id=claims.auth_session_id,
        email=row.email,
    )


async def revoke(token: str, session: AsyncSession) -> None:
    claims = _decode_token(token)
    auth_session = await session.scalar(
        select(XAgentAuthSession)
        .where(XAgentAuthSession.id == claims.auth_session_id)
        .with_for_update()
    )
    if (
        auth_session is None
        or auth_session.account_id != claims.actor_id
        or not secrets.compare_digest(auth_session.jti_hash, _jti_hash(claims.jti))
    ):
        raise AuthenticationRejected
    if auth_session.revoked_at is None:
        auth_session.revoked_at = datetime.now(UTC)
        await session.flush()
