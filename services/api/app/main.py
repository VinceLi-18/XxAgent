from fastapi import Depends, FastAPI

from app.api.routes.artifacts import router as artifacts_router
from app.api.routes.conversations import router as conversations_router
from app.api.routes.projects import router as projects_router
from app.core.config import settings
from app.core.security import Actor, get_current_actor

app = FastAPI(title=settings.PROJECT_NAME)
app.include_router(conversations_router, prefix=settings.API_V1_STR)
app.include_router(artifacts_router, prefix=settings.API_V1_STR)
app.include_router(projects_router, prefix=settings.API_V1_STR)


@app.get(f"{settings.API_V1_STR}/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get(f"{settings.API_V1_STR}/secure/whoami")
async def secure_whoami(actor: Actor = Depends(get_current_actor)) -> dict[str, str]:
    return {"actor_id": str(actor.id), "role": actor.role.value}


@app.get(f"{settings.API_V1_STR}/session")
async def session_scope(actor: Actor = Depends(get_current_actor)) -> dict[str, str]:
    return {"scope": str(actor.id)}
