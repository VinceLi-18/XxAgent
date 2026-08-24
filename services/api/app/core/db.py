from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings

engine = create_async_engine(settings.DATABASE_URL, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
admin_engine = create_async_engine(settings.DATABASE_ADMIN_URL or settings.DATABASE_URL, pool_pre_ping=True)
AdminSessionLocal = async_sessionmaker(admin_engine, expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        async with session.begin():
            yield session


async def get_admin_session() -> AsyncIterator[AsyncSession]:
    async with AdminSessionLocal() as session:
        async with session.begin():
            yield session
