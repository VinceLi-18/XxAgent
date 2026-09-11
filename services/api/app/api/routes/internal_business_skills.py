"""Authenticated Skill governance with current-authority serializable transactions."""

from collections.abc import Awaitable, Callable
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.internal_auth import require_service_identity, require_user_token
from app.core.config import settings
from app.core.db import get_admin_session
from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.business_skills import BusinessSkill
from app.schemas.business_skills import (
    BusinessSkillAuthorizationRequest, BusinessSkillCreateRequest, BusinessSkillDetailRequest,
    BusinessSkillDraftRequest, BusinessSkillMutationRequest, BusinessSkillPageRequest,
    BusinessSkillPublishRequest, BusinessSkillVerdictRequest, BusinessSkillVersionRequest,
    BusinessSkillDetailResponse, BusinessSkillPageResponse,
    BusinessSkillTestStartRequest, BusinessSkillTestStartResponse, BusinessSkillTestSettleRequest,
    BusinessSkillTestResult, BusinessSkillTranscriptRequest, BusinessSkillTranscriptResponse,
    BusinessSkillTestMountRequest, BusinessSkillTestMountResponse, BusinessSkillTestCancelRequest,
    BusinessSkillRuntimeRequest, BusinessSkillCatalogResponse, BusinessSkillLoadRequest,
    BusinessSkillLoadResponse, BusinessSkillToolRequest, BusinessSkillToolResponse,
)
from app.services.auth import AuthenticationRejected, Principal, introspect
from app.services.business_skills import (
    BusinessSkillServiceError, audit_skill, list_business_skills, mutate_business_skill,
    skill_detail, visible_skill,
    start_business_skill_test, settle_business_skill_test, business_skill_transcript,
    mount_business_skill_test, cancel_unmounted_business_skill_test,
    business_skill_catalog, business_skill_runtime_decision,
)

MAX_BODY_BYTES = 512 * 1024


def error_response(code: str) -> JSONResponse:
    statuses = {"business-skill-input-invalid": 422, "not-found": 404, "forbidden": 403,
                "business-skill-revision-conflict": 409, "business-skill-test-required": 409,
                "business-skill-policy-changed": 409, "business-skill-retired": 409,
                "business-skill-conflict": 409, "idempotency-conflict": 409,
                "business-skill-version-changed": 409, "business-skill-tool-denied": 403,
                "business-skill-cancelled": 409}
    return JSONResponse(status_code=statuses.get(code, 503), content={"detail": {
        "code": code if code in statuses else "service-unavailable"}})


class ClosedBusinessSkillRoute(APIRoute):
    """Bound JSON reads and redact validation inputs from public diagnostics."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        handler = super().get_route_handler()

        async def closed(request: Request) -> Response:
            try:
                body = bytearray()
                async for chunk in request.stream():
                    if len(body) + len(chunk) > MAX_BODY_BYTES:
                        return error_response("business-skill-input-invalid")
                    body.extend(chunk)

                async def receive():
                    return {"type": "http.request", "body": bytes(body), "more_body": False}

                return await handler(Request(request.scope, receive))
            except RequestValidationError:
                return error_response("business-skill-input-invalid")

        return closed


router = APIRouter(prefix="/internal/xagent/business-skills", tags=["internal-business-skills"],
                   route_class=ClosedBusinessSkillRoute, dependencies=[Depends(require_service_identity)])
SlugPath = Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")]
RunPath = Annotated[int, Path(ge=1)]
Token = Annotated[str, Depends(require_user_token)]
Database = Annotated[AsyncSession, Depends(get_admin_session)]
GovernanceResult = dict[str, object] | JSONResponse
GovernanceOperation = Callable[[AsyncSession, Principal], Awaitable[GovernanceResult]]


async def governance_transaction(
    database: AsyncSession, token: str, project_id: UUID, operation: GovernanceOperation,
) -> GovernanceResult:
    """Lock authority and project as administrator, then execute all Skill writes under RLS."""
    bind = database.bind
    if bind is None:
        return error_response("service-unavailable")
    for attempt in range(3):
        try:
            async with AsyncSession(bind, expire_on_commit=False) as session:
                async with session.begin():
                    await session.execute(text("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"))
                    principal = await introspect(token, session, update_verification=False)
                    # Hold revocation and membership rows until the mutation commits.
                    await session.execute(text(
                        "SELECT a.id FROM accounts a JOIN xagent_permission_revisions p ON p.account_id=a.id "
                        "JOIN xagent_auth_sessions s ON s.account_id=a.id "
                        "WHERE a.id=:actor AND s.id=:login FOR SHARE OF a,p,s"
                    ), {"actor": principal.actor_id, "login": principal.auth_session_id})
                    member = await session.scalar(text(
                        "SELECT id FROM project_memberships WHERE project_id=:project AND account_id=:actor FOR SHARE"
                    ), {"project": project_id, "actor": principal.actor_id})
                    if member is None:
                        raise BusinessSkillServiceError("not-found")
                    await session.execute(text("SELECT id FROM projects WHERE id=:project FOR UPDATE"), {"project": project_id})
                    role = bind.dialect.identifier_preparer.quote(settings.POSTGRES_APP_USER)
                    await session.execute(text(f"SET LOCAL ROLE {role}"))
                    await set_actor_context(session, Actor(id=principal.actor_id, role=principal.role))
                    result = await operation(session, principal)
            return result
        except AuthenticationRejected:
            return error_response("not-found")
        except BusinessSkillServiceError as error:
            return error_response(error.code)
        except DBAPIError as error:
            if getattr(error.orig, "sqlstate", None) in {"40001", "40P01"} and attempt < 2:
                continue
            return error_response("service-unavailable")
        except (SQLAlchemyError, OSError):
            return error_response("service-unavailable")
    return error_response("service-unavailable")


async def mutation(
    database: AsyncSession, token: str, project_id: UUID, slug: str,
    operation: str, request: BusinessSkillMutationRequest, *, run_number: int | None = None,
) -> GovernanceResult:
    """Retain authorized denial audit after rolling back the attempted mutation."""
    async def execute(session: AsyncSession, principal: Principal) -> GovernanceResult:
        try:
            async with session.begin_nested():
                return await mutate_business_skill(session, principal, project_id, slug, operation, request, run_number=run_number)
        except BusinessSkillServiceError as error:
            if error.code in {"forbidden", "not-found"}:
                skill = await session.scalar(select(BusinessSkill).where(BusinessSkill.project_id == project_id, BusinessSkill.slug == slug))
                if skill is not None:
                    await audit_skill(session, principal, skill, "authorization_denied", error.code)
            return error_response(error.code)

    return await governance_transaction(database, token, project_id, execute)


@router.post("/projects/{project_id}/list", response_model=BusinessSkillPageResponse)
async def list_route(project_id: UUID, request: BusinessSkillPageRequest, token: Token, database: Database):
    return await governance_transaction(database, token, project_id,
        lambda session, principal: list_business_skills(session, project_id, request))


@router.post("/projects/{project_id}/create", response_model=BusinessSkillDetailResponse)
async def create_route(project_id: UUID, request: BusinessSkillCreateRequest, token: Token, database: Database):
    return await mutation(database, token, project_id, request.slug, "create", request)


@router.post("/projects/{project_id}/{slug}/detail", response_model=BusinessSkillDetailResponse)
async def detail_route(project_id: UUID, slug: SlugPath, request: BusinessSkillDetailRequest, token: Token, database: Database):
    async def detail(session, principal):
        return await skill_detail(session, await visible_skill(session, project_id, slug), request)
    return await governance_transaction(database, token, project_id, detail)


@router.post("/projects/{project_id}/{slug}/draft", response_model=BusinessSkillDetailResponse)
async def draft_route(project_id: UUID, slug: SlugPath, request: BusinessSkillDraftRequest, token: Token, database: Database):
    return await mutation(database, token, project_id, slug, "draft", request)


@router.post("/projects/{project_id}/{slug}/publish", response_model=BusinessSkillDetailResponse)
async def publish_route(project_id: UUID, slug: SlugPath, request: BusinessSkillPublishRequest, token: Token, database: Database):
    return await mutation(database, token, project_id, slug, "publish", request)


@router.post("/projects/{project_id}/{slug}/authorization", response_model=BusinessSkillDetailResponse)
async def authorization_route(project_id: UUID, slug: SlugPath, request: BusinessSkillAuthorizationRequest, token: Token, database: Database):
    return await mutation(database, token, project_id, slug, "authorization", request)


@router.post("/projects/{project_id}/{slug}/current-version", response_model=BusinessSkillDetailResponse)
async def version_route(project_id: UUID, slug: SlugPath, request: BusinessSkillVersionRequest, token: Token, database: Database):
    return await mutation(database, token, project_id, slug, "current-version", request)


@router.post("/projects/{project_id}/{slug}/retire", response_model=BusinessSkillDetailResponse)
async def retire_route(project_id: UUID, slug: SlugPath, request: BusinessSkillMutationRequest, token: Token, database: Database):
    return await mutation(database, token, project_id, slug, "retire", request)


@router.post("/projects/{project_id}/{slug}/tests/{run_number}/verdict", response_model=BusinessSkillDetailResponse)
async def verdict_route(project_id: UUID, slug: SlugPath, run_number: RunPath,
                        request: BusinessSkillVerdictRequest, token: Token, database: Database):
    return await mutation(database, token, project_id, slug, "verdict", request, run_number=run_number)


@router.post("/projects/{project_id}/{slug}/tests/start", response_model=BusinessSkillTestStartResponse)
async def test_start_route(project_id: UUID, slug: SlugPath, request: BusinessSkillTestStartRequest,
                           token: Token, database: Database):
    return await governance_transaction(database, token, project_id,
        lambda session, principal: start_business_skill_test(session, principal, project_id, slug, request))


@router.post("/projects/{project_id}/{slug}/tests/{run_number}/mount", response_model=BusinessSkillTestMountResponse)
async def test_mount_route(project_id: UUID, slug: SlugPath, run_number: RunPath,
                           request: BusinessSkillTestMountRequest, token: Token, database: Database):
    return await governance_transaction(database, token, project_id,
        lambda session, principal: mount_business_skill_test(session, principal, project_id, slug, run_number, request))


@router.post("/projects/{project_id}/{slug}/tests/{run_number}/settle", response_model=BusinessSkillTestResult)
async def test_settle_route(project_id: UUID, slug: SlugPath, run_number: RunPath,
                            request: BusinessSkillTestSettleRequest, token: Token, database: Database):
    return await governance_transaction(database, token, project_id,
        lambda session, principal: settle_business_skill_test(session, principal, project_id, slug, run_number, request))


@router.post("/projects/{project_id}/{slug}/tests/{run_number}/cancel-unmounted", response_model=BusinessSkillTestResult)
async def test_cancel_unmounted_route(project_id: UUID, slug: SlugPath, run_number: RunPath,
                                      request: BusinessSkillTestCancelRequest, token: Token, database: Database):
    return await governance_transaction(database, token, project_id,
        lambda session, principal: cancel_unmounted_business_skill_test(session, principal, project_id, slug, run_number, request))


@router.post("/projects/{project_id}/{slug}/tests/{run_number}/transcript", response_model=BusinessSkillTranscriptResponse)
async def test_transcript_route(project_id: UUID, slug: SlugPath, run_number: RunPath,
                                request: BusinessSkillTranscriptRequest, token: Token, database: Database):
    return await governance_transaction(database, token, project_id,
        lambda session, principal: business_skill_transcript(session, project_id, slug, run_number, request))


@router.post("/projects/{project_id}/runtime/catalog", response_model=BusinessSkillCatalogResponse)
async def runtime_catalog_route(project_id: UUID, request: BusinessSkillRuntimeRequest, token: Token, database: Database):
    return await governance_transaction(database, token, project_id,
        lambda session, principal: business_skill_catalog(session, project_id, request))


async def runtime_decision(database: AsyncSession, token: str, project_id: UUID,
                            request: BusinessSkillLoadRequest) -> GovernanceResult:
    """Commit content-free denial audit with the rejected runtime response."""
    async def execute(session: AsyncSession, principal: Principal) -> GovernanceResult:
        try:
            return await business_skill_runtime_decision(session, principal, project_id, request)
        except BusinessSkillServiceError as error:
            return error_response(error.code)
    return await governance_transaction(database, token, project_id, execute)


@router.post("/projects/{project_id}/runtime/load", response_model=BusinessSkillLoadResponse)
async def runtime_load_route(project_id: UUID, request: BusinessSkillLoadRequest, token: Token, database: Database):
    return await runtime_decision(database, token, project_id, request)


@router.post("/projects/{project_id}/runtime/authorize-tool", response_model=BusinessSkillToolResponse)
async def runtime_tool_route(project_id: UUID, request: BusinessSkillToolRequest, token: Token, database: Database):
    return await runtime_decision(database, token, project_id, request)
