from fastapi import Depends, FastAPI

from app.api.routes.auth import router as auth_router
from app.api.routes.internal_auth import router as internal_auth_router
from app.api.routes.internal_artifacts import router as internal_artifacts_router
from app.api.routes.internal_sessions import router as internal_sessions_router
from app.api.routes.internal_workbench import (
    projects_router as internal_projects_router,
    router as internal_workbench_router,
    session_project_refs_router as internal_session_project_refs_router,
)
from app.api.routes.projects import router as projects_router
from app.core.config import settings
from app.core.security import Actor, get_current_actor

app = FastAPI(title=settings.PROJECT_NAME)
app.include_router(projects_router, prefix=settings.API_V1_STR)
app.include_router(auth_router, prefix=settings.API_V1_STR)
app.include_router(internal_auth_router)
app.include_router(internal_artifacts_router)
app.include_router(internal_sessions_router)
app.include_router(internal_workbench_router)
app.include_router(internal_projects_router)
app.include_router(internal_session_project_refs_router)


@app.get(f"{settings.API_V1_STR}/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get(f"{settings.API_V1_STR}/secure/whoami")
async def secure_whoami(actor: Actor = Depends(get_current_actor)) -> dict[str, str]:
    return {"actor_id": str(actor.id), "role": actor.role.value}


@app.get(f"{settings.API_V1_STR}/session")
async def session_scope(actor: Actor = Depends(get_current_actor)) -> dict[str, str]:
    return {"scope": str(actor.id)}
