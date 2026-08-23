from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.identity import Role
from app.models.project import Project, ProjectAction, ProjectMembership, TemporaryProjectGrant


class ForbiddenError(Exception):
    """Raised when the current transaction has no path to a project action."""


async def authorize_project(
    session: AsyncSession,
    actor_id: UUID,
    project_id: UUID,
    action: ProjectAction,
) -> None:
    allowed_grant_actions = (
        (ProjectAction.READ, ProjectAction.EDIT)
        if action is ProjectAction.READ
        else (ProjectAction.EDIT,)
    )
    has_membership = exists(
        select(ProjectMembership.id).where(
            ProjectMembership.project_id == Project.id,
            ProjectMembership.account_id == actor_id,
        )
    )
    has_grant = exists(
        select(TemporaryProjectGrant.id).where(
            TemporaryProjectGrant.project_id == Project.id,
            TemporaryProjectGrant.account_id == actor_id,
            TemporaryProjectGrant.action.in_(allowed_grant_actions),
            TemporaryProjectGrant.expires_at > datetime.now(UTC),
        )
    )
    is_allowed = await session.scalar(
        select(Project.id)
        .where(
            Project.id == project_id,
            or_(
                func.current_setting("app.actor_role", True) == Role.MANAGER.value,
                Project.owner_id == actor_id,
                has_membership,
                has_grant,
            ),
        )
        .limit(1)
    )
    if is_allowed is None:
        raise ForbiddenError
