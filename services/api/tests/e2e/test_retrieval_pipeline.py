import base64
import hashlib
import json
import os
import subprocess
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


if os.environ.get("XAGENT_RETRIEVAL_E2E") != "1":
    pytest.skip(
        "set XAGENT_RETRIEVAL_E2E=1 to run the CPU retrieval pipeline",
        allow_module_level=True,
    )

_BASE_URL = os.environ.get("XAGENT_RETRIEVAL_E2E_URL", "http://127.0.0.1:58000")
_SERVICE_TOKEN = os.environ.get(
    "XAGENT_RETRIEVAL_E2E_SERVICE_TOKEN",
    "xagent-e2e-service-token-test-only-0001",
)
_REPOSITORY = Path(__file__).resolve().parents[4]
_COMPOSE_FILE = _REPOSITORY / "services/api/compose.test.yml"
_PASSWORD = f"retrieval-e2e-{uuid4()}"
_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
_TERMINAL_INDEX_STATES = {"ready", "failed"}


def _compose(*args: str, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["docker", "compose", "-f", str(_COMPOSE_FILE), *args],
        cwd=_REPOSITORY,
        input=input_text,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"docker compose {' '.join(args)} failed ({result.returncode})\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def _psql(statement: str) -> str:
    return _compose(
        "exec",
        "-T",
        "postgres",
        "psql",
        "--set=ON_ERROR_STOP=1",
        "--tuples-only",
        "--no-align",
        "--username",
        "postgres",
        "--dbname",
        "xagent_api_test",
        input_text=statement,
    ).stdout.strip()


def _diagnostics() -> str:
    sections = []
    for command in (
        ("ps", "--all"),
        ("logs", "--no-color", "--tail", "160", "api", "worker", "embedding"),
    ):
        result = subprocess.run(
            ["docker", "compose", "-f", str(_COMPOSE_FILE), *command],
            cwd=_REPOSITORY,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        sections.append(f"$ docker compose {' '.join(command)}\n{result.stdout}{result.stderr}")
    return "\n".join(sections)


@dataclass(frozen=True)
class Upload:
    artifact_id: str
    version_id: str


@dataclass(frozen=True)
class RetrievalSession:
    client: httpx.Client
    headers: dict[str, str]
    actor_id: UUID
    permission_revision: int
    session_id: UUID


def _delegation(
    session: RetrievalSession,
    *,
    tool_call_id: str,
    tool_name: str,
) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "iss": "xagent-host",
            "aud": "xagent-api",
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(seconds=30)).timestamp()),
            "actor_id": str(session.actor_id),
            "project_id": None,
            "session_id": str(session.session_id),
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "permission_revision": session.permission_revision,
            "nonce": f"e2e-{tool_name}-{uuid4()}",
        },
        _PRIVATE_KEY,
        algorithm="EdDSA",
    )


@pytest.fixture(scope="module")
def retrieval_session() -> RetrievalSession:
    email = f"retrieval-e2e-{uuid4()}@example.test"
    _compose(
        "exec", "-T", "api", "xagent-api", "account", "create",
        "--email", email, "--role", "specialist",
    )
    _compose(
        "exec", "-T", "api", "xagent-api", "account", "set-password",
        "--email", email, input_text=f"{_PASSWORD}\n{_PASSWORD}\n",
    )
    client = httpx.Client(base_url=_BASE_URL, timeout=30)
    login = client.post("/api/v1/auth/login", json={"email": email, "password": _PASSWORD})
    assert login.status_code == 200, login.text
    headers = {
        "Authorization": f"Bearer {login.json()['access_token']}",
        "X-XAgent-Service-Token": _SERVICE_TOKEN,
    }
    principal = client.post("/internal/xagent/auth/introspect", headers=headers)
    assert principal.status_code == 200, principal.text
    created = client.post(
        "/internal/xagent/sessions",
        headers=headers,
        json={
            "schema_version": 1,
            "title": "Retrieval pipeline",
            "idempotency_key": f"session-{uuid4()}",
        },
    )
    assert created.status_code == 201, created.text
    result = RetrievalSession(
        client=client,
        headers=headers,
        actor_id=UUID(principal.json()["actor_id"]),
        permission_revision=principal.json()["permission_revision"],
        session_id=UUID(created.json()["session"]["id"]),
    )
    yield result
    client.close()


def _upload(
    session: RetrievalSession,
    filename: str,
    content: bytes,
    *,
    artifact_id: str | None = None,
) -> Upload:
    request_id = str(uuid4())
    endpoint = (
        f"/internal/xagent/artifacts/{artifact_id}/uploads"
        if artifact_id is not None
        else "/internal/xagent/artifacts/uploads"
    )
    created = session.client.post(
        endpoint,
        headers=session.headers,
        json={
            "filename": filename,
            "size": len(content),
            "idempotency_key": f"create-{request_id}",
        },
    )
    assert created.status_code == 201, created.text
    upload = created.json()
    put = httpx.put(upload["put_url"], content=content, timeout=30)
    assert put.status_code == 200, put.text
    completed = session.client.post(
        f"/internal/xagent/artifacts/uploads/{upload['upload_id']}/complete",
        headers=session.headers,
        json={
            "actual_size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
            "idempotency_key": f"complete-{request_id}",
        },
    )
    assert completed.status_code == 201, completed.text
    detail = completed.json()
    return Upload(detail["id"], detail["versions"][0]["id"])


def _wait_for_head(upload: Upload, *, deadline_seconds: float = 240) -> str:
    deadline = time.monotonic() + deadline_seconds
    last = "no database row"
    while time.monotonic() < deadline:
        last = _psql(
            "SELECT i.status || ':' || COALESCE(j.status, '') || ':' || "
            "(h.version_id = i.version_id)::text "
            "FROM artifact_text_indexes i "
            "JOIN artifact_index_jobs j ON j.index_id = i.id "
            "LEFT JOIN artifact_search_heads h ON h.index_id = i.id "
            f"WHERE i.version_id = '{upload.version_id}';\n"
        )
        if last == "ready:succeeded:true":
            return _psql(
                "SELECT h.index_id FROM artifact_search_heads h "
                f"WHERE h.artifact_id = '{upload.artifact_id}' "
                f"AND h.version_id = '{upload.version_id}';\n"
            )
        if last.split(":", 1)[0] in _TERMINAL_INDEX_STATES:
            pytest.fail(f"index reached {last}\n{_diagnostics()}")
        time.sleep(0.5)
    pytest.fail(f"index did not publish within {deadline_seconds}s; last={last}\n{_diagnostics()}")


def _search(session: RetrievalSession, query: str, tool_call_id: str) -> dict[str, object]:
    response = session.client.post(
        "/internal/xagent/retrieval/search",
        headers={
            **session.headers,
            "X-XAgent-Delegation": _delegation(
                session, tool_call_id=tool_call_id, tool_name="search_artifacts"
            ),
        },
        json={
            "schema_version": 1,
            "session_id": str(session.session_id),
            "tool_call_id": tool_call_id,
            "permission_revision": session.permission_revision,
            "query": query,
            "include_private": True,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _embedding(text: str) -> str:
    encoded = base64.b64encode(text.encode()).decode()
    return _compose(
        "exec",
        "-T",
        "embedding",
        "python",
        "-c",
        (
            "import base64,json,urllib.request;"
            f"text=base64.b64decode('{encoded}').decode();"
            "payload=json.dumps({'texts':[text]}).encode();"
            "request=urllib.request.Request('http://127.0.0.1:8000/embed',data=payload,"
            "headers={'Content-Type':'application/json'});"
            "print(json.dumps(json.load(urllib.request.urlopen(request,timeout=120))"
            "['vectors'][0],separators=(',',':')))"
        ),
    ).stdout.strip()


def _seed_ready_artifact(
    session: RetrievalSession,
    *,
    artifact_id: str,
    version_id: str,
    index_id: str,
    filename: str,
    chunks: list[tuple[str, int, str, str]],
) -> None:
    values = []
    for chunk_id, ordinal, text, vector in chunks:
        text_literal = text.replace("'", "''")
        values.append(
            f"('{chunk_id}', '{index_id}', {ordinal}, 1, 1, '{text_literal}', 1, "
            f"repeat('c',64), CAST('{vector}' AS vector))"
        )
    filename_literal = filename.replace("'", "''")
    _psql(
        "BEGIN;\n"
        "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
        f"VALUES ('{artifact_id}', '{filename_literal}', '{session.actor_id}', "
        f"'{session.actor_id}');\n"
        "INSERT INTO artifact_versions (id, artifact_id, owner_id, version_number, "
        "original_filename, uploaded_by_id, declared_size, actual_size, "
        "detected_content_type, scan_status, object_key, size, content_type, sha256) "
        f"VALUES ('{version_id}', '{artifact_id}', '{session.actor_id}', 1, "
        f"'{filename_literal}', '{session.actor_id}', 1, 1, 'text/plain', 'clean', "
        f"'artifacts/{artifact_id}/{version_id}', 1, 'text/plain', repeat('a',64));\n"
        "INSERT INTO artifact_text_indexes (id, artifact_id, version_id, generation, "
        "content_sha256, parser_revision, embedding_model, embedding_revision, "
        "vector_dimensions, configuration_fingerprint, status, chunk_count) "
        f"VALUES ('{index_id}', '{artifact_id}', '{version_id}', 1, repeat('a',64), "
        "'xagent-text-v1', 'BAAI/bge-m3', "
        "'5617a9f61b028005a4858fdac845db406aefb181', 1024, repeat('b',64), "
        f"'ready', {len(chunks)});\n"
        "INSERT INTO artifact_text_chunks (id, index_id, ordinal, line_start, line_end, "
        "text, token_count, text_sha256, embedding) VALUES "
        + ",".join(values)
        + ";\n"
        "INSERT INTO artifact_search_heads (artifact_id, index_id, version_id) "
        f"VALUES ('{artifact_id}', '{index_id}', '{version_id}');\n"
        "COMMIT;\n"
    )


def _tool_result(tool_call_id: str, search: dict[str, object]) -> dict[str, object]:
    citations = search["citations"]
    return {
        "event_type": "tool/result",
        "schema_version": 1,
        "payload": {
            "seq": 0,
            "time": 1_788_451_200_000,
            "type": "tool/result",
            "data": {
                "turn": 0,
                "step": 0,
                "message": {
                    "id": f"message-{tool_call_id}",
                    "role": "user",
                    "source": {"kind": "tool", "callId": tool_call_id},
                    "content": [{
                        "type": "tool-result",
                        "toolCallId": tool_call_id,
                        "isError": False,
                        "content": [{
                            "type": "text",
                            "text": json.dumps(
                                {"citations": citations},
                                ensure_ascii=False,
                                separators=(",", ":"),
                            ),
                        }],
                    }],
                },
                "meta": {
                    "kind": "xagent-retrieval",
                    "payloadHash": search["payload_sha256"],
                    "citations": [item["id"] for item in citations],
                },
            },
        },
    }


def _admit_search(
    session: RetrievalSession,
    *,
    tool_call_id: str,
    search: dict[str, object],
) -> None:
    response = session.client.post(
        f"/internal/xagent/sessions/{session.session_id}/append",
        headers=session.headers,
        json={
            "schema_version": 1,
            "expected_sequence": -1,
            "idempotency_key": f"append-{uuid4()}",
            "events": [_tool_result(tool_call_id, search)],
            "retrieval_receipts": [{
                "event_sequence": 0,
                "tool_call_id": tool_call_id,
                "receipt": search["receipt"],
                "payload_hash": search["payload_sha256"],
            }],
        },
    )
    assert response.status_code == 200, response.text


def _citation_request(
    session: RetrievalSession,
    *,
    path: str,
    tool_name: str,
    citation: dict[str, object],
) -> httpx.Response:
    tool_call_id = f"{tool_name}-{uuid4()}"
    citation_identity = {
        key: citation[key]
        for key in ("id", "artifact_id", "version_id", "chunk_id")
    }
    payload: dict[str, object] = {
        "schema_version": 1,
        "session_id": str(session.session_id),
        "tool_call_id": tool_call_id,
        "permission_revision": session.permission_revision,
    }
    payload["citations" if tool_name == "authorize_citations" else "citation"] = (
        [citation_identity] if tool_name == "authorize_citations" else citation_identity
    )
    return session.client.post(
        path,
        headers={
            **session.headers,
            "X-XAgent-Delegation": _delegation(
                session, tool_call_id=tool_call_id, tool_name=tool_name
            ),
        },
        json=payload,
    )


def test_real_bilingual_index_replacement_and_structured_citation_flow(
    retrieval_session: RetrievalSession,
) -> None:
    first = _upload(
        retrieval_session,
        "bilingual-v1.txt",
        (
            "quartzbudgetalpha controls the annual operating budget.\n"
            "供应链韧性评估要求保留双来源采购。\n"
        ).encode(),
    )
    first_index = _wait_for_head(first)

    dense = _search(retrieval_session, "financial allocation policy", f"dense-{uuid4()}")
    english = _search(retrieval_session, "quartzbudgetalpha", f"english-{uuid4()}")
    chinese = _search(retrieval_session, "供应链韧性", f"chinese-{uuid4()}")
    for result in (dense, english, chinese):
        assert result["citations"]
        assert result["citations"][0]["version_id"] == first.version_id

    _compose("stop", "worker")
    try:
        second = _upload(
            retrieval_session,
            "bilingual-v2.txt",
            (
                "amberforecastbeta replaces the annual operating forecast.\n"
                "供应网络恢复计划采用新的双来源规则。\n"
            ).encode(),
            artifact_id=first.artifact_id,
        )
        while_pending = _search(
            retrieval_session, "quartzbudgetalpha", f"old-head-{uuid4()}"
        )
        assert while_pending["citations"][0]["version_id"] == first.version_id
    finally:
        _compose("start", "worker")

    second_index = _wait_for_head(second)
    assert second_index != first_index
    assert _psql(
        "SELECT version_id FROM artifact_search_heads "
        f"WHERE artifact_id = '{first.artifact_id}';\n"
    ) == second.version_id
    assert _psql(
        "SELECT count(*) FROM artifact_search_heads "
        f"WHERE artifact_id = '{first.artifact_id}' "
        f"AND version_id = '{first.version_id}';\n"
    ) == "0"

    published = _search(retrieval_session, "amberforecastbeta", f"new-head-{uuid4()}")
    assert published["citations"][0]["version_id"] == second.version_id
    tool_call_id = f"citation-source-{uuid4()}"
    cited = _search(retrieval_session, "amberforecastbeta", tool_call_id)
    _admit_search(retrieval_session, tool_call_id=tool_call_id, search=cited)
    citation = cited["citations"][0]

    authorized = _citation_request(
        retrieval_session,
        path="/internal/xagent/retrieval/citations/authorize",
        tool_name="authorize_citations",
        citation=citation,
    )
    resolved = _citation_request(
        retrieval_session,
        path="/internal/xagent/retrieval/citations/resolve",
        tool_name="resolve_citation",
        citation=citation,
    )
    assert authorized.status_code == 200, authorized.text
    assert authorized.json() == {"schema_version": 1, "authorized": True}
    assert resolved.status_code == 200, resolved.text
    assert resolved.json() == {
        "schema_version": 1,
        "artifact_id": citation["artifact_id"],
        "version_id": citation["version_id"],
        "chunk_id": citation["chunk_id"],
        "line_start": citation["line_start"],
        "line_end": citation["line_end"],
    }


def test_real_hybrid_branches_and_final_domain_tie_break(
    retrieval_session: RetrievalSession,
) -> None:
    query = "zzqxvkjwpmgfh"
    query_vector = _embedding(query)
    unrelated_vector = _embedding("astronomy geology unrelated phrase")
    lexical_chunk = "ffffffff-ffff-ffff-ffff-ffffffff0001"
    dense_chunk = "00000000-0000-0000-0000-000000000001"
    lexical_artifact = "30000000-0000-0000-0000-000000000001"
    lexical_version = "f1000000-0000-0000-0000-000000000001"
    dense_artifact = "40000000-0000-0000-0000-000000000001"
    dense_version = "01000000-0000-0000-0000-000000000001"
    distractor_artifact = "50000000-0000-0000-0000-000000000001"
    _seed_ready_artifact(
        retrieval_session,
        artifact_id=lexical_artifact,
        version_id=lexical_version,
        index_id="f2000000-0000-0000-0000-000000000001",
        filename="lexical-only.txt",
        chunks=[(lexical_chunk, 9, query, unrelated_vector)],
    )
    _seed_ready_artifact(
        retrieval_session,
        artifact_id=dense_artifact,
        version_id=dense_version,
        index_id="02000000-0000-0000-0000-000000000001",
        filename="dense-only.txt",
        chunks=[(dense_chunk, 1, "annual capital allocation protocol", query_vector)],
    )
    _seed_ready_artifact(
        retrieval_session,
        artifact_id=distractor_artifact,
        version_id="51000000-0000-0000-0000-000000000001",
        index_id="52000000-0000-0000-0000-000000000001",
        filename="vector-cutoff.txt",
        chunks=[
            (
                str(
                    UUID(
                        bytes=hashlib.md5(
                            f"tie-{number}".encode(),
                            usedforsecurity=False,
                        ).digest()
                    )
                ),
                number,
                "annual capital allocation protocol",
                query_vector,
            )
            for number in range(40)
        ],
    )

    vector_top_40 = _psql(
        "SELECT count(*) FROM (SELECT c.id FROM artifact_text_chunks c "
        "JOIN artifact_text_indexes i ON i.id = c.index_id "
        "JOIN artifact_search_heads h ON h.index_id = i.id "
        f"ORDER BY c.embedding <=> CAST('{query_vector}' AS vector), c.id LIMIT 40) ranked "
        f"WHERE id = '{lexical_chunk}';\n"
    )
    lexical_rank = _psql(
        "SELECT count(*) FROM artifact_text_chunks c WHERE greatest("
        "ts_rank_cd(c.lexical_document, plainto_tsquery('simple'::regconfig, "
        f"'{query}')), similarity(c.normalized_text, '{query}')) > 0;\n"
    )
    dense_vector_rank = _psql(
        "SELECT vector_rank FROM (SELECT c.id, row_number() OVER (ORDER BY "
        f"c.embedding <=> CAST('{query_vector}' AS vector), c.id) AS vector_rank "
        "FROM artifact_text_chunks c JOIN artifact_text_indexes i ON i.id = c.index_id "
        "JOIN artifact_search_heads h ON h.index_id = i.id) ranked "
        f"WHERE id = '{dense_chunk}';\n"
    )
    dense_lexical_rank = _psql(
        "SELECT greatest(ts_rank_cd(c.lexical_document, "
        f"plainto_tsquery('simple'::regconfig, '{query}')), "
        f"similarity(c.normalized_text, '{query}')) FROM artifact_text_chunks c "
        f"WHERE c.id = '{dense_chunk}';\n"
    )
    assert vector_top_40 == "0"
    assert lexical_rank == "1"
    assert dense_vector_rank == "1"
    assert float(dense_lexical_rank) == 0
    artifact_order_opposes_lower_keys = (
        UUID(lexical_artifact) < UUID(dense_artifact)
        and UUID(lexical_version) > UUID(dense_version)
        and 9 > 1
        and UUID(lexical_chunk) > UUID(dense_chunk)
    )
    assert artifact_order_opposes_lower_keys

    tool_call_id = f"top-forty-{uuid4()}"
    result = _search(retrieval_session, query, tool_call_id)
    assert [item["chunk_id"] for item in result["citations"][:2]] == [
        lexical_chunk,
        dense_chunk,
    ]
    assert _psql(
        "SELECT details->>'candidate_count' FROM audit_events "
        f"WHERE action = 'retrieval.search' AND details->>'tool_call_id' = '{tool_call_id}' "
        "ORDER BY created_at DESC LIMIT 1;\n"
    ) == "41"

    ordinal_query = "yxwvqkzjmnhg"
    ordinal_vector = _embedding(ordinal_query)
    ordinal_chunk = "ffffffff-ffff-ffff-ffff-ffffffff0010"
    vector_chunk = "00000000-0000-0000-0000-000000000010"
    ordinal_artifact = "60000000-0000-0000-0000-000000000001"
    ordinal_version = "61000000-0000-0000-0000-000000000001"
    _seed_ready_artifact(
        retrieval_session,
        artifact_id=ordinal_artifact,
        version_id=ordinal_version,
        index_id="62000000-0000-0000-0000-000000000001",
        filename="ordinal-fallback.txt",
        chunks=[
            (ordinal_chunk, 2, ordinal_query, unrelated_vector),
            (vector_chunk, 9, "tectonic nebula unrelated phrase", ordinal_vector),
            *[
                (
                    f"70000000-0000-0000-0000-{number:012d}",
                    100 + number,
                    f"dense filler {number}",
                    ordinal_vector,
                )
                for number in range(1, 40)
            ],
        ],
    )
    ordinal_vector_rank = _psql(
        "SELECT vector_rank FROM (SELECT c.id, row_number() OVER (ORDER BY "
        f"c.embedding <=> CAST('{ordinal_vector}' AS vector), c.id) AS vector_rank "
        "FROM artifact_text_chunks c JOIN artifact_text_indexes i ON i.id = c.index_id "
        "JOIN artifact_search_heads h ON h.index_id = i.id) ranked "
        f"WHERE id = '{vector_chunk}';\n"
    )
    ordinal_lexical_rank = _psql(
        "SELECT count(*) FROM artifact_text_chunks c WHERE greatest("
        "ts_rank_cd(c.lexical_document, plainto_tsquery('simple'::regconfig, "
        f"'{ordinal_query}')), similarity(c.normalized_text, '{ordinal_query}')) > 0;\n"
    )
    ordinal_lexical_vector_top_40 = _psql(
        "SELECT count(*) FROM (SELECT c.id FROM artifact_text_chunks c "
        "JOIN artifact_text_indexes i ON i.id = c.index_id "
        "JOIN artifact_search_heads h ON h.index_id = i.id "
        f"ORDER BY c.embedding <=> CAST('{ordinal_vector}' AS vector), c.id LIMIT 40) ranked "
        f"WHERE id = '{ordinal_chunk}';\n"
    )
    ordinal_result = _search(
        retrieval_session,
        ordinal_query,
        f"ordinal-fallback-{uuid4()}",
    )
    ordinal_order_opposes_chunk_id = (
        UUID(ordinal_chunk) > UUID(vector_chunk) and 2 < 9
    )
    assert ordinal_vector_rank == "1"
    assert ordinal_lexical_rank == "1"
    assert ordinal_lexical_vector_top_40 == "0"
    assert ordinal_order_opposes_chunk_id
    assert [item["chunk_id"] for item in ordinal_result["citations"][:2]] == [
        ordinal_chunk,
        vector_chunk,
    ]

    chinese_query = "甲乙丙丁戊己庚辛壬癸甲乙丙丁戊庚"
    chinese_text = "甲乙丙丁戊己庚辛壬癸甲乙丙丁戊己"
    chinese_vector = _embedding(chinese_query)
    chinese_chunk = "ffffffff-ffff-ffff-ffff-ffffffff0002"
    _seed_ready_artifact(
        retrieval_session,
        artifact_id="20000000-0000-0000-0000-000000000001",
        version_id="21000000-0000-0000-0000-000000000001",
        index_id="22000000-0000-0000-0000-000000000001",
        filename="chinese-trigram-only.txt",
        chunks=[(chinese_chunk, 4, chinese_text, unrelated_vector)],
    )
    _seed_ready_artifact(
        retrieval_session,
        artifact_id="20000000-0000-0000-0000-000000000002",
        version_id="21000000-0000-0000-0000-000000000002",
        index_id="22000000-0000-0000-0000-000000000002",
        filename="chinese-vector-cutoff.txt",
        chunks=[
            (
                str(
                    UUID(
                        bytes=hashlib.md5(
                            f"chinese-{number}".encode(),
                            usedforsecurity=False,
                        ).digest()
                    )
                ),
                number,
                f"unrelated filler {number}",
                chinese_vector,
            )
            for number in range(40)
        ],
    )
    chinese_vector_top_40 = _psql(
        "SELECT count(*) FROM (SELECT c.id FROM artifact_text_chunks c "
        "JOIN artifact_text_indexes i ON i.id = c.index_id "
        "JOIN artifact_search_heads h ON h.index_id = i.id "
        f"ORDER BY c.embedding <=> CAST('{chinese_vector}' AS vector), c.id LIMIT 40) ranked "
        f"WHERE id = '{chinese_chunk}';\n"
    )
    ts_rank = float(
        _psql(
            "SELECT ts_rank_cd(c.lexical_document, "
            f"plainto_tsquery('simple'::regconfig, '{chinese_query}')) "
            f"FROM artifact_text_chunks c WHERE c.id = '{chinese_chunk}';\n"
        )
    )
    trigram_score = float(
        _psql(
            "SELECT similarity(c.normalized_text, "
            f"'{chinese_query}') FROM artifact_text_chunks c "
            f"WHERE c.id = '{chinese_chunk}';\n"
        )
    )
    chinese_lexical_rank = _psql(
        "SELECT count(*) FROM artifact_text_chunks c WHERE greatest("
        "ts_rank_cd(c.lexical_document, plainto_tsquery('simple'::regconfig, "
        f"'{chinese_query}')), similarity(c.normalized_text, '{chinese_query}')) > 0;\n"
    )
    chinese = _search(retrieval_session, chinese_query, f"chinese-trigram-{uuid4()}")
    assert chinese_vector_top_40 == "0"
    assert ts_rank == 0
    assert trigram_score > 0
    assert chinese_lexical_rank == "1"
    assert chinese["citations"][0]["chunk_id"] == chinese_chunk
