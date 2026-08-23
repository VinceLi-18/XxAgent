from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import Actor


async def set_actor_context(session: AsyncSession, actor: Actor) -> None:
    await session.execute(
        text("SELECT set_config('app.actor_id', :actor_id, true)"),
        {"actor_id": str(actor.id)},
    )
    await session.execute(
        text("SELECT set_config('app.actor_role', :actor_role, true)"),
        {"actor_role": actor.role.value},
    )
