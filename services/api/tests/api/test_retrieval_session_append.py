import asyncio
import hashlib
import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
import pytest
from argon2 import PasswordHasher
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditEvent
from app.models.retrieval import XAgentRetrievalReceipt
from app.models.workbench import XAgentSessionProjectRef
from app.services.retrieval import payload_sha256
from app.services.xagent_sessions import _retrieval_public_payload
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
        json={
            "email": (
                "alice@example.test"
                if account.id.int == 1
                else "bob@example.test"
            ),
            "password": PASSWORD,
        },
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def _delegation_token(
    *,
    actor_id: UUID,
    session_id: UUID,
    tool_call_id: str,
    tool_name: str = "search_artifacts",
    project_id: UUID | None = None,
    permission_revision: int = 1,
) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "iss": "xagent-host",
            "aud": "xagent-api",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(seconds=30)).timestamp()),
            "actor_id": str(actor_id),
            "project_id": str(project_id) if project_id is not None else None,
            "session_id": str(session_id),
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "permission_revision": permission_revision,
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


async def _seed_second_search_chunk(engine) -> None:
    index_id = UUID("00000000-0000-0000-0000-000000000723")
    chunk_id = UUID("00000000-0000-0000-0000-000000000725")
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "UPDATE artifact_text_indexes SET chunk_count = 2 WHERE id = :index_id"
                ),
                {"index_id": index_id},
            )
            await session.execute(
                text(
                    "INSERT INTO artifact_text_chunks "
                    "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                    "VALUES (:id, :index, 1, 2, 3, '第二份资料证据', 3, :sha, CAST(:vector AS vector))"
                ),
                {
                    "id": chunk_id,
                    "index": index_id,
                    "sha": hashlib.sha256("第二份资料证据".encode()).hexdigest(),
                    "vector": "[0,1" + ",0" * 1022 + "]",
                },
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
            "surfaceOp": "append",
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


def _cited_answer_result(
    sequence: int,
    tool_call_id: str,
    citation_ids: list[str],
) -> dict[str, object]:
    blocks = [{"type": "markdown", "text": "结论"}]
    for citation_id in citation_ids:
        blocks.append({"type": "citation", "id": citation_id})
    rendered = "结论" + "".join(
        f"【已验证资料：{citation_id}】" for citation_id in citation_ids
    )
    return {
        "event_type": "tool/result",
        "schema_version": 1,
        "payload": {
            "seq": sequence,
            "time": 1_787_587_200_000 + sequence,
            "type": "tool/result",
            "surfaceOp": "append",
            "data": {
                "turn": 0,
                "step": 1,
                "message": {
                    "id": f"message-{sequence}",
                    "role": "user",
                    "source": {"kind": "tool", "callId": tool_call_id},
                    "content": [{
                        "type": "tool-result",
                        "toolCallId": tool_call_id,
                        "isError": False,
                        "content": [{"type": "text", "text": rendered}],
                    }],
                },
                "meta": {
                    "kind": "xagent-cited-answer",
                    "schemaVersion": 1,
                    "blocks": blocks,
                    "citationIds": citation_ids,
                },
            },
        },
    }


def _compaction_checkpoint(
    sequence: int,
    *,
    start: int,
    end: int,
) -> dict[str, object]:
    return {
        "event_type": "user/message",
        "schema_version": 1,
        "payload": {
            "seq": sequence,
            "time": 1_787_587_200_000 + sequence,
            "type": "user/message",
            "surfaceOp": {"op": "replace", "start": start, "end": end},
            "sourceEventSeqs": list(range(start, end + 1)),
            "data": {
                "id": f"message-{sequence}",
                "role": "user",
                "source": {
                    "kind": "plugin",
                    "plugin": "compact",
                    "compactionId": "citation-compaction",
                },
                "content": [{"type": "text", "text": "Earlier evidence and answer."}],
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
            "surfaceOp": "append",
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


def test_receipt_admission_preserves_session_surface_provenance() -> None:
    projects = [{
        "project_id": "00000000-0000-0000-0000-000000000701",
        "name": "Alpha",
    }]
    event = _project_result(16, "project-list", {
        "projects": projects,
        "payload_sha256": payload_sha256({"schema_version": 1, "projects": projects}),
    })
    event["payload"]["surfaceOp"] = "append"
    event["payload"]["sourceEventSeqs"] = [15]

    _, _, _, canonical = _retrieval_public_payload(
        event,
        sequence=16,
        receipt_kind="project_discovery",
    )

    assert canonical["surfaceOp"] == "append"
    assert canonical["sourceEventSeqs"] == [15]


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
    answered = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append",
        headers=headers,
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "append-cited-answer-1",
            "events": [_cited_answer_result(
                1,
                "submit-cited-answer",
                [search_body["citations"][0]["id"]],
            )],
        },
    )
    compacted = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append",
        headers=headers,
        json={
            "schema_version": 1,
            "expected_sequence": 1,
            "idempotency_key": "append-citation-compaction-1",
            "events": [_compaction_checkpoint(2, start=0, end=1)],
        },
    )
    reopened_after_compaction = await client.post(
        "/internal/xagent/retrieval/citations/resolve",
        headers={
            **headers,
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=alice_private_xagent_session.id,
                tool_call_id="resolve-after-compaction",
                tool_name="resolve_citation",
            ),
        },
        json={
            "schema_version": 1,
            "session_id": str(alice_private_xagent_session.id),
            "tool_call_id": "resolve-after-compaction",
            "permission_revision": 1,
            "citation_id": search_body["citations"][0]["id"],
        },
    )
    forked = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/fork",
        headers=headers,
        json={
            "schema_version": 1,
            "through_sequence": 2,
            "title": "cited answer fork",
            "idempotency_key": "fork-cited-answer-1",
        },
    )
    fork_id = UUID(forked.json()["session"]["id"])
    reopened_fork = await client.post(
        "/internal/xagent/retrieval/citations/resolve",
        headers={
            **headers,
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=fork_id,
                tool_call_id="resolve-cited-answer-fork",
                tool_name="resolve_citation",
            ),
        },
        json={
            "schema_version": 1,
            "session_id": str(fork_id),
            "tool_call_id": "resolve-cited-answer-fork",
            "permission_revision": 1,
            "citation_id": search_body["citations"][0]["id"],
        },
    )
    invented = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append",
        headers=headers,
        json={
            "schema_version": 1,
            "expected_sequence": 2,
            "idempotency_key": "append-invented-citation-1",
            "events": [_cited_answer_result(
                2,
                "submit-invented-cited-answer",
                ["[资料999]"],
            )],
        },
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
    assert answered.status_code == 200
    assert compacted.status_code == 200
    assert reopened_after_compaction.status_code == 200
    assert (
        reopened_after_compaction.json()["version_id"]
        == search_body["citations"][0]["version_id"]
    )
    assert forked.status_code == 201
    assert reopened_fork.status_code == 200
    assert reopened_fork.json()["version_id"] == search_body["citations"][0]["version_id"]
    assert invented.status_code == 409
    assert invented.json() == {"detail": {"code": "evidence-conflict"}}
    persisted_event = opened.json()["events"][0]
    persisted_meta = persisted_event["payload"]["data"]["meta"]
    assert persisted_event["payload"] != event["payload"]
    assert set(persisted_meta) == {
        "kind", "tool", "payloadHash", "scopeHash", "queryHash", "citations", "evidence",
    }
    assert persisted_meta == {
        "kind": "xagent-retrieval",
        "tool": "artifact_search",
        "payloadHash": search_body["payload_sha256"],
        "scopeHash": persisted_meta["scopeHash"],
        "queryHash": hashlib.sha256("预算".encode()).hexdigest(),
        "citations": [search_body["citations"][0]["id"]],
        "evidence": [{
            "citationId": search_body["citations"][0]["id"],
            "artifactId": search_body["citations"][0]["artifact_id"],
            "versionId": search_body["citations"][0]["version_id"],
            "chunkId": search_body["citations"][0]["chunk_id"],
            "indexId": "00000000-0000-0000-0000-000000000723",
            "generation": 1,
        }],
    }
    assert len(persisted_meta["scopeHash"]) == 64
    assert persisted_event["audit_id"] is not None
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
        admission_audit = await session.scalar(
            select(AuditEvent).where(
                AuditEvent.id == UUID(persisted_event["audit_id"]),
                AuditEvent.action == "retrieval.evidence_admission",
            )
        )
        provenance = (
            await session.execute(
                text(
                    "SELECT session_id, citation_id, answer_event_sequence, "
                    "admission_event_sequence, artifact_id, version_id, index_id, "
                    "index_generation, chunk_id "
                    "FROM xagent_cited_answer_evidence "
                    "WHERE session_id IN (:source_id, :fork_id) ORDER BY session_id"
                ),
                {
                    "source_id": alice_private_xagent_session.id,
                    "fork_id": fork_id,
                },
            )
        ).all()
    assert receipt is not None
    assert receipt.consumed_event_sequence == 0
    assert receipt.consumed_payload_sha256 == search_body["payload_sha256"]
    assert project_ref is not None
    assert audit_leaks == 0
    assert admission_audit is not None
    assert admission_audit.result == "allowed"
    assert admission_audit.resource_id == alice_private_xagent_session.id
    assert admission_audit.details["tool_call_id"] == tool_call_id
    assert admission_audit.details["query_sha256"] == hashlib.sha256("预算".encode()).hexdigest()
    assert admission_audit.details["project_scope_sha256"] == persisted_meta["scopeHash"]
    assert len(provenance) == 2
    assert {row.session_id for row in provenance} == {
        alice_private_xagent_session.id,
        fork_id,
    }
    assert all(
        (
            row.citation_id,
            row.answer_event_sequence,
            row.admission_event_sequence,
            row.artifact_id,
            row.version_id,
            row.index_id,
            row.index_generation,
            row.chunk_id,
        )
        == (
            search_body["citations"][0]["id"],
            1,
            0,
            UUID(search_body["citations"][0]["artifact_id"]),
            UUID(search_body["citations"][0]["version_id"]),
            UUID("00000000-0000-0000-0000-000000000723"),
            1,
            UUID(search_body["citations"][0]["chunk_id"]),
        )
        for row in provenance
    )
    serialized_audit = json.dumps(admission_audit.details)
    assert search_body["receipt"] not in serialized_audit
    assert "项目预算" not in serialized_audit


@pytest.mark.anyio
async def test_project_member_reopens_admitted_citation_and_revocation_closes_access(
    client,
    seeded_database,
    alice,
    bob,
    shared_xagent_session,
    monkeypatch,
) -> None:
    async def fake_embed(_self, texts):
        return [[1.0] + [0.0] * 1023 for _ in texts]

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", fake_embed)
    assert shared_xagent_session.project_id is not None
    await _seed_search_chunk(
        seeded_database,
        bob.id,
        shared_xagent_session.project_id,
    )
    bob_token = await _login(client, seeded_database, bob)
    bob_headers = {
        "Authorization": f"Bearer {bob_token}",
        "X-XAgent-Service-Token": SERVICE_TOKEN,
    }
    search_call_id = "shared-search"
    search = await client.post(
        "/internal/xagent/retrieval/search",
        headers={
            **bob_headers,
            "X-XAgent-Delegation": _delegation_token(
                actor_id=bob.id,
                session_id=shared_xagent_session.id,
                project_id=shared_xagent_session.project_id,
                tool_call_id=search_call_id,
            ),
        },
        json={
            "schema_version": 1,
            "session_id": str(shared_xagent_session.id),
            "tool_call_id": search_call_id,
            "permission_revision": 1,
            "query": "预算",
        },
    )
    assert search.status_code == 200, search.text
    search_body = search.json()
    citation_id = search_body["citations"][0]["id"]
    admitted = await client.post(
        f"/internal/xagent/sessions/{shared_xagent_session.id}/append",
        headers=bob_headers,
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": "append-shared-search-1",
            "events": [_tool_result(0, search_call_id, search_body)],
            "retrieval_receipts": [{
                "event_sequence": 0,
                "tool_call_id": search_call_id,
                "receipt": search_body["receipt"],
                "payload_hash": search_body["payload_sha256"],
            }],
        },
    )
    answered = await client.post(
        f"/internal/xagent/sessions/{shared_xagent_session.id}/append",
        headers=bob_headers,
        json={
            "schema_version": 1,
            "expected_sequence": 0,
            "idempotency_key": "append-shared-answer-1",
            "events": [_cited_answer_result(
                1,
                "submit-shared-cited-answer",
                [citation_id],
            )],
        },
    )
    assert admitted.status_code == 200, admitted.text
    assert answered.status_code == 200, answered.text

    alice_token = await _login(client, seeded_database, alice)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        alice_revision = await session.scalar(
            text(
                "SELECT revision FROM xagent_permission_revisions "
                "WHERE account_id = :actor"
            ),
            {"actor": alice.id},
        )
        alice_receipts = await session.scalar(
            text(
                "SELECT count(*) FROM xagent_retrieval_receipts "
                "WHERE actor_id = :actor"
            ),
            {"actor": alice.id},
        )
    assert isinstance(alice_revision, int)
    assert alice_receipts == 0

    async def resolve(
        tool_call_id: str,
        permission_revision: int,
        token: str,
    ):
        return await client.post(
            "/internal/xagent/retrieval/citations/resolve",
            headers={
                "Authorization": f"Bearer {token}",
                "X-XAgent-Service-Token": SERVICE_TOKEN,
                "X-XAgent-Delegation": _delegation_token(
                    actor_id=alice.id,
                    session_id=shared_xagent_session.id,
                    project_id=shared_xagent_session.project_id,
                    tool_call_id=tool_call_id,
                    tool_name="resolve_citation",
                    permission_revision=permission_revision,
                ),
            },
            json={
                "schema_version": 1,
                "session_id": str(shared_xagent_session.id),
                "tool_call_id": tool_call_id,
                "permission_revision": permission_revision,
                "citation_id": citation_id,
            },
        )

    reopened = await resolve("resolve-shared", alice_revision, alice_token)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "DELETE FROM project_memberships "
                    "WHERE project_id = :project AND account_id = :actor"
                ),
                {
                    "project": shared_xagent_session.project_id,
                    "actor": alice.id,
                },
            )
        current_revision = await session.scalar(
            text(
                "SELECT revision FROM xagent_permission_revisions "
                "WHERE account_id = :actor"
            ),
            {"actor": alice.id},
        )
    assert isinstance(current_revision, int)
    stale = await resolve("resolve-shared-stale", current_revision, alice_token)
    refreshed_login = await client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.test", "password": PASSWORD},
    )
    assert refreshed_login.status_code == 200
    revoked = await resolve(
        "resolve-shared-revoked",
        current_revision,
        refreshed_login.json()["access_token"],
    )

    assert reopened.status_code == 200
    assert reopened.json()["version_id"] == search_body["citations"][0]["version_id"]
    assert stale.status_code == 401
    assert stale.json() == {"detail": {"code": "unauthenticated"}}
    assert revoked.status_code == 503
    assert revoked.json() == {"detail": {"code": "service-unavailable"}}


@pytest.mark.anyio
async def test_append_resolves_persisted_evidence_by_citation_chunk_order(
    client,
    seeded_database,
    alice,
    alice_project,
    alice_private_xagent_session,
    monkeypatch,
) -> None:
    async def fake_embed(_self, texts):
        return [[0.0, 1.0] + [0.0] * 1022 for _ in texts]

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", fake_embed)
    await _seed_search_chunk(seeded_database, alice.id, alice_project.id)
    await _seed_second_search_chunk(seeded_database)
    token = await _login(client, seeded_database, alice)
    headers = {"Authorization": f"Bearer {token}", "X-XAgent-Service-Token": SERVICE_TOKEN}
    tool_call_id = "append-search-citation-order"
    search_response = await client.post(
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
            "query": "检索",
            "project_ids": [str(alice_project.id)],
            "include_private": False,
        },
    )
    assert search_response.status_code == 200
    search = search_response.json()
    assert search["citations"] == [
        {
            "id": "[资料1]",
            "artifact_id": "00000000-0000-0000-0000-000000000721",
            "version_id": "00000000-0000-0000-0000-000000000722",
            "chunk_id": "00000000-0000-0000-0000-000000000725",
            "display_name": "预算.txt",
            "version_number": 1,
            "line_start": 2,
            "line_end": 3,
            "text": "第二份资料证据",
            "scope": "project",
        },
        {
            "id": "[资料2]",
            "artifact_id": "00000000-0000-0000-0000-000000000721",
            "version_id": "00000000-0000-0000-0000-000000000722",
            "chunk_id": "00000000-0000-0000-0000-000000000724",
            "display_name": "预算.txt",
            "version_number": 1,
            "line_start": 1,
            "line_end": 1,
            "text": "项目预算",
            "scope": "project",
        },
    ]
    event = _tool_result(0, tool_call_id, search)
    request = {
        "schema_version": 1,
        "expected_sequence": -1,
        "idempotency_key": "append-search-citation-order-1",
        "events": [event],
        "retrieval_receipts": [{
            "event_sequence": 0,
            "tool_call_id": tool_call_id,
            "receipt": search["receipt"],
            "payload_hash": search["payload_sha256"],
        }],
    }
    endpoint = f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append"

    appended = await client.post(endpoint, headers=headers, json=request)
    replay = await client.post(endpoint, headers=headers, json=request)
    opened = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/open",
        headers=headers,
        json={"schema_version": 1},
    )

    assert appended.status_code == replay.status_code == opened.status_code == 200
    assert appended.json() == replay.json()
    persisted_event = opened.json()["events"][0]
    persisted = persisted_event["payload"]
    persisted_public = json.loads(
        persisted["data"]["message"]["content"][0]["content"][0]["text"]
    )
    assert persisted_public == {"citations": search["citations"]}
    persisted_meta = persisted["data"]["meta"]
    assert persisted_meta["payloadHash"] == search["payload_sha256"]
    assert persisted_meta["citations"] == ["[资料1]", "[资料2]"]
    assert persisted_event["audit_id"] is not None
    assert persisted_meta["evidence"] == [
        {
            "citationId": "[资料1]",
            "artifactId": "00000000-0000-0000-0000-000000000721",
            "versionId": "00000000-0000-0000-0000-000000000722",
            "chunkId": "00000000-0000-0000-0000-000000000725",
            "indexId": "00000000-0000-0000-0000-000000000723",
            "generation": 1,
        },
        {
            "citationId": "[资料2]",
            "artifactId": "00000000-0000-0000-0000-000000000721",
            "versionId": "00000000-0000-0000-0000-000000000722",
            "chunkId": "00000000-0000-0000-0000-000000000724",
            "indexId": "00000000-0000-0000-0000-000000000723",
            "generation": 1,
        },
    ]
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        admission_audit = await session.get(AuditEvent, UUID(persisted_event["audit_id"]))
        receipt = await session.get(
            XAgentRetrievalReceipt,
            receipt_digest_id(search["receipt"]),
        )
    assert admission_audit is not None and admission_audit.result == "allowed"
    assert receipt is not None and receipt.consumed_event_sequence == 0


@pytest.mark.anyio
async def test_append_records_redacted_admission_infrastructure_failure(
    client,
    seeded_database,
    alice,
    alice_project,
    alice_private_xagent_session,
    monkeypatch,
) -> None:
    async def fake_embed(_self, texts):
        return [[1.0] + [0.0] * 1023 for _ in texts]

    async def fail_candidate_validation(*_args, **_kwargs):
        raise RuntimeError("candidate store unavailable")

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", fake_embed)
    await _seed_search_chunk(seeded_database, alice.id, alice_project.id)
    token = await _login(client, seeded_database, alice)
    headers = {"Authorization": f"Bearer {token}", "X-XAgent-Service-Token": SERVICE_TOKEN}
    tool_call_id = "append-infrastructure-failure"
    search_response = await client.post(
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
    assert search_response.status_code == 200
    search = search_response.json()
    monkeypatch.setattr(
        "app.services.xagent_sessions._validate_artifact_search",
        fail_candidate_validation,
    )

    failed = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append",
        headers=headers,
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": "append-infrastructure-failure-1",
            "events": [_tool_result(0, tool_call_id, search)],
            "retrieval_receipts": [{
                "event_sequence": 0,
                "tool_call_id": tool_call_id,
                "receipt": search["receipt"],
                "payload_hash": search["payload_sha256"],
            }],
        },
    )

    assert failed.status_code == 503
    assert failed.json() == {"detail": {"code": "service-unavailable"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        receipt = await session.get(
            XAgentRetrievalReceipt,
            receipt_digest_id(search["receipt"]),
        )
        event_count = await session.scalar(
            text("SELECT count(*) FROM xagent_session_events WHERE session_id = :session_id"),
            {"session_id": alice_private_xagent_session.id},
        )
        project_ref = await session.get(
            XAgentSessionProjectRef,
            (alice_private_xagent_session.id, alice_project.id),
        )
        admission_audits = list((await session.scalars(
            select(AuditEvent).where(
                AuditEvent.action == "retrieval.evidence_admission",
                AuditEvent.resource_id == alice_private_xagent_session.id,
            )
        )).all())
    assert receipt is not None and receipt.consumed_at is None
    assert event_count == 0
    assert project_ref is None
    assert [audit.result for audit in admission_audits] == ["service-unavailable"]
    serialized_audit = json.dumps(admission_audits[0].details)
    assert search["receipt"] not in serialized_audit
    assert "项目预算" not in serialized_audit


@pytest.mark.anyio
async def test_append_rejects_every_open_or_extra_retrieval_event_field(
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
    tool_call_id = "append-closed-event"
    response = await client.post(
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
    assert response.status_code == 200
    search = response.json()
    canonical = _tool_result(0, tool_call_id, search)
    variants: list[dict[str, object]] = []

    second_item = deepcopy(canonical)
    second_item["payload"]["data"]["message"]["content"].append({
        "type": "text", "text": f"secret:{search['receipt']}"
    })
    variants.append(second_item)
    secret_message_id = deepcopy(canonical)
    secret_message_id["payload"]["data"]["message"]["id"] = search["receipt"]
    variants.append(secret_message_id)
    for path in (
        ("payload",),
        ("payload", "data"),
        ("payload", "data", "message"),
        ("payload", "data", "message", "content", 0),
        ("payload", "data", "message", "content", 0, "content", 0),
    ):
        extra = deepcopy(canonical)
        value: object = extra
        for key in path:
            value = value[key]
        value["receipt"] = search["receipt"]
        variants.append(extra)
    missing = deepcopy(canonical)
    del missing["payload"]["data"]["message"]["id"]
    variants.append(missing)
    null_source_provenance = deepcopy(canonical)
    null_source_provenance["payload"]["sourceEventSeqs"] = None
    variants.append(null_source_provenance)

    endpoint = f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append"
    for index, event in enumerate(variants):
        denied = await client.post(
            endpoint,
            headers=headers,
            json={
                "schema_version": 1,
                "expected_sequence": -1,
                "idempotency_key": f"closed-event-{index}",
                "events": [event],
                "retrieval_receipts": [{
                    "event_sequence": 0,
                    "tool_call_id": tool_call_id,
                    "receipt": search["receipt"],
                    "payload_hash": search["payload_sha256"],
                }],
            },
        )
        assert denied.status_code == 409
        assert denied.json() == {"detail": {"code": "evidence-conflict"}}
        assert search["receipt"] not in denied.text

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        receipt = await session.get(
            XAgentRetrievalReceipt,
            receipt_digest_id(search["receipt"]),
        )
        event_count = await session.scalar(
            text("SELECT count(*) FROM xagent_session_events WHERE session_id = :session_id"),
            {"session_id": alice_private_xagent_session.id},
        )
    assert receipt is not None and receipt.consumed_at is None
    assert event_count == 0


@pytest.mark.anyio
async def test_admission_audit_failure_rolls_back_event_ref_and_receipt(
    client,
    seeded_database,
    alice,
    alice_project,
    alice_private_xagent_session,
    monkeypatch,
) -> None:
    async def fake_embed(_self, texts):
        return [[1.0] + [0.0] * 1023 for _ in texts]

    async def reject_audit(*_args, **_kwargs):
        raise RuntimeError("audit unavailable")

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", fake_embed)
    await _seed_search_chunk(seeded_database, alice.id, alice_project.id)
    token = await _login(client, seeded_database, alice)
    headers = {"Authorization": f"Bearer {token}", "X-XAgent-Service-Token": SERVICE_TOKEN}
    tool_call_id = "append-audit-failure"
    search_response = await client.post(
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
    assert search_response.status_code == 200
    search = search_response.json()
    monkeypatch.setattr("app.services.xagent_sessions.write_audit_event", reject_audit)
    failed = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append",
        headers=headers,
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": "append-audit-failure-1",
            "events": [_tool_result(0, tool_call_id, search)],
            "retrieval_receipts": [{
                "event_sequence": 0,
                "tool_call_id": tool_call_id,
                "receipt": search["receipt"],
                "payload_hash": search["payload_sha256"],
            }],
        },
    )

    assert failed.status_code == 503
    assert failed.json() == {"detail": {"code": "service-unavailable"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        receipt = await session.get(
            XAgentRetrievalReceipt,
            receipt_digest_id(search["receipt"]),
        )
        event_count = await session.scalar(
            text("SELECT count(*) FROM xagent_session_events WHERE session_id = :session_id"),
            {"session_id": alice_private_xagent_session.id},
        )
        project_ref = await session.get(
            XAgentSessionProjectRef,
            (alice_private_xagent_session.id, alice_project.id),
        )
        admission_count = await session.scalar(
            select(text("count(*)")).select_from(AuditEvent).where(
                AuditEvent.action == "retrieval.evidence_admission",
                AuditEvent.resource_id == alice_private_xagent_session.id,
            )
        )
    assert receipt is not None and receipt.consumed_at is None
    assert event_count == 0
    assert project_ref is None
    assert admission_count == 0


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
    replay = await client.post(
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
    opened = await client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/open",
        headers=headers,
        json={"schema_version": 1},
    )

    assert appended.status_code == 200
    assert replay.status_code == 200
    assert replay.json() == appended.json()
    stored = opened.json()["events"][0]
    assert stored["payload"]["data"]["meta"] == {
        "kind": "xagent-retrieval",
        "tool": "project_discovery",
        "payloadHash": discovery["payload_sha256"],
        "scopeHash": hashlib.sha256(b"private-project-discovery").hexdigest(),
        "queryHash": hashlib.sha256(b"").hexdigest(),
        "citations": [],
        "evidence": [],
    }
    assert stored["audit_id"] is not None
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


@pytest.mark.anyio
async def test_append_serializes_permission_revocation_before_receipt_admission(
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
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text("UPDATE projects SET owner_id = :owner WHERE id = :project"),
                {"owner": bob.id, "project": alice_project.id},
            )
            await session.execute(
                text(
                    "INSERT INTO project_memberships (id, project_id, account_id) "
                    "VALUES (:id, :project, :actor)"
                ),
                {
                    "id": UUID("00000000-0000-0000-0000-000000000725"),
                    "project": alice_project.id,
                    "actor": alice.id,
                },
            )
        revision = await session.scalar(
            text("SELECT revision FROM xagent_permission_revisions WHERE account_id = :actor"),
            {"actor": alice.id},
        )
    assert isinstance(revision, int) and revision > 1
    await _seed_search_chunk(seeded_database, alice.id, alice_project.id)
    token = await _login(client, seeded_database, alice)
    headers = {"Authorization": f"Bearer {token}", "X-XAgent-Service-Token": SERVICE_TOKEN}
    tool_call_id = "append-coordinated-revocation"
    search_response = await client.post(
        "/internal/xagent/retrieval/search",
        headers={
            **headers,
            "X-XAgent-Delegation": _delegation_token(
                actor_id=alice.id,
                session_id=alice_private_xagent_session.id,
                tool_call_id=tool_call_id,
                permission_revision=revision,
            ),
        },
        json={
            "schema_version": 1,
            "session_id": str(alice_private_xagent_session.id),
            "tool_call_id": tool_call_id,
            "permission_revision": revision,
            "query": "预算",
            "project_ids": [str(alice_project.id)],
            "include_private": False,
        },
    )
    assert search_response.status_code == 200
    search = search_response.json()
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(XAgentSessionProjectRef(
                session_id=alice_private_xagent_session.id,
                project_id=alice_project.id,
            ))

    revocation = AsyncSession(seeded_database, expire_on_commit=False)
    await revocation.begin()
    await revocation.execute(
        text(
            "DELETE FROM project_memberships "
            "WHERE project_id = :project AND account_id = :actor"
        ),
        {"project": alice_project.id, "actor": alice.id},
    )
    append_task = asyncio.create_task(client.post(
        f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append",
        headers=headers,
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": "append-coordinated-revocation-1",
            "events": [_tool_result(0, tool_call_id, search)],
            "retrieval_receipts": [{
                "event_sequence": 0,
                "tool_call_id": tool_call_id,
                "receipt": search["receipt"],
                "payload_hash": search["payload_sha256"],
            }],
        },
    ))
    await asyncio.sleep(0.1)
    assert not append_task.done()
    await revocation.commit()
    await revocation.close()
    denied = await append_task

    assert denied.status_code == 404
    assert denied.json() == {"detail": {"code": "session-not-found"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        receipt = await session.get(
            XAgentRetrievalReceipt,
            receipt_digest_id(search["receipt"]),
        )
        event_count = await session.scalar(
            text("SELECT count(*) FROM xagent_session_events WHERE session_id = :session_id"),
            {"session_id": alice_private_xagent_session.id},
        )
        refs = await session.scalar(
            text("SELECT count(*) FROM xagent_session_project_refs WHERE session_id = :session_id"),
            {"session_id": alice_private_xagent_session.id},
        )
        admission_audits = list((await session.scalars(
            select(AuditEvent).where(
                AuditEvent.action == "retrieval.evidence_admission",
                AuditEvent.resource_id == alice_private_xagent_session.id,
            )
        )).all())
    assert receipt is not None and receipt.consumed_at is None
    assert event_count == 0
    assert refs == 1
    assert [audit.result for audit in admission_audits] == ["session-not-found"]
    assert all(search["receipt"] not in json.dumps(audit.details) for audit in admission_audits)
