from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.db_context import set_actor_context
from app.core.security import Actor, get_current_actor
from app.services.projects import create_project, get_visible_project, list_visible_projects

router = APIRouter(prefix="/projects", tags=["projects"])


class CreateProjectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)

    @field_validator("name")
    @classmethod
    def nonblank_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Name must not be blank")
        return value


class ProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    created_at: datetime


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    actor: Actor = Depends(get_current_actor),
    session: AsyncSession = Depends(get_session),
) -> list[ProjectResponse]:
    await set_actor_context(session, actor)
    projects = await list_visible_projects(session)
    return [ProjectResponse.model_validate(project) for project in projects]


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_new_project(
    payload: CreateProjectRequest,
    actor: Actor = Depends(get_current_actor),
    session: AsyncSession = Depends(get_session),
) -> ProjectResponse:
    await set_actor_context(session, actor)
    return ProjectResponse.model_validate(await create_project(session, actor, payload.name))


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: UUID,
    actor: Actor = Depends(get_current_actor),
    session: AsyncSession = Depends(get_session),
) -> ProjectResponse:
    await set_actor_context(session, actor)
    project = await get_visible_project(session, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return ProjectResponse.model_validate(project)
