from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import Actor
from app.models.project import Project


async def list_visible_projects(session: AsyncSession) -> Sequence[Project]:
    return (await session.scalars(select(Project).order_by(Project.name))).all()


async def create_project(session: AsyncSession, actor: Actor, name: str) -> Project:
    project = Project(name=name, owner_id=actor.id)
    session.add(project)
    await session.flush()
    return project


async def get_visible_project(session: AsyncSession, project_id: UUID) -> Project | None:
    return await session.scalar(select(Project).where(Project.id == project_id))
