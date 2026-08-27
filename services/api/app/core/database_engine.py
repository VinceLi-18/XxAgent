from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import Pool


def create_database_engine(
    database_url: str,
    *,
    password: str | None = None,
    poolclass: type[Pool] | None = None,
) -> AsyncEngine:
    """Create an engine, preferring an optional raw asyncpg password over the URL."""

    connect_args = {"password": password} if password is not None else {}
    if poolclass is None:
        return create_async_engine(
            database_url,
            pool_pre_ping=True,
            connect_args=connect_args,
        )
    return create_async_engine(
        database_url,
        pool_pre_ping=True,
        connect_args=connect_args,
        poolclass=poolclass,
    )
