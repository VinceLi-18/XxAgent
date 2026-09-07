import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection

from app.core.database_engine import create_database_engine

from app.core.migration_config import migration_settings
from app.models.audit import AuditEvent
from app.models.artifact import Artifact, ArtifactProcessingJob, ArtifactVersion, StagingUpload
from app.models.base import Base
from app.models.identity import Account
from app.models.project import Project, ProjectMembership, TemporaryProjectGrant
from app.models.retrieval import (
    ArtifactIndexJob,
    ArtifactSearchHead,
    ArtifactTextChunk,
    ArtifactTextIndex,
    XAgentRetrievalReceipt,
)
from app.models.workbench import (
    XAgentAccountCapabilityGrant,
    XAgentSessionProjectRef,
    XAgentWorkbenchPreference,
)

config = context.config
if config.get_main_option("sqlalchemy.url") == "postgresql+asyncpg://placeholder":
    config.set_main_option(
        "sqlalchemy.url",
        migration_settings.DATABASE_ADMIN_URL.replace("%", "%%"),
    )
config.set_main_option("application_role", migration_settings.POSTGRES_APP_USER)
config.set_main_option("worker_role", migration_settings.POSTGRES_WORKER_USER)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = create_database_engine(
        config.get_main_option("sqlalchemy.url"),
        password=migration_settings.POSTGRES_PASSWORD,
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
