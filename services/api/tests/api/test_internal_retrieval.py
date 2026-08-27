import pytest
from argon2 import PasswordHasher
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID

from app.api.routes.internal_retrieval import projects_route, search_route
from app.api.routes.internal_sessions import SessionContext
from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.identity import Role
from app.models.retrieval import XAgentRetrievalReceipt
from app.models.xagent_session import XAgentSession
from app.schemas.retrieval import ProjectDiscoveryRequest, SearchRequest, SearchResponse
from app.services.auth import Principal
from app.services.retrieval import RetrievalCandidate
from app.services.retrieval_receipts import receipt_digest_id


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

    monkeypatch.setattr("app.api.routes.internal_retrieval.hybrid_search", fake_hybrid_search)
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
