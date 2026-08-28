# XAgent Phase 4A：RAG 检索与引用实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `xagent-business` 交付只读的项目／私人资料混合检索、可验证引用与最小模型上下文，同时保持 Session 权限、审计和失败关闭边界。

**Architecture:** FastAPI/PostgreSQL 是索引、检索、授权、receipt、引用与审计的唯一真相源；Python index worker 从安全正文构建未发布 generation，再原子切换可检索 head；本地 CPU embedding 服务只提供向量协议。Host 的 `@xagent/dsh-retrieval`、`@xagent/dsh-tool-retrieval` 与 `@xagent/dsh-ui-citation` 通过一次性委托、receipt sidecar、Session checkpoint 和输出缓冲把检索证据接入 Agent，不让 Browser、模型或 Session 日志持有内部令牌、对象 Key 或签名 URL。

**Tech Stack:** Python 3.11、FastAPI、SQLAlchemy async、Alembic、PostgreSQL 16、pgvector、pg_trgm、MinIO、ClamAV、BAAI/bge-m3、TypeScript、Cordis、Typert、React 18、Vitest、Playwright、Docker Compose。

**Spec:** [Phase 4A RAG 检索与引用设计](../specs/2026-08-28-xagent-phase-4a-rag-design.md)

## Global Constraints

- Phase 4A 只实现读取、检索、引用和项目发现；资料写工具、审批、写幂等与写任务恢复留给 Phase 4B。
- 只索引 `clean` 且不超过 10 MiB 的 UTF-8 `text/plain`、Markdown、CSV、JSON；PDF、Office、图片、OCR 留给 Phase 5。
- dense 固定使用 BAAI/bge-m3 的 1024 维向量；lexical 固定使用 PostgreSQL full-text 与 `pg_trgm`；初期只做 RLS 后 exact pgvector 搜索，不建 HNSW。
- CPU-only Docker Compose 是必过基线；GPU 只能作为同协议可选 overlay，不得成为开发、CI 或生产正确性的前提。
- chunk 固定最多 512 BGE token、重叠 64 token、优先段落／行边界、单 chunk 最多 8 KiB；查询最多 512 BGE token。
- vector 与 lexical 各取 40，RRF `k=60`；最终最多 8 个 chunk、每个 Artifact 最多 3 个、总计最多 32 KiB 与 4096 BGE token。
- 不缓存查询、检索结果、最终答案或正文；索引 generation 可持久化，未完成 generation 永不成为 searchable head。
- Project Session 只能检索其固定项目；Private Session 必须显式提供非空 `project_ids` 和／或 `include_private=true`，最多 20 个去重项目，授权全有或全无，`include_private` 默认 `false`。
- 不提供“全部项目”隐式范围或跨项目多选 UI；模型先调用 `list_accessible_projects`，范围有歧义时向用户确认，再调用 `search_artifacts`。
- 每次项目发现与资料搜索都产生 5 分钟、单逻辑消费的 receipt；Session append 的相同幂等重放必须返回原结果，其他重用全部拒绝。
- `[资料N]` 是 Session 内单调递增且不复用的引用 ID；检索、receipt admission、答案放行三个时点都重新授权。
- 使用证据的最终答案必须缓冲并校验引用；第一次无效输出追加纠错事件并重试一次，第二次无效则显式失败；普通非 RAG 对话继续流式输出。
- receipt 只通过 append sidecar 传给 FastAPI，不能进入模型内容、公开 Session 事件、Browser 状态、日志或审计；持久事件只保留公开引用与可重建证据。
- 审计只写 ID、计数、hash 与状态；不写 raw query、chunk、vector、token、完整 prompt／answer、URL 或对象 Key。
- 仅 `xagent-business` 装配本阶段能力；Developer、普通 Web、Headless 与 JiaxinAgent 不装配且行为不变。
- 每个行为改动先取得原因精确的 RED，再写最小 GREEN；每个任务独立提交，不推送远端。

## Fixed Interfaces and Type Graph

```python
class ArtifactIndexStatus(str, Enum):
    BUILDING = "building"
    READY = "ready"
    FAILED = "failed"

class ArtifactIndexJobStatus(str, Enum):
    READY = "ready"
    LEASED = "leased"
    SUCCEEDED = "succeeded"
    DEAD = "dead"

class RetrievalReceiptKind(str, Enum):
    PROJECT_DISCOVERY = "project_discovery"
    ARTIFACT_SEARCH = "artifact_search"

@dataclass(frozen=True)
class ArtifactIndexLease:
    job_id: UUID
    version_id: UUID
    generation_id: UUID
    lease_token: UUID
    attempt: int
```

```ts
export type XAgentRetrievalScope =
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'private'; readonly projectIds: readonly string[]; readonly includePrivate: boolean }

export interface XAgentCitationRef {
  readonly id: string // [资料N]
  readonly artifactId: string
  readonly versionId: string
  readonly chunkId: string
  readonly displayName: string
  readonly lineStart: number
  readonly lineEnd: number
}

export interface XAgentRetrievalReceiptAttachment {
  readonly eventSequence: number
  readonly toolCallId: string
  readonly receipt: string
  readonly payloadHash: string
}

export interface XAgentReceiptRegistry {
  register(input: { sessionId: string; toolCallId: string; receipt: string; payloadHash: string }): void
  bindEvent(sessionId: string, toolCallId: string, eventSequence: number): void
  attachments(sessionId: string, fromSequence: number, toSequence: number): readonly XAgentRetrievalReceiptAttachment[]
  commit(sessionId: string, throughSequence: number): void
  dispose(): Promise<void>
}
```

稳定错误只使用既有集合并新增：`retrieval-scope-invalid`、`retrieval-receipt-invalid`、`citation-invalid`、`citation-revoked`、`index-unavailable`；其他未知失败统一映射为 `service-unavailable`。

---

### Task 1: Add pgvector, Retrieval Schema, RLS, and Role Boundaries

**Files:**

- Create: `.agents/notes/proposed/architecture/2026-08-28-xagent-rag-retrieval.md`
- Create: `services/api/alembic/versions/013_xagent_rag_retrieval.py`
- Create: `services/api/app/models/retrieval.py`
- Modify: `services/api/app/models/xagent_session.py`
- Modify: `services/api/app/models/__init__.py`
- Modify: `services/api/alembic/env.py`
- Modify: `services/api/app/core/migration_config.py`
- Modify: `services/api/postgres/init/01-create-app-role.sh`
- Modify: `services/api/tests/conftest.py`
- Create: `services/api/tests/security/test_retrieval_schema.py`
- Create: `services/api/tests/security/test_retrieval_rls.py`
- Create: `services/api/tests/security/test_retrieval_worker_role.py`
- Modify: `services/api/pyproject.toml`
- Modify: `services/api/uv.lock`
- Modify: `scripts/translation-pairing.manifest.json`
- Modify: `docs/i18n/README.md`
- Modify: `docs/i18n/README.zh.md`

**Interfaces — Consumes:** `artifact_versions`, `artifacts`, `xagent_sessions`, account／project RLS helpers, existing `xagent_worker` role.

**Interfaces — Produces:** `artifact_text_indexes`, `artifact_text_chunks`, `artifact_index_jobs`, `artifact_search_heads`, `xagent_retrieval_receipts`, `xagent_sessions.next_citation_ordinal`; enabled `vector` and `pg_trgm` extensions; constrained grants for app／worker roles.

- [ ] **Step 1: Write schema and RLS RED tests**

```bash
pnpm run api:test -- tests/security/test_retrieval_schema.py tests/security/test_retrieval_rls.py tests/security/test_retrieval_worker_role.py
```

Expected: collection or assertions fail because migration 013, retrieval tables, extensions, policies, and grants do not exist.

- [ ] **Step 2: Implement the migration and ORM model**

```python
class ArtifactTextChunk(Base):
    __tablename__ = "artifact_text_chunks"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    index_id: Mapped[UUID] = mapped_column(ForeignKey("artifact_text_indexes.id", ondelete="CASCADE"))
    ordinal: Mapped[int]
    line_start: Mapped[int]
    line_end: Mapped[int]
    text: Mapped[str]
    token_count: Mapped[int]
    embedding: Mapped[list[float]] = mapped_column(Vector(1024))
    lexical_document: Mapped[object]
```

Add checks for status transitions, one head per Artifact, one generation per index, unique `(index_id, ordinal)`, 1024 dimensions, chunk byte/token bounds, receipt TTL／consumption shape, and positive citation ordinals. Policies must derive Artifact visibility through current actor and project membership; app cannot write embeddings directly, worker cannot read sessions／accounts／auth secrets, and Browser has no database role.

- [ ] **Step 3: Prove clean install and migration round-trip**

```bash
pnpm run api:migrate
cd services/api && .venv/bin/alembic downgrade 012_xagent_artifact_lifecycle
cd services/api && .venv/bin/alembic upgrade head
pnpm run api:test -- tests/security/test_retrieval_schema.py tests/security/test_retrieval_rls.py tests/security/test_retrieval_worker_role.py
```

Expected: both migrations succeed; all security tests pass under real PostgreSQL roles.

- [ ] **Step 4: Commit the database boundary**

```bash
git add .agents/notes/proposed/architecture/2026-08-28-xagent-rag-retrieval.md services/api/alembic services/api/app/models services/api/app/core/migration_config.py services/api/postgres/init/01-create-app-role.sh services/api/tests services/api/pyproject.toml services/api/uv.lock scripts/translation-pairing.manifest.json docs/i18n
git commit -m "feat: add xagent retrieval schema"
```

### Task 2: Build the CPU Embedding Service and Strict Text Chunker

**Files:**

- Create: `services/embedding/pyproject.toml`
- Create: `services/embedding/uv.lock`
- Create: `services/embedding/Dockerfile`
- Create: `services/embedding/app/__init__.py`
- Create: `services/embedding/app/main.py`
- Create: `services/embedding/app/model.py`
- Create: `services/embedding/tests/test_embedding_api.py`
- Create: `services/api/app/retrieval/chunking.py`
- Create: `services/api/app/retrieval/embedding_client.py`
- Create: `services/api/tests/retrieval/test_chunking.py`
- Create: `services/api/tests/retrieval/test_embedding_client.py`
- Modify: `services/api/app/core/config.py`
- Modify: `services/api/tests/conftest.py`

**Interfaces — Consumes:** pinned BAAI/bge-m3 model files, UTF-8 text, HTTP endpoint reachable only inside Compose.

**Interfaces — Produces:** `POST /embed` with bounded `texts: string[]` and exactly 1024 floats per text; `chunk_text(bytes, content_type) -> list[TextChunk]`; `EmbeddingClient.embed(texts) -> list[list[float]]`.

- [ ] **Step 1: Write tokenizer, chunk, and protocol RED tests**

```bash
pnpm run api:test -- tests/retrieval/test_chunking.py tests/retrieval/test_embedding_client.py
cd services/embedding && ../api/.venv/bin/pytest -q tests/test_embedding_api.py
```

Expected: imports fail because the service, strict decoder, token-aware chunker, and client do not exist.

- [ ] **Step 2: Implement bounded UTF-8 chunking**

```python
@dataclass(frozen=True)
class TextChunk:
    ordinal: int
    text: str
    line_start: int
    line_end: int
    token_count: int

def chunk_text(payload: bytes, content_type: str, tokenizer: Tokenizer) -> list[TextChunk]:
    if len(payload) > 10 * 1024 * 1024:
        raise RetrievalInputError("index-unavailable")
    text = payload.decode("utf-8", errors="strict")
    return paragraph_chunks(text, tokenizer, limit=512, overlap=64, max_bytes=8192)
```

Cover CRLF normalization without changing reported logical line numbers, empty content, giant lines, multi-byte UTF-8, CSV/JSON, unsupported MIME, 512-token edge, 64-token overlap, 8 KiB cap, and deterministic output.

- [ ] **Step 3: Implement the no-log embedding protocol**

The embedding service must bind only its container interface, reject batches over 64 texts, reject any text over 8 KiB or 512 BGE tokens, never log body text, expose `/health`, and return model ID plus dimension so the client can fail closed on drift. Its internal `/token-count` endpoint returns the exact no-special-token count with the same pinned model ID and revision for Host retrieval query validation.

```json
{"model":"BAAI/bge-m3","dimension":1024,"vectors":[[0.0,0.1]]}
```

- [ ] **Step 4: Verify deterministic bilingual vectors and cancellation**

```bash
pnpm run api:test -- tests/retrieval/test_chunking.py tests/retrieval/test_embedding_client.py
cd services/embedding && ../api/.venv/bin/pytest -q tests/test_embedding_api.py
```

Expected: Chinese and English fixtures produce finite normalized 1024-dimensional vectors; timeout, disconnect, wrong model, wrong dimension, NaN, oversized body, and partial response fail closed without text logs.

- [ ] **Step 5: Commit embedding and chunking**

```bash
git add services/embedding services/api/app/retrieval services/api/app/core/config.py services/api/tests/retrieval services/api/tests/conftest.py
git commit -m "feat: add xagent embedding and chunking"
```

### Task 3: Add Durable Index Jobs and Atomic Search-Head Publication

**Files:**

- Create: `services/api/app/services/artifact_index_jobs.py`
- Create: `services/api/app/services/artifact_indexing.py`
- Modify: `services/api/app/services/artifact_processing.py`
- Modify: `services/api/app/worker.py`
- Modify: `services/api/app/cli.py`
- Modify: `services/api/app/storage/minio_gateway.py`
- Create: `services/api/tests/services/test_artifact_index_jobs.py`
- Create: `services/api/tests/services/test_artifact_indexing.py`
- Create: `services/api/tests/services/test_artifact_index_concurrency.py`
- Modify: `services/api/tests/storage/test_minio_gateway.py`
- Modify: `services/api/tests/security/test_audit_events.py`

**Interfaces — Consumes:** clean Artifact Version, safe MinIO object stream, chunker, `EmbeddingClient`, worker database role.

**Interfaces — Produces:** leased `ArtifactIndexLease`; unpublished index generation; atomic `artifact_search_heads` switch; durable retry/dead status; hash-only audit events.

- [ ] **Step 1: Write lifecycle and concurrency RED tests**

```bash
pnpm run api:test -- tests/services/test_artifact_index_jobs.py tests/services/test_artifact_indexing.py tests/services/test_artifact_index_concurrency.py tests/security/test_audit_events.py
```

Expected: tests fail because clean promotion does not enqueue indexing and no generation/head lifecycle exists.

- [ ] **Step 2: Enqueue indexing in the same clean-promotion transaction**

Only index supported MIME and actual size at most 10 MiB. Unsupported clean Versions remain downloadable but receive no index job. Use one job per Version and an immutable generation UUID.

```python
async def enqueue_index_job(session: AsyncSession, version: ArtifactVersion) -> None:
    if not is_indexable(version.detected_content_type, version.actual_size):
        return
    session.add(ArtifactIndexJob(version_id=version.id, generation_id=uuid4(), status="ready"))
```

- [ ] **Step 3: Implement lease, retry, and publish**

Use `FOR UPDATE SKIP LOCKED`, lease token matching, bounded exponential retry, expired-lease reclaim, and a final transaction that marks the generation ready, switches the Artifact head, and succeeds the job. Failure never removes the prior ready head.

- [ ] **Step 4: Prove crash and supersession semantics**

```bash
pnpm run api:test -- tests/services/test_artifact_index_jobs.py tests/services/test_artifact_indexing.py tests/services/test_artifact_index_concurrency.py
```

Expected: old ready head stays searchable through new-version build/failure; stale leases cannot publish; identical worker retry does not duplicate chunks; successful replacement switches once.

- [ ] **Step 5: Commit the indexing worker**

```bash
git add services/api/app/services services/api/app/worker.py services/api/app/cli.py services/api/app/storage services/api/tests
git commit -m "feat: index clean xagent artifacts"
```

### Task 4: Implement Hybrid Retrieval, Project Discovery, Receipts, and Auditing

**Files:**

- Create: `services/api/app/schemas/retrieval.py`
- Create: `services/api/app/services/retrieval.py`
- Create: `services/api/app/services/retrieval_receipts.py`
- Create: `services/api/app/api/routes/internal_retrieval.py`
- Modify: `services/api/app/main.py`
- Modify: `services/api/app/services/authorization.py`
- Modify: `services/api/app/services/audit.py`
- Create: `services/api/tests/retrieval/test_hybrid_search.py`
- Create: `services/api/tests/retrieval/test_project_discovery.py`
- Create: `services/api/tests/retrieval/test_retrieval_receipts.py`
- Create: `services/api/tests/api/test_internal_retrieval.py`
- Create: `services/api/tests/security/test_retrieval_audit.py`

**Interfaces — Consumes:** user JWT, service token, delegation token, Session scope, permission revision, searchable heads, query embedding.

**Interfaces — Produces:** `POST /internal/xagent/retrieval/projects`, `/search`, `/citations/authorize`, `/citations/resolve`; opaque 5-minute receipt; deterministic RRF results; redacted audit rows.

- [ ] **Step 1: Write scope, ranking, and receipt RED tests**

```bash
pnpm run api:test -- tests/retrieval/test_hybrid_search.py tests/retrieval/test_project_discovery.py tests/retrieval/test_retrieval_receipts.py tests/api/test_internal_retrieval.py tests/security/test_retrieval_audit.py
```

Expected: routes and services are absent; scope, RRF, and receipt assertions fail.

- [ ] **Step 2: Implement exact bounded retrieval**

```python
def reciprocal_rank_fusion(vector_ids: list[UUID], lexical_ids: list[UUID]) -> list[UUID]:
    score: dict[UUID, float] = defaultdict(float)
    for ranking in (vector_ids[:40], lexical_ids[:40]):
        for rank, chunk_id in enumerate(ranking, start=1):
            score[chunk_id] += 1.0 / (60 + rank)
    return sorted(score, key=lambda item: (-score[item], str(item)))
```

Run RLS-visible exact cosine search and lexical search independently, then enforce 8 total, 3 per Artifact, 32 KiB, and 4096 tokens after RRF. Test stable tie-breaking, Chinese/English lexical fallback, dense-only and lexical-only hits, duplicate chunks, and empty result.

- [ ] **Step 3: Enforce Session-specific scope**

Project Session ignores no caller-selected projects and rejects private flags. Private Session requires at least one explicit scope selector, deduplicates at most 20 UUIDs, authorizes every project before any search, and never falls back to all visible projects.

- [ ] **Step 4: Issue and verify receipts**

Receipt payload binds actor, Session, tool call, kind, normalized scope hash, query hash, permission revision, returned project IDs or generation/chunk IDs, public payload hash, issued/expiry time, and one logical consumption key. Sign it with the existing trusted Host/FastAPI key boundary; persist only its digest and claims needed for atomic consumption.

- [ ] **Step 5: Verify audit minimization and reauthorization**

```bash
pnpm run api:test -- tests/retrieval tests/api/test_internal_retrieval.py tests/security/test_retrieval_audit.py
```

Expected: raw query, content, embedding, prompt, answer, URL, receipt, signature, and object Key never appear in audit/log fixtures; revocation and permission revision drift fail at all authorization endpoints.

- [ ] **Step 6: Commit retrieval APIs**

```bash
git add services/api/app/schemas/retrieval.py services/api/app/services/retrieval.py services/api/app/services/retrieval_receipts.py services/api/app/api/routes/internal_retrieval.py services/api/app/main.py services/api/app/services/authorization.py services/api/app/services/audit.py services/api/tests
git commit -m "feat: add xagent hybrid retrieval api"
```

### Task 5: Extend Delegation Tokens and the Strict Backend Client

**Files:**

- Modify: `packages/xagent/delegation-token/src/types.ts`
- Modify: `packages/xagent/delegation-token/src/index.ts`
- Modify: `packages/xagent/delegation-token/tests/delegation-token.spec.ts`
- Modify: `packages/xagent/backend-client/src/types.ts`
- Modify: `packages/xagent/backend-client/src/index.ts`
- Modify: `packages/xagent/backend-client/tests/backend-client.spec.ts`
- Modify: `packages/xagent/backend-client/README.md`
- Modify: `packages/xagent/backend-client/architecture.md`

**Interfaces — Consumes:** existing Ed25519 issuer/audience/nonce contract and FastAPI retrieval wire.

**Interfaces — Produces:** canonical `RetrievalDelegationScope`; strict `XAgentRetrievalBackend`; endpoint-specific status/error/schema validation with existing response caps and merged abort signals.

- [ ] **Step 1: Write multi-project scope and wire-schema RED tests**

```bash
CI=true corepack pnpm exec vitest run packages/xagent/delegation-token/tests packages/xagent/backend-client/tests/backend-client.spec.ts
```

Expected: tests fail because delegation accepts only one `projectId` and the backend exposes no retrieval client.

- [ ] **Step 2: Add canonical retrieval delegation claims**

```ts
interface DelegationBase {
  readonly actorId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly permissionRevision: number
}

interface SingleProjectDelegationScope extends DelegationBase {
  readonly projectId: string | null
  readonly retrieval?: never
}

interface RetrievalDelegationScope extends DelegationBase {
  readonly projectId: null
  readonly retrieval: {
    readonly projectIds: readonly string[]
    readonly includePrivate: boolean
    readonly scopeHash: string
  }
}

export type DelegationScope =
  | SingleProjectDelegationScope
  | RetrievalDelegationScope
```

Sort and deduplicate project UUIDs before signing, cap at 20, bind tool name and call ID, reject unknown claims, require exact expected scope/hash, and retain the existing 60-second maximum plus single-use nonce.

- [ ] **Step 3: Add strict retrieval parsers and methods**

The client must expose `projects`, `search`, `authorizeCitations`, and `resolveCitation`; reject unknown/sensitive fields, unsafe integers, malformed UUID/date/hash, duplicate citations, oversized arrays/text, wrong endpoint status, and non-closed error codes.

- [ ] **Step 4: Verify no regressions and commit**

```bash
CI=true corepack pnpm exec vitest run packages/xagent/delegation-token/tests packages/xagent/backend-client/tests/backend-client.spec.ts
corepack pnpm run typecheck
git add packages/xagent/delegation-token packages/xagent/backend-client
git commit -m "feat: add xagent retrieval backend client"
```

### Task 6: Create the Host Retrieval Service, Receipt Registry, and Model Tools

**Files:**

- Create: `packages/xagent/retrieval/package.json`
- Create: `packages/xagent/retrieval/tsconfig.json`
- Create: `packages/xagent/retrieval/src/index.ts`
- Create: `packages/xagent/retrieval/src/types.ts`
- Create: `packages/xagent/retrieval/src/receipt-registry.ts`
- Create: `packages/xagent/retrieval/src/invariant.ts`
- Create: `packages/xagent/retrieval/tests/retrieval.spec.ts`
- Create: `packages/xagent/retrieval/tests/receipt-registry.spec.ts`
- Create: `packages/xagent/retrieval/tests/invariant.spec.ts`
- Create: `packages/xagent/tool-retrieval/package.json`
- Create: `packages/xagent/tool-retrieval/tsconfig.json`
- Create: `packages/xagent/tool-retrieval/src/index.ts`
- Create: `packages/xagent/tool-retrieval/tests/tool-retrieval.spec.ts`
- Modify: `packages/xagent/principal/src/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces — Consumes:** authenticated request scope, Session visibility/project, backend retrieval client, delegation signer, `tools/post-execute`, Session events.

**Interfaces — Produces:** `XAgentRetrieval` service; request-scoped `listAccessibleProjects` and `searchArtifacts`; quiescent in-memory `XAgentReceiptRegistry`; model tools `list_accessible_projects` and `search_artifacts`.

- [ ] **Step 1: Write service, lifecycle, and tool RED tests**

```bash
CI=true corepack pnpm exec vitest run packages/xagent/retrieval/tests packages/xagent/tool-retrieval/tests
```

Expected: package imports fail and no retrieval tools or receipt registry are installed.

- [ ] **Step 2: Implement request and Session scope fail-close**

Each operation reads the physical Principal, user token, connection ID, Session ID／visibility／project and tool call ID from the same async scope. It issues one exact delegation token and calls FastAPI once. Missing service, auth, Session, signer, or scope returns a stable failure without partial project results.

- [ ] **Step 3: Implement the receipt registry before materializing results**

```ts
function materializeRetrievalResult(input: {
  registry: {
    register(value: { sessionId: string; toolCallId: string; receipt: string; payloadHash: string }): void
  }
  sessionId: string
  toolCallId: string
  receipt: string
  payloadHash: string
  modelVisibleResult: string
  citations: readonly { readonly id: string }[]
}) {
  input.registry.register({
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    receipt: input.receipt,
    payloadHash: input.payloadHash,
  })
  return {
    content: [{ type: 'text' as const, text: input.modelVisibleResult }],
    meta: { kind: 'xagent-retrieval', payloadHash: input.payloadHash, citations: input.citations },
  }
}
```

The opaque receipt must not enter `content` or `meta`. Register before returning the tool result; bind it when the matching `tool/result` Session event is observed; expose append sidecars only to Session persistence; remove only after confirmed append. Dispose blocks new work, clears secrets, aborts active calls, and awaits settlement.

- [ ] **Step 4: Implement closed tool schemas and prompts**

`list_accessible_projects` accepts no scope arguments. `search_artifacts` accepts `query`, `project_ids?`, `include_private?`; reject more than 20 projects, duplicates after canonicalization, empty query, >512 tokens, Project Session scope overrides, and implicit all-project requests. Tool descriptions instruct the model to ask the user when scope is ambiguous.

- [ ] **Step 5: Prove cancellation, account isolation, and no receipt leakage**

```bash
CI=true corepack pnpm exec vitest run packages/xagent/retrieval/tests packages/xagent/tool-retrieval/tests packages/xagent/authorization/tests
corepack pnpm run typecheck
```

- [ ] **Step 6: Generate only the new workspace importers and commit**

```bash
corepack pnpm install --lockfile-only --offline
git diff -- pnpm-lock.yaml
git add packages/xagent/retrieval packages/xagent/tool-retrieval packages/xagent/principal pnpm-lock.yaml
git commit -m "feat: add xagent retrieval tools"
```

Expected lock diff: only the two new package importers and their exact workspace links; no peer snapshot drift.

### Task 7: Make Session Append Consume Receipt Sidecars Atomically

**Files:**

- Modify: `services/api/app/schemas/xagent_sessions.py`
- Modify: `services/api/app/services/xagent_sessions.py`
- Modify: `services/api/app/api/routes/internal_sessions.py`
- Modify: `services/api/tests/api/test_xagent_sessions.py`
- Create: `services/api/tests/api/test_retrieval_session_append.py`
- Create: `services/api/tests/api/test_retrieval_append_concurrency.py`
- Modify: `packages/xagent/backend-client/src/types.ts`
- Modify: `packages/xagent/backend-client/src/index.ts`
- Modify: `packages/xagent/backend-client/tests/backend-client.spec.ts`
- Modify: `packages/xagent/session-persistence-api/src/index.ts`
- Modify: `packages/xagent/session-persistence-api/package.json`
- Modify: `packages/xagent/session-persistence-api/tsconfig.json`
- Modify: `packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces — Consumes:** Session append event batch, `retrieval_receipts[]` sidecar, receipt registry, current permissions, Session lock.

**Interfaces — Produces:** atomic receipt admission/consumption, `xagent_session_project_refs`, evidence/discovery event persistence, monotonic citation ordinals, exact idempotent replay; no persisted receipt token.

- [ ] **Step 1: Write transactional append RED tests**

```bash
pnpm run api:test -- tests/api/test_retrieval_session_append.py tests/api/test_retrieval_append_concurrency.py tests/api/test_xagent_sessions.py
CI=true corepack pnpm exec vitest run packages/xagent/session-persistence-api/tests packages/xagent/backend-client/tests/backend-client.spec.ts
```

Expected: append rejects the new sidecar or persists events without receipt admission/checkpoint semantics.

- [ ] **Step 2: Extend append schema with a private sidecar**

```python
class RetrievalReceiptAttachment(BaseModel):
    event_sequence: int
    tool_call_id: str
    receipt: str
    payload_hash: str

class SessionAppendRequest(BaseModel):
    schema_version: Literal[1]
    expected_sequence: int
    idempotency_key: str
    events: list[SessionEventInput]
    retrieval_receipts: list[RetrievalReceiptAttachment] = []
```

Never include sidecars in append responses, open/events reads, stored event payloads, logs, or audit rows.

- [ ] **Step 3: Implement one locked transaction**

Lock the Session row; reauthorize current actor and every referenced project; verify event sequence/call ID/public payload hash against receipt; reserve citation ordinals; write project refs; persist enriched public evidence/discovery metadata; consume receipt; append all events; advance Session version. Any failure rolls back everything. Exact append idempotency replay returns the original result without consuming twice.

- [ ] **Step 4: Wire persistence to the receipt registry**

`XAgentSessionPersistence.flushWrites()` asks the registry for attachments covering the exact batch, sends them beside events, and calls `registry.commit()` only after backend success. A failed append retains the same attachment for exact retry. `session/flush` remains the mandatory checkpoint before the next model request.

- [ ] **Step 5: Prove crash, concurrency, and redaction boundaries**

```bash
pnpm run api:test -- tests/api/test_retrieval_session_append.py tests/api/test_retrieval_append_concurrency.py
CI=true corepack pnpm exec vitest run packages/xagent/session-persistence-api/tests packages/xagent/retrieval/tests/receipt-registry.spec.ts
```

Expected: missing/mismatched/expired/revoked/reused receipts fail; concurrent appends allocate unique monotonic `[资料N]`; gaps are not reused; receipt values never appear in Session reads or logs.

- [ ] **Step 6: Commit the checkpoint boundary**

```bash
git add services/api/app services/api/tests packages/xagent/backend-client packages/xagent/session-persistence-api pnpm-lock.yaml
git commit -m "feat: checkpoint xagent retrieval receipts"
```

### Task 8: Buffer and Validate Evidence-Bearing Answers

**Files:**

- Create: `packages/xagent/retrieval/src/{citation-policy.ts,events.ts}`
- Create: `packages/xagent/retrieval/tests/{citation-policy.spec.ts}`
- Modify: `packages/xagent/retrieval/src/index.ts`
- Modify: `packages/xagent/retrieval/src/types.ts`
- Modify: `packages/xagent/retrieval/README.md`
- Modify: `packages/xagent/retrieval/architecture.md`
- Modify: `packages/session/session-checkpoint-policy/tests/session-checkpoint-policy.spec.ts`

**Interfaces — Consumes:** `llm/stream`, `agent/request-error`, Session citation set, FastAPI `authorizeCitations`, checkpoint flush.

**Interfaces — Produces:** ordinary-chat pass-through stream; bounded evidence-answer buffer; `xagent/citation-correction` log event plus plugin-origin correction `user/message`; one retry; terminal citation failure.

- [ ] **Step 1: Write streaming, invalid-output, and revocation RED tests**

```bash
CI=true corepack pnpm exec vitest run packages/xagent/retrieval/tests/{citation-policy.spec.ts} packages/session/session-checkpoint-policy/tests
```

Expected: evidence-bearing answers stream before validation and no correction/retry policy exists.

- [ ] **Step 2: Implement XAgent-only stream buffering**

Only activate when the current model request contains admitted retrieval evidence. Buffer bounded text and tool chunks; reject unknown/cross-Session/revoked citation IDs and evidence claims without citations; call answer-release authorization immediately before yielding the first buffered chunk. Ordinary requests call `next()` unchanged and preserve streaming.

- [ ] **Step 3: Implement one reconstructable correction retry**

On first invalid output, suppress the assistant draft, append:

1. log-only `xagent/citation-correction` with draft hash, bounded invalid draft, reason and allowed IDs;
2. plugin-origin `user/message` containing bounded correction instructions and allowed IDs so normal Session history reconstruction presents it to the next model call.

Then return structured finish error `CITATION_INVALID`; an XAgent-scoped `agent/request-error` listener retries once. A second invalid output returns `CITATION_FAILED`, records no assistant answer, and surfaces an explicit Chinese failure. The custom event alone must never be treated as model-visible history.

- [ ] **Step 4: Prove checkpoint ordering and cancellation**

```bash
CI=true corepack pnpm exec vitest run packages/xagent/retrieval/tests packages/session/session-checkpoint-policy/tests packages/core/agent-loop/tests
```

Expected: evidence/result checkpoint completes before the next model call; revocation before release suppresses all answer bytes; cancellation clears buffers; non-RAG Agent Loop tests remain unchanged.

- [ ] **Step 5: Commit citation enforcement**

```bash
git add packages/xagent/retrieval packages/session/session-checkpoint-policy/tests
git commit -m "feat: enforce xagent retrieval citations"
```

### Task 9: Add Citation UI and Immutable Locator Navigation

**Files:**

- Create under `packages/xagent/ui-citation`: `package.json`, `tsconfig.json`, `src/client/index.ts`, `src/client/CitationStrip.tsx`, `src/client/citation.module.css`, `src/client/locales.ts`, `tests/citation-strip.client.spec.tsx`, `tests/plugin.client.spec.tsx`
- Modify: `packages/xagent/ui-artifact/src/client/index.ts`
- Modify: `packages/xagent/ui-artifact/src/client/service.ts`
- Modify: `packages/xagent/ui-artifact/src/client/ArtifactPanel.tsx`
- Modify: `packages/xagent/ui-artifact/tests/plugin.client.spec.tsx`
- Modify: `packages/xagent/ui-artifact/tests/artifact-panel.client.spec.tsx`
- Modify: `packages/xagent/ui-artifact/README.md`
- Modify: `packages/xagent/ui-artifact/architecture.md`
- Modify: `pnpm-lock.yaml`

**Interfaces — Consumes:** persisted public citation refs, citation resolve Remote, existing Artifact detail/preview controller and XAgent Slot system.

**Interfaces — Produces:** source strip rendering `[资料N]`; keyboard-accessible citation buttons; `xagent.workbench.artifacts.openCitation(ref)` that reauthorizes, opens exact Artifact Version, and highlights immutable line range.

- [ ] **Step 1: Write rendering and navigation RED tests**

```bash
CI=true corepack pnpm exec vitest run packages/xagent/ui-citation/tests packages/xagent/ui-artifact/tests
```

Expected: citation UI package and `openCitation` service do not exist.

- [ ] **Step 2: Implement the source strip without content caching**

Render only citations referenced by the answer, in first-use order. Buttons expose accessible names with ID, display name and line range. Account/Session switch, unmount, revocation, error, and disposal clear the strip and any resolved preview URL.

- [ ] **Step 3: Implement immutable locator opening**

`openCitation` sends only the citation ID to FastAPI, receives reauthorized Artifact/version/chunk/line metadata, opens the existing detail panel, selects the exact clean Version, and highlights `lineStart..lineEnd`. It never persists or reuses a signed URL; a hidden, revoked, unknown, or cross-Session citation fails closed with a visible Chinese alert.

- [ ] **Step 4: Verify keyboard, narrow-screen, and lifecycle behavior**

```bash
CI=true corepack pnpm exec vitest run packages/xagent/ui-citation/tests packages/xagent/ui-artifact/tests packages/xagent/ui-project/tests
corepack pnpm run typecheck
```

- [ ] **Step 5: Regenerate the exact importer and commit**

```bash
corepack pnpm install --lockfile-only --offline
git diff -- pnpm-lock.yaml
git add packages/xagent/ui-citation packages/xagent/ui-artifact pnpm-lock.yaml
git commit -m "feat: add xagent citation navigation"
```

### Task 10: Compose the Real CPU Retrieval Stack and CI Lane

**Files:**

- Modify: `services/api/compose.yml`
- Modify: `services/api/compose.test.yml`
- Modify: `services/api/.env.example`
- Modify: `services/api/README.md`
- Modify: `services/api/app/cli.py`
- Modify: `services/api/app/worker.py`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `scripts/ci-workflow.spec.ts`
- Create: `services/api/tests/e2e/test_retrieval_pipeline.py`
- Create: `services/api/tests/e2e/test_retrieval_worker_recovery.py`

**Interfaces — Consumes:** PostgreSQL+pgvector image, MinIO, ClamAV, API, artifact/index worker, CPU embedding image and pinned model cache.

**Interfaces — Produces:** healthy six-component retrieval stack; opt-in real pipeline tests; bounded CI `xagent-retrieval-e2e` job; no public embedding port.

- [ ] **Step 1: Write deployment and real-pipeline RED tests**

```bash
CI=true corepack pnpm exec vitest run scripts/ci-workflow.spec.ts
XAGENT_RETRIEVAL_E2E=1 pnpm run api:test -- tests/e2e/test_retrieval_pipeline.py tests/e2e/test_retrieval_worker_recovery.py
```

Expected: Compose lacks pgvector/embedding/index health wiring and CI has no retrieval lane.

- [ ] **Step 2: Add health-ordered CPU services**

PostgreSQL must include pgvector; embedding health must prove model loaded and dimension 1024; worker waits for PostgreSQL, MinIO, ClamAV, migration and embedding health; API waits for embedding health but never receives worker database credentials. Keep the embedding port on the service-only network and give only API and worker its internal origin. The embedding `/token-count` route and API `/internal/xagent/retrieval/token-count` relay accept one closed JSON text field under the same 8 KiB raw UTF-8 and worst-case escaping body limits. The relay requires the exact Host service token, accepts no user or delegation token, uses manual redirects, bounded responses and the configured internal embedding origin, and writes no query audit or log. Embedding uses the exact pinned tokenizer asset without loading the inference model and owns cancelled finite tokenization through thread settlement.

- [ ] **Step 3: Add real pipeline and recovery coverage**

Upload clean bilingual text through the Phase 3B path, wait for indexing, exercise vector and lexical hits, replace with v2 while v1 head remains searchable, verify atomic switch, restart worker during a lease, reclaim expiry, and prove unsupported/binary/quarantined text is never indexed.

- [ ] **Step 4: Run the real stack once and clean it unconditionally**

```bash
docker compose -f services/api/compose.test.yml up -d --build --wait
XAGENT_RETRIEVAL_E2E=1 pnpm run api:test -- tests/e2e/test_retrieval_pipeline.py tests/e2e/test_retrieval_worker_recovery.py
docker compose -f services/api/compose.test.yml down --volumes --remove-orphans
```

Expected: tests pass on CPU; final container, volume and network label queries are empty.

- [ ] **Step 5: Commit deployment and CI**

```bash
git add services/api .github/workflows/ci.yml package.json scripts/ci-workflow.spec.ts
git commit -m "test: verify xagent retrieval stack"
```

### Task 11: Compose Retrieval Only into XAgent Business

**Files:**

- Modify: `packages/bundle/xagent-business/cordis.patch.yml`
- Modify: `packages/bundle/xagent-business/package.json`
- Modify: `packages/bundle/xagent-business/tests/business-closure.spec.ts`
- Modify: `apps/cli/package.json`
- Create: `apps/cli/tests/xagent-retrieval-runtime.e2e.ts`
- Modify: `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`
- Modify: `docs/config-catalog.md`
- Modify: `docs/config-catalog.zh.md`
- Modify: `docs/config-catalog.i18n.yaml`
- Modify: `docs/subsystems/web-server.md`
- Modify: `docs/subsystems/web-server.zh.md`
- Modify: `docs/subsystems/web-server.i18n.yaml`
- Modify: `pnpm-lock.yaml`

**Interfaces — Consumes:** retrieval provider, tool consumer, citation Browser consumer, Artifact citation Slot, backend/embedding configuration.

**Interfaces — Produces:** Business-only Host/Browser composition; Developer/Web/Headless dumps with no retrieval packages, retrieval tools, or retrieval slots; real Loader authentication and keyless tool snapshots.

- [ ] **Step 1: Write composition and non-composition RED tests**

```bash
CI=true corepack pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts apps/cli/tests/xagent-retrieval-runtime.e2e.ts
```

Expected: Business dump lacks retrieval provider/tools/UI; non-Business dump assertions already pass.

- [ ] **Step 2: Mount in dependency order**

Mount retrieval provider after auth/authorization/Session persistence, then tool retrieval, then citation UI after project/artifact UI. Supply the existing backend origin, service token and delegation signing configuration only to Host; the retrieval provider calls the Task 10 relay on that backend origin with the service token. Browser gets no service token, receipt, embedding origin or model credentials, and Host receives no separate tokenizer origin.

- [ ] **Step 3: Verify real Loader and keyless snapshots**

Login through the real Host, create/open private and project Sessions, inspect registered tool schemas, prove Business exposes exactly two retrieval tools, and prove dangerous/write tools remain absent. Run a real bounded Host tokenizer call through the published FastAPI origin to the Compose service-only embedding endpoint; assert exact service-token authentication, wrong and missing token denial, redirect/failure/malformed/oversize closure, cancellation/timeout, and no raw query in logs or audits. Developer/Web/Headless dumps must contain none of the three new packages. JiaxinAgent remains a read-only manifest audit because it has no DSH profile.

- [ ] **Step 4: Run generators, docs gates, and commit**

```bash
corepack pnpm run gen-config-catalog
corepack pnpm run gen-cordis-catalog
corepack pnpm install --lockfile-only --offline
CI=true corepack pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts apps/cli/tests/xagent-retrieval-runtime.e2e.ts
corepack pnpm run doc-sync
git add packages/bundle/xagent-business apps/cli packages/extensions/cordis-client-runner docs/config-catalog* docs/subsystems/web-server* pnpm-lock.yaml
git commit -m "feat: compose xagent retrieval runtime"
```

### Task 12: Prove the Full Browser Flow, Finalize Documentation, and Record the GIF

**Files:**

- Create: `apps/web/tests/xagent-retrieval.e2e.ts`
- Create: `apps/web/tests/xagent-retrieval-support.ts`
- Create: `apps/web/tests/xagent-retrieval-support.spec.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/architecture.zh.md`
- Modify: `packages/xagent/retrieval/README.md`
- Modify: `packages/xagent/retrieval/architecture.md`
- Create: `packages/xagent/tool-retrieval/README.md`
- Create: `packages/xagent/tool-retrieval/architecture.md`
- Create: `packages/xagent/ui-citation/README.md`
- Create: `packages/xagent/ui-citation/architecture.md`
- Move: `.agents/notes/proposed/architecture/2026-08-28-xagent-rag-retrieval.md` to `.agents/notes/implemented/architecture/2026-08-28-xagent-rag-retrieval.md`
- Create: `.agents/notes/implemented/architecture/2026-08-28-xagent-rag-retrieval.zh.md`
- Create: `.agents/notes/implemented/architecture/2026-08-28-xagent-rag-retrieval.i18n.yaml`
- Modify: `scripts/translation-pairing.manifest.json`
- Modify: `docs/i18n/README.md`
- Modify: `docs/i18n/README.zh.md`
- Create: `docs/superpowers/progress/2026-08-28-xagent-phase-4a.md`

**Interfaces — Consumes:** built Business Host/Web, real PostgreSQL/pgvector, MinIO, ClamAV, artifact/index worker, CPU embedding service, real Browser.

**Interfaces — Produces:** end-to-end proof of project/private retrieval, cross-project explicit scope, citations, revocation, retry, account isolation, resource cleanup, documentation and GUI GIF provenance.

- [ ] **Step 1: Write the real Browser RED path**

The test must upload bilingual files into two projects plus private scope, wait for clean/index ready, create a Private Session, prove ambiguous prompt asks for scope, select two projects explicitly, retrieve dense and lexical evidence, display `[资料N]`, open the exact line range, and switch accounts with empty state. Add failure cases for hidden project, permission revocation before answer release, invalid first citation corrected once, invalid second citation explicit failure, and no receipt/query/content leakage in Browser diagnostics.

```bash
CI=true corepack pnpm exec vitest run apps/web/tests/xagent-retrieval-support.spec.ts
CI=true corepack pnpm run build
CI=true corepack pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/xagent-retrieval.e2e.ts
```

Expected RED before final wiring: one or more Browser assertions fail at retrieval/citation behavior, while teardown still removes every owned process/container/volume/network.

- [ ] **Step 2: Close the full flow without fixture shortcuts**

Use real built Host/Web, real API/RLS, real MinIO/ClamAV, real artifact/index worker and real CPU bge-m3 service. Mock only the model stream deterministically so citation-correction branches are repeatable; retrieval data, permissions, checkpoints and Browser UI remain real.

- [ ] **Step 3: Finalize current-state docs and Agent Note**

Document ownership, scope rules, embedding purpose, hybrid ranking, indexing generations, receipt/checkpoint mechanics, citation correction, revocation, deployment, limits and Phase 4B/5 exclusions. Archive no active note unless the archive audit proves its future decision value is exhausted. Convert the proposed Note into a complete implemented English/Chinese/sidecar triplet.

- [ ] **Step 4: Run final verification from the final tree**

```bash
pnpm run api:test -- tests/retrieval tests/api/test_internal_retrieval.py tests/api/test_retrieval_session_append.py tests/services/test_artifact_index_jobs.py tests/services/test_artifact_indexing.py
CI=true corepack pnpm exec vitest run packages/xagent/retrieval/tests packages/xagent/tool-retrieval/tests packages/xagent/ui-citation/tests packages/xagent/ui-artifact/tests packages/xagent/session-persistence-api/tests packages/xagent/backend-client/tests
CI=true corepack pnpm run typecheck
CI=true corepack pnpm run build
CI=true corepack pnpm run lint
CI=true corepack pnpm run hygiene
CI=true corepack pnpm run doc-sync
CI=true corepack pnpm run test:web:built
```

Expected: every command exits 0; any documented skip is pre-existing, explicit and unrelated; constraints/rescope/Knip report zero diagnostics.

- [ ] **Step 5: Record and verify the GUI GIF**

Use `record-browser-gif` against a fresh built real stack and fresh Browser context. Capture login, explicit project discovery, hybrid search, source strip, line-highlight navigation, correction retry, and account isolation. Verify dimensions, frame count, duration, SHA-256, decoded representative frames, no secrets, and zero owned resources. Publish only to a dedicated orphan assets branch when preparing the PR; never merge the asset branch into `main`.

- [ ] **Step 6: Commit Phase 4A completion**

```bash
git add apps/web/tests docs packages/xagent .agents/notes scripts/translation-pairing.manifest.json
git diff --cached --check
git commit -m "feat: complete xagent phase 4a retrieval"
```

## Completion Criteria

- Every clean supported Version either has a durable ready search generation or an explicit failed/dead index state; unfinished generations never replace the prior head.
- Hybrid search obeys exact scope, RLS, bounds and deterministic RRF; no implicit all-project search exists.
- Project discovery and search receipts are consumed atomically with Session events and project refs; no receipt reaches model, Browser, event log, audit or ordinary logs.
- Citation IDs are Session-local, monotonic and immutable; click-through always reauthorizes and resolves exact Version/chunk/line.
- Evidence-bearing answers are released only after citation and permission validation; one correction retry is reconstructable, bounded and failure-closed.
- CPU-only real stack, Loader, Browser, revocation, recovery and account isolation tests pass; all owned resources are removed.
- Only XAgent Business composes retrieval; Developer/Web/Headless/JiaxinAgent remain unchanged.
- Current-state docs, implemented Agent Note, progress report and verified GIF provenance are complete.
