from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import settings


def create_database_engine(database_url: str) -> AsyncEngine:
    """Create one independently disposable PostgreSQL engine."""

    return create_async_engine(database_url, pool_pre_ping=True)


engine = create_database_engine(settings.DATABASE_URL)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
admin_engine = create_database_engine(settings.DATABASE_ADMIN_URL or settings.DATABASE_URL)
AdminSessionLocal = async_sessionmaker(admin_engine, expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        async with session.begin():
            yield session


async def get_admin_session() -> AsyncIterator[AsyncSession]:
    async with AdminSessionLocal() as session:
        async with session.begin():
            yield session
