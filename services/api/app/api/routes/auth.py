from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_admin_session
from app.services.auth import AuthenticationRejected, authenticate

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: str = Field(min_length=1, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_at: datetime
    csrf_token: str


@router.post("/login", response_model=LoginResponse)
async def login(
    request: LoginRequest,
    session: AsyncSession = Depends(get_admin_session),
) -> LoginResponse:
    try:
        issued = await authenticate(request.email, request.password, session)
    except AuthenticationRejected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthenticated"},
        ) from None
    # FastAPI finalizes yielded dependencies after response delivery. Commit
    # before exposing a token that another connection must introspect.
    await session.commit()
    return LoginResponse(
        access_token=issued.access_token,
        expires_at=issued.expires_at,
        csrf_token=issued.csrf_token,
    )
