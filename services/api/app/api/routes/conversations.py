from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.security import Actor, get_current_actor
from app.models.conversation import ConversationThread
from app.models.project import ProjectAction
from app.services.audit import write_audit_event
from app.services.authorization import ForbiddenError, authorize_project

router = APIRouter(prefix="/conversations", tags=["conversations"])


async def _record_read(
    session: AsyncSession,
    actor: Actor,
    conversation_id: UUID,
    request_id: UUID,
    result: str,
) -> None:
    await write_audit_event(
        session,
        actor.id,
        "conversation.read",
        "conversation_thread",
        conversation_id,
        request_id,
        result,
    )


@router.get("/{conversation_id}", response_model=None)
async def read_conversation(
    conversation_id: UUID,
    actor: Actor = Depends(get_current_actor),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str] | JSONResponse:
    request_id = uuid4()
    conversation = await session.scalar(
        select(ConversationThread).where(ConversationThread.id == conversation_id)
    )
    if conversation is None:
        await _record_read(session, actor, conversation_id, request_id, "denied")
        return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"detail": "Not found"})

    try:
        if conversation.project_id is not None:
            await authorize_project(session, actor.id, conversation.project_id, ProjectAction.READ)
    except ForbiddenError:
        await _record_read(session, actor, conversation_id, request_id, "denied")
        return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"detail": "Not found"})

    await _record_read(session, actor, conversation_id, request_id, "allowed")
    return {"id": str(conversation.id), "title": conversation.title}
