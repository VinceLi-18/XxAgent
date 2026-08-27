from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
import pytest
from argon2 import PasswordHasher
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.internal_retrieval import MAX_RETRIEVAL_BODY_BYTES, projects_route, search_route
from app.api.routes.internal_sessions import SessionContext
from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.audit import AuditEvent
from app.models.identity import Role
from app.models.retrieval import XAgentRetrievalReceipt
from app.models.xagent_session import XAgentSession
from app.schemas.retrieval import ProjectDiscoveryRequest, SearchRequest, SearchResponse
from app.services.auth import Principal
from app.services.retrieval import RetrievalCandidate
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


@pytest.mark.anyio
async def test_retrieval_routes_require_service_and_user_identity(client) -> None:
    without_service = await client.post(
        "/internal/xagent/retrieval/projects",
        json={"schema_version": 1, "session_id": "00000000-0000-0000-0000-000000000110", "tool_call_id": "call", "query": None},
    )
    without_user = await client.post(
        "/internal/xagent/retrieval/projects",
        headers={"X-XAgent-Service-Token": SERVICE_TOKEN},
        json={"schema_version": 1, "session_id": "00000000-0000-0000-0000-000000000110", "tool_call_id": "call", "query": None},
    )

    assert without_service.status_code == 403
    assert without_user.status_code == 401


@pytest.mark.anyio
async def test_retrieval_wire_maps_unknown_fields_to_closed_protocol_error(
    client,
    seeded_database,
    alice,
) -> None:
    token = await _login(client, seeded_database, alice)
    response = await client.post(
        "/internal/xagent/retrieval/search",
        headers={
            "X-XAgent-Service-Token": SERVICE_TOKEN,
            "Authorization": f"Bearer {token}",
        },
        json={
            "schema_version": 1,
            "session_id": "00000000-0000-0000-0000-000000000110",
            "tool_call_id": "call",
            "permission_revision": 1,
            "query": "budget",
            "include_private": True,
            "unknown": "field",
        },
    )

    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "service-unavailable"}}
    assert "unknown" not in response.text


@pytest.mark.anyio
async def test_retrieval_body_cap_rejects_declared_oversize_before_parsing(client) -> None:
    response = await client.post(
        "/internal/xagent/retrieval/search",
        headers={
            "X-XAgent-Service-Token": SERVICE_TOKEN,
            "Content-Length": str(MAX_RETRIEVAL_BODY_BYTES + 1),
        },
        content=b"{}",
    )

    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "service-unavailable"}}


@pytest.mark.anyio
async def test_retrieval_body_cap_counts_streamed_bytes_when_length_is_absent_or_false(client) -> None:
    async def oversized_stream():
        yield b"{" + (b"x" * MAX_RETRIEVAL_BODY_BYTES)

    response = await client.post(
        "/internal/xagent/retrieval/search",
        headers={
            "X-XAgent-Service-Token": SERVICE_TOKEN,
            "Transfer-Encoding": "chunked",
        },
        content=oversized_stream(),
    )
    misleading = await client.post(
        "/internal/xagent/retrieval/search",
        headers={"X-XAgent-Service-Token": SERVICE_TOKEN, "Content-Length": "2"},
        content=b"{" + ("中" * (MAX_RETRIEVAL_BODY_BYTES // 3)).encode() + b"x",
    )

    assert response.status_code == 503
    assert misleading.status_code == 503
    assert response.json() == misleading.json() == {
        "detail": {"code": "service-unavailable"}
    }


def _delegation_token(
    *, actor_id: UUID, session_id: UUID, tool_call_id: str, nonce: str,
    overrides: dict[str, object] | None = None,
) -> str:
    now = datetime.now(UTC)
    claims = {
        "iss": "xagent-host", "aud": "xagent-api", "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=30)).timestamp()),
        "actor_id": str(actor_id), "project_id": None, "session_id": str(session_id),
        "tool_call_id": tool_call_id, "tool_name": "list_accessible_projects",
        "permission_revision": 1, "nonce": nonce,
    }
    claims.update(overrides or {})
    return jwt.encode(
        claims,
        DELEGATION_PRIVATE_KEY,
        algorithm="EdDSA",
    )


@pytest.mark.anyio
async def test_project_discovery_requires_and_atomically_consumes_delegation(
    client, seeded_database, alice, alice_private_xagent_session
) -> None:
    user_token = await _login(client, seeded_database, alice)
    body = {
        "schema_version": 1, "session_id": str(alice_private_xagent_session.id),
        "tool_call_id": "discover-delegated", "permission_revision": 1,
    }
    base_headers = {
        "X-XAgent-Service-Token": SERVICE_TOKEN,
        "Authorization": f"Bearer {user_token}",
    }
    missing = await client.post(
        "/internal/xagent/retrieval/projects", headers=base_headers, json=body
    )
    delegated = _delegation_token(
        actor_id=alice.id, session_id=alice_private_xagent_session.id,
        tool_call_id="discover-delegated", nonce="http-single-use",
    )
    first = await client.post(
        "/internal/xagent/retrieval/projects",
        headers={**base_headers, "X-XAgent-Delegation": delegated}, json=body,
    )
    replay = await client.post(
        "/internal/xagent/retrieval/projects",
        headers={**base_headers, "X-XAgent-Delegation": delegated}, json=body,
    )

    assert missing.status_code == 503
    assert first.status_code == 200, first.text
    assert replay.status_code == 503
    assert replay.json() == {"detail": {"code": "service-unavailable"}}


@pytest.mark.anyio
async def test_project_discovery_rejects_tampered_expired_or_mismatched_delegation(
    client, seeded_database, alice, alice_private_xagent_session
) -> None:
    user_token = await _login(client, seeded_database, alice)
    body = {
        "schema_version": 1, "session_id": str(alice_private_xagent_session.id),
        "tool_call_id": "claim-check", "permission_revision": 1,
    }
    headers = {
        "X-XAgent-Service-Token": SERVICE_TOKEN,
        "Authorization": f"Bearer {user_token}",
    }
    now = datetime.now(UTC)
    overrides = (
        {"actor_id": str(UUID(int=808))},
        {"session_id": str(UUID(int=809))},
        {"project_id": str(UUID(int=810))},
        {"tool_call_id": "other-call"},
        {"tool_name": "search_artifacts"},
        {"permission_revision": 2},
        {
            "iat": int((now - timedelta(seconds=31)).timestamp()),
            "exp": int((now - timedelta(seconds=1)).timestamp()),
        },
    )
    tokens = [
        _delegation_token(
            actor_id=alice.id, session_id=alice_private_xagent_session.id,
            tool_call_id="claim-check", nonce=f"claim-{index}", overrides=value,
        )
        for index, value in enumerate(overrides)
    ]
    valid = _delegation_token(
        actor_id=alice.id, session_id=alice_private_xagent_session.id,
        tool_call_id="claim-check", nonce="tampered",
    )
    parts = valid.split(".")
    parts[2] = ("A" if parts[2][0] != "A" else "B") + parts[2][1:]
    tokens.append(".".join(parts))

    for token in tokens:
        response = await client.post(
            "/internal/xagent/retrieval/projects",
            headers={**headers, "X-XAgent-Delegation": token}, json=body,
        )
        assert response.status_code == 503
        assert response.json() == {"detail": {"code": "service-unavailable"}}


@pytest.mark.anyio
async def test_search_allocates_monotonic_ordinals_and_discovery_allocates_none(
    actor_session,
    alice,
    alice_private_xagent_session,
    monkeypatch,
) -> None:
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    principal = Principal(
        actor_id=alice.id,
        role=Role.SPECIALIST,
        permission_revision=1,
        auth_session_id=UUID(int=909),
        email="alice@example.test",
    )
    context = SessionContext(principal, actor_session)
    candidate = RetrievalCandidate(
        chunk_id=UUID(int=910), artifact_id=UUID(int=911), version_id=UUID(int=912),
        index_id=UUID(int=913), generation=2, ordinal=0, filename="evidence.txt",
        version_number=1, line_start=1, line_end=2, text="evidence", token_count=2,
        project_id=None,
    )

    async def fake_hybrid_search(*args, **kwargs):
        return [candidate], 1

    async def fake_verify_delegation(*args, **kwargs):
        return None

    monkeypatch.setattr("app.api.routes.internal_retrieval.hybrid_search", fake_hybrid_search)
    monkeypatch.setattr(
        "app.api.routes.internal_retrieval._verify_delegation", fake_verify_delegation
    )
    request = SearchRequest(
        schema_version=1,
        session_id=alice_private_xagent_session.id,
        tool_call_id="call-1",
        permission_revision=1,
        query="budget",
        include_private=True,
    )
    first = await search_route(request, context)
    second = await search_route(request.model_copy(update={"tool_call_id": "call-2"}), context)
    discovery = await projects_route(
        ProjectDiscoveryRequest(
            schema_version=1,
            session_id=alice_private_xagent_session.id,
            tool_call_id="discover-1",
            permission_revision=1,
        ),
        context,
    )

    assert isinstance(first, SearchResponse)
    assert isinstance(second, SearchResponse)
    assert [first.citations[0].id, second.citations[0].id] == ["[资料1]", "[资料2]"]
    assert receipt_digest_id(first.receipt) != receipt_digest_id(second.receipt)
    assert discovery.receipt not in {first.receipt, second.receipt}
    stored_session = await actor_session.scalar(
        select(XAgentSession).where(XAgentSession.id == alice_private_xagent_session.id)
    )
    assert stored_session.next_citation_ordinal == 3
    receipts = (
        await actor_session.scalars(
            select(XAgentRetrievalReceipt).order_by(XAgentRetrievalReceipt.issued_at)
        )
    ).all()
    assert [(item.kind, item.citation_ordinal_start, item.citation_ordinal_end) for item in receipts] == [
        ("artifact_search", 1, 1),
        ("artifact_search", 2, 2),
        ("project_discovery", None, None),
    ]


@pytest.mark.anyio
async def test_search_statement_failure_rolls_back_output_and_persists_redacted_audit(
    seeded_database, actor_session, alice, alice_private_xagent_session, monkeypatch
) -> None:
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    context = SessionContext(
        Principal(
            actor_id=alice.id, role=Role.SPECIALIST, permission_revision=1,
            auth_session_id=UUID(int=991), email="alice@example.test",
        ),
        actor_session,
    )

    async def fake_verify(*args, **kwargs):
        return None

    async def failing_search(session, *args, **kwargs):
        async with session.begin_nested():
            await session.execute(text("SELECT * FROM xagent_missing_retrieval_relation"))

    monkeypatch.setattr("app.api.routes.internal_retrieval._verify_delegation", fake_verify)
    monkeypatch.setattr("app.api.routes.internal_retrieval.hybrid_search", failing_search)
    response = await search_route(
        SearchRequest(
            schema_version=1, session_id=alice_private_xagent_session.id,
            tool_call_id="statement-failure", permission_revision=1,
            query="must-not-appear", include_private=True,
        ),
        context,
    )

    assert response.status_code == 503
    async with AsyncSession(seeded_database, expire_on_commit=False) as verification:
        audit = await verification.scalar(
            select(AuditEvent).where(AuditEvent.action == "retrieval.search")
        )
        stored_session = await verification.get(XAgentSession, alice_private_xagent_session.id)
        receipt_count = await verification.scalar(
            select(func.count()).select_from(XAgentRetrievalReceipt)
        )
    assert audit.result == "retrieval-unavailable"
    assert "must-not-appear" not in str(audit.details)
    assert stored_session.next_citation_ordinal == 1
    assert receipt_count == 0
