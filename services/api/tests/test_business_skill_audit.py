"""Lifecycle audit persists outcomes without authored content or secrets."""

import pytest
from sqlalchemy import text

from test_business_skill_governance import body, creation, skill_api


@pytest.mark.anyio
async def test_create_edit_and_governance_denial_audit_are_redacted(skill_api, seeded_database):
    request = creation()
    assert (await skill_api("/create", request)).status_code == 200
    assert (await skill_api("/create", request)).status_code == 200
    assert (await skill_api("/research/draft", body(expected_draft_revision=1, instructions="Private changed body"))).status_code == 200
    assert (await skill_api("/research/retire", body())).status_code == 403
    async with seeded_database.begin() as connection:
        rows = (await connection.execute(text("SELECT action, details FROM audit_events WHERE action LIKE 'business_skill.%' ORDER BY created_at"))).all()
    assert [row.action for row in rows] == ["business_skill.create", "business_skill.draft_update", "business_skill.authorization_denied"]
    assert [row.details["result"] for row in rows] == ["created", "updated", "forbidden"]
    for row in rows:
        assert set(row.details) <= {"project_id", "skill_id", "result", "draft_revision", "content_digest", "request_sha256", "latency_ms"}
        assert not any(secret in str(row.details) for secret in ["Private changed body", "Find evidence", request["idempotency_key"]])


@pytest.mark.anyio
async def test_audit_failure_rolls_back_content_and_idempotency(skill_api, seeded_database):
    async with seeded_database.begin() as connection:
        await connection.execute(text("""
            CREATE FUNCTION reject_skill_audit() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.action LIKE 'business_skill.%' THEN
                    RAISE EXCEPTION 'audit unavailable';
                END IF;
                RETURN NEW;
            END $$
        """))
        await connection.execute(text("CREATE TRIGGER reject_skill_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_skill_audit()"))
    response = await skill_api("/create", creation())
    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "service-unavailable"}}
    async with seeded_database.begin() as connection:
        assert await connection.scalar(text("SELECT count(*) FROM business_skills")) == 0
        assert await connection.scalar(text("SELECT count(*) FROM business_skill_drafts")) == 0
        assert await connection.scalar(text("SELECT count(*) FROM xagent_idempotency_keys WHERE operation LIKE 'business_skill.%'")) == 0
