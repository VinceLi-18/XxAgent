from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import Actor
from app.models.identity import Account
from app.models.project import Project
from app.models.workbench import XAgentWorkbenchPreference
from app.models.xagent_session import XAgentIdempotencyKey, XAgentSession
from app.services.auth import Principal
from app.services.capabilities import effective_capabilities
from app.services.projects import create_project


@dataclass(frozen=True)
class WorkbenchContext:
    kind: Literal["workbench", "project"]
    project_id: UUID | None = None


class WorkbenchNotFound(Exception):
    pass


class WorkbenchIdempotencyConflict(Exception):
    pass


async def normalize_context(
    session: AsyncSession,
    principal: Principal,
    requested: WorkbenchContext | None,
) -> WorkbenchContext:
    preference = await session.get(
        XAgentWorkbenchPreference,
        principal.actor_id,
        with_for_update=True,
    )
    candidate = requested
    if candidate is None and preference is not None:
        candidate = WorkbenchContext(
            kind=preference.context_kind,
            project_id=preference.project_id,
        )

    normalized = WorkbenchContext(kind="workbench")
    if candidate is not None and candidate.kind == "project" and candidate.project_id is not None:
        visible_project = await session.scalar(
            select(Project.id).where(Project.id == candidate.project_id)
        )
        if visible_project is not None:
            normalized = candidate
        elif requested is not None:
            raise WorkbenchNotFound

    now = datetime.now(UTC)
    if preference is None:
        session.add(
            XAgentWorkbenchPreference(
                account_id=principal.actor_id,
                context_kind=normalized.kind,
                project_id=normalized.project_id,
                updated_at=now,
            )
        )
    elif (
        preference.context_kind != normalized.kind
        or preference.project_id != normalized.project_id
    ):
        preference.context_kind = normalized.kind
        preference.project_id = normalized.project_id
        preference.updated_at = now
    await session.flush()
    return normalized


async def bootstrap_workbench(
    session: AsyncSession,
    principal: Principal,
) -> dict[str, Any]:
    account = Account(
        id=principal.actor_id,
        email=principal.email,
        role=principal.role,
        is_active=True,
    )
    capabilities = await effective_capabilities(session, account)
    projects = (
        await session.scalars(select(Project).order_by(Project.name, Project.id))
    ).all()
    context = await normalize_context(session, principal, None)
    counts = (
        await session.execute(
            select(
                XAgentSession.visibility,
                XAgentSession.project_id,
                func.count(),
            ).group_by(XAgentSession.visibility, XAgentSession.project_id)
        )
    ).all()
    private_count = 0
    project_counts = {str(project.id): 0 for project in projects}
    for visibility, project_id, count in counts:
        if visibility == "private":
            private_count += count
        elif project_id is not None and str(project_id) in project_counts:
            project_counts[str(project_id)] += count

    return {
        "schema_version": 1,
        "account": {
            "id": str(principal.actor_id),
            "email": principal.email,
            "role": principal.role.value,
            "permission_revision": principal.permission_revision,
        },
        "capabilities": sorted(capability.value for capability in capabilities),
        "context": {
            "kind": context.kind,
            "project_id": str(context.project_id) if context.project_id is not None else None,
        },
        "projects": [
            {
                "id": str(project.id),
                "name": project.name,
                "created_at": project.created_at.isoformat(),
            }
            for project in projects
        ],
        "session_summary": {
            "private_count": private_count,
            "project_counts": project_counts,
        },
    }


async def create_and_select_project(
    session: AsyncSession,
    principal: Principal,
    *,
    name: str,
    idempotency_key: str,
    digest: str,
) -> tuple[dict[str, Any], bool]:
    operation = "project.create"
    lock_name = f"{principal.actor_id}:{operation}:{idempotency_key}"
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_name, 0))"),
        {"lock_name": lock_name},
    )
    stored = await session.get(
        XAgentIdempotencyKey,
        (principal.actor_id, operation, idempotency_key),
    )
    if stored is not None and stored.expires_at > datetime.now(UTC):
        if stored.request_hash != digest:
            raise WorkbenchIdempotencyConflict
        stored_project_id = UUID(stored.result["project"]["id"])
        await normalize_context(
            session,
            principal,
            WorkbenchContext(kind="project", project_id=stored_project_id),
        )
        return stored.result, True

    project = await create_project(
        session,
        Actor(id=principal.actor_id, role=principal.role),
        name,
    )
    selected = await normalize_context(
        session,
        principal,
        WorkbenchContext(kind="project", project_id=project.id),
    )
    result = {
        "schema_version": 1,
        "account_id": str(principal.actor_id),
        "project": {
            "id": str(project.id),
            "name": project.name,
            "created_at": project.created_at.isoformat(),
        },
        "context": {
            "kind": selected.kind,
            "project_id": str(selected.project_id),
        },
    }
    expires_at = datetime.now(UTC) + timedelta(hours=24)
    if stored is None:
        session.add(
            XAgentIdempotencyKey(
                actor_id=principal.actor_id,
                operation=operation,
                idempotency_key=idempotency_key,
                request_hash=digest,
                result=result,
                expires_at=expires_at,
            )
        )
    else:
        stored.request_hash = digest
        stored.result = result
        stored.expires_at = expires_at
    await session.flush()
    return result, False


async def project_detail(
    session: AsyncSession,
    principal: Principal,
    project_id: UUID,
) -> dict[str, Any]:
    project = await session.scalar(select(Project).where(Project.id == project_id))
    if project is None:
        raise WorkbenchNotFound
    can_edit = bool(
        await session.scalar(
            text(
                "SELECT :project_id IN "
                "(SELECT public.xagent_authorized_project_edit_ids())"
            ),
            {"project_id": project_id},
        )
    )
    session_count = await session.scalar(
        select(func.count())
        .select_from(XAgentSession)
        .where(XAgentSession.project_id == project_id)
    )
    return {
        "schema_version": 1,
        "account_id": str(principal.actor_id),
        "project": {
            "id": str(project.id),
            "name": project.name,
            "created_at": project.created_at.isoformat(),
        },
        "access": {"can_edit": can_edit},
        "session_summary": {"session_count": session_count or 0},
    }
