import hashlib
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import jwt
import pytest
from argon2 import PasswordHasher
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditEvent
from app.models.facts import (
    FactOperationIdempotency,
    FactProposal,
    FactProposalEvidence,
    FactProposalReceipt,
)
from app.models.project import ProjectMembership
from app.models.retrieval import XAgentAdmittedEvidence
from app.models.xagent_session import XAgentSession, XAgentSessionEvent
from conftest import DELEGATION_PRIVATE_KEY


PASSWORD = "correct horse battery staple"
SERVICE_TOKEN = "xagent-test-service-token-00000001"
MAX_FACT_BODY_BYTES = 64 * 1024


async def _login(client, engine, account, email: str) -> str:
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


def _headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "X-XAgent-Service-Token": SERVICE_TOKEN,
    }


def _permission_revision(token: str) -> int:
    revision = jwt.decode(token, options={"verify_signature": False})["permission_revision"]
    assert isinstance(revision, int)
    return revision


def _prepare_body(session_id: object) -> dict[str, object]:
    return {
        "schema_version": 1,
        "session_id": str(session_id),
        "tool_call_id": "call-fact-validation",
        "permission_revision": 1,
        "idempotency_key": "prepare-validation",
        "field_key": "customer.primary-contact",
        "label": "Primary contact",
        "value": {"type": "text", "value": "Ada"},
        "evidence_ids": [],
        "assertion_reason": "Confirmed by the account team",
    }


def _delegation_token(
    *,
    actor_id: UUID,
    session_id: UUID,
    project_id: UUID,
    tool_call_id: str,
    tool_name: str = "propose_fact",
    permission_revision: int = 1,
    nonce: str | None = None,
) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "iss": "xagent-host",
            "aud": "xagent-api",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(seconds=30)).timestamp()),
            "actor_id": str(actor_id),
            "project_id": str(project_id),
            "session_id": str(session_id),
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "permission_revision": permission_revision,
            "nonce": nonce or f"nonce-{tool_call_id}-{uuid4()}",
        },
        DELEGATION_PRIVATE_KEY,
        algorithm="EdDSA",
    )


async def _prime_tool_call(
    engine,
    session_id: UUID,
    actor_id: UUID,
    *,
    tool_call_id: str = "call-prime",
    tool_name: str = "propose_fact",
) -> None:
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO xagent_session_events "
                    "(session_id, sequence, event_type, schema_version, payload, actor_id, "
                    "tool_call_id) VALUES (:session_id, 0, 'tool/call', 1, "
                    "CAST(:payload AS jsonb), :actor_id, :tool_call_id) "
                    "ON CONFLICT (session_id, sequence) DO UPDATE SET "
                    "event_type = EXCLUDED.event_type, "
                    "schema_version = EXCLUDED.schema_version, "
                    "payload = EXCLUDED.payload, "
                    "actor_id = EXCLUDED.actor_id, "
                    "tool_call_id = EXCLUDED.tool_call_id"
                ),
                {
                    "session_id": session_id,
                    "actor_id": actor_id,
                    "tool_call_id": tool_call_id,
                    "payload": json.dumps(
                        {
                            "seq": 0,
                            "time": 1788854400000,
                            "type": "tool/call",
                            "surfaceOp": "append",
                            "data": {
                                "turn": 0,
                                "step": 0,
                                "callId": tool_call_id,
                                "name": tool_name,
                                "arguments": "{}",
                            },
                        }
                    ),
                },
            )
            await session.execute(
                text(
                    "UPDATE xagent_sessions SET last_event_sequence = 0 "
                    "WHERE id = :session_id"
                ),
                {"session_id": session_id},
            )


@pytest.mark.anyio
async def test_prepare_rejects_every_invalid_fact_value_and_closed_wire_field(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    base = {
        **_prepare_body(fact_project_session.id),
        "permission_revision": _permission_revision(token),
    }
    invalid_bodies = []
    for field_key in ("Customer Name", "customer..name", "a" * 129):
        invalid_bodies.append({**base, "field_key": field_key})
    invalid_bodies.extend((
        {**base, "label": "界" * 85 + "a"},
        {**base, "value": {"type": "text", "value": "界" * 5461 + "aa"}},
        {**base, "value": {"type": "number", "value": float("nan")}},
        {**base, "value": {"type": "number", "value": float("inf")}},
        {**base, "value": {"type": "number", "value": True}},
        {**base, "value": {"type": "date", "value": "2025-02-29"}},
        {**base, "value": {"type": "date", "value": "2024-2-29"}},
        {**base, "evidence_ids": ["[资料1]", "[资料1]"], "assertion_reason": None},
        {
            **base,
            "evidence_ids": [f"[资料{index}]" for index in range(1, 66)],
            "assertion_reason": None,
        },
        {**base, "assertion_reason": None},
        {**base, "assertion_reason": " "},
        {**base, "assertion_reason": "界" * 1365 + "aa"},
        {**base, "unknown": "field"},
        {**base, "value": {"type": "text", "value": "Ada", "unknown": True}},
    ))

    for body in invalid_bodies:
        response = await client.post(
            "/internal/xagent/facts/proposals/prepare",
            headers=_headers(token),
            content=json.dumps(body, allow_nan=True).encode(),
        )
        assert response.status_code == 422
        assert response.json() == {"detail": {"code": "fact-input-invalid"}}
        assert "unknown" not in response.text


@pytest.mark.anyio
async def test_prepare_accepts_exact_utf8_byte_and_calendar_boundaries_before_authorization(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    permission_revision = _permission_revision(token)
    base = {
        **_prepare_body(fact_project_session.id),
        "permission_revision": permission_revision,
    }
    valid_bodies = (
        {**base, "field_key": "a" * 128},
        {**base, "label": "界" * 85},
        {**base, "value": {"type": "text", "value": "界" * 5461 + "a"}},
        {**base, "value": {"type": "number", "value": 1.25}},
        {**base, "value": {"type": "date", "value": "2024-02-29"}},
        {**base, "assertion_reason": "界" * 1365 + "a"},
        {
            **base,
            "evidence_ids": [f"[资料{index}]" for index in range(1, 65)],
            "assertion_reason": None,
        },
    )

    for body in valid_bodies:
        response = await client.post(
            "/internal/xagent/facts/proposals/prepare",
            headers=_headers(token),
            json=body,
        )
        assert response.status_code == 404
        assert response.json() == {"detail": {"code": "not-found"}}


@pytest.mark.anyio
async def test_prepare_rejects_declared_and_streamed_oversized_requests(client) -> None:
    declared = await client.post(
        "/internal/xagent/facts/proposals/prepare",
        headers={
            "X-XAgent-Service-Token": SERVICE_TOKEN,
            "Content-Length": str(MAX_FACT_BODY_BYTES + 1),
        },
        content=b"{}",
    )

    async def oversized_stream():
        yield b"{" + b"x" * MAX_FACT_BODY_BYTES

    streamed = await client.post(
        "/internal/xagent/facts/proposals/prepare",
        headers={
            "X-XAgent-Service-Token": SERVICE_TOKEN,
            "Transfer-Encoding": "chunked",
        },
        content=oversized_stream(),
    )

    assert declared.status_code == streamed.status_code == 422
    assert declared.json() == streamed.json() == {
        "detail": {"code": "fact-input-invalid"}
    }


@pytest.mark.anyio
async def test_prepare_accepts_an_exact_sixty_four_kibibyte_request_body(client) -> None:
    encoded = json.dumps(
        _prepare_body(UUID(int=595)),
        separators=(",", ":"),
    ).encode()
    body = encoded + b" " * (MAX_FACT_BODY_BYTES - len(encoded))
    assert len(body) == MAX_FACT_BODY_BYTES

    response = await client.post(
        "/internal/xagent/facts/proposals/prepare",
        headers={
            "X-XAgent-Service-Token": SERVICE_TOKEN,
            "Content-Type": "application/json",
        },
        content=body,
    )

    assert response.status_code == 401
    assert response.json() == {"detail": {"code": "unauthenticated"}}


@pytest.mark.anyio
async def test_prepare_requires_current_project_session_membership_and_exact_delegation(
    client,
    seeded_database,
    alice,
    bob_project,
    alice_private_xagent_session,
    bob_private_xagent_session,
    fact_project_session,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    permission_revision = _permission_revision(token)
    await _prime_tool_call(seeded_database, alice_private_xagent_session.id, alice.id)
    await _prime_tool_call(seeded_database, fact_project_session.id, alice.id)

    async def prepare(
        session_id: UUID,
        *,
        project_id: UUID,
        permission_revision: int = permission_revision,
        tool_call_id: str,
    ):
        body = {
            **_prepare_body(session_id),
            "tool_call_id": tool_call_id,
            "permission_revision": permission_revision,
            "idempotency_key": f"prepare-{tool_call_id}",
        }
        return await client.post(
            "/internal/xagent/facts/proposals/prepare",
            headers={
                **_headers(token),
                "X-XAgent-Delegation": _delegation_token(
                    actor_id=alice.id,
                    session_id=session_id,
                    project_id=project_id,
                    tool_call_id=tool_call_id,
                    permission_revision=permission_revision,
                ),
            },
            json=body,
        )

    private = await prepare(
        alice_private_xagent_session.id,
        project_id=fact_project_session.project_id,
        tool_call_id="call-private",
    )
    wrong_project = await prepare(
        fact_project_session.id,
        project_id=bob_project.id,
        tool_call_id="call-wrong-project",
    )
    stale = await prepare(
        fact_project_session.id,
        project_id=fact_project_session.project_id,
        permission_revision=permission_revision + 1,
        tool_call_id="call-stale",
    )
    guessed = await prepare(
        UUID("00000000-0000-0000-0000-000000000599"),
        project_id=fact_project_session.project_id,
        tool_call_id="call-guessed",
    )
    inaccessible = await prepare(
        bob_private_xagent_session.id,
        project_id=fact_project_session.project_id,
        tool_call_id="call-inaccessible",
    )

    assert private.status_code == 409
    assert private.json() == {"detail": {"code": "fact-session-invalid"}}
    assert wrong_project.status_code == 404
    assert wrong_project.json() == {"detail": {"code": "not-found"}}
    assert stale.status_code == 409
    assert stale.json() == {"detail": {"code": "stale-permission"}}
    assert guessed.status_code == inaccessible.status_code == 404
    assert guessed.json() == inaccessible.json() == {"detail": {"code": "not-found"}}


@pytest.mark.anyio
async def test_prepare_accepts_opaque_provider_tool_call_identity(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    permission_revision = _permission_revision(token)
    tool_call_id = "call_00_UTka2FfoIbNh3F3j9WZN7457"
    await _prime_tool_call(
        seeded_database,
        fact_project_session.id,
        alice.id,
        tool_call_id=tool_call_id,
    )

    response = await client.post(
        "/internal/xagent/facts/proposals/prepare",
        headers={
            **_headers(token),
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=fact_project_session.id,
                project_id=fact_project_session.project_id,
                tool_call_id=tool_call_id,
                permission_revision=permission_revision,
            ),
        },
        json={
            **_prepare_body(fact_project_session.id),
            "tool_call_id": tool_call_id,
            "permission_revision": permission_revision,
            "idempotency_key": "prepare-provider-tool-call",
        },
    )

    assert response.status_code == 200
    assert response.json()["result"]["status"] == "pending"


@pytest.mark.anyio
async def test_specialist_and_manager_prepare_hidden_proposals_with_private_receipts(
    client,
    seeded_database,
    alice,
    manager,
    fact_project_session,
) -> None:
    alice_token = await _login(client, seeded_database, alice, "alice@example.test")
    manager_token = await _login(client, seeded_database, manager, "manager@example.test")
    manager_session_id = uuid4()
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(
                XAgentSession(
                    id=manager_session_id,
                    title="Manager fact proposal",
                    owner_id=manager.id,
                    project_id=fact_project_session.project_id,
                    visibility="project",
                    permission_revision_created=1,
                )
            )

    responses = []
    for account, token, session_id, suffix in (
        (alice, alice_token, fact_project_session.id, "specialist"),
        (manager, manager_token, manager_session_id, "manager"),
    ):
        tool_call_id = f"call-{suffix}"
        await _prime_tool_call(
            seeded_database,
            session_id,
            account.id,
            tool_call_id=tool_call_id,
        )
        body = {
            **_prepare_body(session_id),
            "tool_call_id": tool_call_id,
            "permission_revision": _permission_revision(token),
            "idempotency_key": f"prepare-{suffix}",
            "field_key": f"customer.{suffix}",
            "label": suffix.title(),
        }
        responses.append(await client.post(
            "/internal/xagent/facts/proposals/prepare",
            headers={
                **_headers(token),
                "X-XAgent-Delegation": _delegation_token(
                    actor_id=account.id,
                    session_id=session_id,
                    project_id=fact_project_session.project_id,
                    tool_call_id=tool_call_id,
                    permission_revision=_permission_revision(token),
                ),
            },
            json=body,
        ))

    for response in responses:
        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"schema_version", "result", "receipt", "payload_sha256"}
        assert set(body["result"]) == {"proposalId", "status"}
        assert body["result"]["status"] == "pending"
        assert len(body["payload_sha256"]) == 64
        assert body["receipt"] not in json.dumps(body["result"])

    proposal_ids = [UUID(response.json()["result"]["proposalId"]) for response in responses]
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposals = list(
            (
                await session.scalars(
                    select(FactProposal)
                    .where(FactProposal.id.in_(proposal_ids))
                    .order_by(FactProposal.id)
                )
            ).all()
        )
        receipts = list(
            (
                await session.scalars(
                    select(FactProposalReceipt)
                    .where(FactProposalReceipt.proposal_id.in_(proposal_ids))
                )
            ).all()
        )
        audits = list(
            (
                await session.scalars(
                    select(AuditEvent)
                    .where(AuditEvent.action == "fact.prepare")
                )
            ).all()
        )

    assert len(proposals) == len(receipts) == len(audits) == 2
    assert {proposal.status for proposal in proposals} == {"prepared"}
    assert {receipt.source_event_sequence for receipt in receipts} == {1}
    receipt_by_proposal = {receipt.proposal_id: receipt for receipt in receipts}
    for response in responses:
        raw_receipt = response.json()["receipt"]
        proposal_id = UUID(response.json()["result"]["proposalId"])
        assert receipt_by_proposal[proposal_id].receipt_digest_id == UUID(
            bytes=hashlib.sha256(raw_receipt.encode()).digest()[:16]
        )
        assert raw_receipt != str(receipt_by_proposal[proposal_id].receipt_digest_id)
    serialized_audits = json.dumps([audit.details for audit in audits])
    for response in responses:
        assert response.json()["receipt"] not in serialized_audits


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("stored_actor", "stored_call_id", "stored_tool_name"),
    (
        ("alice", "call-durable", "generic_tool"),
        ("alice", "call-other", "propose_fact"),
        ("bob", "call-durable", "propose_fact"),
    ),
)
async def test_prepare_requires_the_exact_owned_durable_propose_fact_call(
    client,
    seeded_database,
    alice,
    bob,
    fact_project_session,
    stored_actor,
    stored_call_id,
    stored_tool_name,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    permission_revision = _permission_revision(token)
    await _prime_tool_call(
        seeded_database,
        fact_project_session.id,
        alice.id if stored_actor == "alice" else bob.id,
        tool_call_id=stored_call_id,
        tool_name=stored_tool_name,
    )
    response = await client.post(
        "/internal/xagent/facts/proposals/prepare",
        headers={
            **_headers(token),
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=fact_project_session.id,
                project_id=fact_project_session.project_id,
                tool_call_id="call-durable",
                permission_revision=permission_revision,
            ),
        },
        json={
            **_prepare_body(fact_project_session.id),
            "tool_call_id": "call-durable",
            "permission_revision": permission_revision,
            "idempotency_key": (
                f"prepare-durable-{stored_actor}-{stored_call_id}-{stored_tool_name}"
            ),
        },
    )

    assert response.status_code == 404
    assert response.json() == {"detail": {"code": "not-found"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal_count = await session.scalar(
            select(func.count()).select_from(FactProposal)
        )
    assert proposal_count == 0


@pytest.mark.anyio
async def test_revoked_login_cannot_prepare_a_fact(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    revoked = await client.post(
        "/internal/xagent/auth/revoke",
        headers=_headers(token),
    )
    assert revoked.status_code == 204
    response = await client.post(
        "/internal/xagent/facts/proposals/prepare",
        headers={
            **_headers(token),
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=fact_project_session.id,
                project_id=fact_project_session.project_id,
                tool_call_id="call-revoked",
            ),
        },
        json={
            **_prepare_body(fact_project_session.id),
            "tool_call_id": "call-revoked",
            "idempotency_key": "prepare-revoked",
        },
    )

    assert response.status_code == 401
    assert response.json() == {"detail": {"code": "unauthenticated"}}


@pytest.mark.anyio
async def test_prepare_copies_exact_admitted_evidence_identity_and_chunk_range(
    client,
    seeded_database,
    alice,
    fact_project_session,
    fact_admitted_evidence,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    tool_call_id = "call-evidence-exact"
    await _prime_tool_call(
        seeded_database,
        fact_project_session.id,
        alice.id,
        tool_call_id=tool_call_id,
    )
    response = await client.post(
        "/internal/xagent/facts/proposals/prepare",
        headers={
            **_headers(token),
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=fact_project_session.id,
                project_id=fact_project_session.project_id,
                tool_call_id=tool_call_id,
                permission_revision=_permission_revision(token),
            ),
        },
        json={
            **_prepare_body(fact_project_session.id),
            "tool_call_id": tool_call_id,
            "permission_revision": _permission_revision(token),
            "idempotency_key": "prepare-evidence-exact",
            "evidence_ids": ["[资料2]", "[资料1]"],
            "assertion_reason": None,
        },
    )

    assert response.status_code == 200
    proposal_id = UUID(response.json()["result"]["proposalId"])
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        evidence = list(
            (
                await session.scalars(
                    select(FactProposalEvidence)
                    .where(FactProposalEvidence.proposal_id == proposal_id)
                    .order_by(FactProposalEvidence.citation_id)
                )
            ).all()
        )

    assert len(evidence) == 2
    expected = {row["citation"]: row for row in fact_admitted_evidence[:2]}
    for row in evidence:
        source = expected[row.citation_id]
        assert (
            row.project_id,
            row.session_id,
            row.admission_event_sequence,
            row.artifact_id,
            row.version_id,
            row.index_id,
            row.index_generation,
            row.chunk_id,
            row.line_start,
            row.line_end,
        ) == (
            fact_project_session.project_id,
            fact_project_session.id,
            0,
            source["artifact"],
            source["version"],
            source["index"],
            1,
            source["chunk"],
            source["line"],
            source["line"],
        )


@pytest.mark.anyio
async def test_prepare_rejects_invented_cross_session_and_cross_project_evidence_atomically(
    client,
    seeded_database,
    alice,
    alice_project,
    fact_project_session,
    fact_admitted_evidence,
) -> None:
    same_project_session_id = uuid4()
    other_project_session_id = uuid4()
    source = fact_admitted_evidence[0]
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(
                ProjectMembership(
                    id=uuid4(),
                    project_id=alice_project.id,
                    account_id=alice.id,
                )
            )
            session.add_all(
                (
                    XAgentSession(
                        id=same_project_session_id,
                        title="Same project, different evidence ledger",
                        owner_id=alice.id,
                        project_id=fact_project_session.project_id,
                        visibility="project",
                        permission_revision_created=1,
                        last_event_sequence=0,
                    ),
                    XAgentSession(
                        id=other_project_session_id,
                        title="Different fixed project",
                        owner_id=alice.id,
                        project_id=alice_project.id,
                        visibility="project",
                        permission_revision_created=1,
                        last_event_sequence=0,
                    ),
                )
            )
            await session.flush()
            session.add_all(
                XAgentSessionEvent(
                    session_id=session_id,
                    sequence=0,
                    event_type="tool/call",
                    schema_version=1,
                    payload={
                        "seq": 0,
                        "time": 1788854400000,
                        "type": "tool/call",
                        "surfaceOp": "append",
                        "data": {
                            "turn": 0,
                            "step": 0,
                            "callId": tool_call_id,
                            "name": "propose_fact",
                            "arguments": "{}",
                        },
                    },
                    actor_id=alice.id,
                    tool_call_id=tool_call_id,
                )
                for session_id, tool_call_id in (
                    (same_project_session_id, "call-evidence-cross-session"),
                    (other_project_session_id, "call-evidence-cross-project"),
                )
            )
            await session.flush()
            session.add(
                XAgentAdmittedEvidence(
                    session_id=other_project_session_id,
                    citation_id=source["citation"],
                    admission_event_sequence=0,
                    artifact_id=source["artifact"],
                    version_id=source["version"],
                    index_id=source["index"],
                    index_generation=1,
                    chunk_id=source["chunk"],
                )
            )

    await _prime_tool_call(
        seeded_database,
        fact_project_session.id,
        alice.id,
        tool_call_id="call-evidence-invented",
    )

    token = await _login(client, seeded_database, alice, "alice@example.test")
    permission_revision = _permission_revision(token)
    cases = (
        (fact_project_session.id, fact_project_session.project_id, "[资料999]", "invented"),
        (same_project_session_id, fact_project_session.project_id, "[资料1]", "cross-session"),
        (other_project_session_id, alice_project.id, "[资料1]", "cross-project"),
    )
    for session_id, project_id, citation_id, suffix in cases:
        tool_call_id = f"call-evidence-{suffix}"
        response = await client.post(
            "/internal/xagent/facts/proposals/prepare",
            headers={
                **_headers(token),
                "X-XAgent-Delegation": _delegation_token(
                    actor_id=alice.id,
                    session_id=session_id,
                    project_id=project_id,
                    tool_call_id=tool_call_id,
                    permission_revision=permission_revision,
                ),
            },
            json={
                **_prepare_body(session_id),
                "tool_call_id": tool_call_id,
                "permission_revision": permission_revision,
                "idempotency_key": f"prepare-evidence-{suffix}",
                "evidence_ids": [citation_id],
                "assertion_reason": None,
            },
        )
        assert response.status_code == 422
        assert response.json() == {"detail": {"code": "fact-evidence-invalid"}}

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal_count = await session.scalar(
            select(FactProposal).where(
                FactProposal.idempotency_key.like("prepare-evidence-%")
            ).with_only_columns(text("count(*)"))
        )
        operation_count = await session.scalar(
            select(FactOperationIdempotency).where(
                FactOperationIdempotency.idempotency_key.like("prepare-evidence-%")
            ).with_only_columns(text("count(*)"))
        )
    assert proposal_count == operation_count == 0


@pytest.mark.anyio
async def test_prepare_exact_replay_keeps_one_proposal_and_rotates_private_receipt(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    permission_revision = _permission_revision(token)
    tool_call_id = "call-prepare-replay"
    await _prime_tool_call(
        seeded_database,
        fact_project_session.id,
        alice.id,
        tool_call_id=tool_call_id,
    )
    body = {
        **_prepare_body(fact_project_session.id),
        "tool_call_id": tool_call_id,
        "permission_revision": permission_revision,
        "idempotency_key": "prepare-exact-replay",
    }

    responses = []
    for _ in range(2):
        responses.append(
            await client.post(
                "/internal/xagent/facts/proposals/prepare",
                headers={
                    **_headers(token),
                    "X-XAgent-Delegation": _delegation_token(
                        actor_id=alice.id,
                        session_id=fact_project_session.id,
                        project_id=fact_project_session.project_id,
                        tool_call_id=tool_call_id,
                        permission_revision=permission_revision,
                    ),
                },
                json=body,
            )
        )

    assert [response.status_code for response in responses] == [200, 200]
    first, replay = (response.json() for response in responses)
    assert replay["result"] == first["result"]
    assert replay["payload_sha256"] == first["payload_sha256"]
    assert replay["receipt"] != first["receipt"]
    proposal_id = UUID(first["result"]["proposalId"])
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposals = list(
            (
                await session.scalars(
                    select(FactProposal).where(FactProposal.id == proposal_id)
                )
            ).all()
        )
        receipts = list(
            (
                await session.scalars(
                    select(FactProposalReceipt).where(
                        FactProposalReceipt.proposal_id == proposal_id
                    )
                )
            ).all()
        )
        operations = list(
            (
                await session.scalars(
                    select(FactOperationIdempotency).where(
                        FactOperationIdempotency.proposal_id == proposal_id
                    )
                )
            ).all()
        )
        audits = list(
            (
                await session.scalars(
                    select(AuditEvent)
                    .where(AuditEvent.resource_id == proposal_id)
                    .order_by(AuditEvent.created_at)
                )
            ).all()
        )

    assert len(proposals) == len(operations) == 1
    assert len(receipts) == 2
    assert {receipt.issued_at for receipt in receipts} == {proposals[0].created_at}
    assert {receipt.expires_at for receipt in receipts} == {
        proposals[0].admission_expires_at
    }
    assert [(audit.action, audit.result) for audit in audits] == [
        ("fact.prepare", "prepared"),
        ("fact.replay", "replayed"),
    ]
    assert audits[-1].details["operation"] == "prepare"
    assert audits[-1].details["status"] == "prepared"
    assert first["receipt"] not in json.dumps([audit.details for audit in audits])
    assert replay["receipt"] not in json.dumps([audit.details for audit in audits])


@pytest.mark.anyio
async def test_prepare_rejects_idempotency_hash_conflict_without_new_state(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    permission_revision = _permission_revision(token)
    tool_call_id = "call-prepare-conflict"
    await _prime_tool_call(
        seeded_database,
        fact_project_session.id,
        alice.id,
        tool_call_id=tool_call_id,
    )
    body = {
        **_prepare_body(fact_project_session.id),
        "tool_call_id": tool_call_id,
        "permission_revision": permission_revision,
        "idempotency_key": "prepare-hash-conflict",
    }

    first = await client.post(
        "/internal/xagent/facts/proposals/prepare",
        headers={
            **_headers(token),
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=fact_project_session.id,
                project_id=fact_project_session.project_id,
                tool_call_id=tool_call_id,
                permission_revision=permission_revision,
            ),
        },
        json=body,
    )
    conflict = await client.post(
        "/internal/xagent/facts/proposals/prepare",
        headers={
            **_headers(token),
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=fact_project_session.id,
                project_id=fact_project_session.project_id,
                tool_call_id=tool_call_id,
                permission_revision=permission_revision,
            ),
        },
        json={**body, "label": "A different request"},
    )

    assert first.status_code == 200
    assert conflict.status_code == 409
    assert conflict.json() == {"detail": {"code": "idempotency-conflict"}}
    proposal_id = UUID(first.json()["result"]["proposalId"])
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        receipt_count = await session.scalar(
            select(FactProposalReceipt)
            .where(FactProposalReceipt.proposal_id == proposal_id)
            .with_only_columns(text("count(*)"))
        )
        proposal_count = await session.scalar(
            select(FactProposal)
            .where(FactProposal.idempotency_key == "prepare-hash-conflict")
            .with_only_columns(text("count(*)"))
        )
    assert receipt_count == proposal_count == 1
