from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import get_session
from app.models.identity import Account, Role

bearer_scheme = HTTPBearer(auto_error=False)
SESSION_COOKIE_NAME = "jiaxin_agent_session"


class Actor(BaseModel):
    id: UUID
    role: Role


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_actor(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    session: AsyncSession = Depends(get_session),
) -> Actor:
    token = credentials.credentials if credentials is not None and credentials.scheme.lower() == "bearer" else None
    token = token or request.cookies.get(SESSION_COOKIE_NAME)
    if token is None:
        raise _unauthorized()

    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=["HS256"],
            issuer=settings.JWT_ISSUER,
            audience=settings.JWT_AUDIENCE,
            options={"require": ["sub", "iss", "aud", "iat", "exp", "jti"]},
        )
        subject = payload["sub"]
        token_id = payload["jti"]
        if not isinstance(subject, str) or not subject or not isinstance(token_id, str) or not token_id:
            raise ValueError("JWT subject and token ID must be non-empty strings")
        account_id = UUID(subject)
    except (jwt.PyJWTError, KeyError, TypeError, ValueError):
        raise _unauthorized() from None

    account = (
        await session.execute(
            select(Account.id, Account.role, Account.is_active).where(Account.id == account_id)
        )
    ).one_or_none()
    if account is None or not account.is_active:
        raise _unauthorized()

    actor = Actor(id=account.id, role=account.role)
    from app.core.db_context import set_actor_context

    await set_actor_context(session, actor)
    return actor
