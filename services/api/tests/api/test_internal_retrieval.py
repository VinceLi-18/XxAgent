import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
import pytest
from argon2 import PasswordHasher
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.internal_retrieval import (
    MAX_RETRIEVAL_BODY_BYTES,
    authorize_citations_route,
    projects_route,
    resolve_citation_route,
    search_route,
)
from app.api.routes.internal_sessions import SessionContext
from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.audit import AuditEvent
from app.models.identity import Role
from app.models.retrieval import XAgentDelegationNonce, XAgentRetrievalReceipt
from app.models.xagent_session import XAgentSession
from app.schemas.retrieval import (
    CitationAuthorizeRequest,
    CitationResolveRequest,
    ProjectDiscoveryRequest,
    SearchRequest,
    SearchResponse,
)
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
        json={
            "email": "alice@example.test" if account.id.int == 1 else "bob@example.test",
            "password": PASSWORD,
        },
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
    tool_name: str = "list_accessible_projects",
    project_id: UUID | None = None,
    permission_revision: int = 1,
    overrides: dict[str, object] | None = None,
) -> str:
    now = datetime.now(UTC)
    claims = {
        "iss": "xagent-host", "aud": "xagent-api", "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=30)).timestamp()),
        "actor_id": str(actor_id),
        "project_id": str(project_id) if project_id is not None else None,
        "session_id": str(session_id),
        "tool_call_id": tool_call_id, "tool_name": tool_name,
        "permission_revision": permission_revision, "nonce": nonce,
    }
    claims.update(overrides or {})
    return jwt.encode(
        claims,
        DELEGATION_PRIVATE_KEY,
        algorithm="EdDSA",
    )


async def _seed_search_chunk(
    engine,
    *,
    base: int,
    actor_id: UUID,
    filename: str,
    content: str,
    project_id: UUID | None,
) -> tuple[UUID, UUID, UUID]:
    artifact_id, version_id, index_id, chunk_id = (
        UUID(int=base + offset) for offset in range(4)
    )
    artifact_scope = "project_id" if project_id is not None else "owner_id"
    scope_id = project_id or actor_id
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    f"INSERT INTO artifacts (id, filename, {artifact_scope}, created_by_id) "
                    f"VALUES (:id, :filename, :scope_id, :actor)"
                ),
                {
                    "id": artifact_id, "filename": filename,
                    "scope_id": scope_id, "actor": actor_id,
                },
            )
            await session.execute(
                text(
                    f"INSERT INTO artifact_versions "
                    f"(id, artifact_id, {artifact_scope}, version_number, original_filename, "
                    f"uploaded_by_id, declared_size, actual_size, detected_content_type, scan_status, "
                    f"object_key, size, content_type, sha256) VALUES (:id, :artifact, :scope_id, 1, "
                    f":filename, :actor, 1, 1, 'text/plain', 'clean', :key, 1, 'text/plain', :sha)"
                ),
                {
                    "id": version_id, "artifact": artifact_id, "scope_id": scope_id,
                    "filename": filename, "actor": actor_id,
                    "key": f"artifacts/{artifact_id}/{version_id}", "sha": f"{base:064x}",
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
                    "id": index_id, "artifact": artifact_id, "version": version_id,
                    "sha": f"{base + 1:064x}", "fingerprint": f"{base + 2:064x}",
                },
            )
            await session.execute(
                text(
                    "INSERT INTO artifact_text_chunks "
                    "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                    "VALUES (:id, :index, 0, 1, 1, :content, 2, :sha, CAST(:vector AS vector))"
                ),
                {
                    "id": chunk_id, "index": index_id, "content": content,
                    "sha": f"{base + 3:064x}", "vector": "[1" + ",0" * 1023 + "]",
                },
            )
            await session.execute(
                text(
                    "INSERT INTO artifact_search_heads (artifact_id, index_id, version_id) "
                    "VALUES (:artifact, :index, :version)"
                ),
                {"artifact": artifact_id, "index": index_id, "version": version_id},
            )
    return artifact_id, version_id, chunk_id


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
async def test_read_only_project_grant_can_search_through_the_real_http_route(
    client,
    seeded_database,
    alice,
    bob,
    alice_project,
    monkeypatch,
) -> None:
    session_id = UUID(int=860)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO temporary_project_grants "
                    "(id, project_id, account_id, action, granted_by_id, expires_at) "
                    "VALUES (:id, :project, :account, 'read', :grantor, :expires)"
                ),
                {
                    "id": UUID(int=861), "project": alice_project.id,
                    "account": bob.id, "grantor": alice.id,
                    "expires": datetime.now(UTC) + timedelta(hours=1),
                },
            )
            await session.execute(
                text(
                    "INSERT INTO xagent_sessions "
                    "(id, owner_id, project_id, visibility, permission_revision_created, "
                    "title, archived, last_event_sequence, next_citation_ordinal, version) "
                    "VALUES (:id, :owner, :project, 'project', 1, 'read-only route', "
                    "false, -1, 1, 1)"
                ),
                {"id": session_id, "owner": alice.id, "project": alice_project.id},
            )
        revision = await session.scalar(
            text("SELECT revision FROM xagent_permission_revisions WHERE account_id = :actor"),
            {"actor": bob.id},
        )
    user_token = await _login(client, seeded_database, bob)

    async def fake_embed(self, texts):
        return [[0.0] * 1024]

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", fake_embed)
    body = {
        "schema_version": 1, "session_id": str(session_id),
        "tool_call_id": "read-only-search", "permission_revision": revision,
        "query": "no matching evidence",
    }
    delegation = _delegation_token(
        actor_id=bob.id, session_id=session_id, tool_call_id="read-only-search",
        nonce="read-only-project-route", tool_name="search_artifacts",
        project_id=alice_project.id, permission_revision=revision,
    )

    response = await client.post(
        "/internal/xagent/retrieval/search",
        headers={
            "X-XAgent-Service-Token": SERVICE_TOKEN,
            "X-XAgent-Delegation": delegation,
            "Authorization": f"Bearer {user_token}",
        },
        json=body,
    )

    assert response.status_code == 200, response.text
    assert response.json()["citations"] == []
    async with AsyncSession(seeded_database, expire_on_commit=False) as verification:
        ordinal = await verification.scalar(
            select(XAgentSession.next_citation_ordinal).where(XAgentSession.id == session_id)
        )
    assert ordinal == 1


@pytest.mark.anyio
async def test_private_session_http_search_returns_explicit_project_and_private_chunks(
    client,
    seeded_database,
    alice,
    alice_project,
    alice_private_xagent_session,
    monkeypatch,
) -> None:
    project_identity = await _seed_search_chunk(
        seeded_database,
        base=900,
        actor_id=alice.id,
        filename="project-mixed.txt",
        content="mixed project evidence",
        project_id=alice_project.id,
    )
    private_identity = await _seed_search_chunk(
        seeded_database,
        base=910,
        actor_id=alice.id,
        filename="private-mixed.txt",
        content="mixed private evidence",
        project_id=None,
    )
    user_token = await _login(client, seeded_database, alice)

    async def fake_embed(self, texts):
        return [[1.0, *([0.0] * 1023)]]

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", fake_embed)
    tool_call_id = "mixed-project-private-search"
    delegation = _delegation_token(
        actor_id=alice.id,
        session_id=alice_private_xagent_session.id,
        tool_call_id=tool_call_id,
        nonce="mixed-project-private-search",
        tool_name="search_artifacts",
    )

    response = await client.post(
        "/internal/xagent/retrieval/search",
        headers={
            "X-XAgent-Service-Token": SERVICE_TOKEN,
            "X-XAgent-Delegation": delegation,
            "Authorization": f"Bearer {user_token}",
        },
        json={
            "schema_version": 1,
            "session_id": str(alice_private_xagent_session.id),
            "tool_call_id": tool_call_id,
            "permission_revision": 1,
            "query": "mixed evidence",
            "project_ids": [str(alice_project.id)],
            "include_private": True,
        },
    )

    assert response.status_code == 200, response.text
    citations = response.json()["citations"]
    assert {
        (item["artifact_id"], item["version_id"], item["chunk_id"], item["scope"])
        for item in citations
    } == {
        tuple(str(value) for value in project_identity) + ("project",),
        tuple(str(value) for value in private_identity) + ("private",),
    }


@pytest.mark.anyio
async def test_search_route_rejects_jwt_account_switch_from_session_and_delegation_actor(
    client,
    seeded_database,
    alice,
    bob,
    alice_private_xagent_session,
) -> None:
    bob_token = await _login(client, seeded_database, bob)
    tool_call_id = "account-switch-search"
    delegation = _delegation_token(
        actor_id=alice.id,
        session_id=alice_private_xagent_session.id,
        tool_call_id=tool_call_id,
        nonce="account-switch-search",
        tool_name="search_artifacts",
    )

    response = await client.post(
        "/internal/xagent/retrieval/search",
        headers={
            "X-XAgent-Service-Token": SERVICE_TOKEN,
            "X-XAgent-Delegation": delegation,
            "Authorization": f"Bearer {bob_token}",
        },
        json={
            "schema_version": 1,
            "session_id": str(alice_private_xagent_session.id),
            "tool_call_id": tool_call_id,
            "permission_revision": 1,
            "query": "must stay closed",
            "include_private": True,
        },
    )

    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "service-unavailable"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as verification:
        nonce_count = await verification.scalar(
            select(func.count()).select_from(XAgentDelegationNonce)
        )
    assert nonce_count == 0


@pytest.mark.anyio
async def test_search_http_rejects_wrong_delegation_bindings_and_replay(
    client,
    seeded_database,
    alice,
    alice_private_xagent_session,
    monkeypatch,
) -> None:
    user_token = await _login(client, seeded_database, alice)

    async def fake_embed(self, texts):
        return [[0.0] * 1024]

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", fake_embed)
    body = {
        "schema_version": 1,
        "session_id": str(alice_private_xagent_session.id),
        "tool_call_id": "search-binding-check",
        "permission_revision": 1,
        "query": "binding check",
        "include_private": True,
    }
    headers = {
        "X-XAgent-Service-Token": SERVICE_TOKEN,
        "Authorization": f"Bearer {user_token}",
    }
    valid = _delegation_token(
        actor_id=alice.id,
        session_id=alice_private_xagent_session.id,
        tool_call_id="search-binding-check",
        nonce="search-binding-valid",
        tool_name="search_artifacts",
    )
    first = await client.post(
        "/internal/xagent/retrieval/search",
        headers={**headers, "X-XAgent-Delegation": valid},
        json=body,
    )
    replay = await client.post(
        "/internal/xagent/retrieval/search",
        headers={**headers, "X-XAgent-Delegation": valid},
        json=body,
    )
    overrides = (
        {"tool_name": "resolve_citation"},
        {"session_id": str(UUID(int=920))},
        {"project_id": str(UUID(int=921))},
        {"permission_revision": 2},
    )
    mismatches = []
    for index, override in enumerate(overrides):
        token = _delegation_token(
            actor_id=alice.id,
            session_id=alice_private_xagent_session.id,
            tool_call_id="search-binding-check",
            nonce=f"search-binding-invalid-{index}",
            tool_name="search_artifacts",
            overrides=override,
        )
        mismatches.append(
            await client.post(
                "/internal/xagent/retrieval/search",
                headers={**headers, "X-XAgent-Delegation": token},
                json=body,
            )
        )

    assert first.status_code == 200
    assert replay.status_code == 503
    assert [response.status_code for response in mismatches] == [503, 503, 503, 503]
    assert all(
        response.json() == {"detail": {"code": "service-unavailable"}}
        for response in [replay, *mismatches]
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as verification:
        nonce_count = await verification.scalar(
            select(func.count()).select_from(XAgentDelegationNonce)
        )
        receipt_count = await verification.scalar(
            select(func.count()).select_from(XAgentRetrievalReceipt)
        )
    assert nonce_count == 1
    assert receipt_count == 1


@pytest.mark.anyio
async def test_http_search_closes_commit_time_serialization_failure_without_reusing_nonce(
    client,
    seeded_database,
    alice,
    alice_private_xagent_session,
    monkeypatch,
) -> None:
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "CREATE FUNCTION test_retrieval_commit_failure() RETURNS trigger "
                    "LANGUAGE plpgsql AS $$ BEGIN "
                    "IF NEW.result = 'allowed' AND NEW.details->>'tool_call_id' = 'commit-failure' "
                    "THEN RAISE EXCEPTION 'serialization conflict' USING ERRCODE = '40001'; END IF; "
                    "RETURN NEW; END $$"
                )
            )
            await session.execute(
                text(
                    "CREATE CONSTRAINT TRIGGER test_retrieval_commit_failure "
                    "AFTER INSERT ON audit_events DEFERRABLE INITIALLY DEFERRED "
                    "FOR EACH ROW EXECUTE FUNCTION test_retrieval_commit_failure()"
                )
            )
    user_token = await _login(client, seeded_database, alice)

    async def fake_embed(self, texts):
        return [[0.0] * 1024]

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", fake_embed)
    body = {
        "schema_version": 1, "session_id": str(alice_private_xagent_session.id),
        "tool_call_id": "commit-failure", "permission_revision": 1,
        "query": "empty corpus", "include_private": True,
    }
    delegation = _delegation_token(
        actor_id=alice.id, session_id=alice_private_xagent_session.id,
        tool_call_id="commit-failure", nonce="survives-operation-rollback",
        tool_name="search_artifacts",
    )
    headers = {
        "X-XAgent-Service-Token": SERVICE_TOKEN,
        "X-XAgent-Delegation": delegation,
        "Authorization": f"Bearer {user_token}",
    }

    response = await client.post("/internal/xagent/retrieval/search", headers=headers, json=body)
    replay = await client.post("/internal/xagent/retrieval/search", headers=headers, json=body)

    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "retrieval-unavailable"}}
    assert replay.status_code == 503
    async with AsyncSession(seeded_database, expire_on_commit=False) as verification:
        receipts = await verification.scalar(
            select(func.count()).select_from(XAgentRetrievalReceipt)
        )
        ordinal = await verification.scalar(
            select(XAgentSession.next_citation_ordinal).where(
                XAgentSession.id == alice_private_xagent_session.id
            )
        )
        audits = (
            await verification.scalars(
                select(AuditEvent).where(AuditEvent.action == "retrieval.search")
            )
        ).all()
    assert receipts == 0
    assert ordinal == 1
    assert [item.result for item in audits] == ["retrieval-unavailable", "service-unavailable"]


@pytest.mark.anyio
async def test_real_http_citation_routes_enforce_endpoint_session_and_evidence_bindings(
    client,
    seeded_database,
    alice,
    bob,
    alice_private_xagent_session,
) -> None:
    artifact_id, version_id, index_id, chunk_id = (
        UUID(int=value) for value in range(870, 874)
    )
    other_session_id = UUID(int=874)
    issued_at = datetime.now(UTC)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                    "VALUES (:id, 'citation.txt', :actor, :actor)"
                ),
                {"id": artifact_id, "actor": alice.id},
            )
            await session.execute(
                text(
                    "INSERT INTO artifact_versions "
                    "(id, artifact_id, owner_id, version_number, original_filename, uploaded_by_id, "
                    "declared_size, actual_size, detected_content_type, scan_status, object_key, size, "
                    "content_type, sha256) VALUES (:id, :artifact, :actor, 1, 'citation.txt', :actor, "
                    "1, 1, 'text/plain', 'clean', :key, 1, 'text/plain', :sha)"
                ),
                {
                    "id": version_id, "artifact": artifact_id, "actor": alice.id,
                    "key": f"artifacts/{artifact_id}/{version_id}", "sha": "a" * 64,
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
                    "id": index_id, "artifact": artifact_id, "version": version_id,
                    "sha": "b" * 64, "fingerprint": "c" * 64,
                },
            )
            await session.execute(
                text(
                    "INSERT INTO artifact_text_chunks "
                    "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                    "VALUES (:id, :index, 0, 4, 6, 'citation evidence', 2, :sha, CAST(:vector AS vector))"
                ),
                {
                    "id": chunk_id, "index": index_id, "sha": "d" * 64,
                    "vector": "[1" + ",0" * 1023 + "]",
                },
            )
            await session.execute(
                text(
                    "INSERT INTO xagent_sessions "
                    "(id, owner_id, visibility, permission_revision_created, title, archived, "
                    "last_event_sequence, next_citation_ordinal, version) "
                    "VALUES (:id, :actor, 'private', 1, 'other', false, -1, 1, 1)"
                ),
                {"id": other_session_id, "actor": alice.id},
            )
            await session.execute(
                text(
                    "INSERT INTO xagent_retrieval_receipts "
                    "(id, kind, actor_id, session_id, tool_call_id, query_sha256, scope, "
                    "permission_revision, project_ids, index_generations, chunk_ids, payload_sha256, "
                    "issued_at, expires_at, consumed_at, consumed_event_sequence, "
                    "consumed_payload_sha256, citation_ordinal_start, citation_ordinal_end) "
                    "VALUES (:id, 'artifact_search', :actor, :session, 'seed-search', :query, "
                    "CAST(:scope AS jsonb), 1, CAST('[]' AS jsonb), CAST(:generations AS jsonb), "
                    "CAST(:chunks AS jsonb), :payload, :issued, :expires, :consumed, 0, :payload, 1, 1)"
                ),
                {
                    "id": UUID(int=875), "actor": alice.id,
                    "session": alice_private_xagent_session.id, "query": "e" * 64,
                    "scope": '{"kind":"private","project_ids":[],"include_private":true}',
                    "generations": json.dumps([{"index_id": str(index_id), "generation": 1}]),
                    "chunks": json.dumps([str(chunk_id)]), "payload": "f" * 64,
                    "issued": issued_at, "expires": issued_at + timedelta(minutes=5),
                    "consumed": issued_at,
                },
            )
    user_token = await _login(client, seeded_database, alice)
    base_headers = {
        "X-XAgent-Service-Token": SERVICE_TOKEN,
        "Authorization": f"Bearer {user_token}",
    }
    citation = {
        "id": "[资料1]", "artifact_id": str(artifact_id),
        "version_id": str(version_id), "chunk_id": str(chunk_id),
    }

    async def call(path, session_id, tool_call_id, tool_name, nonce, payload):
        token = _delegation_token(
            actor_id=alice.id, session_id=session_id, tool_call_id=tool_call_id,
            nonce=nonce, tool_name=tool_name,
        )
        return await client.post(
            path,
            headers={**base_headers, "X-XAgent-Delegation": token},
            json={
                "schema_version": 1, "session_id": str(session_id),
                "tool_call_id": tool_call_id, "permission_revision": 1, **payload,
            },
        ), token

    authorized, authorize_token = await call(
        "/internal/xagent/retrieval/citations/authorize",
        alice_private_xagent_session.id, "authorize-real", "authorize_citations",
        "authorize-real", {"citations": [citation]},
    )
    resolved, resolve_token = await call(
        "/internal/xagent/retrieval/citations/resolve",
        alice_private_xagent_session.id, "resolve-real", "resolve_citation",
        "resolve-real", {"citation": citation},
    )
    replay = await client.post(
        "/internal/xagent/retrieval/citations/authorize",
        headers={**base_headers, "X-XAgent-Delegation": authorize_token},
        json={
            "schema_version": 1, "session_id": str(alice_private_xagent_session.id),
            "tool_call_id": "authorize-real", "permission_revision": 1,
            "citations": [citation],
        },
    )
    resolve_replay = await client.post(
        "/internal/xagent/retrieval/citations/resolve",
        headers={**base_headers, "X-XAgent-Delegation": resolve_token},
        json={
            "schema_version": 1, "session_id": str(alice_private_xagent_session.id),
            "tool_call_id": "resolve-real", "permission_revision": 1,
            "citation": citation,
        },
    )
    resolve_mismatches = []
    for index, override in enumerate((
        {"tool_name": "search_artifacts"},
        {"session_id": str(other_session_id)},
        {"project_id": str(UUID(int=876))},
        {"permission_revision": 2},
    )):
        token = _delegation_token(
            actor_id=alice.id,
            session_id=alice_private_xagent_session.id,
            tool_call_id="resolve-binding-check",
            nonce=f"resolve-binding-invalid-{index}",
            tool_name="resolve_citation",
            overrides=override,
        )
        resolve_mismatches.append(
            await client.post(
                "/internal/xagent/retrieval/citations/resolve",
                headers={**base_headers, "X-XAgent-Delegation": token},
                json={
                    "schema_version": 1,
                    "session_id": str(alice_private_xagent_session.id),
                    "tool_call_id": "resolve-binding-check",
                    "permission_revision": 1,
                    "citation": citation,
                },
            )
        )
    cross_session, _ = await call(
        "/internal/xagent/retrieval/citations/resolve",
        other_session_id, "resolve-cross-session", "resolve_citation",
        "resolve-cross-session", {"citation": citation},
    )
    unknown = {**citation, "chunk_id": str(UUID(int=999))}
    unknown_response, _ = await call(
        "/internal/xagent/retrieval/citations/authorize",
        alice_private_xagent_session.id, "authorize-unknown", "authorize_citations",
        "authorize-unknown", {"citations": [unknown]},
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "CREATE FUNCTION test_citation_commit_failure() RETURNS trigger "
                    "LANGUAGE plpgsql AS $$ BEGIN "
                    "IF NEW.result = 'allowed' AND NEW.details->>'tool_call_id' "
                    "IN ('authorize-commit-failure', 'resolve-commit-failure') "
                    "THEN RAISE EXCEPTION 'serialization conflict' USING ERRCODE = '40001'; END IF; "
                    "RETURN NEW; END $$"
                )
            )
            await session.execute(
                text(
                    "CREATE CONSTRAINT TRIGGER test_citation_commit_failure "
                    "AFTER INSERT ON audit_events DEFERRABLE INITIALLY DEFERRED "
                    "FOR EACH ROW EXECUTE FUNCTION test_citation_commit_failure()"
                )
            )
    authorize_commit_failure, _ = await call(
        "/internal/xagent/retrieval/citations/authorize",
        alice_private_xagent_session.id, "authorize-commit-failure", "authorize_citations",
        "authorize-commit-failure", {"citations": [citation]},
    )
    resolve_commit_failure, _ = await call(
        "/internal/xagent/retrieval/citations/resolve",
        alice_private_xagent_session.id, "resolve-commit-failure", "resolve_citation",
        "resolve-commit-failure", {"citation": citation},
    )
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text("UPDATE artifacts SET owner_id = :owner WHERE id = :artifact"),
                {"owner": bob.id, "artifact": artifact_id},
            )
            await session.execute(
                text("UPDATE artifact_versions SET owner_id = :owner WHERE id = :version"),
                {"owner": bob.id, "version": version_id},
            )
    revoked_response, _ = await call(
        "/internal/xagent/retrieval/citations/resolve",
        alice_private_xagent_session.id, "resolve-revoked", "resolve_citation",
        "resolve-revoked", {"citation": citation},
    )

    assert authorized.status_code == 200
    assert authorized.json()["authorized"] is True
    assert resolved.status_code == 200
    assert resolved.json()["line_start"] == 4
    assert replay.status_code == resolve_replay.status_code == 503
    assert [response.status_code for response in resolve_mismatches] == [503, 503, 503, 503]
    assert all(
        response.json() == {"detail": {"code": "service-unavailable"}}
        for response in [resolve_replay, *resolve_mismatches]
    )
    assert authorize_commit_failure.status_code == resolve_commit_failure.status_code == 503
    assert authorize_commit_failure.json() == resolve_commit_failure.json() == {
        "detail": {"code": "service-unavailable"}
    }
    assert cross_session.status_code == unknown_response.status_code == revoked_response.status_code == 422
    assert cross_session.json() == unknown_response.json() == revoked_response.json() == {
        "detail": {"code": "citation-invalid"}
    }
    async with AsyncSession(seeded_database, expire_on_commit=False) as verification:
        nonce_count = await verification.scalar(
            select(func.count()).select_from(XAgentDelegationNonce)
        )
        receipt_count = await verification.scalar(
            select(func.count()).select_from(XAgentRetrievalReceipt)
        )
        failure_audits = (
            await verification.execute(
                select(AuditEvent.details["tool_call_id"].as_string(), AuditEvent.result)
                .where(
                    AuditEvent.details["tool_call_id"].as_string().in_((
                        "authorize-commit-failure",
                        "resolve-commit-failure",
                        "resolve-revoked",
                    ))
                )
                .order_by(AuditEvent.details["tool_call_id"].as_string())
            )
        ).all()
    assert nonce_count == 7
    assert receipt_count == 1
    assert failure_audits == [
        ("authorize-commit-failure", "service-unavailable"),
        ("resolve-commit-failure", "service-unavailable"),
        ("resolve-revoked", "citation-invalid"),
    ]


@pytest.mark.anyio
async def test_concurrent_http_searches_allocate_unique_session_ordinals(
    client,
    seeded_database,
    alice,
    alice_private_xagent_session,
    monkeypatch,
) -> None:
    artifact_id, version_id, index_id, chunk_id = (
        UUID(int=value) for value in range(880, 884)
    )
    vector = "[1" + ",0" * 1023 + "]"
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                    "VALUES (:id, 'concurrent.txt', :actor, :actor)"
                ),
                {"id": artifact_id, "actor": alice.id},
            )
            await session.execute(
                text(
                    "INSERT INTO artifact_versions "
                    "(id, artifact_id, owner_id, version_number, original_filename, uploaded_by_id, "
                    "declared_size, actual_size, detected_content_type, scan_status, object_key, size, "
                    "content_type, sha256) VALUES (:id, :artifact, :actor, 1, 'concurrent.txt', :actor, "
                    "1, 1, 'text/plain', 'clean', :key, 1, 'text/plain', :sha)"
                ),
                {
                    "id": version_id, "artifact": artifact_id, "actor": alice.id,
                    "key": f"artifacts/{artifact_id}/{version_id}", "sha": "1" * 64,
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
                    "id": index_id, "artifact": artifact_id, "version": version_id,
                    "sha": "2" * 64, "fingerprint": "3" * 64,
                },
            )
            await session.execute(
                text(
                    "INSERT INTO artifact_text_chunks "
                    "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                    "VALUES (:id, :index, 0, 1, 1, 'concurrent evidence', 2, :sha, CAST(:vector AS vector))"
                ),
                {
                    "id": chunk_id, "index": index_id, "sha": "4" * 64,
                    "vector": vector,
                },
            )
            await session.execute(
                text(
                    "INSERT INTO artifact_search_heads (artifact_id, index_id, version_id) "
                    "VALUES (:artifact, :index, :version)"
                ),
                {"artifact": artifact_id, "index": index_id, "version": version_id},
            )
    user_token = await _login(client, seeded_database, alice)
    second_login = await client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.test", "password": PASSWORD},
    )
    assert second_login.status_code == 200
    user_tokens = (user_token, second_login.json()["access_token"])

    async def fake_embed(self, texts):
        return [[1.0, *([0.0] * 1023)]]

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", fake_embed)

    async def search(number: int):
        tool_call_id = f"concurrent-{number}"
        delegation = _delegation_token(
            actor_id=alice.id, session_id=alice_private_xagent_session.id,
            tool_call_id=tool_call_id, nonce=f"concurrent-nonce-{number}",
            tool_name="search_artifacts",
        )
        return await client.post(
            "/internal/xagent/retrieval/search",
            headers={
                "X-XAgent-Service-Token": SERVICE_TOKEN,
                "X-XAgent-Delegation": delegation,
                "Authorization": f"Bearer {user_tokens[number - 1]}",
            },
            json={
                "schema_version": 1,
                "session_id": str(alice_private_xagent_session.id),
                "tool_call_id": tool_call_id,
                "permission_revision": 1,
                "query": "concurrent evidence",
                "include_private": True,
            },
        )

    responses = await asyncio.gather(search(1), search(2))

    assert sorted(response.status_code for response in responses) == [200, 503]
    successful = next(response for response in responses if response.status_code == 200)
    conflicted = next(response for response in responses if response.status_code == 503)
    assert successful.json()["citations"][0]["id"] == "[资料1]"
    assert conflicted.json() == {"detail": {"code": "retrieval-unavailable"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as verification:
        ordinal = await verification.scalar(
            select(XAgentSession.next_citation_ordinal).where(
                XAgentSession.id == alice_private_xagent_session.id
            )
        )
        receipt_count = await verification.scalar(
            select(func.count()).select_from(XAgentRetrievalReceipt)
        )
        nonce_count = await verification.scalar(
            select(func.count()).select_from(XAgentDelegationNonce)
        )
        audits = (
            await verification.execute(
                select(AuditEvent.details["tool_call_id"].as_string(), AuditEvent.result)
                .where(
                    AuditEvent.details["tool_call_id"].as_string().in_((
                        "concurrent-1", "concurrent-2",
                    ))
                )
                .order_by(AuditEvent.result)
            )
        ).all()
    assert ordinal == 2
    assert receipt_count == 1
    assert nonce_count == 2
    assert sorted(result for _, result in audits) == ["allowed", "retrieval-unavailable"]
    assert {tool_call_id for tool_call_id, _ in audits} == {"concurrent-1", "concurrent-2"}


@pytest.mark.anyio
async def test_mid_query_project_revocation_closes_the_whole_http_search_snapshot(
    client,
    seeded_database,
    alice,
    bob,
    alice_project,
    bob_project,
    alice_private_xagent_session,
    monkeypatch,
) -> None:
    grant_id = UUID(int=890)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO temporary_project_grants "
                    "(id, project_id, account_id, action, granted_by_id, expires_at) "
                    "VALUES (:id, :project, :account, 'read', :grantor, :expires)"
                ),
                {
                    "id": grant_id, "project": bob_project.id, "account": alice.id,
                    "grantor": bob.id, "expires": datetime.now(UTC) + timedelta(hours=1),
                },
            )
        revision = await session.scalar(
            text("SELECT revision FROM xagent_permission_revisions WHERE account_id = :actor"),
            {"actor": alice.id},
        )
    user_token = await _login(client, seeded_database, alice)
    embedding_started = asyncio.Event()
    revocation_committed = asyncio.Event()

    async def blocked_embed(self, texts):
        embedding_started.set()
        await revocation_committed.wait()
        return [[0.0] * 1024]

    monkeypatch.setattr("app.retrieval.embedding_client.EmbeddingClient.embed", blocked_embed)
    body = {
        "schema_version": 1,
        "session_id": str(alice_private_xagent_session.id),
        "tool_call_id": "mid-query-revocation",
        "permission_revision": revision,
        "query": "must not return a partial scope",
        "project_ids": [str(alice_project.id), str(bob_project.id)],
    }
    delegation = _delegation_token(
        actor_id=alice.id,
        session_id=alice_private_xagent_session.id,
        tool_call_id="mid-query-revocation",
        nonce="mid-query-revocation-nonce",
        tool_name="search_artifacts",
        permission_revision=revision,
    )
    request_task = asyncio.create_task(
        client.post(
            "/internal/xagent/retrieval/search",
            headers={
                "X-XAgent-Service-Token": SERVICE_TOKEN,
                "X-XAgent-Delegation": delegation,
                "Authorization": f"Bearer {user_token}",
            },
            json=body,
        )
    )
    await embedding_started.wait()
    async with AsyncSession(seeded_database, expire_on_commit=False) as revoker:
        async with revoker.begin():
            await revoker.execute(
                text("DELETE FROM temporary_project_grants WHERE id = :id"),
                {"id": grant_id},
            )
    revocation_committed.set()

    response = await request_task

    assert response.status_code == 503
    assert response.json() == {"detail": {"code": "retrieval-unavailable"}}
    async with AsyncSession(seeded_database, expire_on_commit=False) as verification:
        receipt_count = await verification.scalar(
            select(func.count()).select_from(XAgentRetrievalReceipt)
        )
        nonce_count = await verification.scalar(
            select(func.count()).select_from(XAgentDelegationNonce)
        )
        ordinal = await verification.scalar(
            select(XAgentSession.next_citation_ordinal).where(
                XAgentSession.id == alice_private_xagent_session.id
            )
        )
        audits = (
            await verification.scalars(
                select(AuditEvent).where(
                    AuditEvent.action == "retrieval.search",
                    AuditEvent.details["tool_call_id"].as_string() == "mid-query-revocation",
                )
            )
        ).all()
    assert receipt_count == 0
    assert nonce_count == 1
    assert ordinal == 1
    assert [item.result for item in audits] == ["retrieval-unavailable"]


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

    async def keep_test_transaction(context, response, **kwargs):
        return response

    monkeypatch.setattr("app.api.routes.internal_retrieval.hybrid_search", fake_hybrid_search)
    monkeypatch.setattr(
        "app.api.routes.internal_retrieval._verify_delegation", fake_verify_delegation
    )
    monkeypatch.setattr(
        "app.api.routes.internal_retrieval._commit_response", keep_test_transaction
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


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("route", "request_type", "action"),
    (
        (authorize_citations_route, CitationAuthorizeRequest, "retrieval.citation_authorize"),
        (resolve_citation_route, CitationResolveRequest, "retrieval.citation_resolve"),
    ),
)
async def test_citation_statement_failures_are_service_failures_not_invalid_evidence(
    route,
    request_type,
    action,
    seeded_database,
    actor_session,
    alice,
    alice_private_xagent_session,
    monkeypatch,
) -> None:
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    context = SessionContext(
        Principal(
            actor_id=alice.id, role=Role.SPECIALIST, permission_revision=1,
            auth_session_id=UUID(int=992), email="alice@example.test",
        ),
        actor_session,
    )

    async def fake_verify(*args, **kwargs):
        return None

    async def failing_authorization(session, *args, **kwargs):
        async with session.begin_nested():
            await session.execute(text("SELECT * FROM xagent_missing_citation_relation"))

    monkeypatch.setattr("app.api.routes.internal_retrieval._verify_delegation", fake_verify)
    monkeypatch.setattr(
        "app.api.routes.internal_retrieval.authorize_session_citations",
        failing_authorization,
    )
    citation = {
        "id": "[资料1]", "artifact_id": UUID(int=993),
        "version_id": UUID(int=994), "chunk_id": UUID(int=995),
    }
    common = {
        "schema_version": 1, "session_id": alice_private_xagent_session.id,
        "tool_call_id": f"{action}-statement-failure", "permission_revision": 1,
    }
    request = request_type(
        **common,
        **({"citations": [citation]} if request_type is CitationAuthorizeRequest else {"citation": citation}),
    )

    response = await route(request, context)

    assert response.status_code == 503
    assert response.body == b'{"detail":{"code":"service-unavailable"}}'
    async with AsyncSession(seeded_database, expire_on_commit=False) as verification:
        audit = await verification.scalar(select(AuditEvent).where(AuditEvent.action == action))
    assert audit.result == "service-unavailable"
