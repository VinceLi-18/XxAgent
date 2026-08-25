from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from app.core.security import Actor
from app.models.identity import Account
from app.models.project import Project
from app.models.workbench import XAgentCapability
from app.services.capabilities import effective_capabilities


class ProjectCreationForbidden(Exception):
    pass


async def list_visible_projects(session: AsyncSession) -> Sequence[Project]:
    return (await session.scalars(select(Project).order_by(Project.name))).all()


async def create_project(session: AsyncSession, actor: Actor, name: str) -> Project:
    account = await session.scalar(
        select(Account)
        .options(load_only(Account.id, Account.role, Account.is_active))
        .where(Account.id == actor.id)
    )
    if account is None:
        raise ProjectCreationForbidden
    if XAgentCapability.PROJECT_CREATE not in await effective_capabilities(
        session,
        account,
    ):
        raise ProjectCreationForbidden
    project = Project(name=name, owner_id=actor.id)
    session.add(project)
    await session.flush()
    return project


async def get_visible_project(session: AsyncSession, project_id: UUID) -> Project | None:
    return await session.scalar(select(Project).where(Project.id == project_id))
