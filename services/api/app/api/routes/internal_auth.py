import secrets

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import get_admin_session
from app.services.auth import AuthenticationRejected, Principal, introspect, revoke

router = APIRouter(prefix="/internal/xagent/auth", tags=["internal-auth"])
bearer = HTTPBearer(auto_error=False)


def require_service_identity(
    service_token: str | None = Header(default=None, alias="X-XAgent-Service-Token"),
) -> None:
    if service_token is None or not secrets.compare_digest(service_token, settings.XAGENT_SERVICE_TOKEN):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "service-unauthorized"},
        )


def require_user_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> str:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthenticated"},
        )
    return credentials.credentials


@router.post("/introspect", response_model=Principal)
async def introspect_route(
    _: None = Depends(require_service_identity),
    token: str = Depends(require_user_token),
    session: AsyncSession = Depends(get_admin_session),
) -> Principal:
    try:
        return await introspect(token, session)
    except AuthenticationRejected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthenticated"},
        ) from None


@router.post("/revoke", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_route(
    _: None = Depends(require_service_identity),
    token: str = Depends(require_user_token),
    session: AsyncSession = Depends(get_admin_session),
) -> Response:
    try:
        await revoke(token, session)
    except AuthenticationRejected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthenticated"},
        ) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)
