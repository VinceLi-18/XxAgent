import json
from uuid import UUID

import pytest
from sqlalchemy import text

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.identity import Role
from app.retrieval.embedding_client import RetrievalUnavailableError
from app.services.retrieval import (
    RetrievalCandidate,
    RetrievalScope,
    hybrid_search,
    reciprocal_rank_fusion,
    select_bounded_results,
)


def _candidate(value: int, *, artifact: int = 1, tokens: int = 10, text: str = "evidence") -> RetrievalCandidate:
    return RetrievalCandidate(
        chunk_id=UUID(int=value),
        artifact_id=UUID(int=artifact),
        version_id=UUID(int=artifact + 100),
        index_id=UUID(int=artifact + 200),
        generation=1,
        ordinal=value,
        filename=f"artifact-{artifact}.txt",
        version_number=1,
        line_start=value + 1,
        line_end=value + 1,
        text=text,
        token_count=tokens,
        project_id=None,
    )


def test_rrf_combines_dense_and_lexical_candidates_and_uses_domain_ties() -> None:
    first = _candidate(1, artifact=2)
    second = _candidate(2, artifact=1)
    third = _candidate(3, artifact=3)

    ranked = reciprocal_rank_fusion([first, third], [second, third])

    assert [item.chunk_id for item in ranked] == [third.chunk_id, second.chunk_id, first.chunk_id]


def test_bounded_selection_enforces_total_artifact_byte_and_token_limits() -> None:
    candidates = [
        _candidate(value, artifact=1 if value < 5 else value, tokens=600, text="中" * 1000)
        for value in range(1, 14)
    ]

    selected = select_bounded_results(candidates)

    assert len(selected) <= 8
    assert sum(item.token_count for item in selected) <= 4096
    assert sum(len(item.text.encode("utf-8")) for item in selected) <= 32 * 1024
    assert sum(item.artifact_id == UUID(int=1) for item in selected) == 3
    payload = {
        "schema_version": 1,
        "citations": [
            {
                "id": f"[资料{ordinal}]", "artifact_id": str(item.artifact_id),
                "version_id": str(item.version_id), "chunk_id": str(item.chunk_id),
                "display_name": item.filename, "version_number": item.version_number,
                "line_start": item.line_start, "line_end": item.line_end,
                "text": item.text, "scope": "private",
            }
            for ordinal, item in enumerate(selected, 1)
        ],
    }
    assert len(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()) <= 32 * 1024


def test_global_payload_overflow_stops_at_the_first_ranked_chunk() -> None:
    oversized = _candidate(1, artifact=1, tokens=4096, text="中" * 11000)
    lower_ranked = _candidate(2, artifact=2, tokens=1, text="small")

    assert select_bounded_results([oversized, lower_ranked]) == []


class _CharacterTokenizer:
    def count(self, value: str) -> int:
        return len(value)


def test_token_limit_measures_exact_serialized_metadata_and_framing() -> None:
    empty = _candidate(1, artifact=1, tokens=1, text="")
    payload = {
        "schema_version": 1,
        "citations": [{
            "id": "[资料37]", "artifact_id": str(empty.artifact_id),
            "version_id": str(empty.version_id), "chunk_id": str(empty.chunk_id),
            "display_name": empty.filename, "version_number": empty.version_number,
            "line_start": empty.line_start, "line_end": empty.line_end,
            "text": "", "scope": "private",
        }],
    }
    framing_tokens = len(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
    exact = _candidate(
        1, artifact=1, tokens=1, text="x" * (4096 - framing_tokens)
    )
    over = _candidate(
        1, artifact=1, tokens=1, text="x" * (4097 - framing_tokens)
    )

    assert select_bounded_results(
        [exact], tokenizer=_CharacterTokenizer(), citation_ordinal_start=37
    ) == [exact]
    assert select_bounded_results(
        [over, _candidate(2, artifact=2)],
        tokenizer=_CharacterTokenizer(), citation_ordinal_start=37,
    ) == []


def test_rrf_accepts_dense_only_lexical_only_duplicates_and_empty_results() -> None:
    dense = _candidate(1)
    lexical = _candidate(2, artifact=2)

    assert [item.chunk_id for item in reciprocal_rank_fusion([dense], [lexical])] == [
        dense.chunk_id,
        lexical.chunk_id,
    ]
    assert [item.chunk_id for item in reciprocal_rank_fusion([dense], [dense])] == [dense.chunk_id]
    assert reciprocal_rank_fusion([], []) == []


class _Embedding:
    async def embed(self, texts: list[str]) -> list[list[float]]:
        assert texts == ["cross language budget"]
        return [[1.0, *([0.0] * 1023)]]


class _UnavailableEmbedding:
    async def embed(self, texts: list[str]) -> list[list[float]]:
        raise RetrievalUnavailableError


@pytest.mark.anyio
async def test_real_postgres_hybrid_search_reads_only_the_current_rls_visible_head(
    seeded_database,
    actor_session,
    alice,
) -> None:
    artifact_id = UUID(int=801)
    version_id = UUID(int=802)
    index_id = UUID(int=803)
    old_index_id = UUID(int=804)
    visible_chunk_id = UUID(int=805)
    old_chunk_id = UUID(int=806)
    vector = "[1" + ",0" * 1023 + "]"
    async with seeded_database.begin() as connection:
        await connection.execute(
            text("INSERT INTO artifacts (id, filename, owner_id, created_by_id) VALUES (:id, 'budget.txt', :actor, :actor)"),
            {"id": artifact_id, "actor": alice.id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions (id, artifact_id, owner_id, version_number, original_filename, "
                "uploaded_by_id, declared_size, actual_size, detected_content_type, scan_status, object_key, size, "
                "content_type, sha256) VALUES (:id, :artifact, :actor, 1, 'budget.txt', :actor, 10, 10, "
                "'text/plain', 'clean', :key, 10, 'text/plain', :sha)"
            ),
            {"id": version_id, "artifact": artifact_id, "actor": alice.id, "key": f"artifacts/{artifact_id}/{version_id}", "sha": "a" * 64},
        )
        for current_index, generation in ((index_id, 2), (old_index_id, 1)):
            await connection.execute(
                text(
                    "INSERT INTO artifact_text_indexes (id, artifact_id, version_id, generation, content_sha256, "
                    "parser_revision, embedding_model, embedding_revision, vector_dimensions, configuration_fingerprint, "
                    "status, chunk_count) VALUES (:id, :artifact, :version, :generation, :sha, 'parser', 'BAAI/bge-m3', "
                    "'revision', 1024, :fingerprint, 'ready', 1)"
                ),
                {"id": current_index, "artifact": artifact_id, "version": version_id, "generation": generation, "sha": "b" * 64, "fingerprint": str(generation) * 64},
            )
        for chunk_id, current_index, content in (
            (visible_chunk_id, index_id, "跨语言 budget evidence"),
            (old_chunk_id, old_index_id, "stale budget evidence"),
        ):
            await connection.execute(
                text(
                    "INSERT INTO artifact_text_chunks (id, index_id, ordinal, line_start, line_end, text, token_count, "
                    "text_sha256, embedding) VALUES (:id, :index, 0, 1, 1, :content, 4, :sha, CAST(:vector AS vector))"
                ),
                {"id": chunk_id, "index": current_index, "content": content, "sha": "c" * 64, "vector": vector},
            )
        await connection.execute(
            text("INSERT INTO artifact_search_heads (artifact_id, index_id, version_id) VALUES (:artifact, :index, :version)"),
            {"artifact": artifact_id, "index": index_id, "version": version_id},
        )

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    results, candidate_count = await hybrid_search(
        actor_session,
        _Embedding(),  # type: ignore[arg-type]
        query="cross language budget",
        scope=RetrievalScope((), True),
    )

    assert candidate_count == 1
    assert [item.chunk_id for item in results] == [visible_chunk_id]


@pytest.mark.anyio
async def test_embedding_failure_never_falls_back_to_lexical_search(actor_session) -> None:
    with pytest.raises(RetrievalUnavailableError):
        await hybrid_search(
            actor_session,
            _UnavailableEmbedding(),  # type: ignore[arg-type]
            query="cross language budget",
            scope=RetrievalScope((), True),
        )


@pytest.mark.anyio
async def test_real_postgres_keeps_dense_and_english_chinese_lexical_top40_independent(
    seeded_database,
    actor_session,
    alice,
) -> None:
    base = 2000
    artifacts = []
    versions = []
    indexes = []
    chunks = []
    heads = []
    dense_vector = "[1" + ",0" * 1023 + "]"
    lexical_vector = "[-1" + ",0" * 1023 + "]"
    for offset in range(80):
        artifact_id = UUID(int=base + offset)
        version_id = UUID(int=base + 100 + offset)
        index_id = UUID(int=base + 200 + offset)
        chunk_id = UUID(int=base + 300 + offset)
        is_dense = offset < 40
        artifacts.append(
            {"id": artifact_id, "filename": f"candidate-{offset}.txt", "actor": alice.id}
        )
        versions.append(
            {
                "id": version_id, "artifact": artifact_id, "actor": alice.id,
                "filename": f"candidate-{offset}.txt",
                "key": f"artifacts/{artifact_id}/{version_id}", "sha": f"{offset:064x}",
            }
        )
        indexes.append(
            {
                "id": index_id, "artifact": artifact_id, "version": version_id,
                "sha": f"{offset + 100:064x}", "fingerprint": f"{offset + 200:064x}",
            }
        )
        chunks.append(
            {
                "id": chunk_id, "index": index_id,
                "content": (
                    f"dense semantic evidence {offset}"
                    if is_dense
                    else f"english needle evidence 预算报告 {offset}"
                ),
                "sha": f"{offset + 300:064x}",
                "vector": dense_vector if is_dense else lexical_vector,
            }
        )
        heads.append({"artifact": artifact_id, "index": index_id, "version": version_id})

    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                "VALUES (:id, :filename, :actor, :actor)"
            ),
            artifacts,
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, uploaded_by_id, "
                "declared_size, actual_size, detected_content_type, scan_status, object_key, size, "
                "content_type, sha256) VALUES (:id, :artifact, :actor, 1, :filename, :actor, "
                "1, 1, 'text/plain', 'clean', :key, 1, 'text/plain', :sha)"
            ),
            versions,
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_text_indexes "
                "(id, artifact_id, version_id, generation, content_sha256, parser_revision, "
                "embedding_model, embedding_revision, vector_dimensions, configuration_fingerprint, "
                "status, chunk_count) VALUES (:id, :artifact, :version, 1, :sha, 'parser', "
                "'BAAI/bge-m3', 'revision', 1024, :fingerprint, 'ready', 1)"
            ),
            indexes,
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_text_chunks "
                "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                "VALUES (:id, :index, 0, 1, 1, :content, 4, :sha, CAST(:vector AS vector))"
            ),
            chunks,
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_search_heads (artifact_id, index_id, version_id) "
                "VALUES (:artifact, :index, :version)"
            ),
            heads,
        )

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    english, english_count = await hybrid_search(
        actor_session,
        _Embedding(),  # type: ignore[arg-type]
        query="cross language budget",
        scope=RetrievalScope((), True),
    )

    class _EnglishLexicalEmbedding:
        async def embed(self, texts: list[str]) -> list[list[float]]:
            assert texts == ["english needle evidence"]
            return [[1.0, *([0.0] * 1023)]]

    english_lexical, english_lexical_count = await hybrid_search(
        actor_session,
        _EnglishLexicalEmbedding(),  # type: ignore[arg-type]
        query="english needle evidence",
        scope=RetrievalScope((), True),
    )

    class _ChineseEmbedding:
        async def embed(self, texts: list[str]) -> list[list[float]]:
            assert texts == ["预算报告"]
            return [[1.0, *([0.0] * 1023)]]

    chinese, chinese_count = await hybrid_search(
        actor_session,
        _ChineseEmbedding(),  # type: ignore[arg-type]
        query="预算报告",
        scope=RetrievalScope((), True),
    )

    assert english_count == 40
    assert english_lexical_count == 80
    assert chinese_count == 80
    assert [item.chunk_id for item in chinese[:4]] == [
        UUID(int=base + 300), UUID(int=base + 340),
        UUID(int=base + 301), UUID(int=base + 341),
    ]
    assert any("dense semantic" in item.text for item in chinese)
    assert any("预算报告" in item.text for item in chinese)
    assert any("english needle" in item.text for item in english_lexical)
