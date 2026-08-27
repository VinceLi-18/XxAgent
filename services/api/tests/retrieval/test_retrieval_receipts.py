import hashlib
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import select, text

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.identity import Role
from app.models.retrieval import XAgentRetrievalReceipt

from app.services.retrieval_receipts import (
    ReceiptClaims,
    RetrievalReceiptError,
    issue_receipt_secret,
    persist_receipt,
    receipt_digest_id,
    verify_receipt,
)
from app.services.retrieval import RetrievalError, authorize_session_citations


def _claims() -> ReceiptClaims:
    issued = datetime(2026, 8, 28, tzinfo=UTC)
    return ReceiptClaims(
        kind="artifact_search",
        actor_id=UUID(int=1),
        session_id=UUID(int=2),
        tool_call_id="call-1",
        query_sha256=hashlib.sha256(b"query").hexdigest(),
        scope={"kind": "private", "project_ids": [], "include_private": True},
        permission_revision=1,
        project_ids=(),
        index_generations=(),
        chunk_ids=(),
        payload_sha256=hashlib.sha256(b"payload").hexdigest(),
        issued_at=issued,
        expires_at=issued + timedelta(minutes=5),
        citation_ordinal_start=None,
        citation_ordinal_end=None,
    )


def test_receipt_is_opaque_random_secret_identified_only_by_its_digest() -> None:
    first = issue_receipt_secret()
    second = issue_receipt_secret()

    assert first != second
    assert len(first) >= 43
    assert receipt_digest_id(first) != receipt_digest_id(second)
    assert first not in str(_claims())


def test_receipt_verification_checks_digest_expiry_and_all_bound_claims() -> None:
    secret = issue_receipt_secret()
    claims = _claims()

    verify_receipt(secret, receipt_digest_id(secret), claims, claims, now=claims.issued_at)

    with pytest.raises(RetrievalReceiptError, match="evidence-expired"):
        verify_receipt(secret, receipt_digest_id(secret), claims, claims, now=claims.expires_at)
    with pytest.raises(RetrievalReceiptError, match="evidence-conflict"):
        verify_receipt(secret + "x", receipt_digest_id(secret), claims, claims, now=claims.issued_at)
    changed = ReceiptClaims(**{**claims.__dict__, "tool_call_id": "other"})
    with pytest.raises(RetrievalReceiptError, match="evidence-conflict"):
        verify_receipt(secret, receipt_digest_id(secret), claims, changed, now=claims.issued_at)


@pytest.mark.anyio
async def test_persisted_receipt_contains_only_digest_and_five_minute_bound_claims(
    actor_session,
    alice,
    alice_private_xagent_session,
) -> None:
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    claims = ReceiptClaims(
        **{
            **_claims().__dict__,
            "actor_id": alice.id,
            "session_id": alice_private_xagent_session.id,
        }
    )

    secret = await persist_receipt(actor_session, claims)
    stored = await actor_session.scalar(
        select(XAgentRetrievalReceipt).where(XAgentRetrievalReceipt.id == receipt_digest_id(secret))
    )

    assert stored is not None
    assert stored.expires_at - stored.issued_at == timedelta(minutes=5)
    assert secret not in repr(stored.__dict__)
    assert stored.tool_call_id == claims.tool_call_id


@pytest.mark.anyio
async def test_citation_requires_consumed_same_session_receipt_before_reauthorization(
    actor_session,
    seeded_database,
    alice,
    alice_private_xagent_session,
) -> None:
    artifact_id, version_id, index_id, chunk_id = (UUID(int=value) for value in range(1201, 1205))
    vector = "[1" + ",0" * 1023 + "]"
    async with seeded_database.begin() as connection:
        await connection.execute(
            text("INSERT INTO artifacts (id, filename, owner_id, created_by_id) VALUES (:id, 'c.txt', :actor, :actor)"),
            {"id": artifact_id, "actor": alice.id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions (id, artifact_id, owner_id, version_number, original_filename, uploaded_by_id, "
                "declared_size, actual_size, detected_content_type, scan_status, object_key, size, content_type, sha256) "
                "VALUES (:id, :artifact, :actor, 1, 'c.txt', :actor, 1, 1, 'text/plain', 'clean', :key, 1, 'text/plain', :sha)"
            ),
            {"id": version_id, "artifact": artifact_id, "actor": alice.id, "key": f"artifacts/{artifact_id}/{version_id}", "sha": "a" * 64},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_text_indexes (id, artifact_id, version_id, generation, content_sha256, parser_revision, "
                "embedding_model, embedding_revision, vector_dimensions, configuration_fingerprint, status, chunk_count) "
                "VALUES (:id, :artifact, :version, 1, :sha, 'parser', 'BAAI/bge-m3', 'revision', 1024, :fingerprint, 'ready', 1)"
            ),
            {"id": index_id, "artifact": artifact_id, "version": version_id, "sha": "b" * 64, "fingerprint": "c" * 64},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_text_chunks (id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                "VALUES (:id, :index, 0, 1, 1, 'citation evidence', 2, :sha, CAST(:vector AS vector))"
            ),
            {"id": chunk_id, "index": index_id, "sha": "d" * 64, "vector": vector},
        )
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    issued_at = datetime.now(UTC)
    claims = ReceiptClaims(
        kind="artifact_search", actor_id=alice.id, session_id=alice_private_xagent_session.id,
        tool_call_id="call-citation", query_sha256="e" * 64,
        scope={"kind": "private", "project_ids": [], "include_private": True},
        permission_revision=1, project_ids=(),
        index_generations=({"index_id": str(index_id), "generation": 1},),
        chunk_ids=(chunk_id,), payload_sha256="f" * 64,
        issued_at=issued_at, expires_at=issued_at + timedelta(minutes=5),
        citation_ordinal_start=1, citation_ordinal_end=1,
    )
    secret = await persist_receipt(actor_session, claims)
    citation = [("[资料1]", artifact_id, version_id, chunk_id)]

    with pytest.raises(RetrievalError, match="citation-invalid"):
        await authorize_session_citations(
            actor_session, actor_id=alice.id,
            session_id=alice_private_xagent_session.id, citations=citation,
        )

    receipt = await actor_session.get(XAgentRetrievalReceipt, receipt_digest_id(secret))
    receipt.consumed_at = datetime.now(UTC)
    receipt.consumed_event_sequence = 0
    receipt.consumed_payload_sha256 = claims.payload_sha256
    await actor_session.flush()

    authorized = await authorize_session_citations(
        actor_session, actor_id=alice.id,
        session_id=alice_private_xagent_session.id, citations=citation,
    )
    assert [item.chunk_id for item in authorized] == [chunk_id]
