"""Fact receipt lifecycle and atomic Session admission coverage."""

import asyncio
import hashlib
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

import app.services.fact_receipts as fact_receipts
import app.services.xagent_sessions as xagent_sessions
from app.models.audit import AuditEvent
from app.models.facts import FactOperationIdempotency, FactProposal, FactProposalReceipt
from app.models.retrieval import XAgentRetrievalReceipt
from app.models.xagent_session import XAgentSession, XAgentSessionEvent
from app.services.audit import fact_audit_details, write_audit_event
from test_fact_prepare import (
    PASSWORD,
    _delegation_token,
    _headers,
    _login,
    _permission_revision,
    _prepare_body,
    _prime_tool_call,
)


def _claims() -> fact_receipts.FactReceiptClaims:
    issued_at = datetime(2026, 9, 8, tzinfo=UTC)
    return fact_receipts.FactReceiptClaims(
        proposal_id=UUID(int=1),
        project_id=UUID(int=2),
        actor_id=UUID(int=3),
        session_id=UUID(int=4),
        tool_call_id="call-fact-receipt",
        permission_revision=7,
        source_event_sequence=11,
        payload_sha256=hashlib.sha256(b"public-result").hexdigest(),
        issued_at=issued_at,
        expires_at=issued_at + timedelta(minutes=5),
    )


def test_fact_receipt_is_opaque_random_digest_with_exact_five_minute_ttl() -> None:
    first = fact_receipts.issue_receipt_secret()
    second = fact_receipts.issue_receipt_secret()
    issued_at = datetime(2026, 9, 8, tzinfo=UTC)

    starts_at, expires_at = fact_receipts.new_receipt_times(issued_at)

    assert first != second
    assert len(first) >= 43
    assert fact_receipts.receipt_digest_id(first) == UUID(
        bytes=hashlib.sha256(first.encode()).digest()[:16]
    )
    assert fact_receipts.receipt_digest_id(first) != fact_receipts.receipt_digest_id(second)
    assert (starts_at, expires_at) == (issued_at, issued_at + timedelta(minutes=5))


def test_fact_receipt_verification_rejects_expiry_digest_and_every_changed_claim() -> None:
    secret = fact_receipts.issue_receipt_secret()
    claims = _claims()

    fact_receipts.verify_receipt(
        secret,
        fact_receipts.receipt_digest_id(secret),
        claims,
        claims,
        now=claims.issued_at,
    )

    with pytest.raises(fact_receipts.FactReceiptError, match="fact-receipt-expired"):
        fact_receipts.verify_receipt(
            secret,
            fact_receipts.receipt_digest_id(secret),
            claims,
            claims,
            now=claims.expires_at,
        )
    with pytest.raises(fact_receipts.FactReceiptError, match="fact-receipt-invalid"):
        fact_receipts.verify_receipt(
            secret + "x",
            fact_receipts.receipt_digest_id(secret),
            claims,
            claims,
            now=claims.issued_at,
        )
    for field, value in (
        ("proposal_id", UUID(int=99)),
        ("project_id", UUID(int=99)),
        ("actor_id", UUID(int=99)),
        ("session_id", UUID(int=99)),
        ("tool_call_id", "call-other"),
        ("permission_revision", 8),
        ("source_event_sequence", 12),
        ("payload_sha256", "f" * 64),
        ("issued_at", claims.issued_at + timedelta(seconds=1)),
        ("expires_at", claims.expires_at + timedelta(seconds=1)),
    ):
        changed = fact_receipts.FactReceiptClaims(
            **{**claims.__dict__, field: value}
        )
        with pytest.raises(fact_receipts.FactReceiptError, match="fact-receipt-invalid"):
            fact_receipts.verify_receipt(
                secret,
                fact_receipts.receipt_digest_id(secret),
                claims,
                changed,
                now=claims.issued_at,
            )


@pytest.mark.anyio
async def test_fact_admission_functions_have_restricted_definer_catalog_and_grants(
    seeded_database,
    application_role,
    worker_role,
) -> None:
    function_names = {
        "xagent_fact_prepare_context",
        "xagent_admit_fact_proposal",
        "xagent_expire_fact_proposal",
    }
    async with seeded_database.connect() as connection:
        owner = await connection.scalar(text("SELECT current_user"))
        rows = (
            await connection.execute(
                text(
                    "SELECT routine_name, grantee FROM information_schema.routine_privileges "
                    "WHERE routine_schema = 'public' AND routine_name IN "
                    "('xagent_fact_prepare_context', 'xagent_admit_fact_proposal', "
                    "'xagent_expire_fact_proposal')"
                )
            )
        ).all()
        catalog_rows = (
            await connection.execute(
                text(
                    "SELECT procedures.proname, procedures.prosecdef, procedures.proconfig, "
                    "owners.rolname AS owner FROM pg_proc AS procedures "
                    "JOIN pg_namespace AS namespaces ON namespaces.oid = procedures.pronamespace "
                    "JOIN pg_roles AS owners ON owners.oid = procedures.proowner "
                    "WHERE namespaces.nspname = 'public' AND procedures.proname IN "
                    "('xagent_fact_prepare_context', 'xagent_admit_fact_proposal', "
                    "'xagent_expire_fact_proposal')"
                )
            )
        ).all()

    grants = {(row.routine_name, row.grantee) for row in rows}
    assert {(name, application_role) for name in function_names} <= grants
    assert not {
        (name, grantee)
        for name, grantee in grants
        if grantee in {"PUBLIC", worker_role}
    }
    assert {row.proname for row in catalog_rows} == function_names
    for row in catalog_rows:
        assert row.owner == owner
        assert row.prosecdef is True
        assert set(row.proconfig or ()) == {"search_path=pg_catalog, public"}


@pytest.mark.anyio
async def test_fact_receipt_denial_audit_accepts_only_the_action_specific_outcome(
    audit_session,
    alice,
) -> None:
    session_id = UUID(int=40)
    proposal_id = UUID(int=41)
    event = await write_audit_event(
        audit_session,
        alice.id,
        "fact.authorization_denied",
        "fact_proposal",
        proposal_id,
        UUID(int=42),
        "fact-receipt-invalid",
        details=fact_audit_details(
            session_id=session_id,
            proposal_id=proposal_id,
            tool_call_id="call-fact-denied",
            event_sequence=1,
            operation="admit",
            request_sha256="a" * 64,
            payload_sha256="b" * 64,
            permission_revision=1,
            result="fact-receipt-invalid",
            latency_ms=0,
        ),
    )

    assert event.details["result"] == "fact-receipt-invalid"


@pytest.mark.anyio
async def test_fact_cancel_audit_accepts_an_unknown_status_without_claiming_one(
    audit_session,
    alice,
) -> None:
    session_id = UUID(int=43)
    event = await write_audit_event(
        audit_session,
        alice.id,
        "fact.cancel",
        "xagent_session",
        session_id,
        UUID(int=44),
        "cancelled",
        details=fact_audit_details(
            session_id=session_id,
            tool_call_id="call-fact-cancel-unknown",
            operation="admit",
            request_sha256="c" * 64,
            payload_sha256="d" * 64,
            permission_revision=1,
            result="cancelled",
            latency_ms=0,
        ),
    )

    assert event.details["result"] == "cancelled"
    assert "status" not in event.details


@pytest.mark.anyio
async def test_cancelled_prepare_rolls_back_business_state_and_records_cancellation(
    client,
    seeded_database,
    alice,
    fact_project_session,
    monkeypatch,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    permission_revision = _permission_revision(token)
    tool_call_id = "call-prepare-cancelled"
    await _prime_tool_call(
        seeded_database,
        fact_project_session.id,
        alice.id,
        tool_call_id=tool_call_id,
    )

    async def cancel_receipt(*_args, **_kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr("app.services.facts.persist_receipt", cancel_receipt)
    with pytest.raises(asyncio.CancelledError):
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
            json={
                **_prepare_body(fact_project_session.id),
                "tool_call_id": tool_call_id,
                "permission_revision": permission_revision,
                "idempotency_key": "prepare-cancelled",
            },
        )

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal_count = await session.scalar(
            select(func.count()).select_from(FactProposal).where(
                FactProposal.idempotency_key == "prepare-cancelled"
            )
        )
        receipt_count = await session.scalar(
            select(func.count()).select_from(FactProposalReceipt).where(
                FactProposalReceipt.tool_call_id == tool_call_id
            )
        )
        operation_count = await session.scalar(
            select(func.count()).select_from(FactOperationIdempotency).where(
                FactOperationIdempotency.idempotency_key == "prepare-cancelled"
            )
        )
        audits = list(
            (
                await session.scalars(
                    select(AuditEvent).where(
                        AuditEvent.details["tool_call_id"].astext == tool_call_id
                    )
                )
            ).all()
        )
    assert proposal_count == receipt_count == operation_count == 0
    assert len(audits) == 1
    audit = audits[0]
    assert audit.action == "fact.cancel"
    assert audit.resource_type == "xagent_session"
    assert audit.resource_id == fact_project_session.id
    assert audit.details["operation"] == "prepare"
    assert audit.details["result"] == "cancelled"
    assert "status" not in audit.details
    assert audit.details["evidence_count"] == 0
    assert "assertion_reason" not in audit.details


async def _prepare_for_admission(
    client,
    seeded_database,
    alice,
    fact_project_session,
    *,
    suffix: str,
) -> tuple[str, int, str, dict[str, object]]:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    permission_revision = _permission_revision(token)
    tool_call_id = f"call-admit-{suffix}"
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
            "idempotency_key": f"prepare-admit-{suffix}",
        },
    )
    assert response.status_code == 200
    return token, permission_revision, tool_call_id, response.json()


def _fact_result_event(
    *,
    sequence: int,
    tool_call_id: str,
    proposal_id: str,
    status: str = "pending",
) -> dict[str, object]:
    result = {"proposalId": proposal_id, "status": status}
    return {
        "event_type": "tool/result",
        "schema_version": 1,
        "payload": {
            "seq": sequence,
            "time": 1788854400000,
            "type": "tool/result",
            "surfaceOp": "append",
            "sourceEventSeqs": [0],
            "data": {
                "turn": 0,
                "step": 0,
                "message": {
                    "id": f"message-{sequence}",
                    "role": "user",
                    "source": {"kind": "tool", "callId": tool_call_id},
                    "content": [
                        {
                            "type": "tool-result",
                            "toolCallId": tool_call_id,
                            "isError": False,
                            "content": [
                                {
                                    "type": "text",
                                    "text": json.dumps(
                                        result,
                                        ensure_ascii=False,
                                        separators=(",", ":"),
                                    ),
                                }
                            ],
                        }
                    ],
                },
            },
        },
    }


def _fact_attachment(
    prepared: dict[str, object],
    *,
    sequence: int,
    tool_call_id: str,
) -> dict[str, object]:
    result = prepared["result"]
    assert isinstance(result, dict)
    return {
        "event_sequence": sequence,
        "tool_call_id": tool_call_id,
        "proposal_id": result["proposalId"],
        "receipt": prepared["receipt"],
        "payload_hash": prepared["payload_sha256"],
    }


def _retrieval_result_event(
    *,
    sequence: int,
    tool_call_id: str,
    search: dict[str, object],
) -> dict[str, object]:
    public = {"citations": search["citations"]}
    return {
        "event_type": "tool/result",
        "schema_version": 1,
        "payload": {
            "seq": sequence,
            "time": 1788854400000 + sequence,
            "type": "tool/result",
            "surfaceOp": "append",
            "data": {
                "turn": 0,
                "step": 0,
                "message": {
                    "id": f"message-{sequence}",
                    "role": "user",
                    "source": {"kind": "tool", "callId": tool_call_id},
                    "content": [
                        {
                            "type": "tool-result",
                            "toolCallId": tool_call_id,
                            "isError": False,
                            "content": [
                                {
                                    "type": "text",
                                    "text": json.dumps(
                                        public,
                                        ensure_ascii=False,
                                        separators=(",", ":"),
                                    ),
                                }
                            ],
                        }
                    ],
                },
                "meta": {
                    "kind": "xagent-retrieval",
                    "payloadHash": search["payload_sha256"],
                    "citations": [
                        item["id"] for item in search["citations"]
                    ],
                },
            },
        },
    }


async def _assert_fact_append_left_prepared(
    seeded_database,
    fact_project_session,
    prepared: dict[str, object],
) -> None:
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal = await session.get(
            FactProposal,
            UUID(prepared["result"]["proposalId"]),
        )
        receipt = await session.get(
            FactProposalReceipt,
            fact_receipts.receipt_digest_id(prepared["receipt"]),
        )
        session_head = await session.scalar(
            select(XAgentSession.last_event_sequence).where(
                XAgentSession.id == fact_project_session.id
            )
        )
    assert proposal is not None and proposal.status == "prepared"
    assert receipt is not None and receipt.consumed_at is None
    assert session_head == 0


@pytest.mark.anyio
async def test_fact_result_without_receipt_attachment_is_rejected_atomically(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    token, _, tool_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="missing-attachment",
    )
    response = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "append-fact-missing-attachment",
            "events": [
                _fact_result_event(
                    sequence=1,
                    tool_call_id=tool_call_id,
                    proposal_id=prepared["result"]["proposalId"],
                )
            ],
            "fact_proposal_receipts": [],
            "fact_outbox_events": [],
        },
    )

    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "fact-receipt-invalid"}}
    await _assert_fact_append_left_prepared(
        seeded_database,
        fact_project_session,
        prepared,
    )


@pytest.mark.anyio
async def test_fact_receipt_attachment_without_matching_result_is_rejected_atomically(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    token, _, tool_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="missing-result",
    )
    response = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "append-fact-missing-result",
            "events": [
                {
                    "event_type": "user/message",
                    "schema_version": 1,
                    "payload": {"seq": 1, "type": "user/message"},
                }
            ],
            "fact_proposal_receipts": [
                _fact_attachment(prepared, sequence=1, tool_call_id=tool_call_id)
            ],
            "fact_outbox_events": [],
        },
    )

    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "fact-receipt-invalid"}}
    await _assert_fact_append_left_prepared(
        seeded_database,
        fact_project_session,
        prepared,
    )


@pytest.mark.anyio
async def test_duplicate_fact_receipt_attachments_are_rejected_atomically(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    token, _, tool_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="duplicate-attachment",
    )
    attachment = _fact_attachment(prepared, sequence=1, tool_call_id=tool_call_id)
    response = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "append-fact-duplicate-attachment",
            "events": [
                _fact_result_event(
                    sequence=1,
                    tool_call_id=tool_call_id,
                    proposal_id=prepared["result"]["proposalId"],
                )
            ],
            "fact_proposal_receipts": [attachment, attachment],
            "fact_outbox_events": [],
        },
    )

    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "fact-receipt-invalid"}}
    await _assert_fact_append_left_prepared(
        seeded_database,
        fact_project_session,
        prepared,
    )


@pytest.mark.anyio
@pytest.mark.parametrize("second_proposal_id", [None, str(UUID(int=998))])
async def test_duplicate_or_unbound_fact_result_is_rejected_atomically(
    client,
    seeded_database,
    alice,
    fact_project_session,
    second_proposal_id,
) -> None:
    token, _, tool_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix=f"extra-result-{second_proposal_id is not None}",
    )
    proposal_id = prepared["result"]["proposalId"]
    response = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": f"append-fact-extra-{second_proposal_id is not None}",
            "events": [
                _fact_result_event(
                    sequence=1,
                    tool_call_id=tool_call_id,
                    proposal_id=proposal_id,
                ),
                _fact_result_event(
                    sequence=2,
                    tool_call_id=tool_call_id,
                    proposal_id=second_proposal_id or proposal_id,
                ),
            ],
            "fact_proposal_receipts": [
                _fact_attachment(prepared, sequence=1, tool_call_id=tool_call_id)
            ],
            "fact_outbox_events": [],
        },
    )

    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "fact-receipt-invalid"}}
    await _assert_fact_append_left_prepared(
        seeded_database,
        fact_project_session,
        prepared,
    )


@pytest.mark.anyio
async def test_fact_shaped_result_for_unrelated_durable_tool_call_remains_generic(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    tool_call_id = "call-unrelated-generic"
    await _prime_tool_call(
        seeded_database,
        fact_project_session.id,
        alice.id,
        tool_call_id=tool_call_id,
        tool_name="generic_tool",
    )
    response = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "append-generic-fact-coincidence",
            "events": [
                _fact_result_event(
                    sequence=1,
                    tool_call_id=tool_call_id,
                    proposal_id=str(UUID(int=999)),
                )
            ],
            "fact_proposal_receipts": [],
            "fact_outbox_events": [],
        },
    )

    assert response.status_code == 200
    assert response.json()["last_event_sequence"] == 1


@pytest.mark.anyio
async def test_session_append_admits_fact_once_and_exact_replay_recovers_lost_response(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    token, _, tool_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="success",
    )
    proposal_id = prepared["result"]["proposalId"]
    append_body = {
        "schema_version": 1,
        "expected_sequence": 0,
        "idempotency_key": "append-fact-success",
        "events": [
            _fact_result_event(
                sequence=1,
                tool_call_id=tool_call_id,
                proposal_id=proposal_id,
            )
        ],
        "fact_proposal_receipts": [
            _fact_attachment(prepared, sequence=1, tool_call_id=tool_call_id)
        ],
        "fact_outbox_events": [],
    }

    first = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json=append_body,
    )
    replay = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json=append_body,
    )

    assert first.status_code == replay.status_code == 200
    assert replay.json() == first.json()
    assert first.json()["last_event_sequence"] == 1
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal = await session.get(FactProposal, UUID(proposal_id))
        receipt = await session.get(
            FactProposalReceipt,
            fact_receipts.receipt_digest_id(prepared["receipt"]),
        )
        event_count = await session.scalar(
            select(func.count()).select_from(XAgentSessionEvent).where(
                XAgentSessionEvent.session_id == fact_project_session.id,
                XAgentSessionEvent.sequence == 1,
            )
        )
        audits = list(
            (
                await session.scalars(
                    select(AuditEvent).where(
                        AuditEvent.resource_id == UUID(proposal_id),
                        AuditEvent.action == "fact.admit",
                    )
                )
            ).all()
        )

    assert proposal is not None and proposal.status == "pending"
    assert proposal.admitted_at is not None
    assert receipt is not None and receipt.consumed_event_sequence == 1
    assert receipt.consumed_payload_sha256 == prepared["payload_sha256"]
    assert event_count == len(audits) == 1
    assert prepared["receipt"] not in json.dumps([audit.details for audit in audits])


@pytest.mark.anyio
async def test_fact_and_retrieval_receipts_can_be_admitted_in_one_append(
    client,
    seeded_database,
    alice,
    fact_project_session,
    fact_admitted_evidence,
    monkeypatch,
) -> None:
    async def fake_embed(_self, texts):
        return [[1.0] + [0.0] * 1023 for _ in texts]

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", fake_embed)
    source = fact_admitted_evidence[0]
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "UPDATE artifact_text_chunks SET embedding = CAST(:embedding AS vector) "
                    "WHERE id = :chunk_id"
                ),
                {
                    "chunk_id": source["chunk"],
                    "embedding": "[1" + ",0" * 1023 + "]",
                },
            )
            await session.execute(
                text(
                    "INSERT INTO artifact_search_heads (artifact_id, index_id, version_id) "
                    "VALUES (:artifact_id, :index_id, :version_id)"
                ),
                {
                    "artifact_id": source["artifact"],
                    "index_id": source["index"],
                    "version_id": source["version"],
                },
            )

    token, permission_revision, fact_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="with-retrieval",
    )
    retrieval_call_id = "call-retrieval-with-fact"
    search = await client.post(
        "/internal/xagent/retrieval/search",
        headers={
            **_headers(token),
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=fact_project_session.id,
                project_id=fact_project_session.project_id,
                tool_call_id=retrieval_call_id,
                tool_name="search_artifacts",
                permission_revision=permission_revision,
            ),
        },
        json={
            "schema_version": 1,
            "session_id": str(fact_project_session.id),
            "tool_call_id": retrieval_call_id,
            "permission_revision": permission_revision,
            "query": "fact evidence",
            "include_private": False,
        },
    )
    assert search.status_code == 200, search.text
    search_body = search.json()
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "DELETE FROM xagent_admitted_evidence "
                    "WHERE session_id = :session_id"
                ),
                {"session_id": fact_project_session.id},
            )
    appended = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "append-fact-with-retrieval",
            "events": [
                _fact_result_event(
                    sequence=1,
                    tool_call_id=fact_call_id,
                    proposal_id=prepared["result"]["proposalId"],
                ),
                _retrieval_result_event(
                    sequence=2,
                    tool_call_id=retrieval_call_id,
                    search=search_body,
                ),
            ],
            "retrieval_receipts": [
                {
                    "event_sequence": 2,
                    "tool_call_id": retrieval_call_id,
                    "receipt": search_body["receipt"],
                    "payload_hash": search_body["payload_sha256"],
                }
            ],
            "fact_proposal_receipts": [
                _fact_attachment(prepared, sequence=1, tool_call_id=fact_call_id)
            ],
            "fact_outbox_events": [],
        },
    )

    assert appended.status_code == 200, appended.text
    assert appended.json()["last_event_sequence"] == 2
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal = await session.get(
            FactProposal,
            UUID(prepared["result"]["proposalId"]),
        )
        fact_receipt = await session.get(
            FactProposalReceipt,
            fact_receipts.receipt_digest_id(prepared["receipt"]),
        )
        retrieval_receipt = await session.scalar(
            select(XAgentRetrievalReceipt).where(
                XAgentRetrievalReceipt.tool_call_id == retrieval_call_id
            )
        )

    assert proposal is not None and proposal.status == "pending"
    assert fact_receipt is not None and fact_receipt.consumed_event_sequence == 1
    assert retrieval_receipt is not None
    assert retrieval_receipt.consumed_event_sequence == 2


@pytest.mark.anyio
async def test_malformed_fact_result_rolls_back_event_admission_and_receipt_consumption(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    token, _, tool_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="rollback",
    )
    proposal_id = prepared["result"]["proposalId"]
    response = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "append-fact-rollback",
            "events": [
                _fact_result_event(
                    sequence=1,
                    tool_call_id=tool_call_id,
                    proposal_id=proposal_id,
                    status="prepared",
                )
            ],
            "fact_proposal_receipts": [
                _fact_attachment(prepared, sequence=1, tool_call_id=tool_call_id)
            ],
            "fact_outbox_events": [],
        },
    )

    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "fact-receipt-invalid"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal = await session.get(FactProposal, UUID(proposal_id))
        receipt = await session.get(
            FactProposalReceipt,
            fact_receipts.receipt_digest_id(prepared["receipt"]),
        )
        session_head = await session.scalar(
            select(XAgentSession.last_event_sequence).where(
                XAgentSession.id == fact_project_session.id
            )
        )
        denial_count = await session.scalar(
            select(func.count()).select_from(AuditEvent).where(
                AuditEvent.resource_id == UUID(proposal_id),
                AuditEvent.action == "fact.authorization_denied",
            )
        )
    assert proposal is not None and proposal.status == "prepared"
    assert receipt is not None and receipt.consumed_at is None
    assert session_head == 0
    assert denial_count == 1


@pytest.mark.anyio
async def test_fact_admission_rejects_every_mismatched_claim_without_an_identity_oracle(
    client,
    seeded_database,
    alice,
    bob,
    fact_project_session,
) -> None:
    token, _, tool_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="claims",
    )
    proposal_id = prepared["result"]["proposalId"]
    event = _fact_result_event(
        sequence=1,
        tool_call_id=tool_call_id,
        proposal_id=proposal_id,
    )
    attachment = _fact_attachment(prepared, sequence=1, tool_call_id=tool_call_id)
    changed_event = _fact_result_event(
        sequence=1,
        tool_call_id=tool_call_id,
        proposal_id=str(UUID(int=991)),
    )
    cases = (
        ({**attachment, "receipt": f"{prepared['receipt']}x"}, event, "digest"),
        ({**attachment, "proposal_id": str(UUID(int=992))}, event, "proposal"),
        ({**attachment, "tool_call_id": "call-admit-other"}, event, "tool"),
        ({**attachment, "payload_hash": "f" * 64}, event, "hash"),
        (attachment, changed_event, "event"),
    )
    results = []
    for changed_attachment, changed_result, suffix in cases:
        response = await client.post(
            f"/internal/xagent/sessions/{fact_project_session.id}/append",
            headers=_headers(token),
            json={
                "schema_version": 1,
                "expected_sequence": 0,
                "idempotency_key": f"append-fact-claim-{suffix}",
                "events": [changed_result],
                "fact_proposal_receipts": [changed_attachment],
                "fact_outbox_events": [],
            },
        )
        results.append(response)

    guessed_session = await client.post(
        f"/internal/xagent/sessions/{UUID(int=993)}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "append-fact-guessed-session",
            "events": [event],
            "fact_proposal_receipts": [attachment],
            "fact_outbox_events": [],
        },
    )
    bob_token = await _login(client, seeded_database, bob, "bob@example.test")
    cross_actor = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(bob_token),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "append-fact-cross-actor",
            "events": [event],
            "fact_proposal_receipts": [attachment],
            "fact_outbox_events": [],
        },
    )

    assert {response.status_code for response in results} == {409}
    assert {json.dumps(response.json(), sort_keys=True) for response in results} == {
        json.dumps({"detail": {"code": "fact-receipt-invalid"}}, sort_keys=True)
    }
    assert guessed_session.status_code == 404
    assert guessed_session.json() == {"detail": {"code": "not-found"}}
    assert cross_actor.status_code == 409
    assert cross_actor.json() == {"detail": {"code": "fact-receipt-invalid"}}
    for response in (*results, guessed_session, cross_actor):
        assert prepared["receipt"] not in response.text

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal = await session.get(FactProposal, UUID(proposal_id))
        receipt = await session.get(
            FactProposalReceipt,
            fact_receipts.receipt_digest_id(prepared["receipt"]),
        )
        session_head = await session.scalar(
            select(XAgentSession.last_event_sequence).where(
                XAgentSession.id == fact_project_session.id
            )
        )
    assert proposal is not None and proposal.status == "prepared"
    assert receipt is not None and receipt.consumed_at is None
    assert session_head == 0


@pytest.mark.anyio
async def test_fact_receipt_source_sequence_rejects_same_batch_leading_events(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    token, _, tool_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="source-sequence",
    )
    response = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "append-fact-source-sequence",
            "events": [
                {
                    "event_type": "message/user",
                    "schema_version": 1,
                    "payload": {"seq": 1, "type": "message/user"},
                },
                _fact_result_event(
                    sequence=2,
                    tool_call_id=tool_call_id,
                    proposal_id=prepared["result"]["proposalId"],
                ),
            ],
            "fact_proposal_receipts": [
                _fact_attachment(prepared, sequence=2, tool_call_id=tool_call_id)
            ],
            "fact_outbox_events": [],
        },
    )

    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "fact-receipt-invalid"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal = await session.get(
            FactProposal,
            UUID(prepared["result"]["proposalId"]),
        )
        session_head = await session.scalar(
            select(XAgentSession.last_event_sequence).where(
                XAgentSession.id == fact_project_session.id
            )
        )
    assert proposal is not None and proposal.status == "prepared"
    assert session_head == 0


@pytest.mark.anyio
async def test_expired_fact_receipt_hides_proposal_then_records_expiry_without_an_event(
    client,
    seeded_database,
    alice,
    fact_project_session,
    monkeypatch,
) -> None:
    issued_at = datetime.now(UTC) - timedelta(minutes=6)
    monkeypatch.setattr(
        "app.services.facts.new_receipt_times",
        lambda: (issued_at, issued_at + timedelta(minutes=5)),
    )
    token, _, tool_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="expired",
    )
    proposal_id = prepared["result"]["proposalId"]
    response = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "append-fact-expired",
            "events": [
                _fact_result_event(
                    sequence=1,
                    tool_call_id=tool_call_id,
                    proposal_id=proposal_id,
                )
            ],
            "fact_proposal_receipts": [
                _fact_attachment(prepared, sequence=1, tool_call_id=tool_call_id)
            ],
            "fact_outbox_events": [],
        },
    )

    assert response.status_code == 410
    assert response.json() == {"detail": {"code": "fact-receipt-expired"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal = await session.get(FactProposal, UUID(proposal_id))
        receipt = await session.get(
            FactProposalReceipt,
            fact_receipts.receipt_digest_id(prepared["receipt"]),
        )
        expire_audits = list(
            (
                await session.scalars(
                    select(AuditEvent).where(
                        AuditEvent.resource_id == UUID(proposal_id),
                        AuditEvent.action == "fact.expire",
                    )
                )
            ).all()
        )
        session_head = await session.scalar(
            select(XAgentSession.last_event_sequence).where(
                XAgentSession.id == fact_project_session.id
            )
        )
    assert proposal is not None and proposal.status == "expired"
    assert proposal.decided_at is not None and proposal.admitted_at is None
    assert receipt is not None and receipt.consumed_at is None
    assert len(expire_audits) == 1
    assert prepared["receipt"] not in json.dumps(expire_audits[0].details)
    assert session_head == 0


@pytest.mark.anyio
async def test_fact_deadline_uses_wall_clock_after_authoritative_rows_are_locked(
    client,
    seeded_database,
    application_role,
    alice,
    fact_project_session,
    monkeypatch,
) -> None:
    issued_at = datetime.now(UTC) - timedelta(minutes=5) + timedelta(seconds=5)
    monkeypatch.setattr(
        "app.services.facts.new_receipt_times",
        lambda: (issued_at, issued_at + timedelta(minutes=5)),
    )
    _, permission_revision, tool_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="wall-clock",
    )
    proposal_id = UUID(prepared["result"]["proposalId"])
    receipt_digest = fact_receipts.receipt_digest_id(prepared["receipt"])
    expires_at = issued_at + timedelta(minutes=5)
    parameters = {
        "receipt_digest": receipt_digest,
        "proposal_id": proposal_id,
        "project_id": fact_project_session.project_id,
        "actor_id": alice.id,
        "session_id": fact_project_session.id,
        "tool_call_id": tool_call_id,
        "permission_revision": permission_revision,
        "event_sequence": 1,
        "payload_sha256": prepared["payload_sha256"],
    }
    signature = (
        ":receipt_digest, :proposal_id, :project_id, :actor_id, :session_id, "
        ":tool_call_id, :permission_revision, :event_sequence, :payload_sha256"
    )
    quoted_role = seeded_database.dialect.identifier_preparer.quote(application_role)
    admission_started = asyncio.Event()

    async def admit_after_transaction_start() -> tuple[bool | None, datetime]:
        async with AsyncSession(seeded_database, expire_on_commit=False) as session:
            async with session.begin():
                await session.execute(text(f"SET LOCAL ROLE {quoted_role}"))
                await session.execute(
                    text("SELECT set_config('app.actor_id', :actor_id, true)"),
                    {"actor_id": str(alice.id)},
                )
                await session.execute(
                    text("SELECT set_config('app.actor_role', 'specialist', true)")
                )
                transaction_time = await session.scalar(text("SELECT CURRENT_TIMESTAMP"))
                admission_started.set()
                accepted = await session.scalar(
                    text(
                        "SELECT public.xagent_admit_fact_proposal("
                        f"{signature})"
                    ),
                    parameters,
                )
        assert isinstance(transaction_time, datetime)
        return accepted, transaction_time

    async with AsyncSession(seeded_database, expire_on_commit=False) as blocker:
        async with blocker.begin():
            await blocker.execute(
                select(XAgentSession)
                .where(XAgentSession.id == fact_project_session.id)
                .with_for_update()
            )
            admission_task = asyncio.create_task(admit_after_transaction_start())
            await admission_started.wait()
            wait_seconds = (expires_at - datetime.now(UTC)).total_seconds() + 0.2
            assert wait_seconds > 0
            await asyncio.sleep(wait_seconds)
    accepted, transaction_time = await admission_task

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(text(f"SET LOCAL ROLE {quoted_role}"))
            await session.execute(
                text("SELECT set_config('app.actor_id', :actor_id, true)"),
                {"actor_id": str(alice.id)},
            )
            await session.execute(
                text("SELECT set_config('app.actor_role', 'specialist', true)")
            )
            expired = await session.scalar(
                text(
                    "SELECT public.xagent_expire_fact_proposal("
                    f"{signature})"
                ),
                parameters,
            )

    assert transaction_time < expires_at < datetime.now(UTC)
    assert accepted is False
    assert expired is True
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal = await session.get(FactProposal, proposal_id)
        receipt = await session.get(FactProposalReceipt, receipt_digest)
    assert proposal is not None and proposal.status == "expired"
    assert proposal.decided_at is not None and proposal.decided_at >= expires_at
    assert receipt is not None and receipt.consumed_at is None


@pytest.mark.anyio
async def test_cancelled_fact_append_rolls_back_admission_and_records_cancellation(
    client,
    seeded_database,
    alice,
    fact_project_session,
    monkeypatch,
) -> None:
    token, _, tool_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="cancelled",
    )
    proposal_id = prepared["result"]["proposalId"]

    async def cancel_after_append(*_args, **_kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(
        "app.services.xagent_sessions._store_idempotent_result",
        cancel_after_append,
    )
    with pytest.raises(asyncio.CancelledError):
        await client.post(
            f"/internal/xagent/sessions/{fact_project_session.id}/append",
            headers=_headers(token),
            json={
                "schema_version": 1,
                "expected_sequence": 0,
                "idempotency_key": "append-fact-cancelled",
                "events": [
                    _fact_result_event(
                        sequence=1,
                        tool_call_id=tool_call_id,
                        proposal_id=proposal_id,
                    )
                ],
                "fact_proposal_receipts": [
                    _fact_attachment(prepared, sequence=1, tool_call_id=tool_call_id)
                ],
                "fact_outbox_events": [],
            },
        )

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal = await session.get(FactProposal, UUID(proposal_id))
        receipt = await session.get(
            FactProposalReceipt,
            fact_receipts.receipt_digest_id(prepared["receipt"]),
        )
        event_count = await session.scalar(
            select(func.count()).select_from(XAgentSessionEvent).where(
                XAgentSessionEvent.session_id == fact_project_session.id,
                XAgentSessionEvent.sequence == 1,
            )
        )
        cancellation_audits = list(
            (
                await session.scalars(
                    select(AuditEvent)
                    .where(
                        AuditEvent.action == "fact.cancel",
                        AuditEvent.details["tool_call_id"].astext == tool_call_id,
                    )
                    .order_by(AuditEvent.created_at)
                )
            ).all()
        )
    assert proposal is not None and proposal.status == "prepared"
    assert receipt is not None and receipt.consumed_at is None
    assert event_count == 0
    assert len(cancellation_audits) == 1
    assert cancellation_audits[0].resource_type == "xagent_session"
    assert cancellation_audits[0].resource_id == fact_project_session.id
    assert "proposal_id" not in cancellation_audits[0].details
    assert "status" not in cancellation_audits[0].details


@pytest.mark.anyio
async def test_early_fact_append_cancellation_does_not_claim_proposal_or_status(
    client,
    seeded_database,
    alice,
    fact_project_session,
    monkeypatch,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    tool_call_id = "call-cancel-before-validation"
    await _prime_tool_call(
        seeded_database,
        fact_project_session.id,
        alice.id,
        tool_call_id=tool_call_id,
        tool_name="generic_tool",
    )

    async def cancel_validation(*_args, **_kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(
        "app.services.xagent_sessions._load_fact_admissions",
        cancel_validation,
    )
    with pytest.raises(asyncio.CancelledError):
        await client.post(
            f"/internal/xagent/sessions/{fact_project_session.id}/append",
            headers=_headers(token),
            json={
                "schema_version": 1,
                "expected_sequence": 0,
                "idempotency_key": "append-fact-cancel-before-validation",
                "events": [
                    _fact_result_event(
                        sequence=1,
                        tool_call_id=tool_call_id,
                        proposal_id=str(UUID(int=997)),
                    )
                ],
                "fact_proposal_receipts": [
                    {
                        "event_sequence": 1,
                        "tool_call_id": tool_call_id,
                        "proposal_id": str(UUID(int=997)),
                        "receipt": "a" * 43,
                        "payload_hash": "b" * 64,
                    }
                ],
                "fact_outbox_events": [],
            },
        )

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        audits = list(
            (
                await session.scalars(
                    select(AuditEvent).where(
                        AuditEvent.action == "fact.cancel",
                        AuditEvent.details["tool_call_id"].astext == tool_call_id,
                    )
                )
            ).all()
        )
        session_head = await session.scalar(
            select(XAgentSession.last_event_sequence).where(
                XAgentSession.id == fact_project_session.id
            )
        )
    assert len(audits) == 1
    assert audits[0].resource_type == "xagent_session"
    assert audits[0].resource_id == fact_project_session.id
    assert "proposal_id" not in audits[0].details
    assert "status" not in audits[0].details
    assert session_head == 0


@pytest.mark.anyio
async def test_cancelled_exact_append_replay_reports_the_committed_pending_status(
    client,
    seeded_database,
    alice,
    fact_project_session,
    monkeypatch,
) -> None:
    token, _, tool_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="cancelled-replay",
    )
    proposal_id = prepared["result"]["proposalId"]
    append_body = {
        "schema_version": 1,
        "expected_sequence": 0,
        "idempotency_key": "append-fact-cancelled-replay",
        "events": [
            _fact_result_event(
                sequence=1,
                tool_call_id=tool_call_id,
                proposal_id=proposal_id,
            )
        ],
        "fact_proposal_receipts": [
            _fact_attachment(prepared, sequence=1, tool_call_id=tool_call_id)
        ],
        "fact_outbox_events": [],
    }
    first = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json=append_body,
    )
    assert first.status_code == 200
    original_idempotent_result = xagent_sessions._idempotent_result

    async def cancel_after_replay(*args, **kwargs):
        replay = await original_idempotent_result(*args, **kwargs)
        if replay is not None:
            raise asyncio.CancelledError
        return replay

    monkeypatch.setattr(
        "app.services.xagent_sessions._idempotent_result",
        cancel_after_replay,
    )
    with pytest.raises(asyncio.CancelledError):
        await client.post(
            f"/internal/xagent/sessions/{fact_project_session.id}/append",
            headers=_headers(token),
            json=append_body,
        )

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal = await session.get(FactProposal, UUID(proposal_id))
        event_count = await session.scalar(
            select(func.count()).select_from(XAgentSessionEvent).where(
                XAgentSessionEvent.session_id == fact_project_session.id,
                XAgentSessionEvent.sequence == 1,
            )
        )
        cancel_audit = await session.scalar(
            select(AuditEvent).where(
                AuditEvent.action == "fact.cancel",
                AuditEvent.details["tool_call_id"].astext == tool_call_id,
            )
        )
    assert proposal is not None and proposal.status == "pending"
    assert event_count == 1
    assert cancel_audit is not None
    assert cancel_audit.resource_type == "fact_proposal"
    assert cancel_audit.resource_id == UUID(proposal_id)
    assert cancel_audit.details["proposal_id"] == proposal_id
    assert cancel_audit.details["status"] == "pending"


@pytest.mark.anyio
async def test_consumed_or_terminal_proposal_receipts_cannot_admit_again(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    token, permission_revision, tool_call_id, first = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="single-use",
    )
    replay = await client.post(
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
            "idempotency_key": "prepare-admit-single-use",
        },
    )
    assert replay.status_code == 200
    assert replay.json()["receipt"] != first["receipt"]
    proposal_id = first["result"]["proposalId"]

    admitted = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "append-fact-single-use-first",
            "events": [
                _fact_result_event(
                    sequence=1,
                    tool_call_id=tool_call_id,
                    proposal_id=proposal_id,
                )
            ],
            "fact_proposal_receipts": [
                _fact_attachment(first, sequence=1, tool_call_id=tool_call_id)
            ],
            "fact_outbox_events": [],
        },
    )
    consumed = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 1,
            "idempotency_key": "append-fact-single-use-consumed",
            "events": [
                _fact_result_event(
                    sequence=2,
                    tool_call_id=tool_call_id,
                    proposal_id=proposal_id,
                )
            ],
            "fact_proposal_receipts": [
                _fact_attachment(first, sequence=2, tool_call_id=tool_call_id)
            ],
            "fact_outbox_events": [],
        },
    )
    terminal = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "expected_sequence": 1,
            "idempotency_key": "append-fact-single-use-terminal",
            "events": [
                _fact_result_event(
                    sequence=2,
                    tool_call_id=tool_call_id,
                    proposal_id=proposal_id,
                )
            ],
            "fact_proposal_receipts": [
                _fact_attachment(replay.json(), sequence=2, tool_call_id=tool_call_id)
            ],
            "fact_outbox_events": [],
        },
    )

    assert admitted.status_code == 200
    assert consumed.status_code == terminal.status_code == 409
    assert consumed.json() == terminal.json() == {
        "detail": {"code": "fact-receipt-invalid"}
    }
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        event_count = await session.scalar(
            select(func.count()).select_from(XAgentSessionEvent).where(
                XAgentSessionEvent.session_id == fact_project_session.id,
                XAgentSessionEvent.sequence > 0,
            )
        )
    assert event_count == 1


@pytest.mark.anyio
async def test_revoked_project_membership_cannot_admit_a_prepared_fact(
    client,
    seeded_database,
    alice,
    fact_project_session,
) -> None:
    _token, _, tool_call_id, prepared = await _prepare_for_admission(
        client,
        seeded_database,
        alice,
        fact_project_session,
        suffix="revoked-membership",
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "DELETE FROM project_memberships "
                    "WHERE project_id = :project_id AND account_id = :actor_id"
                ),
                {
                    "project_id": fact_project_session.project_id,
                    "actor_id": alice.id,
                },
            )

    refreshed_login = await client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.test", "password": PASSWORD},
    )
    assert refreshed_login.status_code == 200
    response = await client.post(
        f"/internal/xagent/sessions/{fact_project_session.id}/append",
        headers=_headers(refreshed_login.json()["access_token"]),
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "append-fact-revoked-membership",
            "events": [
                _fact_result_event(
                    sequence=1,
                    tool_call_id=tool_call_id,
                    proposal_id=prepared["result"]["proposalId"],
                )
            ],
            "fact_proposal_receipts": [
                _fact_attachment(prepared, sequence=1, tool_call_id=tool_call_id)
            ],
            "fact_outbox_events": [],
        },
    )

    assert response.status_code == 404
    assert response.json() == {"detail": {"code": "not-found"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        proposal = await session.get(
            FactProposal,
            UUID(prepared["result"]["proposalId"]),
        )
        receipt = await session.get(
            FactProposalReceipt,
            fact_receipts.receipt_digest_id(prepared["receipt"]),
        )
        session_head = await session.scalar(
            select(XAgentSession.last_event_sequence).where(
                XAgentSession.id == fact_project_session.id
            )
        )
    assert proposal is not None and proposal.status == "prepared"
    assert receipt is not None and receipt.consumed_at is None
    assert session_head == 0
