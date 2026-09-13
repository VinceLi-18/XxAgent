"""Governance transitions run under a locked project and current actor RLS."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.business_skills import (
    BusinessSkill, BusinessSkillAuthorization, BusinessSkillDraft,
    BusinessSkillTestRun, BusinessSkillVersion,
)
from app.models.identity import Role
from app.models.audit import AuditEvent
from app.models.xagent_session import XAgentIdempotencyKey, XAgentSession, XAgentSessionEvent
from app.schemas.business_skills import (
    BusinessSkillAuthorizationRequest, BusinessSkillCreateRequest, BusinessSkillDetailRequest,
    BusinessSkillDraftRequest, BusinessSkillMutationRequest, BusinessSkillPageRequest,
    BusinessSkillPublishRequest, BusinessSkillVerdictRequest, BusinessSkillVersionRequest,
    BusinessSkillTestStartRequest, BusinessSkillTestSettleRequest, BusinessSkillTranscriptRequest,
    BusinessSkillTestMountRequest,
    BusinessSkillTestCancelRequest,
    BusinessSkillTestToolRequest,
    BusinessSkillRuntimeRequest, BusinessSkillLoadRequest, BusinessSkillToolRequest,
)
from app.services.audit import business_skill_audit_details, write_audit_event
from app.services.auth import Principal
from app.services.business_skill_policy import business_skill_content_digest, resolve_business_skill_policy
from app.services.fact_validation import canonical_sha256


class BusinessSkillServiceError(Exception):
    """A stable public error without private storage or authored content."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


async def visible_skill(session: AsyncSession, project_id: UUID, slug: str) -> BusinessSkill:
    item = await session.scalar(select(BusinessSkill).where(
        BusinessSkill.project_id == project_id, BusinessSkill.slug == slug,
    ).with_for_update())
    if item is None:
        raise BusinessSkillServiceError("not-found")
    return item


async def skill_summary(session: AsyncSession, item: BusinessSkill) -> dict[str, object]:
    draft = await session.get(BusinessSkillDraft, item.id)
    version = await session.get(BusinessSkillVersion, item.current_version_id) if item.current_version_id else None
    authorized = await session.scalar(select(BusinessSkillAuthorization.id).where(BusinessSkillAuthorization.skill_id == item.id))
    latest = await session.scalar(select(BusinessSkillTestRun).where(BusinessSkillTestRun.skill_id == item.id).order_by(BusinessSkillTestRun.run_number.desc()).limit(1))
    return {
        "slug": item.slug, "display_name": item.display_name, "status": item.status,
        "authorized": authorized is not None, "current_version": version.version_number if version else None,
        "draft_revision": draft.revision if draft else None,
        "latest_test": test_payload(latest) if latest else None,
        "updated_at": item.updated_at.isoformat(),
    }


def test_payload(run: BusinessSkillTestRun) -> dict[str, object]:
    return {"run_number": run.run_number, "draft_revision": run.draft_revision,
            "content_digest": run.content_digest, "tool_policy_digest": run.tool_policy_digest,
            "unexecuted_write_tools": run.unexecuted_write_tools,
            "status": run.status, "termination_reason": run.termination_reason, "verdict": run.verdict,
            "started_at": run.started_at.isoformat(),
            "settled_at": run.settled_at.isoformat() if run.settled_at else None,
            "verdict_at": run.verdict_at.isoformat() if run.verdict_at else None}


async def skill_detail(session: AsyncSession, item: BusinessSkill, request: BusinessSkillDetailRequest) -> dict[str, object]:
    result = {"schema_version": 1, **await skill_summary(session, item)}
    draft = await session.get(BusinessSkillDraft, item.id)
    result["draft"] = None if draft is None else {
        "revision": draft.revision, "description": draft.description, "instructions": draft.instructions,
        "primary_tools": draft.primary_tools, "content_digest": draft.content_digest,
        "tool_policy_digest": resolve_business_skill_policy(draft.primary_tools).digest,
    }
    versions_query = select(BusinessSkillVersion).where(BusinessSkillVersion.skill_id == item.id)
    runs_query = select(BusinessSkillTestRun).where(BusinessSkillTestRun.skill_id == item.id)
    if request.version_cursor is not None:
        versions_query = versions_query.where(BusinessSkillVersion.version_number < request.version_cursor)
    if request.run_cursor is not None:
        runs_query = runs_query.where(BusinessSkillTestRun.run_number < request.run_cursor)
    versions = list((await session.scalars(versions_query.order_by(BusinessSkillVersion.version_number.desc()).limit(request.limit + 1))).all())
    runs = list((await session.scalars(runs_query.order_by(BusinessSkillTestRun.run_number.desc()).limit(request.limit + 1))).all())
    result["versions"] = [{"version_number": v.version_number, "description": v.description,
                           "instructions": v.instructions, "primary_tools": v.primary_tools,
                           "complete_tools": v.complete_tools, "content_digest": v.content_digest,
                           "tool_policy_digest": v.tool_policy_digest, "source_draft_revision": v.source_draft_revision,
                           "published_at": v.published_at.isoformat()} for v in versions[:request.limit]]
    result["tests"] = [test_payload(run) for run in runs[:request.limit]]
    result["next_version_cursor"] = versions[request.limit - 1].version_number if len(versions) > request.limit else None
    result["next_run_cursor"] = runs[request.limit - 1].run_number if len(runs) > request.limit else None
    audits = await session.scalars(select(AuditEvent).where(
        AuditEvent.resource_type == "business_skill", AuditEvent.resource_id == item.id,
        AuditEvent.action.like("business_skill.%"),
    ).order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc()).limit(request.limit))
    result["audit_summary"] = [{"action": event.action, "result": event.result,
                               "version_number": event.details.get("version_number"),
                               "created_at": event.created_at.isoformat()} for event in audits]
    return result


async def list_business_skills(session: AsyncSession, project_id: UUID, request: BusinessSkillPageRequest) -> dict[str, object]:
    query = select(BusinessSkill).where(BusinessSkill.project_id == project_id)
    if request.cursor:
        query = query.where(BusinessSkill.slug > request.cursor)
    rows = list((await session.scalars(query.order_by(BusinessSkill.slug).limit(request.limit + 1))).all())
    return {"schema_version": 1, "items": [await skill_summary(session, row) for row in rows[:request.limit]],
            "next_cursor": rows[request.limit - 1].slug if len(rows) > request.limit else None}


async def audit_skill(session: AsyncSession, principal: Principal, skill: BusinessSkill, action: str, result: str, **details) -> None:
    await write_audit_event(session, principal.actor_id, f"business_skill.{action}", "business_skill",
                            skill.id, uuid4(), result, details=business_skill_audit_details(
                                project_id=skill.project_id, skill_id=skill.id, result=result, **details))


async def mutate_business_skill(
    session: AsyncSession, principal: Principal, project_id: UUID, slug: str,
    operation: str, request: BusinessSkillMutationRequest, *, run_number: int | None = None,
) -> dict[str, object]:
    """Recheck authorization before replay, then commit content, pointers, and audit together.

    The caller owns the serializable transaction and locks the project before entering
    actor RLS; project-wide number allocation and per-Skill transitions share that order.
    """
    skill = None if operation == "create" else await visible_skill(session, project_id, slug)
    if operation in {"publish", "authorization", "current-version", "retire"} and principal.role != Role.MANAGER:
        raise BusinessSkillServiceError("forbidden")
    operation_key = f"business_skill.{operation}"
    await session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                          {"key": f"{principal.actor_id}:{operation_key}:{request.idempotency_key}"})
    digest = canonical_sha256({"project_id": str(project_id), "slug": slug, "run_number": run_number,
                               "request": request.model_dump(mode="json", exclude={"idempotency_key"})})
    stored = await session.get(XAgentIdempotencyKey, (principal.actor_id, operation_key, request.idempotency_key))
    if stored is not None:
        if stored.request_hash != digest:
            raise BusinessSkillServiceError("idempotency-conflict")
        return stored.result
    if skill is not None and skill.status == "retired":
        raise BusinessSkillServiceError("business-skill-retired")
    if skill is not None:
        skill.updated_at = datetime.now(UTC)
    if isinstance(request, BusinessSkillCreateRequest):
        existing = await session.scalar(select(BusinessSkill.id).where(BusinessSkill.project_id == project_id, BusinessSkill.slug == slug))
        if existing is not None:
            raise BusinessSkillServiceError("business-skill-conflict")
        skill = BusinessSkill(id=uuid4(), project_id=project_id, slug=slug, display_name=request.display_name,
                              created_by_id=principal.actor_id, status="active")
        session.add(skill)
        await session.flush()
        session.add(BusinessSkillDraft(skill_id=skill.id, project_id=project_id, revision=1,
                    description=request.description, instructions=request.instructions, primary_tools=request.primary_tools,
                    content_digest=business_skill_content_digest(request.description, request.instructions, request.primary_tools),
                    edited_by_id=principal.actor_id))
        await session.flush()
        await audit_skill(session, principal, skill, "create", "created", request_sha256=digest)
    else:
        assert skill is not None
        if isinstance(request, BusinessSkillDraftRequest):
            await update_draft(session, principal, skill, request, digest)
        elif isinstance(request, BusinessSkillPublishRequest):
            await publish_skill(session, principal, skill, request, digest)
        elif isinstance(request, BusinessSkillAuthorizationRequest):
            authorization = await session.scalar(select(BusinessSkillAuthorization).where(BusinessSkillAuthorization.skill_id == skill.id))
            if request.authorized:
                if skill.current_version_id is None:
                    raise BusinessSkillServiceError("business-skill-conflict")
                if authorization is None:
                    session.add(BusinessSkillAuthorization(skill_id=skill.id, project_id=project_id, authorized_by_id=principal.actor_id))
            elif authorization is not None:
                await session.delete(authorization)
            await audit_skill(session, principal, skill, "authorize" if request.authorized else "unauthorize",
                              "authorized" if request.authorized else "unauthorized", request_sha256=digest)
        elif isinstance(request, BusinessSkillVersionRequest):
            version = await own_version(session, skill, request.version_number)
            skill.current_version_id = version.id
            await audit_skill(session, principal, skill, "rollback", "selected", version_number=version.version_number, request_sha256=digest)
        elif isinstance(request, BusinessSkillVerdictRequest):
            run = await session.scalar(select(BusinessSkillTestRun).where(BusinessSkillTestRun.skill_id == skill.id,
                                        BusinessSkillTestRun.run_number == run_number).with_for_update())
            if run is None:
                raise BusinessSkillServiceError("not-found")
            if run.status == "running" or (request.verdict == "pass" and run.status != "completed"):
                raise BusinessSkillServiceError("business-skill-conflict")
            run.verdict, run.verdict_by_id, run.verdict_at = request.verdict, principal.actor_id, datetime.now(UTC)
            await audit_skill(session, principal, skill, "test_verdict", "reviewed", run_number=run.run_number,
                              verdict=run.verdict, request_sha256=digest)
        elif operation == "retire":
            await session.execute(delete(BusinessSkillAuthorization).where(BusinessSkillAuthorization.skill_id == skill.id))
            skill.status = "retired"
            await audit_skill(session, principal, skill, "retire", "retired", request_sha256=digest)
        else:
            raise BusinessSkillServiceError("business-skill-input-invalid")
    await session.flush()
    result = await skill_detail(session, skill, BusinessSkillDetailRequest(schema_version=1))
    session.add(XAgentIdempotencyKey(actor_id=principal.actor_id, operation=operation_key,
                idempotency_key=request.idempotency_key, request_hash=digest, result=result,
                expires_at=datetime.max.replace(tzinfo=UTC)))
    await session.flush()
    return result


async def own_version(session: AsyncSession, skill: BusinessSkill, number: int) -> BusinessSkillVersion:
    version = await session.scalar(select(BusinessSkillVersion).where(BusinessSkillVersion.skill_id == skill.id,
                                    BusinessSkillVersion.version_number == number))
    if version is None:
        raise BusinessSkillServiceError("not-found")
    return version


async def update_draft(session: AsyncSession, principal: Principal, skill: BusinessSkill,
                       request: BusinessSkillDraftRequest, digest: str) -> None:
    draft = await session.get(BusinessSkillDraft, skill.id, with_for_update=True)
    if draft is None or draft.revision != request.expected_draft_revision:
        raise BusinessSkillServiceError("business-skill-revision-conflict")
    source = await own_version(session, skill, request.source_version_number) if request.source_version_number else draft
    values = {key: getattr(request, key) if getattr(request, key) is not None else getattr(source, key)
              for key in ("description", "instructions", "primary_tools")}
    content_digest = business_skill_content_digest(**values)
    if content_digest != draft.content_digest:
        draft.revision += 1
        for key, value in values.items():
            setattr(draft, key, value)
        draft.content_digest = content_digest
        draft.edited_by_id, draft.updated_at = principal.actor_id, datetime.now(UTC)
    if request.display_name is not None:
        skill.display_name = request.display_name
    await audit_skill(session, principal, skill, "draft_update", "updated", draft_revision=draft.revision,
                      content_digest=draft.content_digest, request_sha256=digest)


async def publish_skill(session: AsyncSession, principal: Principal, skill: BusinessSkill,
                        request: BusinessSkillPublishRequest, digest: str) -> None:
    draft = await session.get(BusinessSkillDraft, skill.id, with_for_update=True)
    if draft is None or draft.revision != request.expected_draft_revision:
        raise BusinessSkillServiceError("business-skill-revision-conflict")
    policy = resolve_business_skill_policy(draft.primary_tools)
    passing = await session.scalar(select(BusinessSkillTestRun.id).where(
        BusinessSkillTestRun.skill_id == skill.id, BusinessSkillTestRun.draft_revision == draft.revision,
        BusinessSkillTestRun.content_digest == draft.content_digest, BusinessSkillTestRun.tool_policy_digest == policy.digest,
        BusinessSkillTestRun.status == "completed", BusinessSkillTestRun.termination_reason == "completed",
        BusinessSkillTestRun.verdict == "pass",
    ).limit(1))
    if passing is None:
        raise BusinessSkillServiceError("business-skill-test-required")
    number = (await session.scalar(select(func.coalesce(func.max(BusinessSkillVersion.version_number), 0)).where(
                                    BusinessSkillVersion.project_id == skill.project_id))) + 1
    version = BusinessSkillVersion(id=uuid4(), skill_id=skill.id, project_id=skill.project_id, version_number=number,
                description=draft.description, instructions=draft.instructions, primary_tools=draft.primary_tools,
                complete_tools=list(policy.complete_tools), content_digest=draft.content_digest, tool_policy_digest=policy.digest,
                source_draft_revision=draft.revision, published_by_id=principal.actor_id)
    session.add(version)
    await session.flush()
    skill.current_version_id = version.id
    await audit_skill(session, principal, skill, "publish", "published", version_number=number,
                      draft_revision=draft.revision, content_digest=draft.content_digest, tool_policy_digest=policy.digest,
                      request_sha256=digest)


async def test_replay(session: AsyncSession, principal: Principal, project_id: UUID,
                      slug: str, operation: str, request: BusinessSkillMutationRequest,
                      run_number: int | None = None) -> tuple[dict[str, object] | None, str]:
    """Replay only after the caller locks and reauthorizes its project and test identity."""
    await session.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                          {"key": f"{principal.actor_id}:{operation}:{request.idempotency_key}"})
    digest = canonical_sha256({"project_id": str(project_id), "slug": slug, "run_number": run_number,
                               "request": request.model_dump(mode="json", exclude={"idempotency_key"})})
    stored = await session.get(XAgentIdempotencyKey, (principal.actor_id, operation, request.idempotency_key))
    if stored is not None and stored.request_hash != digest:
        raise BusinessSkillServiceError("idempotency-conflict")
    return (stored.result if stored is not None else None), digest


async def store_test_replay(session: AsyncSession, principal: Principal, operation: str,
                            request: BusinessSkillMutationRequest, digest: str, result: dict[str, object]) -> None:
    session.add(XAgentIdempotencyKey(actor_id=principal.actor_id, operation=operation,
        idempotency_key=request.idempotency_key, request_hash=digest, result=result,
        expires_at=datetime.max.replace(tzinfo=UTC)))
    await session.flush()


async def start_business_skill_test(session: AsyncSession, principal: Principal, project_id: UUID,
                                     slug: str, request: BusinessSkillTestStartRequest) -> dict[str, object]:
    """Create an empty isolated Session and run atomically; the Host admits the actual turn.

    The durable idempotent response retains the exact draft and scenario across edits.
    The caller holds project authority and the project allocation lock until commit.
    """
    skill = await visible_skill(session, project_id, slug)
    if skill.status != "active":
        raise BusinessSkillServiceError("business-skill-retired")
    replay, digest = await test_replay(session, principal, project_id, slug, "business_skill.test_start", request)
    if replay is not None:
        return replay
    draft = await session.get(BusinessSkillDraft, skill.id, with_for_update=True)
    if draft is None or draft.revision != request.expected_draft_revision:
        raise BusinessSkillServiceError("business-skill-revision-conflict")
    policy = resolve_business_skill_policy(draft.primary_tools)
    if policy.digest != request.tool_policy_digest:
        raise BusinessSkillServiceError("business-skill-policy-changed")
    number = (await session.scalar(select(func.coalesce(func.max(BusinessSkillTestRun.run_number), 0)).where(
        BusinessSkillTestRun.project_id == project_id))) + 1
    test_session = XAgentSession(id=uuid4(), owner_id=principal.actor_id, project_id=project_id,
        visibility="project", purpose="business_skill_test", permission_revision_created=principal.permission_revision,
        title=f"{slug} test {number}")
    session.add(test_session)
    await session.flush()
    run = BusinessSkillTestRun(id=uuid4(), skill_id=skill.id, project_id=project_id, run_number=number,
        draft_revision=draft.revision, content_digest=draft.content_digest, tool_policy_digest=policy.digest,
        unexecuted_write_tools=list(policy.unexecuted_write_tools),
        test_tools=list(policy.test_tools),
        session_id=test_session.id, started_by_id=principal.actor_id)
    session.add(run)
    await session.flush()
    result = {"schema_version": 1, "test": test_payload(run), "session_id": str(test_session.id),
        "purpose": "business_skill_test", "scenario": request.scenario,
        "draft": {"revision": draft.revision, "description": draft.description, "instructions": draft.instructions,
                  "primary_tools": draft.primary_tools, "content_digest": draft.content_digest, "tool_policy_digest": policy.digest},
        "test_tools": run.test_tools, "unexecuted_write_tools": run.unexecuted_write_tools}
    await audit_skill(session, principal, skill, "test_start", "running", run_number=number,
        session_id=test_session.id, draft_revision=draft.revision, content_digest=draft.content_digest,
        tool_policy_digest=policy.digest, request_sha256=digest)
    await store_test_replay(session, principal, "business_skill.test_start", request, digest, result)
    return result


async def locked_test(session: AsyncSession, project_id: UUID, slug: str,
                       run_number: int) -> tuple[BusinessSkill, BusinessSkillTestRun]:
    """Discover the immutable Session identity, then lock Session, Skill, and run in order."""
    identity = await session.scalar(select(BusinessSkillTestRun.session_id).join(
        BusinessSkill, BusinessSkill.id == BusinessSkillTestRun.skill_id).where(
        BusinessSkill.project_id == project_id, BusinessSkill.slug == slug,
        BusinessSkillTestRun.run_number == run_number))
    if identity is None:
        raise BusinessSkillServiceError("not-found")
    test_session = await session.scalar(select(XAgentSession).where(XAgentSession.id == identity,
        XAgentSession.project_id == project_id, XAgentSession.purpose == "business_skill_test").with_for_update())
    if test_session is None:
        raise BusinessSkillServiceError("not-found")
    skill = await visible_skill(session, project_id, slug)
    run = await session.scalar(select(BusinessSkillTestRun).where(
        BusinessSkillTestRun.skill_id == skill.id, BusinessSkillTestRun.run_number == run_number).with_for_update())
    assert run is not None
    return skill, run


async def settle_business_skill_test(session: AsyncSession, principal: Principal, project_id: UUID,
                                      slug: str, run_number: int, request: BusinessSkillTestSettleRequest) -> dict[str, object]:
    """Only the starting actor can settle; terminal outcomes never change, including late replies."""
    skill, run = await locked_test(session, project_id, slug, run_number)
    if run.session_id != request.session_id or run.started_by_id != principal.actor_id:
        raise BusinessSkillServiceError("not-found")
    replay, digest = await test_replay(session, principal, project_id, slug, "business_skill.test_settle", request, run_number)
    if replay is not None:
        return replay
    if run.status != "running":
        raise BusinessSkillServiceError("business-skill-conflict")
    run.termination_reason = request.termination_reason
    run.status = request.termination_reason if request.termination_reason in {"completed", "cancelled"} else "failed"
    run.settled_at = datetime.now(UTC)
    await session.flush()
    result = {"schema_version": 1, "test": test_payload(run)}
    await audit_skill(session, principal, skill, "test_settle", run.status,
                      run_number=run.run_number, session_id=run.session_id, request_sha256=digest)
    await store_test_replay(session, principal, "business_skill.test_settle", request, digest, result)
    return result


async def mount_business_skill_test(session: AsyncSession, principal: Principal, project_id: UUID,
                                    slug: str, run_number: int, request: BusinessSkillTestMountRequest) -> dict[str, object]:
    """Publish one factory atomically; an exact replay observes ownership but never reacquires it."""
    skill, run = await locked_test(session, project_id, slug, run_number)
    if run.session_id != request.session_id or run.started_by_id != principal.actor_id:
        raise BusinessSkillServiceError("not-found")
    if skill.status != "active":
        raise BusinessSkillServiceError("business-skill-retired")
    replay, digest = await test_replay(session, principal, project_id, slug, "business_skill.test_mount", request, run_number)
    if replay is not None:
        return {"schema_version": 1, "test": test_payload(run), "claimed": False}
    item = await session.get(XAgentSession, run.session_id)
    assert item is not None
    nonempty = await session.scalar(select(XAgentSessionEvent.sequence).where(XAgentSessionEvent.session_id == item.id).limit(1))
    if run.status != "running" or item.runtime_header is not None or item.last_event_sequence != -1 or nonempty is not None:
        raise BusinessSkillServiceError("business-skill-conflict")
    item.runtime_header = request.runtime_header
    for sequence, event in enumerate(request.events):
        session.add(XAgentSessionEvent(session_id=item.id, sequence=sequence, schema_version=1,
            event_type=event.event_type, payload=event.payload, actor_id=principal.actor_id))
    item.last_event_sequence = len(request.events) - 1
    await session.flush()
    result = {"schema_version": 1, "test": test_payload(run), "claimed": True}
    await store_test_replay(session, principal, "business_skill.test_mount", request, digest, result)
    return result


async def authorize_business_skill_test_tool(session: AsyncSession, principal: Principal, project_id: UUID,
                                             slug: str, run_number: int, request: BusinessSkillTestToolRequest) -> dict[str, object]:
    """Recheck the mounted run and immutable test policy under current authority and retirement locks."""
    skill, run = await locked_test(session, project_id, slug, run_number)
    try:
        if run.session_id != request.session_id or run.started_by_id != principal.actor_id:
            raise BusinessSkillServiceError("not-found")
        item = await session.get(XAgentSession, run.session_id)
        assert item is not None
        if run.status != "running" or item.runtime_header is None:
            raise BusinessSkillServiceError("business-skill-conflict")
        if skill.status != "active":
            raise BusinessSkillServiceError("business-skill-retired")
        if request.cancelled:
            raise BusinessSkillServiceError("business-skill-cancelled")
        if request.tool_policy_digest != run.tool_policy_digest:
            raise BusinessSkillServiceError("business-skill-policy-changed")
        if request.tool_name not in run.test_tools:
            raise BusinessSkillServiceError("business-skill-tool-denied")
        return {"schema_version": 1, "allowed": True}
    except BusinessSkillServiceError as error:
        outcome = {"business-skill-conflict": "forbidden", "business-skill-policy-changed": "forbidden",
                   "business-skill-cancelled": "cancelled"}.get(error.code, error.code)
        await audit_skill(session, principal, skill, "tool_authorization_denied", outcome,
                          session_id=run.session_id, run_number=run.run_number)
        raise


async def cancel_unmounted_business_skill_test(session: AsyncSession, principal: Principal, project_id: UUID,
                                               slug: str, run_number: int, request: BusinessSkillTestCancelRequest) -> dict[str, object]:
    """Race mounting under the same locks; mounted runs remain exclusively owned by their runner."""
    _, run = await locked_test(session, project_id, slug, run_number)
    if run.session_id != request.session_id or run.started_by_id != principal.actor_id:
        raise BusinessSkillServiceError("not-found")
    test_session = await session.get(XAgentSession, run.session_id)
    assert test_session is not None
    occupied = await session.scalar(select(XAgentSessionEvent.sequence).where(
        XAgentSessionEvent.session_id == run.session_id).limit(1))
    if run.status != "running" or test_session.runtime_header is not None or test_session.last_event_sequence != -1 or occupied is not None:
        return {"schema_version": 1, "test": test_payload(run)}
    return await settle_business_skill_test(session, principal, project_id, slug, run_number,
        BusinessSkillTestSettleRequest(schema_version=1, session_id=request.session_id,
            termination_reason="cancelled", idempotency_key=request.idempotency_key))


async def business_skill_transcript(session: AsyncSession, project_id: UUID, slug: str,
                                     run_number: int, request: BusinessSkillTranscriptRequest) -> dict[str, object]:
    """Return durable test events without persistence actor, audit, or Session keys."""
    _, run = await locked_test(session, project_id, slug, run_number)
    events = list(await session.scalars(select(XAgentSessionEvent).where(
        XAgentSessionEvent.session_id == run.session_id, XAgentSessionEvent.sequence > request.after_sequence
    ).order_by(XAgentSessionEvent.sequence).limit(request.limit)))
    return {"schema_version": 1, "test": test_payload(run), "events": [
        {"schema_version": event.schema_version, "sequence": event.sequence, "event_type": event.event_type,
         "payload": event.payload, "created_at": event.created_at.isoformat()} for event in events],
        "next_sequence": events[-1].sequence if events else request.after_sequence}


async def runtime_session(session: AsyncSession, project_id: UUID, session_id: UUID) -> XAgentSession:
    item = await session.scalar(select(XAgentSession).where(XAgentSession.id == session_id,
        XAgentSession.project_id == project_id, XAgentSession.visibility == "project",
        XAgentSession.purpose == "conversation", XAgentSession.archived.is_(False)).with_for_update())
    if item is None:
        raise BusinessSkillServiceError("not-found")
    return item


def catalog_entry(skill: BusinessSkill, version: BusinessSkillVersion) -> dict[str, object]:
    return {"schema_version": 1, "slug": skill.slug, "description": version.description,
            "version_number": version.version_number, "version_key": str(version.id)}


async def business_skill_catalog(session: AsyncSession, project_id: UUID,
                                  request: BusinessSkillRuntimeRequest) -> dict[str, object]:
    await runtime_session(session, project_id, request.session_id)
    rows = await session.execute(select(BusinessSkill, BusinessSkillVersion).join(
        BusinessSkillVersion, BusinessSkill.current_version_id == BusinessSkillVersion.id).join(
        BusinessSkillAuthorization, BusinessSkillAuthorization.skill_id == BusinessSkill.id).where(
        BusinessSkill.project_id == project_id, BusinessSkill.status == "active").order_by(BusinessSkill.slug))
    return {"schema_version": 1, "items": [catalog_entry(skill, version) for skill, version in rows]}


async def business_skill_runtime_decision(session: AsyncSession, principal: Principal, project_id: UUID,
                                           request: BusinessSkillLoadRequest) -> dict[str, object]:
    """Recheck current authorization on every load or tool call; tool calls may pin history."""
    await runtime_session(session, project_id, request.session_id)
    skill = await visible_skill(session, project_id, request.slug)
    tool_request = isinstance(request, BusinessSkillToolRequest)
    try:
        version = await session.scalar(select(BusinessSkillVersion).where(
            BusinessSkillVersion.id == request.version_key, BusinessSkillVersion.skill_id == skill.id,
            BusinessSkillVersion.project_id == project_id))
        authorization = await session.scalar(select(BusinessSkillAuthorization).where(
            BusinessSkillAuthorization.skill_id == skill.id))
        if skill.status != "active" or authorization is None or version is None:
            raise BusinessSkillServiceError("not-found")
        if tool_request:
            if request.cancelled:
                raise BusinessSkillServiceError("business-skill-cancelled")
            if request.tool_policy_digest != version.tool_policy_digest:
                raise BusinessSkillServiceError("business-skill-policy-changed")
            if request.tool_name not in version.complete_tools:
                raise BusinessSkillServiceError("business-skill-tool-denied")
            return {"schema_version": 1, "allowed": True}
        if skill.current_version_id != version.id:
            raise BusinessSkillServiceError("business-skill-version-changed")
        return {**catalog_entry(skill, version), "instructions": version.instructions,
                "content_digest": version.content_digest, "tool_policy_digest": version.tool_policy_digest,
                "complete_tools": version.complete_tools}
    except BusinessSkillServiceError as error:
        outcome = {"business-skill-cancelled": "cancelled", "business-skill-policy-changed": "forbidden",
                   "business-skill-version-changed": "forbidden"}.get(error.code, error.code)
        await audit_skill(session, principal, skill, "tool_authorization_denied" if tool_request else "load_denied",
                          outcome, session_id=request.session_id)
        raise
