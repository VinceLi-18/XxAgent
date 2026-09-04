"""RLS-filtered project discovery, hybrid retrieval, and citation authorization."""

import hashlib
import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy import Select, func, literal_column, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.artifact import Artifact, ArtifactVersion
from app.models.project import Project, ProjectAction
from app.models.retrieval import (
    ArtifactSearchHead,
    ArtifactTextChunk,
    ArtifactTextIndex,
    XAgentCitedAnswerEvidence,
    XAgentRetrievalReceipt,
)
from app.models.xagent_session import XAgentSession
from app.retrieval.embedding_client import EmbeddingClient, RetrievalUnavailableError
from app.services.authorization import ForbiddenError, authorize_projects

MAX_CANDIDATES = 40
RRF_K = 60
MAX_RESULTS = 8
MAX_RESULTS_PER_ARTIFACT = 3
MAX_RESULT_BYTES = 32 * 1024
MAX_RESULT_TOKENS = 4096


class RetrievalTokenizer(Protocol):
    """Count tokens in the exact serialized model-visible payload."""

    def count(self, value: str) -> int: ...


class _PinnedRetrievalTokenizer:
    def __init__(self) -> None:
        from tokenizers import Tokenizer

        from app.retrieval.embedding_client import MODEL_ID, MODEL_REVISION

        self._tokenizer = Tokenizer.from_pretrained(MODEL_ID, revision=MODEL_REVISION)

    def count(self, value: str) -> int:
        return len(self._tokenizer.encode(value).ids)


@lru_cache(maxsize=1)
def get_retrieval_tokenizer() -> RetrievalTokenizer:
    """Return the tokenizer pinned to the retrieval embedding model revision."""
    return _PinnedRetrievalTokenizer()


class RetrievalError(RuntimeError):
    """A stable retrieval failure safe for the internal protocol."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class RetrievalScope:
    project_ids: tuple[UUID, ...]
    include_private: bool

    def public_value(self, visibility: str) -> dict[str, Any]:
        return {
            "kind": visibility,
            "project_ids": [str(value) for value in self.project_ids],
            "include_private": self.include_private,
        }


@dataclass(frozen=True)
class RetrievalCandidate:
    chunk_id: UUID
    artifact_id: UUID
    version_id: UUID
    index_id: UUID
    generation: int
    ordinal: int
    filename: str
    version_number: int
    line_start: int
    line_end: int
    text: str
    token_count: int
    project_id: UUID | None


def normalize_retrieval_scope(
    *,
    visibility: str,
    fixed_project_id: UUID | None,
    project_ids: list[UUID] | None,
    include_private: bool,
) -> RetrievalScope:
    """Resolve the exact Session scope or reject any implicit or widened scope."""
    if visibility == "project":
        if fixed_project_id is None or project_ids is not None or include_private:
            raise RetrievalError("invalid-retrieval-scope")
        return RetrievalScope((fixed_project_id,), False)
    if visibility != "private" or fixed_project_id is not None:
        raise RetrievalError("invalid-retrieval-scope")
    normalized = tuple(sorted(set(project_ids or ()), key=str))
    if len(normalized) > 20 or (not normalized and not include_private):
        raise RetrievalError("invalid-retrieval-scope")
    return RetrievalScope(normalized, include_private)


def reciprocal_rank_fusion(
    vector_candidates: list[RetrievalCandidate],
    lexical_candidates: list[RetrievalCandidate],
) -> list[RetrievalCandidate]:
    """Fuse independent top-40 ranks with deterministic domain-identity ties.

    Live head cardinality permits one searchable Version per Artifact, so VersionID
    fallback is reachable only for direct candidate lists, not a valid live search.
    """
    scores: dict[UUID, float] = defaultdict(float)
    values: dict[UUID, RetrievalCandidate] = {}
    for ranking in (vector_candidates[:MAX_CANDIDATES], lexical_candidates[:MAX_CANDIDATES]):
        for rank, candidate in enumerate(ranking, start=1):
            values[candidate.chunk_id] = candidate
            scores[candidate.chunk_id] += 1.0 / (RRF_K + rank)
    return sorted(
        values.values(),
        key=lambda candidate: (
            -scores[candidate.chunk_id],
            str(candidate.artifact_id),
            str(candidate.version_id),
            candidate.ordinal,
        ),
    )


def _public_citation(candidate: RetrievalCandidate, ordinal: int) -> dict[str, Any]:
    return {
        "id": f"[资料{ordinal}]",
        "artifact_id": str(candidate.artifact_id),
        "version_id": str(candidate.version_id),
        "chunk_id": str(candidate.chunk_id),
        "display_name": candidate.filename,
        "version_number": candidate.version_number,
        "line_start": candidate.line_start,
        "line_end": candidate.line_end,
        "text": candidate.text,
        "scope": "project" if candidate.project_id is not None else "private",
    }


def select_bounded_results(
    candidates: list[RetrievalCandidate],
    *,
    tokenizer: RetrievalTokenizer | None = None,
    citation_ordinal_start: int = 1,
) -> list[RetrievalCandidate]:
    """Select complete chunks within all model-visible result limits."""
    selected: list[RetrievalCandidate] = []
    artifact_counts: Counter[UUID] = Counter()
    for candidate in candidates:
        if artifact_counts[candidate.artifact_id] >= MAX_RESULTS_PER_ARTIFACT:
            continue
        proposed = [*selected, candidate]
        serialized = json.dumps(
            {
                "schema_version": 1,
                "citations": [
                    _public_citation(item, citation_ordinal_start + offset)
                    for offset, item in enumerate(proposed)
                ],
            },
            separators=(",", ":"),
            ensure_ascii=False,
        )
        exact_tokens = (
            tokenizer.count(serialized)
            if tokenizer is not None
            else sum(item.token_count for item in proposed)
        )
        if len(serialized.encode("utf-8")) > MAX_RESULT_BYTES or exact_tokens > MAX_RESULT_TOKENS:
            break
        selected = proposed
        artifact_counts[candidate.artifact_id] += 1
        if len(selected) == MAX_RESULTS:
            break
    return selected


def payload_sha256(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def scope_sha256(scope: RetrievalScope, visibility: str) -> str:
    return payload_sha256(scope.public_value(visibility))


async def load_retrieval_session(
    session: AsyncSession,
    actor_id: UUID,
    session_id: UUID,
    *,
    lock: bool = False,
) -> XAgentSession:
    statement = select(XAgentSession).where(XAgentSession.id == session_id)
    if lock:
        statement = statement.with_for_update()
    item = await session.scalar(statement)
    if item is None or (item.visibility == "private" and item.owner_id != actor_id):
        raise RetrievalError("service-unavailable")
    return item


async def reserve_citation_ordinals(
    session: AsyncSession, session_id: UUID, count: int
) -> int:
    """Reserve a Session-local citation range through the narrow RLS-aware function."""
    try:
        async with session.begin_nested():
            value = await session.scalar(
                text("SELECT public.xagent_reserve_citation_ordinals(:session_id, :count)"),
                {"session_id": session_id, "count": count},
            )
    except Exception:
        raise RetrievalUnavailableError() from None
    if not isinstance(value, int):
        raise RetrievalError("service-unavailable")
    return value


async def citation_ordinal_base(session: AsyncSession, session_id: UUID) -> int:
    """Lock and return a Session citation base through the narrow RLS-aware function."""
    try:
        async with session.begin_nested():
            value = await session.scalar(
                text("SELECT public.xagent_citation_ordinal_base(:session_id)"),
                {"session_id": session_id},
            )
    except Exception:
        raise RetrievalUnavailableError() from None
    if not isinstance(value, int):
        raise RetrievalError("service-unavailable")
    return value


async def finalize_retrieval_authorization(
    session: AsyncSession,
    *,
    session_id: UUID,
    permission_revision: int,
    project_ids: tuple[UUID, ...],
) -> None:
    """Serialize retrieval output against revision and project authorization changes."""
    try:
        async with session.begin_nested():
            authorized = await session.scalar(
                text(
                    "SELECT public.xagent_finalize_retrieval_authorization"
                    "(:session_id, :permission_revision, CAST(:project_ids AS uuid[]))"
                ),
                {
                    "session_id": session_id,
                    "permission_revision": permission_revision,
                    "project_ids": list(project_ids),
                },
            )
    except Exception:
        raise RetrievalUnavailableError() from None
    if authorized is not True:
        raise RetrievalError("service-unavailable")


async def resolve_scope(
    session: AsyncSession,
    *,
    actor_id: UUID,
    session_item: XAgentSession,
    project_ids: list[UUID] | None,
    include_private: bool,
) -> RetrievalScope:
    scope = normalize_retrieval_scope(
        visibility=session_item.visibility,
        fixed_project_id=session_item.project_id,
        project_ids=project_ids,
        include_private=include_private,
    )
    try:
        await authorize_projects(session, actor_id, scope.project_ids, ProjectAction.READ)
    except ForbiddenError:
        raise RetrievalError("service-unavailable") from None
    return scope


async def list_accessible_projects(
    session: AsyncSession,
    *,
    query: str | None,
) -> list[dict[str, Any]]:
    statement = select(Project.id, Project.name)
    if query is not None:
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        statement = statement.where(Project.name.ilike(f"%{escaped}%", escape="\\"))
    rows = (await session.execute(statement.order_by(func.lower(Project.name), Project.id).limit(20))).all()
    return [{"project_id": row.id, "name": row.name} for row in rows]


def _candidate_statement(scope: RetrievalScope) -> Select[Any]:
    statement = (
        select(
            ArtifactTextChunk.id.label("chunk_id"),
            Artifact.id.label("artifact_id"),
            ArtifactVersion.id.label("version_id"),
            ArtifactTextIndex.id.label("index_id"),
            ArtifactTextIndex.generation,
            ArtifactTextChunk.ordinal,
            Artifact.filename,
            ArtifactVersion.version_number,
            ArtifactTextChunk.line_start,
            ArtifactTextChunk.line_end,
            ArtifactTextChunk.text,
            ArtifactTextChunk.token_count,
            Artifact.project_id,
        )
        .join(ArtifactTextIndex, ArtifactTextIndex.id == ArtifactTextChunk.index_id)
        .join(ArtifactSearchHead, ArtifactSearchHead.index_id == ArtifactTextIndex.id)
        .join(Artifact, Artifact.id == ArtifactSearchHead.artifact_id)
        .join(ArtifactVersion, ArtifactVersion.id == ArtifactSearchHead.version_id)
        .where(ArtifactTextIndex.status == "ready", ArtifactVersion.scan_status == "clean")
    )
    predicates = []
    if scope.project_ids:
        predicates.append(Artifact.project_id.in_(scope.project_ids))
    if scope.include_private:
        predicates.append(Artifact.owner_id.is_not(None))
    return statement.where(or_(*predicates))


def _rows_to_candidates(rows: list[Any]) -> list[RetrievalCandidate]:
    return [RetrievalCandidate(**dict(row._mapping)) for row in rows]


async def hybrid_search(
    session: AsyncSession,
    embedding_client: EmbeddingClient,
    *,
    query: str,
    scope: RetrievalScope,
    citation_ordinal_start: int = 1,
) -> tuple[list[RetrievalCandidate], int]:
    """Run independent exact cosine and lexical top-40 queries, then apply RRF limits."""
    try:
        async with session.begin_nested():
            vectors = await embedding_client.embed([query])
            vector = vectors[0]
            base = _candidate_statement(scope)
            vector_rows = (
                await session.execute(
                    base.order_by(ArtifactTextChunk.embedding.cosine_distance(vector), ArtifactTextChunk.id).limit(40)
                )
            ).all()
            lexical_score = func.greatest(
                func.ts_rank_cd(
                    ArtifactTextChunk.lexical_document,
                    func.plainto_tsquery(literal_column("'simple'::regconfig"), query),
                ),
                func.similarity(ArtifactTextChunk.normalized_text, query.casefold()),
            )
            lexical_rows = (
                await session.execute(
                    base.where(lexical_score > 0).order_by(lexical_score.desc(), ArtifactTextChunk.id).limit(40)
                )
            ).all()
    except RetrievalUnavailableError:
        raise
    except Exception:
        raise RetrievalUnavailableError() from None
    fused = reciprocal_rank_fusion(_rows_to_candidates(vector_rows), _rows_to_candidates(lexical_rows))
    return select_bounded_results(
        fused,
        tokenizer=get_retrieval_tokenizer(),
        citation_ordinal_start=citation_ordinal_start,
    ), len(fused)


async def authorize_citation_chunks(
    session: AsyncSession,
    *,
    identities: list[tuple[UUID, UUID, UUID]],
) -> list[RetrievalCandidate]:
    """Reauthorize immutable historical chunks without requiring the current search head."""
    if len({chunk_id for _, _, chunk_id in identities}) != len(identities):
        raise RetrievalError("citation-invalid")
    rows = (
        await session.execute(
            select(
                ArtifactTextChunk.id.label("chunk_id"), Artifact.id.label("artifact_id"),
                ArtifactVersion.id.label("version_id"), ArtifactTextIndex.id.label("index_id"),
                ArtifactTextIndex.generation, ArtifactTextChunk.ordinal, Artifact.filename,
                ArtifactVersion.version_number, ArtifactTextChunk.line_start, ArtifactTextChunk.line_end,
                ArtifactTextChunk.text, ArtifactTextChunk.token_count, Artifact.project_id,
            )
            .join(ArtifactTextIndex, ArtifactTextIndex.id == ArtifactTextChunk.index_id)
            .join(Artifact, Artifact.id == ArtifactTextIndex.artifact_id)
            .join(ArtifactVersion, ArtifactVersion.id == ArtifactTextIndex.version_id)
            .where(ArtifactTextChunk.id.in_([value[2] for value in identities]))
        )
    ).all()
    candidates = _rows_to_candidates(rows)
    actual = {(item.artifact_id, item.version_id, item.chunk_id) for item in candidates}
    if actual != set(identities):
        raise RetrievalError("citation-invalid")
    return candidates


async def authorize_session_citations(
    session: AsyncSession,
    *,
    actor_id: UUID,
    session_id: UUID,
    citations: list[tuple[str, UUID, UUID, UUID]],
) -> list[RetrievalCandidate]:
    """Require each citation to come from consumed evidence in the same Session."""
    receipts = (
        await session.scalars(
            select(XAgentRetrievalReceipt).where(
                XAgentRetrievalReceipt.actor_id == actor_id,
                XAgentRetrievalReceipt.session_id == session_id,
                XAgentRetrievalReceipt.kind == "artifact_search",
                XAgentRetrievalReceipt.consumed_at.is_not(None),
            )
        )
    ).all()
    admitted: dict[str, UUID] = {}
    for receipt in receipts:
        if receipt.citation_ordinal_start is None:
            continue
        for offset, chunk_id in enumerate(receipt.chunk_ids):
            admitted[f"[资料{receipt.citation_ordinal_start + offset}]"] = UUID(chunk_id)
    if any(admitted.get(citation_id) != chunk_id for citation_id, _, _, chunk_id in citations):
        raise RetrievalError("citation-invalid")
    return await authorize_citation_chunks(
        session,
        identities=[
            (artifact_id, version_id, chunk_id)
            for _, artifact_id, version_id, chunk_id in citations
        ],
    )


async def resolve_session_citation(
    session: AsyncSession,
    *,
    session_id: UUID,
    citation_id: str,
) -> RetrievalCandidate:
    """Resolve durable answer provenance and reauthorize its exact immutable chunk."""
    rows = (
        await session.scalars(
            select(XAgentCitedAnswerEvidence)
            .where(
                XAgentCitedAnswerEvidence.session_id == session_id,
                XAgentCitedAnswerEvidence.citation_id == citation_id,
            )
            .order_by(XAgentCitedAnswerEvidence.answer_event_sequence)
        )
    ).all()
    identities = {
        (
            row.artifact_id,
            row.version_id,
            row.index_id,
            row.index_generation,
            row.chunk_id,
        )
        for row in rows
    }
    if len(identities) != 1:
        raise RetrievalError("citation-invalid")
    artifact_id, version_id, index_id, index_generation, chunk_id = identities.pop()
    candidates = await authorize_citation_chunks(
        session,
        identities=[(artifact_id, version_id, chunk_id)],
    )
    candidate = candidates[0]
    if candidate.index_id != index_id or candidate.generation != index_generation:
        raise RetrievalError("citation-invalid")
    return candidate
