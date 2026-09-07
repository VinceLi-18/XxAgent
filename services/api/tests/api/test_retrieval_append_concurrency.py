import asyncio

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.retrieval import XAgentRetrievalReceipt
from app.services.retrieval_receipts import receipt_digest_id
from test_retrieval_session_append import (
    SERVICE_TOKEN,
    _delegation_token,
    _login,
    _seed_search_chunk,
    _tool_result,
)


@pytest.mark.anyio
async def test_concurrent_receipts_keep_preallocated_ordinals_and_unconsumed_gaps(
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
    first_token = await _login(client, seeded_database, alice)
    second_login = await client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.test", "password": "correct horse battery staple"},
    )
    assert second_login.status_code == 200
    second_token = second_login.json()["access_token"]
    headers = {
        "Authorization": f"Bearer {first_token}",
        "X-XAgent-Service-Token": SERVICE_TOKEN,
    }

    async def search(tool_call_id: str, user_token: str = first_token):
        return await client.post(
            "/internal/xagent/retrieval/search",
            headers={
                **headers,
                "Authorization": f"Bearer {user_token}",
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

    first_response = await search("concurrent-a", first_token)
    second_response = await search("concurrent-b", second_token)
    assert first_response.status_code == second_response.status_code == 200
    first_search = first_response.json()
    second_search = second_response.json()
    assert first_search["citations"][0]["id"] == "[资料1]"
    assert second_search["citations"][0]["id"] == "[资料2]"

    first_append = {
        "schema_version": 1,
        "expected_sequence": -1,
        "idempotency_key": "append-concurrent-first",
        "events": [_tool_result(0, "concurrent-a", first_search)],
        "retrieval_receipts": [{
            "event_sequence": 0,
            "tool_call_id": "concurrent-a",
            "receipt": first_search["receipt"],
            "payload_hash": first_search["payload_sha256"],
        }],
    }
    second_append = {
        "schema_version": 1,
        "expected_sequence": 0,
        "idempotency_key": "append-concurrent-second",
        "events": [_tool_result(1, "concurrent-b", second_search)],
        "retrieval_receipts": [{
            "event_sequence": 1,
            "tool_call_id": "concurrent-b",
            "receipt": second_search["receipt"],
            "payload_hash": second_search["payload_sha256"],
        }],
    }
    endpoint = f"/internal/xagent/sessions/{alice_private_xagent_session.id}/append"

    async def append(body, user_token):
        return await client.post(
            endpoint,
            headers={**headers, "Authorization": f"Bearer {user_token}"},
            json=body,
        )

    first_append_response, second_append_response = await asyncio.gather(
        append(first_append, first_token),
        append(second_append, second_token),
    )
    if second_append_response.status_code == 409:
        second_append_response = await append(second_append, second_token)
    assert first_append_response.status_code == second_append_response.status_code == 200

    unconsumed_response = await search("concurrent-c")
    third_response = await search("concurrent-d")

    assert unconsumed_response.status_code == third_response.status_code == 200
    assert unconsumed_response.json()["citations"][0]["id"] == "[资料3]"
    assert third_response.json()["citations"][0]["id"] == "[资料4]"
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        first_receipt = await session.get(
            XAgentRetrievalReceipt,
            receipt_digest_id(first_search["receipt"]),
        )
        second_receipt = await session.get(
            XAgentRetrievalReceipt,
            receipt_digest_id(second_search["receipt"]),
        )
        unconsumed_receipt = await session.get(
            XAgentRetrievalReceipt,
            receipt_digest_id(unconsumed_response.json()["receipt"]),
        )
        next_ordinal = await session.scalar(
            text(
                "SELECT next_citation_ordinal FROM xagent_sessions "
                "WHERE id = :session_id"
            ),
            {"session_id": alice_private_xagent_session.id},
        )
    assert first_receipt is not None and first_receipt.consumed_event_sequence == 0
    assert second_receipt is not None and second_receipt.consumed_event_sequence == 1
    assert unconsumed_receipt is not None and unconsumed_receipt.consumed_at is None
    assert next_ordinal == 5
