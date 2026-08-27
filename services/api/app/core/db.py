from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import settings
from app.core.database_engine import create_database_engine


engine = create_database_engine(
    settings.DATABASE_URL,
    password=settings.POSTGRES_APP_PASSWORD,
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
admin_engine = create_database_engine(
    settings.DATABASE_ADMIN_URL or settings.DATABASE_URL,
    password=(
        settings.POSTGRES_PASSWORD
        if settings.DATABASE_ADMIN_URL is not None
        else settings.POSTGRES_APP_PASSWORD
    ),
)
AdminSessionLocal = async_sessionmaker(admin_engine, expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        async with session.begin():
            yield session


async def get_admin_session() -> AsyncIterator[AsyncSession]:
    async with AdminSessionLocal() as session:
        async with session.begin():
            yield session
