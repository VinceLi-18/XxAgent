import hashlib
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
import pytest
from argon2 import PasswordHasher
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.retrieval import XAgentRetrievalReceipt
from app.models.workbench import XAgentSessionProjectRef
from app.services.retrieval_receipts import receipt_digest_id
from conftest import DELEGATION_PRIVATE_KEY


SERVICE_TOKEN = "xagent-test-service-token-00000001"
PASSWORD = "correct horse battery staple"


async def _login(client, engine, account) -> str:
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO xagent_account_credentials "
                    "(account_id, password_hash, password_changed_at) "
                    "VALUES (:account_id, :password_hash, CURRENT_TIMESTAMP)"
                ),
                {"account_id": account.id, "password_hash": PasswordHasher().hash(PASSWORD)},
            )
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.test", "password": PASSWORD},
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def _delegation_token(
    *,
    actor_id: UUID,
    session_id: UUID,
    tool_call_id: str,
    tool_name: str = "search_artifacts",
) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "iss": "xagent-host",
            "aud": "xagent-api",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(seconds=30)).timestamp()),
            "actor_id": str(actor_id),
            "project_id": None,
            "session_id": str(session_id),
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "permission_revision": 1,
            "nonce": f"nonce-{tool_call_id}",
        },
        DELEGATION_PRIVATE_KEY,
        algorithm="EdDSA",
    )


async def _seed_search_chunk(engine, actor_id: UUID, project_id: UUID) -> None:
    artifact_id = UUID("00000000-0000-0000-0000-000000000721")
    version_id = UUID("00000000-0000-0000-0000-000000000722")
    index_id = UUID("00000000-0000-0000-0000-000000000723")
    chunk_id = UUID("00000000-0000-0000-0000-000000000724")
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO artifacts (id, filename, project_id, created_by_id) "
                    "VALUES (:id, '预算.txt', :project, :actor)"
                ),
                {"id": artifact_id, "project": project_id, "actor": actor_id},
            )
            await session.execute(
                text(
                    "INSERT INTO artifact_versions "
                    "(id, artifact_id, project_id, version_number, original_filename, uploaded_by_id, "
                    "declared_size, actual_size, detected_content_type, scan_status, object_key, size, "
                    "content_type, sha256) VALUES (:id, :artifact, :project, 1, '预算.txt', :actor, "
                    "6, 6, 'text/plain', 'clean', :key, 6, 'text/plain', :sha)"
                ),
                {
                    "id": version_id,
                    "artifact": artifact_id,
                    "project": project_id,
                    "actor": actor_id,
                    "key": f"artifacts/{artifact_id}/{version_id}",
                    "sha": hashlib.sha256(b"budget").hexdigest(),
                },
            )
            await session.execute(
                text(
                    "INSERT INTO artifact_text_indexes "
                    "(id, artifact_id, version_id, generation, content_sha256, parser_revision, "
                    "embedding_model, embedding_revision, vector_dimensions, configuration_fingerprint, "
                    "status, chunk_count) VALUES (:id, :artifact, :version, 1, :sha, 'parser', "
                    "'BAAI/bge-m3', 'revision', 1024, :fingerprint, 'ready', 1)"
                ),
                {
                    "id": index_id,
                    "artifact": artifact_id,
                    "version": version_id,
                    "sha": "a" * 64,
                    "fingerprint": "b" * 64,
                },
            )
            await session.execute(
                text(
                    "INSERT INTO artifact_text_chunks "
                    "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                    "VALUES (:id, :index, 0, 1, 1, '项目预算', 2, :sha, CAST(:vector AS vector))"
                ),
                {
                    "id": chunk_id,
                    "index": index_id,
                    "sha": hashlib.sha256("项目预算".encode()).hexdigest(),
                    "vector": "[1" + ",0" * 1023 + "]",
                },
            )
            await session.execute(
                text(
                    "INSERT INTO artifact_search_heads (artifact_id, index_id, version_id) "
                    "VALUES (:artifact, :index, :version)"
                ),
                {"artifact": artifact_id, "index": index_id, "version": version_id},
            )


def _tool_result(sequence: int, tool_call_id: str, search: dict[str, object]) -> dict[str, object]:
    public = {"citations": search["citations"]}
    return {
        "event_type": "tool/result",
        "schema_version": 1,
        "payload": {
            "seq": sequence,
            "time": 1_787_587_200_000 + sequence,
            "type": "tool/result",
            "data": {
                "turn": 0,
                "step": 0,
                "message": {
                    "id": f"message-{sequence}",
                    "role": "user",
                    "source": {"kind": "tool", "callId": tool_call_id},
                    "content": [{
                        "type": "tool-result",
                        "toolCallId": tool_call_id,
                        "isError": False,
                        "content": [{"type": "text", "text": json.dumps(public, ensure_ascii=False, separators=(",", ":"))}],
                    }],
                },
                "meta": {
                    "kind": "xagent-retrieval",
                    "payloadHash": search["payload_sha256"],
                    "citations": [item["id"] for item in search["citations"]],
                },
            },
        },
    }


def _project_result(
    sequence: int,
    tool_call_id: str,
    discovery: dict[str, object],
) -> dict[str, object]:
    public = {"projects": discovery["projects"]}
    return {
        "event_type": "tool/result",
        "schema_version": 1,
        "payload": {
            "seq": sequence,
            "time": 1_787_587_200_000 + sequence,
            "type": "tool/result",
            "data": {
                "turn": 0,
                "step": 0,
                "message": {
                    "id": f"message-{sequence}",
                    "role": "user",
                    "source": {"kind": "tool", "callId": tool_call_id},
                    "content": [{
                        "type": "tool-result",
                        "toolCallId": tool_call_id,
                        "isError": False,
                        "content": [{
                            "type": "text",
                            "text": json.dumps(public, ensure_ascii=False, separators=(",", ":")),
                        }],
                    }],
                },
                "meta": {
                    "kind": "xagent-retrieval",
                    "payloadHash": discovery["payload_sha256"],
                    "citations": [],
                },
            },
        },
    }


@pytest.mark.anyio
async def test_append_atomically_consumes_search_receipt_and_persists_only_public_evidence(
    client,
    seeded_database,
    alice,
    alice_project,
    alice_private_xagent_session,
    monkeypatch,
) -> None:
    async def fake_embed(_self, texts):
        return [[1.0] + [0.0] * 1023 for _ in texts]

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", fake_embed)
    await _seed_search_chunk(seeded_database, alice.id, alice_project.id)
    user_token = await _login(client, seeded_database, alice)
    tool_call_id = "append-search"
    headers = {
        "Authorization": f"Bearer {user_token}",
        "X-XAgent-Service-Token": SERVICE_TOKEN,
    }
    search = await client.post(
        "/internal/xagent/retrieval/search",
        headers={
            **headers,
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=alice_private_xagent_session.id,
                tool_call_id=tool_call_id,
            ),
        },
        json={
            "schema_version": 1,
            "session_id": str(alice_private_xagent_session.id),
            "tool_call_id": tool_call_id,
            "permission_revision": 1,
            "query": "预算",
            "project_ids": [str(alice_project.id)],
            "include_private": False,
        },
    )
    assert search.status_code == 200
    search_body = search.json()
    event = _tool_result(0, tool_call_id, search_body)
    attachment = {
        "event_sequence": 0,
        "tool_call_id": tool_call_id,
        "receipt": search_body["receipt"],
        "payload_hash": search_body["payload_sha256"],
    }

    appended = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append",
        headers=headers,
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": "append-search-1",
            "events": [event],
            "retrieval_receipts": [attachment],
        },
    )
    replay = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append",
        headers=headers,
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": "append-search-1",
            "events": [event],
            "retrieval_receipts": [attachment],
        },
    )
    conflicting_replay = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append",
        headers=headers,
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": "append-search-1",
            "events": [event],
            "retrieval_receipts": [{**attachment, "payload_hash": "f" * 64}],
        },
    )
    reused = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append",
        headers=headers,
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": "append-search-reused",
            "events": [event],
            "retrieval_receipts": [attachment],
        },
    )
    opened = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/open",
        headers=headers,
        json={"schema_version": 1},
    )

    assert appended.status_code == replay.status_code == 200
    assert appended.json() == replay.json()
    assert conflicting_replay.status_code == 409
    assert conflicting_replay.json() == {
        "detail": {"code": "idempotency-conflict"}
    }
    assert reused.status_code == 409
    assert reused.json() == {"detail": {"code": "evidence-conflict"}}
    assert search_body["receipt"] not in opened.text
    assert "retrieval_receipts" not in opened.text
    assert opened.json()["events"][0]["payload"] == event["payload"]
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        receipt = await session.get(XAgentRetrievalReceipt, receipt_digest_id(search_body["receipt"]))
        project_ref = await session.get(
            XAgentSessionProjectRef,
            (alice_private_xagent_session.id, alice_project.id),
        )
        audit_leaks = await session.scalar(
            text(
                "SELECT count(*) FROM audit_events "
                "WHERE details::text LIKE :receipt"
            ),
            {"receipt": f"%{search_body['receipt']}%"},
        )
    assert receipt is not None
    assert receipt.consumed_event_sequence == 0
    assert receipt.consumed_payload_sha256 == search_body["payload_sha256"]
    assert project_ref is not None
    assert audit_leaks == 0


@pytest.mark.anyio
async def test_append_admits_project_discovery_without_allocating_citation_ordinals(
    client,
    seeded_database,
    alice,
    alice_project,
    alice_private_xagent_session,
) -> None:
    token = await _login(client, seeded_database, alice)
    headers = {
        "Authorization": f"Bearer {token}",
        "X-XAgent-Service-Token": SERVICE_TOKEN,
    }
    tool_call_id = "append-projects"
    discovered = await client.post(
        "/internal/xagent/retrieval/projects",
        headers={
            **headers,
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=alice_private_xagent_session.id,
                tool_call_id=tool_call_id,
                tool_name="list_accessible_projects",
            ),
        },
        json={
            "schema_version": 1,
            "session_id": str(alice_private_xagent_session.id),
            "tool_call_id": tool_call_id,
            "permission_revision": 1,
        },
    )
    assert discovered.status_code == 200
    discovery = discovered.json()
    event = _project_result(0, tool_call_id, discovery)

    appended = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append",
        headers=headers,
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": "append-projects-1",
            "events": [event],
            "retrieval_receipts": [{
                "event_sequence": 0,
                "tool_call_id": tool_call_id,
                "receipt": discovery["receipt"],
                "payload_hash": discovery["payload_sha256"],
            }],
        },
    )

    assert appended.status_code == 200
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        receipt = await session.get(
            XAgentRetrievalReceipt,
            receipt_digest_id(discovery["receipt"]),
        )
        next_ordinal = await session.scalar(
            text(
                "SELECT next_citation_ordinal FROM xagent_sessions "
                "WHERE id = :session_id"
            ),
            {"session_id": alice_private_xagent_session.id},
        )
    assert receipt is not None and receipt.consumed_event_sequence == 0
    assert next_ordinal == 1


@pytest.mark.anyio
async def test_append_rejects_missing_mismatched_expired_and_reused_receipts_without_partial_events(
    client,
    seeded_database,
    alice,
    alice_project,
    alice_private_xagent_session,
    monkeypatch,
) -> None:
    async def fake_embed(_self, texts):
        return [[1.0] + [0.0] * 1023 for _ in texts]

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", fake_embed)
    await _seed_search_chunk(seeded_database, alice.id, alice_project.id)
    token = await _login(client, seeded_database, alice)
    headers = {"Authorization": f"Bearer {token}", "X-XAgent-Service-Token": SERVICE_TOKEN}
    tool_call_id = "append-failures"
    search = await client.post(
        "/internal/xagent/retrieval/search",
        headers={
            **headers,
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=alice_private_xagent_session.id,
                tool_call_id=tool_call_id,
            ),
        },
        json={
            "schema_version": 1,
            "session_id": str(alice_private_xagent_session.id),
            "tool_call_id": tool_call_id,
            "permission_revision": 1,
            "query": "预算",
            "project_ids": [str(alice_project.id)],
            "include_private": False,
        },
    )
    body = search.json()
    event = _tool_result(0, tool_call_id, body)
    base = {
        "schema_version": 1,
        "expected_sequence": -1,
        "events": [event],
    }
    endpoint = f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append"
    missing = await client.post(endpoint, headers=headers, json={**base, "idempotency_key": "missing"})
    mismatch = await client.post(
        endpoint,
        headers=headers,
        json={
            **base,
            "idempotency_key": "mismatch",
            "retrieval_receipts": [{
                "event_sequence": 0,
                "tool_call_id": tool_call_id,
                "receipt": body["receipt"],
                "payload_hash": "f" * 64,
            }],
        },
    )
    malformed_secret = "receipt-must-never-echo!"
    malformed = await client.post(
        endpoint,
        headers=headers,
        json={
            **base,
            "idempotency_key": "malformed",
            "retrieval_receipts": [{
                "event_sequence": 0,
                "tool_call_id": tool_call_id,
                "receipt": malformed_secret,
                "payload_hash": body["payload_sha256"],
            }],
        },
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            receipt = await session.get(XAgentRetrievalReceipt, receipt_digest_id(body["receipt"]))
            assert receipt is not None
            expired_at = datetime.now(UTC) - timedelta(minutes=1)
            replacement = XAgentRetrievalReceipt(
                id=receipt.id,
                kind=receipt.kind,
                actor_id=receipt.actor_id,
                session_id=receipt.session_id,
                tool_call_id=receipt.tool_call_id,
                query_sha256=receipt.query_sha256,
                scope=receipt.scope,
                permission_revision=receipt.permission_revision,
                project_ids=receipt.project_ids,
                index_generations=receipt.index_generations,
                chunk_ids=receipt.chunk_ids,
                payload_sha256=receipt.payload_sha256,
                issued_at=expired_at - timedelta(minutes=5),
                expires_at=expired_at,
                citation_ordinal_start=receipt.citation_ordinal_start,
                citation_ordinal_end=receipt.citation_ordinal_end,
            )
            await session.delete(receipt)
            await session.flush()
            session.add(replacement)
    expired = await client.post(
        endpoint,
        headers=headers,
        json={
            **base,
            "idempotency_key": "expired",
            "retrieval_receipts": [{
                "event_sequence": 0,
                "tool_call_id": tool_call_id,
                "receipt": body["receipt"],
                "payload_hash": body["payload_sha256"],
            }],
        },
    )

    assert missing.status_code == mismatch.status_code == 409
    assert missing.json() == mismatch.json() == {"detail": {"code": "evidence-conflict"}}
    assert malformed.status_code == 422
    assert malformed.json() == {"detail": {"code": "invalid-request"}}
    assert malformed_secret not in malformed.text
    assert expired.status_code == 410
    assert expired.json() == {"detail": {"code": "evidence-expired"}}
    opened = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/open",
        headers=headers,
        json={"schema_version": 1},
    )
    assert opened.json()["events"] == []


@pytest.mark.anyio
async def test_append_reauthorizes_receipt_projects_after_access_revocation(
    client,
    seeded_database,
    alice,
    bob,
    alice_project,
    alice_private_xagent_session,
    monkeypatch,
) -> None:
    async def fake_embed(_self, texts):
        return [[1.0] + [0.0] * 1023 for _ in texts]

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", fake_embed)
    await _seed_search_chunk(seeded_database, alice.id, alice_project.id)
    token = await _login(client, seeded_database, alice)
    headers = {
        "Authorization": f"Bearer {token}",
        "X-XAgent-Service-Token": SERVICE_TOKEN,
    }
    tool_call_id = "append-revoked"
    search = await client.post(
        "/internal/xagent/retrieval/search",
        headers={
            **headers,
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=alice_private_xagent_session.id,
                tool_call_id=tool_call_id,
            ),
        },
        json={
            "schema_version": 1,
            "session_id": str(alice_private_xagent_session.id),
            "tool_call_id": tool_call_id,
            "permission_revision": 1,
            "query": "预算",
            "project_ids": [str(alice_project.id)],
            "include_private": False,
        },
    )
    assert search.status_code == 200
    body = search.json()
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text("UPDATE projects SET owner_id = :owner_id WHERE id = :project_id"),
                {"owner_id": bob.id, "project_id": alice_project.id},
            )

    denied = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append",
        headers=headers,
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": "append-revoked-1",
            "events": [_tool_result(0, tool_call_id, body)],
            "retrieval_receipts": [{
                "event_sequence": 0,
                "tool_call_id": tool_call_id,
                "receipt": body["receipt"],
                "payload_hash": body["payload_sha256"],
            }],
        },
    )

    assert denied.status_code == 404
    assert denied.json() == {"detail": {"code": "session-not-found"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        receipt = await session.get(
            XAgentRetrievalReceipt,
            receipt_digest_id(body["receipt"]),
        )
        event_count = await session.scalar(
            text(
                "SELECT count(*) FROM xagent_session_events "
                "WHERE session_id = :session_id"
            ),
            {"session_id": alice_private_xagent_session.id},
        )
        project_ref = await session.get(
            XAgentSessionProjectRef,
            (alice_private_xagent_session.id, alice_project.id),
        )
    assert receipt is not None and receipt.consumed_at is None
    assert event_count == 0
    assert project_ref is None
