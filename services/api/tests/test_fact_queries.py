import base64
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from argon2 import PasswordHasher
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.facts import FactProposal


PASSWORD = "correct horse battery staple"
SERVICE_TOKEN = "xagent-test-service-token-00000001"


async def login(client, engine, account, email: str) -> str:
    """Create one current login for an API test actor."""
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO xagent_account_credentials "
                    "(account_id, password_hash, password_changed_at) "
                    "VALUES (:account_id, :password_hash, CURRENT_TIMESTAMP)"
                ),
                {
                    "account_id": account.id,
                    "password_hash": PasswordHasher().hash(PASSWORD),
                },
            )
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": PASSWORD},
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def headers(token: str) -> dict[str, str]:
    """Return the two authenticated internal API headers."""
    return {
        "Authorization": f"Bearer {token}",
        "X-XAgent-Service-Token": SERVICE_TOKEN,
    }


def encoded_cursor(payload: object) -> str:
    """Encode a hand-written cursor payload without production cursor helpers."""
    raw = json.dumps(payload, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


async def seed_proposal(
    engine,
    source_session,
    proposer_id: UUID,
    *,
    field_key: str,
    value_type: str = "text",
    value: object = "Ada",
    label: str | None = None,
    base_revision: int = 0,
    status: str = "pending",
    created_at: datetime | None = None,
    proposal_id: UUID | None = None,
    assertion_reason: str | None = "Confirmed by account team",
) -> UUID:
    """Insert one durable proposal fixture without exercising preparation again."""
    proposal_id = proposal_id or uuid4()
    created_at = created_at or datetime.now(UTC)
    admitted_at = (
        created_at
        if status in {"pending", "confirmed", "rejected", "withdrawn", "conflicted"}
        else None
    )
    decided_at = created_at if status == "expired" else None
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO fact_proposals "
                    "(id, project_id, field_key, label, value_type, value, proposer_id, "
                    "source_session_id, source_tool_call_id, base_revision, assertion_reason, "
                    "status, payload_sha256, idempotency_key, permission_revision, "
                    "admission_expires_at, admitted_at, decided_at, created_at, updated_at) "
                    "VALUES (:id, :project, :field_key, :label, :value_type, "
                    "CAST(:value AS jsonb), "
                    ":proposer, :source_session, :tool_call, :base_revision, :assertion_reason, "
                    ":status, :payload_hash, :idempotency_key, 1, :expires_at, :admitted_at, "
                    ":decided_at, :created_at, :created_at)"
                ),
                {
                    "id": proposal_id,
                    "project": source_session.project_id,
                    "field_key": field_key,
                    "label": label or field_key.replace("_", " ").title(),
                    "value_type": value_type,
                    "value": json.dumps(value),
                    "proposer": proposer_id,
                    "source_session": source_session.id,
                    "tool_call": f"call-{proposal_id}",
                    "base_revision": base_revision,
                    "assertion_reason": assertion_reason,
                    "status": status,
                    "payload_hash": proposal_id.hex.ljust(64, "0")[:64],
                    "idempotency_key": f"prepare-{proposal_id}",
                    "expires_at": created_at + timedelta(minutes=5),
                    "admitted_at": admitted_at,
                    "decided_at": decided_at,
                    "created_at": created_at,
                },
            )
    return proposal_id


async def seed_evidence(
    engine,
    proposal_id: UUID,
    source_session,
    admitted: dict,
    proposer_id: UUID,
) -> None:
    """Attach one exact admitted-evidence identity to a proposal fixture."""
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text("SELECT set_config('app.actor_id', :actor_id, true)"),
                {"actor_id": str(proposer_id)},
            )
            await session.execute(
                text(
                    "INSERT INTO fact_proposal_evidence "
                    "(proposal_id, citation_id, project_id, session_id, admission_event_sequence, "
                    "artifact_id, version_id, index_id, index_generation, chunk_id, "
                    "line_start, line_end) "
                    "VALUES (:proposal, :citation, :project, :session, 0, :artifact, :version, "
                    ":index, 1, :chunk, :line, :line)"
                ),
                {
                    "proposal": proposal_id,
                    "citation": admitted["citation"],
                    "project": source_session.project_id,
                    "session": source_session.id,
                    "artifact": admitted["artifact"],
                    "version": admitted["version"],
                    "index": admitted["index"],
                    "chunk": admitted["chunk"],
                    "line": admitted["line"],
                },
            )


async def admit_seeded_proposal(engine, proposal_id: UUID) -> None:
    """Move a prepared fixture to the public pending state."""
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "UPDATE fact_proposals SET status = 'pending', admitted_at = created_at "
                    "WHERE id = :proposal"
                ),
                {"proposal": proposal_id},
            )


async def seed_confirmed_revision(
    engine,
    source_session,
    proposer_id: UUID,
    confirmer_id: UUID,
    *,
    field_key: str,
    content_revision: int,
    value_type: str,
    value: object,
    created_at: datetime,
) -> tuple[UUID, UUID]:
    """Insert a confirmed proposal, immutable revision, head, and terminal Outbox row."""
    proposal_id = await seed_proposal(
        engine,
        source_session,
        proposer_id,
        field_key=field_key,
        value_type=value_type,
        value=value,
        base_revision=content_revision - 1,
        created_at=created_at,
    )
    revision_id = uuid4()
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO project_fact_revisions "
                    "(id, project_id, field_key, label, value_type, value, content_revision, "
                    "proposal_id, confirmed_by_id, created_at) "
                    "SELECT :revision, project_id, field_key, label, value_type, value, "
                    ":content_revision, id, :confirmer, :created_at FROM fact_proposals "
                    "WHERE id = :proposal"
                ),
                {
                    "revision": revision_id,
                    "content_revision": content_revision,
                    "confirmer": confirmer_id,
                    "created_at": created_at,
                    "proposal": proposal_id,
                },
            )
            if content_revision == 1:
                await session.execute(
                    text(
                        "INSERT INTO project_fact_heads "
                        "(project_id, field_key, revision_id, content_revision, updated_at) "
                        "VALUES (:project, :field_key, :revision, 1, :created_at)"
                    ),
                    {
                        "project": source_session.project_id,
                        "field_key": field_key,
                        "revision": revision_id,
                        "created_at": created_at,
                    },
                )
            else:
                await session.execute(
                    text(
                        "UPDATE project_fact_heads SET revision_id = :revision, "
                        "content_revision = :content_revision, updated_at = :created_at "
                        "WHERE project_id = :project AND field_key = :field_key"
                    ),
                    {
                        "project": source_session.project_id,
                        "field_key": field_key,
                        "revision": revision_id,
                        "content_revision": content_revision,
                        "created_at": created_at,
                    },
                )
            await session.execute(
                text(
                    "UPDATE fact_proposals SET status = 'confirmed', "
                    "decision_actor_id = :confirmer, "
                    "decided_at = :created_at WHERE id = :proposal"
                ),
                {
                    "confirmer": confirmer_id,
                    "created_at": created_at,
                    "proposal": proposal_id,
                },
            )
            await session.execute(
                text(
                    "INSERT INTO business_outbox "
                    "(id, aggregate_kind, aggregate_id, project_id, source_session_id, "
                    "payload_sha256, created_at) VALUES (:id, 'fact_proposal', :proposal, "
                    ":project, :source_session, :payload_hash, :created_at)"
                ),
                {
                    "id": uuid4(),
                    "proposal": proposal_id,
                    "project": source_session.project_id,
                    "source_session": source_session.id,
                    "payload_hash": revision_id.hex.ljust(64, "0")[:64],
                    "created_at": created_at,
                },
            )
    return proposal_id, revision_id


@pytest.mark.anyio
async def test_proposal_pages_are_stable_bounded_public_and_exact(
    client,
    seeded_database,
    manager,
    fact_project_session,
    fact_admitted_evidence,
) -> None:
    """Pages exclude internal states and retain exact review data across cursors."""
    token = await login(
        client,
        seeded_database,
        manager,
        "manager@example.test",
    )
    created_at = datetime(2026, 9, 8, 8, 0, tzinfo=UTC)
    first_visible = await seed_proposal(
        seeded_database,
        fact_project_session,
        manager.id,
        proposal_id=UUID(int=100),
        field_key="field_000",
        value_type="number",
        value=12.5,
        status="prepared",
        created_at=created_at,
    )
    await seed_evidence(
        seeded_database,
        first_visible,
        fact_project_session,
        fact_admitted_evidence[0],
        manager.id,
    )
    await admit_seeded_proposal(seeded_database, first_visible)
    visible_ids = [first_visible]
    for index in range(1, 103):
        visible_ids.append(
            await seed_proposal(
                seeded_database,
                fact_project_session,
                manager.id,
                proposal_id=UUID(int=index + 100),
                field_key=f"field_{index:03d}",
                value_type="text",
                value=f"value-{index}",
                created_at=created_at,
            )
        )
    prepared = await seed_proposal(
        seeded_database,
        fact_project_session,
        manager.id,
        field_key="hidden_prepared",
        status="prepared",
        created_at=created_at,
    )
    expired = await seed_proposal(
        seeded_database,
        fact_project_session,
        manager.id,
        field_key="hidden_expired",
        status="expired",
        created_at=created_at,
    )
    first = await client.post(
        f"/internal/xagent/facts/projects/{fact_project_session.project_id}/proposals/list",
        headers=headers(token),
        json={"schema_version": 1, "limit": 100},
    )
    assert first.status_code == 200
    first_body = first.json()
    assert set(first_body) == {"schema_version", "items", "next_cursor"}
    assert len(first_body["items"]) == 100
    assert [item["id"] for item in first_body["items"]] == [
        str(proposal_id) for proposal_id in visible_ids[:100]
    ]
    serialized = json.dumps(first_body)
    assert str(prepared) not in serialized
    assert str(expired) not in serialized
    assert "payload_sha256" not in serialized
    assert "source_tool_call_id" not in serialized
    assert "idempotency_key" not in serialized

    first_item = first_body["items"][0]
    assert first_item["value"] == {"type": "number", "value": 12.5}
    assert first_item["assertion_reason"] == "Confirmed by account team"
    assert first_item["evidence"] == [{
        "citation_id": "[资料1]",
        "artifact_id": str(fact_admitted_evidence[0]["artifact"]),
        "version_id": str(fact_admitted_evidence[0]["version"]),
        "index_id": str(fact_admitted_evidence[0]["index"]),
        "index_generation": 1,
        "chunk_id": str(fact_admitted_evidence[0]["chunk"]),
        "line_start": 1,
        "line_end": 1,
    }]

    second = await client.post(
        f"/internal/xagent/facts/projects/{fact_project_session.project_id}/proposals/list",
        headers=headers(token),
        json={
            "schema_version": 1,
            "limit": 100,
            "cursor": first_body["next_cursor"],
        },
    )
    assert second.status_code == 200
    assert [item["id"] for item in second.json()["items"]] == [
        str(proposal_id) for proposal_id in visible_ids[100:]
    ]
    assert second.json()["next_cursor"] is None

    malformed = await client.post(
        f"/internal/xagent/facts/projects/{fact_project_session.project_id}/proposals/list",
        headers=headers(token),
        json={"schema_version": 1, "cursor": "not-a-v1-cursor"},
    )
    assert malformed.status_code == 422
    assert malformed.json() == {"detail": {"code": "fact-input-invalid"}}

    detail = await client.post(
        f"/internal/xagent/facts/proposals/{visible_ids[0]}",
        headers=headers(token),
        json={"schema_version": 1},
    )
    assert detail.status_code == 200
    assert detail.json() == {"schema_version": 1, "proposal": first_item}


@pytest.mark.anyio
async def test_fact_heads_and_revision_detail_return_typed_ordered_history(
    client,
    seeded_database,
    alice,
    manager,
    fact_project_session,
) -> None:
    """Head reads preserve typed values, stable order, and complete field history."""
    token = await login(
        client,
        seeded_database,
        manager,
        "manager@example.test",
    )
    first_proposal, first_revision = await seed_confirmed_revision(
        seeded_database,
        fact_project_session,
        alice.id,
        manager.id,
        field_key="renewal_date",
        content_revision=1,
        value_type="date",
        value="2026-10-01",
        created_at=datetime(2026, 9, 8, 9, 0, tzinfo=UTC),
    )
    second_proposal, second_revision = await seed_confirmed_revision(
        seeded_database,
        fact_project_session,
        alice.id,
        manager.id,
        field_key="renewal_date",
        content_revision=2,
        value_type="date",
        value="2027-10-01",
        created_at=datetime(2026, 9, 8, 10, 0, tzinfo=UTC),
    )

    heads = await client.post(
        f"/internal/xagent/facts/projects/{fact_project_session.project_id}/heads/list",
        headers=headers(token),
        json={"schema_version": 1, "limit": 100},
    )
    assert heads.status_code == 200
    assert len(heads.json()["items"]) == 1
    assert heads.json()["items"][0]["id"] == str(second_revision)
    assert heads.json()["items"][0]["value"] == {
        "type": "date",
        "value": "2027-10-01",
    }

    detail = await client.post(
        f"/internal/xagent/facts/revisions/{second_revision}",
        headers=headers(token),
        json={"schema_version": 1},
    )
    assert detail.status_code == 200
    body = detail.json()
    assert body["schema_version"] == 1
    assert body["revision"]["proposal_id"] == str(second_proposal)
    assert [(row["id"], row["content_revision"]) for row in body["history"]] == [
        (str(second_revision), 2),
        (str(first_revision), 1),
    ]
    assert body["history"][1]["proposal_id"] == str(first_proposal)

    missing = await client.post(
        f"/internal/xagent/facts/revisions/{uuid4()}",
        headers=headers(token),
        json={"schema_version": 1},
    )
    assert missing.status_code == 404
    assert missing.json() == {"detail": {"code": "not-found"}}

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        assert await session.scalar(select(FactProposal.id).limit(1)) is not None


@pytest.mark.anyio
@pytest.mark.parametrize(
    "cursor",
    (
        encoded_cursor({
            "created_at": "2026-09-08T08:00:00+00:00",
            "id": str(UUID(int=1)),
            "v": True,
        }),
        encoded_cursor({
            "created_at": "2026-09-08T08:00:00+00:00",
            "id": str(UUID(int=1)),
            "v": 1.0,
        }),
        encoded_cursor({
            "created_at": "2026-09-08T08:00:00+00:00",
            "id": 1,
            "v": 1,
        }),
        encoded_cursor({
            "created_at": 1,
            "id": str(UUID(int=1)),
            "v": 1,
        }),
        encoded_cursor({
            "created_at": "2026-09-08",
            "id": str(UUID(int=1)),
            "v": 1,
        }),
        base64.urlsafe_b64encode(
            (
                '{"created_at":"2026-09-08T08:00:00+00:00",'
                f'"id":"{UUID(int=1)}","v":1,"v":1}}'
            ).encode()
        ).rstrip(b"=").decode(),
    ),
)
async def test_every_fact_page_rejects_typed_malformed_cursors(
    client,
    seeded_database,
    manager,
    fact_project_session,
    cursor: str,
) -> None:
    """Malformed typed cursor fields never escape or authorize any paged read."""
    token = await login(client, seeded_database, manager, "manager@example.test")
    paths = (
        f"/internal/xagent/facts/projects/{fact_project_session.project_id}/heads/list",
        f"/internal/xagent/facts/projects/{fact_project_session.project_id}/proposals/list",
        f"/internal/xagent/facts/sessions/{fact_project_session.id}/outbox/pull",
    )
    for path in paths:
        response = await client.post(
            path,
            headers=headers(token),
            json={"schema_version": 1, "cursor": cursor},
        )
        assert response.status_code == 422
        assert response.json() == {"detail": {"code": "fact-input-invalid"}}
