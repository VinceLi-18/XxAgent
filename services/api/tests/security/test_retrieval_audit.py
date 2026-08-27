import json
from uuid import UUID

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.audit import AuditEvent
from app.models.identity import Role
from app.services.audit import retrieval_audit_details, write_audit_event


def test_retrieval_audit_contains_only_ids_hashes_counts_status_and_latency() -> None:
    details = retrieval_audit_details(
        session_id="00000000-0000-0000-0000-000000000110",
        tool_call_id="call-1",
        project_scope_sha256="a" * 64,
        query_sha256="b" * 64,
        candidate_count=40,
        returned_count=8,
        result="allowed",
        latency_ms=12,
    )
    serialized = json.dumps(details)

    assert details["candidate_count"] == 40
    assert details["evidence"] == []
    for secret in (
        "raw query",
        "chunk content",
        "embedding",
        "prompt",
        "answer",
        "https://storage.test/object?signature=secret",
        "receipt-secret",
        "artifacts/bucket/object-key",
    ):
        assert secret not in serialized

    with pytest.raises(ValueError, match="retrieval audit details are invalid"):
        retrieval_audit_details(
            session_id="00000000-0000-0000-0000-000000000110",
            tool_call_id="call-1",
            project_scope_sha256="raw project names",
            query_sha256="raw query",
            candidate_count=1,
            returned_count=1,
            result="allowed",
            latency_ms=1,
        )


@pytest.mark.anyio
async def test_retrieval_audit_persists_only_the_redacted_detail_set(
    actor_session,
    alice,
    alice_private_xagent_session,
) -> None:
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    details = retrieval_audit_details(
        session_id=str(alice_private_xagent_session.id),
        tool_call_id="call-1",
        project_scope_sha256="a" * 64,
        query_sha256="b" * 64,
        candidate_count=40,
        returned_count=8,
        result="allowed",
        latency_ms=12,
    )
    event = await write_audit_event(
        actor_session,
        alice.id,
        "retrieval.search",
        "xagent_session",
        alice_private_xagent_session.id,
        alice_private_xagent_session.id,
        "allowed",
        details=details,
    )

    stored = await actor_session.scalar(select(AuditEvent).where(AuditEvent.id == event.id))

    assert stored.details == details
    assert set(stored.details) == {
        "session_id", "tool_call_id", "project_scope_sha256", "query_sha256",
        "candidate_count", "returned_count", "result", "latency_ms",
        "evidence",
    }


def test_retrieval_audit_accepts_only_bounded_evidence_identities() -> None:
    identity = {
        "artifact_id": str(UUID(int=1)),
        "version_id": str(UUID(int=2)),
        "index_id": str(UUID(int=3)),
        "generation": 1,
        "chunk_id": str(UUID(int=4)),
    }
    details = retrieval_audit_details(
        session_id=str(UUID(int=5)), tool_call_id="call",
        project_scope_sha256="a" * 64, query_sha256="b" * 64,
        candidate_count=1, returned_count=1, result="allowed", latency_ms=1,
        evidence=[identity],
    )
    assert details["evidence"] == [identity]
    with pytest.raises(ValueError):
        retrieval_audit_details(
            session_id=str(UUID(int=5)), tool_call_id="call",
            project_scope_sha256="a" * 64, query_sha256="b" * 64,
            candidate_count=9, returned_count=9, result="allowed", latency_ms=1,
            evidence=[identity] * 9,
        )


@pytest.mark.anyio
async def test_audit_schema_rejects_non_object_or_unbounded_details(
    seeded_database, alice
) -> None:
    for details in (
        "[]",
        '{"value":"' + ("x" * 8200) + '"}',
        '{"session_id":"raw-query-or-incomplete-identity"}',
    ):
        with pytest.raises(DBAPIError):
            async with seeded_database.begin() as connection:
                await connection.execute(
                    text(
                        "INSERT INTO audit_events "
                        "(id, actor_id, action, resource_type, resource_id, request_id, result, details) "
                        "VALUES (:id, :actor, 'retrieval.search', 'xagent_session', :resource, "
                        ":request, 'allowed', CAST(:details AS jsonb))"
                    ),
                    {
                        "id": UUID(int=700), "actor": alice.id, "resource": UUID(int=701),
                        "request": UUID(int=702), "details": details,
                    },
                )
