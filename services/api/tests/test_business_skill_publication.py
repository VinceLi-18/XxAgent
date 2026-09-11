"""Publication consumes exact successful human-reviewed test evidence."""

import asyncio
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import select, func, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.business_skills import BusinessSkill, BusinessSkillTestRun
from app.models.xagent_session import XAgentSession

from test_business_skill_governance import body, creation, skill_api


async def seed_test(engine, project_session, actor_id, draft, *, status="completed", verdict="pass", slug="research", **overrides):
    async with AsyncSession(engine) as session:
        async with session.begin():
            skill = await session.scalar(select(BusinessSkill).where(BusinessSkill.slug == slug))
            number = (await session.scalar(select(func.coalesce(func.max(BusinessSkillTestRun.run_number), 0)))) + 1
            test_session = XAgentSession(id=uuid4(), title="Test", owner_id=actor_id,
                project_id=project_session.project_id, visibility="project", permission_revision_created=1,
                purpose="business_skill_test")
            session.add(test_session)
            await session.flush()
            session.add(BusinessSkillTestRun(id=uuid4(), skill_id=skill.id, project_id=skill.project_id,
                run_number=number, draft_revision=overrides.get("revision", draft["revision"]),
                content_digest=overrides.get("content", draft["content_digest"]),
                tool_policy_digest=overrides.get("policy", draft["tool_policy_digest"]),
                session_id=test_session.id, started_by_id=actor_id, status=status,
                settled_at=datetime.now(UTC) if status != "running" else None,
                termination_reason=status if status != "running" else None, verdict=verdict,
                verdict_by_id=actor_id if verdict else None, verdict_at=datetime.now(UTC) if verdict else None))
    return number


@pytest.mark.anyio
@pytest.mark.parametrize("status,verdict,mismatch", [
    ("completed", None, None), ("completed", "reject", None), ("failed", None, None),
    ("cancelled", None, None), ("running", None, None),
    ("completed", "pass", "revision"), ("completed", "pass", "content"),
    ("completed", "pass", "policy"),
])
async def test_publication_rejects_ineligible_test(skill_api, seeded_database, fact_project_session, alice, status, verdict, mismatch):
    draft = (await skill_api("/create", creation())).json()["draft"]
    overrides = {mismatch: 2 if mismatch == "revision" else "f" * 64} if mismatch else {}
    await seed_test(seeded_database, fact_project_session, alice.id, draft, status=status, verdict=verdict, **overrides)
    result = await skill_api("/research/publish", body(expected_draft_revision=1), "manager")
    assert result.status_code == 409
    assert result.json() == {"detail": {"code": "business-skill-test-required"}}


@pytest.mark.anyio
async def test_publication_requires_test_and_exact_revision(skill_api):
    assert (await skill_api("/create", creation())).status_code == 200
    for revision, code in [(1, "business-skill-test-required"), (2, "business-skill-revision-conflict")]:
        result = await skill_api("/research/publish", body(expected_draft_revision=revision), "manager")
        assert result.json() == {"detail": {"code": code}}


@pytest.mark.anyio
async def test_publish_replay_authorization_version_copy_and_terminal_retirement(skill_api, seeded_database, fact_project_session, alice):
    draft = (await skill_api("/create", creation())).json()["draft"]
    await seed_test(seeded_database, fact_project_session, alice.id, draft, verdict=None)
    verdict = await skill_api("/research/tests/1/verdict", body(verdict="pass"))
    assert verdict.status_code == 200, verdict.text
    publish = body(expected_draft_revision=1)
    results = await asyncio.gather(*[skill_api("/research/publish", publish, "manager") for _ in range(2)])
    assert all(result.status_code == 200 for result in results), [r.text for r in results]
    assert results[0].json() == results[1].json()
    published = results[0].json()
    assert published["current_version"] == 1 and published["authorized"] is False
    authorized = await skill_api("/research/authorization", body(authorized=True), "manager")
    assert authorized.json()["authorized"] is True
    edited = await skill_api("/research/draft", body(expected_draft_revision=1, source_version_number=1, instructions="Second draft"))
    assert edited.json()["draft"]["revision"] == 2
    detail = (await skill_api("/research/detail")).json()
    assert detail["versions"][0]["instructions"] == "# Research\nFind evidence."
    selected = await skill_api("/research/current-version", body(version_number=1), "manager")
    assert selected.json()["authorized"] is True
    retire = body()
    retired = await skill_api("/research/retire", retire, "manager")
    assert retired.json()["status"] == "retired" and retired.json()["authorized"] is False
    assert (await skill_api("/research/retire", retire, "manager")).json() == retired.json()
    for operation, payload in [("draft", {"expected_draft_revision": 2, "display_name": "Restore"}), ("publish", {"expected_draft_revision": 2}), ("authorization", {"authorized": True}), ("current-version", {"version_number": 1})]:
        rejected = await skill_api(f"/research/{operation}", body(**payload), "manager")
        assert rejected.json() == {"detail": {"code": "business-skill-retired"}}


@pytest.mark.anyio
async def test_version_selection_and_copy_reject_other_skill(skill_api, seeded_database, fact_project_session, alice):
    draft = (await skill_api("/create", creation())).json()["draft"]
    await seed_test(seeded_database, fact_project_session, alice.id, draft)
    assert (await skill_api("/research/publish", body(expected_draft_revision=1), "manager")).status_code == 200
    other = creation()
    other["slug"] = "other"
    assert (await skill_api("/create", other)).status_code == 200
    for operation, payload in [("current-version", {"version_number": 1}), ("draft", {"expected_draft_revision": 1, "source_version_number": 1})]:
        result = await skill_api(f"/other/{operation}", body(**payload), "manager")
        assert result.status_code == 404


@pytest.mark.anyio
@pytest.mark.parametrize("status", ["running", "failed", "cancelled"])
async def test_human_pass_requires_completed_test(skill_api, seeded_database, fact_project_session, alice, status):
    draft = (await skill_api("/create", creation())).json()["draft"]
    await seed_test(seeded_database, fact_project_session, alice.id, draft, status=status, verdict=None)
    result = await skill_api("/research/tests/1/verdict", body(verdict="pass"))
    assert result.status_code == 409


@pytest.mark.anyio
async def test_authorization_follows_new_versions_and_copy_uses_selected_history(skill_api, seeded_database, fact_project_session, alice):
    draft = (await skill_api("/create", creation())).json()["draft"]
    await seed_test(seeded_database, fact_project_session, alice.id, draft)
    assert (await skill_api("/research/publish", body(expected_draft_revision=1), "manager")).status_code == 200
    assert (await skill_api("/research/authorization", body(authorized=True), "manager")).status_code == 200
    draft = (await skill_api("/research/draft", body(expected_draft_revision=1, instructions="Version two"))).json()["draft"]
    await seed_test(seeded_database, fact_project_session, alice.id, draft)
    published = (await skill_api("/research/publish", body(expected_draft_revision=2), "manager")).json()
    assert published["authorized"] is True and published["current_version"] == 2
    assert (await skill_api("/research/current-version", body(version_number=1), "manager")).status_code == 200
    copied = (await skill_api("/research/draft", body(expected_draft_revision=2, source_version_number=1))).json()
    assert copied["draft"]["instructions"] == "# Research\nFind evidence."
    assert copied["draft"]["revision"] == 3
    assert len(copied["versions"]) == 2
    assert (await skill_api("/research/authorization", body(authorized=False), "manager")).json()["authorized"] is False


@pytest.mark.anyio
async def test_publication_racing_edit_never_publishes_untested_content(skill_api, seeded_database, fact_project_session, alice):
    draft = (await skill_api("/create", creation())).json()["draft"]
    await seed_test(seeded_database, fact_project_session, alice.id, draft)
    publish, edit = await asyncio.gather(
        skill_api("/research/publish", body(expected_draft_revision=1), "manager"),
        skill_api("/research/draft", body(expected_draft_revision=1, instructions="Untested")),
    )
    assert edit.status_code == 200
    assert publish.status_code in {200, 409}
    detail = (await skill_api("/research/detail")).json()
    assert detail["draft"]["revision"] == 2
    assert all(version["instructions"] == "# Research\nFind evidence." for version in detail["versions"])


@pytest.mark.anyio
async def test_tool_policy_is_exact_and_resolver_changes_require_new_test(skill_api, seeded_database, fact_project_session, alice, monkeypatch):
    from app.services import business_skill_policy
    request = creation()
    request["primary_tools"] = ["list_accessible_projects", "propose_fact", "search_artifacts"]
    draft = (await skill_api("/create", request)).json()["draft"]
    await seed_test(seeded_database, fact_project_session, alice.id, draft)
    published = (await skill_api("/research/publish", body(expected_draft_revision=1), "manager")).json()
    assert published["versions"][0]["complete_tools"] == ["list_accessible_projects", "propose_fact", "search_artifacts", "skill", "submit_cited_answer"]
    monkeypatch.setattr(business_skill_policy, "BUSINESS_SKILL_TOOL_POLICY_VERSION", 2)
    result = await skill_api("/research/publish", body(expected_draft_revision=1), "manager")
    assert result.json() == {"detail": {"code": "business-skill-test-required"}}


@pytest.mark.anyio
async def test_retirement_racing_authorization_cannot_leave_effective_permission(skill_api, seeded_database, fact_project_session, alice):
    draft = (await skill_api("/create", creation())).json()["draft"]
    await seed_test(seeded_database, fact_project_session, alice.id, draft)
    assert (await skill_api("/research/publish", body(expected_draft_revision=1), "manager")).status_code == 200
    retire, authorize = await asyncio.gather(
        skill_api("/research/retire", body(), "manager"),
        skill_api("/research/authorization", body(authorized=True), "manager"),
    )
    assert retire.status_code == 200
    assert authorize.status_code in {200, 409}
    detail = (await skill_api("/research/detail")).json()
    assert detail["status"] == "retired" and detail["authorized"] is False


@pytest.mark.anyio
async def test_concurrent_publications_allocate_project_numbers_across_skills(skill_api, seeded_database, fact_project_session, alice):
    for slug in ["research", "other"]:
        request = creation()
        request["slug"] = slug
        draft = (await skill_api("/create", request)).json()["draft"]
        await seed_test(seeded_database, fact_project_session, alice.id, draft, slug=slug)
    results = await asyncio.gather(*[
        skill_api(f"/{slug}/publish", body(expected_draft_revision=1), "manager")
        for slug in ["research", "other"]
    ])
    assert all(result.status_code == 200 for result in results), [r.text for r in results]
    assert sorted(result.json()["current_version"] for result in results) == [1, 2]


@pytest.mark.anyio
async def test_publication_idempotency_conflict_never_creates_another_version(skill_api, seeded_database, fact_project_session, alice):
    draft = (await skill_api("/create", creation())).json()["draft"]
    await seed_test(seeded_database, fact_project_session, alice.id, draft)
    request = body(expected_draft_revision=1)
    assert (await skill_api("/research/publish", request, "manager")).status_code == 200
    conflict = await skill_api("/research/publish", {**request, "expected_draft_revision": 2}, "manager")
    assert conflict.json() == {"detail": {"code": "idempotency-conflict"}}
    assert len((await skill_api("/research/detail")).json()["versions"]) == 1
