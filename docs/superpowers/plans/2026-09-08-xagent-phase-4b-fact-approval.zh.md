# XAgent Phase 4B：事实提案与审批实施计划

中文 | [English](2026-09-08-xagent-phase-4b-fact-approval.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `xagent-business` 交付第一个受治理的业务写入闭环：Project Session 中的 Agent 提交带类型的项目事实提案，经理异步审核，FastAPI 原子确认不可变事实修订，并把决定恰好一次投影回来源 Session。

**Architecture:** FastAPI/PostgreSQL 是事实、提案、证据、权限、幂等、审计与 Outbox 的唯一真相源。Host 侧 `@xagent/dsh-fact` 通过当前连接派生身份和项目范围，`@xagent/dsh-tool-fact` 只在已认证 Project Session 注册 `propose_fact`，私有 admission receipt 随 Session append sidecar 入账。Browser 侧 `@xagent/dsh-ui-fact` 只经生成的 Remote 读取和决策；Outbox 决定由 Host 在 Session 打开或下一次模型请求前追加为闭合 Session event，但绝不自动启动 Turn。

**Tech Stack:** Python 3.11、FastAPI、SQLAlchemy async、Alembic、PostgreSQL 16、TypeScript、Cordis、Typert、React 18、Vitest、Playwright、Docker Compose。

**Spec:** [Phase 4B 事实提案与审批设计](../specs/2026-09-06-xagent-phase-4b-fact-approval-design.md)

## Global Constraints

- 只在 `xagent-business` 的已认证 Project Session 提供事实写入；Private Session、跨项目 Session、Developer、普通 Web、Headless、JiaxinAgent 与 Code Mode 不出现工具 schema、Remote 或 UI。
- specialist 和 manager 可提案；只有仍有当前项目访问权的 manager 可批准或拒绝；允许自我批准；proposer 只可撤回自己的 pending 提案。
- FastAPI/PostgreSQL 决定 actor、role、project、permission revision、base revision、证据身份和当前 head；Browser、模型及 Host 调用参数不能提供这些授权事实。
- 值是 `text | number | boolean | date` 闭合联合；日期严格为 `YYYY-MM-DD`，number 必须有限，field key、label、值和理由均按规格字节上限在 wire 与 API 边界一致拒绝。
- 每项提案最多 64 个不重复 citation ID；没有证据时必须提供非空 assertion reason，并稳定展示 “No artifact evidence”。
- `prepared` 是五分钟内不可见的内部状态；只有匹配的公开 `tool/result` 与私有 receipt 在同一次 Session append 中成功入账，提案才原子转为 `pending`。
- receipt 只保存摘要并只走 append sidecar；不得进入工具公开结果、Session event、模型内容、Browser 状态、日志或审计。
- public 生命周期固定为 `pending -> confirmed | rejected | withdrawn | conflicted`；终态不可逆，批准没有异步 `executing` 状态。
- 批准使用 serializable 事务；事实 revision、head、proposal 终态、审计和 Outbox 必须全成或全败。head 已变化时只写 `conflicted` 终态、审计和决定 Outbox，不写事实 revision。
- 事实与提案列表每页最多 100 行，Outbox 每次最多 32 行；游标排序必须稳定，不允许未界定的全量读取。
- Outbox admission 与 Session event append 同一事务消费；丢失响应后的相同幂等重放不得产生第二个事件；拉取或 append 取消时不得错误确认。
- 决定事件不会唤醒 Agent；它只在后续用户发起 Turn 的模型请求中出现。Fact UI 直接读取 FastAPI，不依赖 Session 投影延迟。
- 现有 `@deepseek-ai/dsh-user-approval` 保持原样；不能把一次 live-Turn approval 当成业务审批。
- 审计仅写 ID、计数、hash、稳定结果与 latency；不得写事实正文、理由正文、证据正文、token、receipt、URL 或对象 Key。
- 任何 `SessionEventMap` 变化同步更新 TypeScript 与 Python SDK 预期输出；任何产品可见行为同时增加真实 runnable example 的 keyless snapshot。
- 每个非平凡变更维护同 PR 的 active Agent Note；代码、README、architecture、JSDoc、双语文档和生成目录在同一提交阶段同步。
- 每个行为先取得原因精确的 RED，再写最小 GREEN；每个任务独立提交。执行阶段在每次推送前使用 `dsh-pre-push-checks` 选择最小充分检查。
- 本 PR 改变 GUI，最终验收必须使用 `record-browser-gif` 从该 PR 的真实服务与模型路径录制并附上无秘密 GIF。

## Fixed Interfaces and Type Graph

```python
class ProjectFactValueType(str, Enum):
    TEXT = "text"
    NUMBER = "number"
    BOOLEAN = "boolean"
    DATE = "date"

class FactProposalStatus(str, Enum):
    PREPARED = "prepared"
    PENDING = "pending"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    WITHDRAWN = "withdrawn"
    CONFLICTED = "conflicted"
    EXPIRED = "expired"

FACT_FIELD_KEY_MAX_BYTES = 128
FACT_LABEL_MAX_BYTES = 255
FACT_TEXT_MAX_BYTES = 16 * 1024
FACT_REASON_MAX_BYTES = 4 * 1024
FACT_MAX_EVIDENCE = 64
FACT_LIST_PAGE_MAX = 100
FACT_OUTBOX_PAGE_MAX = 32
FACT_RECEIPT_TTL_SECONDS = 5 * 60
```

```ts
export type ProjectFactValue =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'date'; readonly value: string }

export type FactProposalPublicStatus =
  | 'pending'
  | 'confirmed'
  | 'rejected'
  | 'withdrawn'
  | 'conflicted'

export interface ProposeFactInput {
  readonly field_key: string
  readonly label: string
  readonly value: ProjectFactValue
  readonly evidence_ids?: readonly string[]
  readonly assertion_reason?: string
}

export interface ProposeFactResult {
  readonly proposalId: string
  readonly status: 'pending'
}

export interface XAgentFactProposalReceiptAttachment {
  readonly eventSequence: number
  readonly toolCallId: string
  readonly proposalId: string
  readonly receipt: string
  readonly payloadHash: string
}

export interface XAgentFactOutboxAttachment {
  readonly eventSequence: number
  readonly outboxId: string
  readonly payloadHash: string
}

export interface FactProposalDecidedEvent {
  readonly type: 'fact/proposal-decided'
  readonly data: {
    readonly proposalId: string
    readonly projectId: string
    readonly fieldKey: string
    readonly label: string
    readonly status: 'confirmed' | 'rejected' | 'withdrawn' | 'conflicted'
    readonly factRevisionId?: string
    readonly contentRevision?: number
    readonly decisionReason?: string
  }
}
```

Host/API 路径固定为：

```text
POST /internal/xagent/facts/proposals/prepare
POST /internal/xagent/facts/projects/{project_id}/heads/list
POST /internal/xagent/facts/projects/{project_id}/proposals/list
POST /internal/xagent/facts/revisions/{revision_id}
POST /internal/xagent/facts/proposals/{proposal_id}
POST /internal/xagent/facts/proposals/{proposal_id}/approve
POST /internal/xagent/facts/proposals/{proposal_id}/reject
POST /internal/xagent/facts/proposals/{proposal_id}/withdraw
POST /internal/xagent/facts/sessions/{session_id}/outbox/pull
```

新增稳定错误为 `fact-input-invalid`、`fact-evidence-invalid`、`fact-session-invalid`、`fact-receipt-invalid`、`fact-receipt-expired`、`fact-revision-conflict`、`fact-already-decided`；复用 `not-found`、`stale-permission`、`idempotency-conflict` 与 `service-unavailable`。Browser/Host 对未知状态、未知字段或畸形响应一律映射 `service-unavailable`，不得猜测兼容。

---

### Task 1: Freeze the Architecture Note and Add the Fact Schema

**Files:**

- Create: `.agents/notes/proposed/architecture/2026-09-06-xagent-fact-approval.md`
- Create: `.agents/notes/proposed/architecture/2026-09-06-xagent-fact-approval.zh.md`
- Create: `.agents/notes/proposed/architecture/2026-09-06-xagent-fact-approval.i18n.yaml`
- Create: `services/api/alembic/versions/016_xagent_fact_approval.py`
- Create: `services/api/app/models/facts.py`
- Modify: `services/api/app/models/__init__.py`
- Modify: `services/api/alembic/env.py`
- Modify: `services/api/app/core/migration_config.py`
- Modify: `services/api/tests/conftest.py`
- Create: `services/api/tests/security/test_fact_schema.py`
- Create: `services/api/tests/security/test_fact_rls.py`
- Create: `services/api/tests/security/test_fact_grants.py`
- Modify: `scripts/translation-pairing.manifest.json`

**Interfaces — Consumes:** `accounts`, `projects`, `project_members`, `xagent_sessions`, `xagent_session_events`, `xagent_admitted_evidence`, `artifact_text_chunks`, current actor/RLS helpers, app and worker database roles, Alembic revision `015_citation_authorization`.

**Interfaces — Produces:** immutable `project_fact_revisions`, one-head-per-field `project_fact_heads`, `fact_proposals`, exact `fact_proposal_evidence`, digest-only `fact_proposal_receipts`, `fact_operation_idempotency`, single-aggregate `business_outbox`; RLS policies, grants, constraints and downgrade preflight.

- [ ] Write the bilingual active Agent Note before schema code. Record why durable business approval is separate from live user approval, why tool output needs receipt-gated Session admission, why decisions use Outbox projection, and why only one object type is implemented.
- [ ] Add failing migration tests asserting head revision `016_xagent_fact_approval`, all seven relations, closed enums/status checks, non-empty field keys, positive contiguous content revisions, one head per `(project_id, field_key)`, and one Outbox row per terminal proposal.
- [ ] Add failing evidence tests requiring a proposal evidence row to match both the durable admitted-evidence identity and the exact chunk line range. Add the smallest unique key needed on `artifact_text_chunks` for `(id, index_id, line_start, line_end)` and exercise a mismatched line range rejection.
- [ ] Add failing immutability tests proving confirmed revision content and terminal proposal payload/status cannot be updated, while the approved head can only advance to the next revision for the same project and field.
- [ ] Add failing RLS tests for proposer, manager, unrelated project member, revoked membership, guessed IDs, prepared-row product invisibility, manager-without-membership denial, and worker-role denial.
- [ ] Add failing grant tests proving the API role has only required DML and `xagent_worker` has no Fact, proposal, receipt, idempotency or Outbox access.
- [ ] Add a migration downgrade test that succeeds on empty/disposable tables. Add a non-empty-data test asserting downgrade fails before any DDL, leaves revision `016` and all data unchanged, and instructs operators to restore a reviewed backup.
- [ ] Implement SQLAlchemy models and Alembic DDL. Use composite foreign keys so heads cannot cross project/field and evidence cannot cross Session/citation/chunk/line identities.
- [ ] Implement action-aware database audit validation for `fact_*` audit actions with only IDs, counts, SHA-256 hashes, stable outcomes and latency. Reject raw `field_key`, value, label, reasons, evidence text, receipt, token, URL and object key keys.
- [ ] Run `pnpm run api:test:db:up` followed by `pnpm run api:test -- tests/security/test_fact_schema.py tests/security/test_fact_rls.py tests/security/test_fact_grants.py`; expect all selected tests to pass.
- [ ] Run `pnpm run verify-translation-pairing --write .agents/notes/proposed/architecture/2026-09-06-xagent-fact-approval.md`; expect the sidecar to be regenerated.
- [ ] Commit: `feat(xagent-api): add governed fact approval schema`

---

### Task 2: Implement Proposal Preparation and Session Admission

**Files:**

- Create: `services/api/app/schemas/facts.py`
- Create: `services/api/app/services/fact_validation.py`
- Create: `services/api/app/services/fact_receipts.py`
- Create: `services/api/app/services/facts.py`
- Create: `services/api/app/api/routes/internal_facts.py`
- Modify: `services/api/app/main.py`
- Modify: `services/api/app/api/routes/internal_sessions.py`
- Modify: `services/api/app/services/xagent_sessions.py`
- Modify: `services/api/app/services/audit.py`
- Create: `services/api/tests/test_fact_prepare.py`
- Create: `services/api/tests/test_fact_admission.py`
- Modify: `services/api/tests/api/test_internal_sessions.py`

**Interfaces — Consumes:** current service credential, user login and permission revision, Project Session, `propose_fact` delegation, admitted evidence, append idempotency and `tool/result` event sequence.

**Interfaces — Produces:** immutable five-minute `prepared` proposal, opaque receipt returned once per prepare response, public `{proposalId,status:'pending'}` payload, private `fact_proposal_receipts` append attachment, atomic `prepared -> pending` admission.

```python
class FactProposalReceiptAttachment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_sequence: int = Field(ge=1)
    tool_call_id: str
    proposal_id: UUID
    receipt: str
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")

class XAgentSessionAppendRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: int
    expected_sequence: int
    idempotency_key: str
    events: list[XAgentSessionEvent]
    retrieval_receipts: list[RetrievalReceiptAttachment] = []
    fact_proposal_receipts: list[FactProposalReceiptAttachment] = []
    fact_outbox_events: list[FactOutboxAttachment] = []
```

- [ ] Add failing validation tests for invalid regex, byte-boundary UTF-8 label/text/reason values, non-finite numbers, impossible calendar dates, duplicate or 65th evidence ID, missing no-evidence reason, unknown fields and oversized requests.
- [ ] Add failing prepare authorization tests for Private Session, wrong project, revoked login, stale permission, specialist success, manager success and indistinguishable guessed/not-found identities.
- [ ] Add failing exact evidence tests proving only citation IDs durably admitted to the same source Session and fixed project are accepted; current proposer access is rechecked without replacing historical admission authority.
- [ ] Add failing idempotency tests: same actor/operation/key/canonical request returns the same proposal/public payload, different request fails `idempotency-conflict`, and a replay may rotate a fresh private receipt while the proposal remains prepared.
- [ ] Add failing receipt tests for digest-only storage, 32-byte entropy, five-minute expiry, single logical consumption, wrong actor/Session/project/tool call/proposal/event sequence/payload hash, cancellation before append and response-lost append replay.
- [ ] Add failing append rollback tests proving event validation failure leaves the proposal hidden/prepared and receipt unconsumed; successful append persists the public tool result, changes exactly one proposal to pending and consumes the receipt in one transaction.
- [ ] Implement shared canonical JSON hashing and byte-aware Fact validation. Keep internal status and receipt out of public schemas.
- [ ] Implement receipt issue/verify/consume using the Phase 4A digest-derived UUID pattern; never persist plaintext receipt and never log request bodies.
- [ ] Implement `/proposals/prepare`, delegation verification and current RLS authorization. Derive base revision while reading the current head under the transaction.
- [ ] Extend Session append to correlate each attachment with exactly one matching `tool/result` by event sequence and tool call ID, then admit the proposal in the existing append transaction.
- [ ] Add fact audit events for success, replay, expiry, cancellation-before-commit and denial using the Task 1 allowlist.
- [ ] Run `pnpm run api:test -- tests/test_fact_prepare.py tests/test_fact_admission.py tests/api/test_internal_sessions.py`; expect all selected tests to pass.
- [ ] Commit: `feat(xagent-api): admit fact proposals through sessions`

---

### Task 3: Implement Review, Atomic Confirmation, and Outbox

**Files:**

- Modify: `services/api/app/schemas/facts.py`
- Modify: `services/api/app/services/facts.py`
- Modify: `services/api/app/api/routes/internal_facts.py`
- Modify: `services/api/app/services/xagent_sessions.py`
- Create: `services/api/tests/test_fact_queries.py`
- Create: `services/api/tests/test_fact_decisions.py`
- Create: `services/api/tests/test_fact_outbox.py`
- Create: `services/api/tests/test_fact_audit.py`

**Interfaces — Consumes:** pending proposal, current manager and project membership, immutable evidence identities, current Fact head, operation idempotency key, source Session append transaction.

**Interfaces — Produces:** bounded Fact/proposal pages and details, confirmed immutable revisions and heads, rejected/withdrawn/conflicted terminal states, redacted audit rows, ordered decision Outbox and exactly-once `fact/proposal-decided` admission.

```python
async def approve_fact_proposal(
    session: AsyncSession,
    *,
    actor: RequestActor,
    proposal_id: UUID,
    decision_note: str | None,
    idempotency_key: str,
) -> FactProposalDecision:
    """Confirm one proposal in a serializable all-or-nothing transaction."""
```

- [ ] Add failing list/detail tests for stable cursor order, 100-row cap, pending/current separation, typed value decode, revision history, evidence-free marker, exact evidence identities, and hidden prepared/expired rows.
- [ ] Add failing decision authorization tests for specialist rejection, global manager without project membership, revoked manager, stale permission, guessed proposal/revision IDs, self-approval success and evidence reauthorization failure.
- [ ] Add failing withdrawal tests proving only the proposer can withdraw pending, no manager shortcut exists, and all terminal states reject mutation.
- [ ] Add failing serializable concurrency tests: identical approve requests replay the same result; approve-versus-reject and two distinct decisions yield one winner plus `fact-already-decided`; two proposals with the same base revision yield one confirmation and one `fact-revision-conflict`.
- [ ] Add failing atomicity tests that inject failures after revision insert, head update, proposal update, audit and Outbox insert; every failure must roll back all five effects.
- [ ] Add failing outbox tests for 32-row cap, `(created_at,id)` ordering, exactly one row per terminal decision, no Agent wake-up, pull after restart, cancellation before commit, malformed identity failure, and append-response-loss replay.
- [ ] Add failing audit tests for preparation, admission, expiry, withdrawal, approval, rejection, conflict, Fact confirmation, Outbox projection, replay and denial; scan serialized details for all forbidden content and secret fields.
- [ ] Implement bounded query/detail endpoints using RLS-backed current authorization and opaque cursors.
- [ ] Implement withdraw/reject/approve with dedicated operation idempotency. For approval, set transaction isolation to serializable before reads and lock proposal plus current head in deterministic order.
- [ ] Reauthorize evidence against durable admitted evidence and the current reviewer’s artifact RLS before confirmation.
- [ ] Insert `business_outbox` in every terminal decision transaction, including rejected, withdrawn and revision-conflicted outcomes.
- [ ] Implement Outbox pull and Session append admission. Bind payload hash, source Session, proposal, terminal status, Outbox ID and event sequence; mark consumed only in the Session append transaction.
- [ ] Run `pnpm run api:test -- tests/test_fact_queries.py tests/test_fact_decisions.py tests/test_fact_outbox.py tests/test_fact_audit.py`; expect all selected tests to pass.
- [ ] Commit: `feat(xagent-api): confirm facts and project decisions`

---

### Task 4: Extend the Strict Backend Client and Session Protocol

**Files:**

- Modify: `packages/xagent/backend-client/src/types.ts`
- Modify: `packages/xagent/backend-client/src/index.ts`
- Modify: `packages/xagent/backend-client/README.md`
- Modify: `packages/xagent/backend-client/architecture.md`
- Modify: `packages/xagent/backend-client/tests/backend-client.spec.ts`
- Modify: `packages/xagent/session-persistence-api/src/index.ts`
- Modify: `packages/xagent/session-persistence-api/README.md`
- Modify: `packages/xagent/session-persistence-api/architecture.md`
- Modify: `packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts`

**Interfaces — Consumes:** Task 2/3 closed FastAPI JSON, existing authenticated request metadata and CSRF provider, append event range, retrieval receipt sidecar.

**Interfaces — Produces:** strict Fact wire types and errors, bounded endpoint methods, merged private append sidecars, Fact receipt registry and Outbox attachment registration without Session-log exposure.

- [ ] Add failing exact-decoder tests for every Fact value/status/result/detail/page/event. Reject unknown fields, unknown tags/status, invalid dates, non-finite numbers, byte-limit overflow, page overflow and malformed cursors.
- [ ] Add failing request tests proving actor, role, membership, project ownership, permission revision and evidence identities cannot be supplied by Browser methods.
- [ ] Add failing error mapping tests for the fixed Fact errors and unknown backend responses.
- [ ] Add failing append tests proving retrieval receipts, Fact proposal receipts and Fact Outbox attachments can coexist, correlate only within the appended sequence range and commit independently only after a successful response.
- [ ] Add failing secrecy tests scanning encoded public events, backend errors, logs and Session snapshots for receipt/token values.
- [ ] Implement closed types and parsers in `types.ts`/`index.ts`; reuse existing exact-object, UTF-8 byte and bounded-array helpers instead of parallel validation.
- [ ] Add Fact methods for the fixed paths with existing service credential, user token, CSRF, abort signal and timeout ownership.
- [ ] Extend append input and session persistence to ask the optional Fact registry for receipt/Outbox attachments, send them privately, then commit them through the acknowledged sequence only.
- [ ] Preserve zero behavior when `xagentFact` is absent so non-Business profiles serialize the identical append body they use today.
- [ ] Run `pnpm vitest run packages/xagent/backend-client/tests/backend-client.spec.ts packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts`; expect all selected tests to pass.
- [ ] Run `pnpm run typecheck -- --pretty false`; expect no TypeScript errors caused by the new protocol.
- [ ] Commit: `feat(xagent): add strict fact session protocol`

---

### Task 5: Add the Request-Scoped Fact Service Provider

**Files:**

- Create: `packages/xagent/fact/package.json`
- Create: `packages/xagent/fact/tsconfig.json`
- Create: `packages/xagent/fact/README.md`
- Create: `packages/xagent/fact/README.zh.md`
- Create: `packages/xagent/fact/README.i18n.yaml`
- Create: `packages/xagent/fact/architecture.md`
- Create: `packages/xagent/fact/src/index.ts`
- Create: `packages/xagent/fact/src/types.ts`
- Create: `packages/xagent/fact/src/receipt-registry.ts`
- Create: `packages/xagent/fact/src/invariant.ts`
- Create: `packages/xagent/fact/tests/fact.spec.ts`
- Create: `packages/xagent/fact/tests/receipt-registry.spec.ts`
- Create: `packages/xagent/fact/tests/invariant.spec.ts`
- Modify: `tsconfig.host.json`
- Modify: `pnpm-lock.yaml`

**Interfaces — Consumes:** Principal/request scope, fixed Project Session, current user token, backend client Fact methods, checkpoint append range, `agent/pre-step`, Session cancellation and plugin lifecycle.

**Interfaces — Produces:** `XAgentFactService`, Typert Remote, digest-opaque receipt registry, bounded Outbox delivery before later model requests, strict owner cancellation/disposal.

```ts
export interface XAgentFactService {
  proposeFact(input: {
    readonly sessionId: string
    readonly toolCallId: string
    readonly fieldKey: string
    readonly label: string
    readonly value: ProjectFactValue
    readonly evidenceIds: readonly string[]
    readonly assertionReason?: string
    readonly signal?: AbortSignal
  }): Promise<{ readonly proposalId: string; readonly status: 'pending' }>
}
```

- [ ] Create package tests first and obtain RED for service registration, authenticated Project scope derivation, Private/anonymous denial and absent-plugin invariant.
- [ ] Add failing delegation tests asserting exact actor, Session, fixed project, `propose_fact`, tool call, permission revision, nonce and 60-second expiry; reject caller-supplied authority fields.
- [ ] Add failing registry tests for duplicate registration, bind-before-register, out-of-range sequence, partial append, successful commit, failed append retention, Session replacement and zero-secret disposal.
- [ ] Add failing lifecycle tests proving owner rejects new work before abort, awaits in-flight settlement, clears scope synchronously and discards late response on account/project/Session/plugin changes.
- [ ] Add failing Outbox tests proving delivery runs when a source Session opens and before `agent/pre-step`, appends at most 32 ordered events, never calls loop execution, and retries only unconsumed rows after restart.
- [ ] Implement `XAgentFactService` as a Service Definition/Provider seam with AsyncLocalStorage request context matching existing Project and Artifact providers.
- [ ] Implement Remote list/detail/approve/reject/withdraw methods that derive identity from the physical connection and create a fresh idempotency key only for a newly initiated UI operation.
- [ ] Implement receipt registry and private append attachment hooks; expose no receipt-bearing method over Typert.
- [ ] Implement Outbox pull/projection as a Session lifecycle effect and `agent/pre-step` effect. Use one owner per active Session and ensure duplicate triggers coalesce without dropping a later pull.
- [ ] Implement package invariant over actual registered service, Remote and active Session ownership relationships.
- [ ] Run `pnpm vitest run packages/xagent/fact/tests`; expect all Fact provider tests to pass with per-file source coverage prepared for the CI gate.
- [ ] Run `pnpm run typecheck -- --pretty false`; expect the Host face to compile.
- [ ] Commit: `feat(xagent): add governed fact provider`

---

### Task 6: Add the Project-Only `propose_fact` Consumer

**Files:**

- Create: `packages/xagent/tool-fact/package.json`
- Create: `packages/xagent/tool-fact/tsconfig.json`
- Create: `packages/xagent/tool-fact/README.md`
- Create: `packages/xagent/tool-fact/README.zh.md`
- Create: `packages/xagent/tool-fact/README.i18n.yaml`
- Create: `packages/xagent/tool-fact/architecture.md`
- Create: `packages/xagent/tool-fact/src/index.ts`
- Create: `packages/xagent/tool-fact/src/invariant.ts`
- Create: `packages/xagent/tool-fact/tests/tool-fact.spec.ts`
- Create: `packages/xagent/tool-fact/tests/invariant.spec.ts`
- Modify: `packages/xagent/retrieval/tests/cited-answer-policy.spec.ts`
- Modify: `tsconfig.host.json`
- Modify: `pnpm-lock.yaml`

**Interfaces — Consumes:** `XAgentFactService`, current authenticated Project request scope, Agent scoped tool registry, exact tool call ID, retrieval cited-answer policy.

**Interfaces — Produces:** native-only `propose_fact` schema with generic render intent, minimal public result, private receipt registration, no Private/Code Mode/non-Business schema.

```ts
const proposeFactTool = {
  name: 'propose_fact',
  nativeOnly: true,
  render: { intent: 'generic' as const },
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['field_key', 'label', 'value'],
    properties: {
      field_key: { type: 'string' },
      label: { type: 'string' },
      value: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'value'],
            properties: { type: { const: 'text' }, value: { type: 'string' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'value'],
            properties: { type: { const: 'number' }, value: { type: 'number' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'value'],
            properties: { type: { const: 'boolean' }, value: { type: 'boolean' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'value'],
            properties: { type: { const: 'date' }, value: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
          },
        ],
      },
      evidence_ids: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string' } },
      assertion_reason: { type: 'string' },
    },
  },
}
```

- [ ] Add failing assembled tool-schema tests proving registration only for an authenticated Project Session in Native mode and immediate disposal when scope becomes Private, anonymous, different Session or Code Mode.
- [ ] Add failing JSON schema tests for the closed tagged value union, additional fields, 64 evidence IDs, and conditional assertion reason behavior. Keep backend byte validation authoritative for UTF-8 limits.
- [ ] Add failing execution tests proving the Consumer derives Session/tool call, passes cancellation, returns only `{proposalId,status:'pending'}` and registers the private receipt without exposing it to model-visible tool output.
- [ ] Add failing cancellation tests for disposal during prepare and during receipt registration; a prepared proposal without successful append remains hidden until expiry.
- [ ] Add failing interaction tests where a Turn both searches artifacts and proposes a fact: proposal tool success does not conclude the Turn, and the existing structured cited-answer policy still requires a valid cited final answer.
- [ ] Add failing tests proving an evidence-free proposal with a reason succeeds and retains stable UI metadata, while missing reason yields `fact-input-invalid`.
- [ ] Implement scoped registration through `agent.ctx.tools.register()` and return its disposer from the owning effect.
- [ ] Implement the tool with no hardcoded deployment tunables and concise JSDoc for model-visible fields and public result.
- [ ] Implement relationship-based invariant for the tool registration and Fact service rather than method-presence checks.
- [ ] Run `pnpm vitest run packages/xagent/tool-fact/tests packages/xagent/retrieval/tests/cited-answer-policy.spec.ts`; expect all selected tests to pass.
- [ ] Commit: `feat(xagent): add project fact proposal tool`

---

### Task 7: Add the Fact Workbench UI

**Files:**

- Create: `packages/xagent/ui-fact/package.json`
- Create: `packages/xagent/ui-fact/tsconfig.json`
- Create: `packages/xagent/ui-fact/tsdown.config.ts`
- Create: `packages/xagent/ui-fact/README.md`
- Create: `packages/xagent/ui-fact/README.zh.md`
- Create: `packages/xagent/ui-fact/README.i18n.yaml`
- Create: `packages/xagent/ui-fact/architecture.md`
- Create: `packages/xagent/ui-fact/src/index.ts`
- Create: `packages/xagent/ui-fact/src/invariant.ts`
- Create: `packages/xagent/ui-fact/src/{client/index.ts}`
- Create: `packages/xagent/ui-fact/src/{client/service.ts}`
- Create: `packages/xagent/ui-fact/src/{client/store.ts}`
- Create: `packages/xagent/ui-fact/src/{client/FactPanel.tsx}`
- Create: `packages/xagent/ui-fact/src/{client/FactDetail.tsx}`
- Create: `packages/xagent/ui-fact/src/{client/FactToolCard.tsx}`
- Create: `packages/xagent/ui-fact/src/{client/locales.ts}`
- Create: `packages/xagent/ui-fact/src/{client/fact.module.css}`
- Create: `packages/xagent/ui-fact/tests/plugin.client.spec.tsx`
- Create: `packages/xagent/ui-fact/tests/store.client.spec.ts`
- Create: `packages/xagent/ui-fact/tests/fact-panel.client.spec.tsx`
- Create: `packages/xagent/ui-fact/tests/styles.client.spec.ts`
- Modify: `packages/xagent/ui-project/src/client/WorkbenchDetails.tsx`
- Modify: `packages/xagent/ui-project/src/client/service.ts`
- Modify: `packages/xagent/ui-project/src/client/locales.ts`
- Modify: `packages/xagent/ui-project/README.md`
- Modify: `packages/xagent/ui-project/architecture.md`
- Modify: `packages/xagent/ui-project/tests/details.client.spec.tsx`
- Modify: `tsconfig.client.json`
- Modify: `pnpm-lock.yaml`

**Interfaces — Consumes:** generated Fact Remote, authenticated workbench project scope, `xagent.workbench.facts` slot, existing artifact citation opener, connection/account/project/Session lifecycle.

**Interfaces — Produces:** Business Facts tab, current heads and pending review list, typed detail/history, role-aware approve/reject/withdraw actions, proposal Tool renderer, exact immutable evidence navigation.

- [ ] Add the `facts` workbench tab and empty slot behavior to ui-project tests first. Verify profiles without an occupant keep a stable empty row and no Fact Remote call.
- [ ] Add failing store tests for current heads, pending proposals, 100-row pagination, stable cursors, typed values, conflict results, detail refresh and late-result rejection.
- [ ] Add failing role/action tests: specialist sees status only, manager with project access sees approve/reject, proposer sees withdraw, self-approval works, duplicate submit is disabled and losing permission resolves to unavailable without leaking identifiers.
- [ ] Add failing detail tests for label/field key, revision history, proposer/confirmer, assertion reason, evidence-free “No artifact evidence” and evidence links that call the existing opener with exact Artifact/Version/Chunk/line identity.
- [ ] Add failing lifecycle tests for connection replacement, account/project/Session switch and plugin disposal. Clear owned state synchronously, abort HTTP and ignore late completion.
- [ ] Add failing persistence tests proving localStorage/sessionStorage/IndexedDB contain no Fact cache, fact value, reason, receipt, token, object key, URL or evidence payload.
- [ ] Add keyboard and accessible-name tests for tabs, list items, dialogs, decision note/rejection reason, confirmation and error states.
- [ ] Implement the dedicated slot, localized UI and CSS using existing workbench typography/tokens. Keep state scoped to the active connection/project/Session and memory-only.
- [ ] Implement approve/reject/withdraw with one operation idempotency key per user initiation; retain the same key for explicit retry after transport uncertainty.
- [ ] Implement `FactToolCard` from server proposal ID/status only; never infer approval from tool arguments or model text.
- [ ] Implement UI invariant over registered slot/renderer/service relationships.
- [ ] Run `pnpm vitest run packages/xagent/ui-project/tests/details.client.spec.tsx packages/xagent/ui-fact/tests`; expect all selected client tests to pass.
- [ ] Run `pnpm run typecheck -- --pretty false`; expect Client and Host faces to compile.
- [ ] Commit: `feat(xagent): add fact review workbench`

---

### Task 8: Assemble Business, Session Projection, Snapshots, and Documentation

**Files:**

- Modify: `packages/bundle/xagent-business/cordis.patch.yml`
- Modify: `packages/bundle/xagent-business/package.json`
- Modify: `packages/bundle/xagent-business/README.md`
- Modify: `packages/bundle/xagent-business/src/invariant.ts`
- Modify: `packages/bundle/xagent-business/tests/business-closure.spec.ts`
- Modify: `packages/xagent/fact/src/types.ts`
- Modify: `packages/xagent/fact/tests/fact.spec.ts`
- Modify: `packages/sdk/client/tests/fake-runtime.ts`
- Modify: `packages/sdk/client/tests/sdk-client.spec.ts`
- Modify: `python/sdk/tests/test_client.py`
- Create: `apps/cli/tests/xagent-fact-runtime.e2e.ts`
- Create: `examples/headless-agent/tests/xagent-fact-approval.snapshot.ts`
- Create: `examples/headless-agent/tests/fixtures/xagent/fact/cordis.yml`
- Create: `examples/headless-agent/tests/fixtures/xagent/fact/driver.ts`
- Create: `examples/headless-agent/tests/fixtures/xagent/fact/fact-approval.expected.jsonl`
- Modify: `packages/xagent/README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/architecture.zh.md`
- Create: `docs/superpowers/progress/2026-09-08-xagent-phase-4b.md`
- Create: `docs/superpowers/progress/2026-09-08-xagent-phase-4b.zh.md`
- Create: `docs/superpowers/progress/2026-09-08-xagent-phase-4b.i18n.yaml`
- Modify: `docs/tool-catalog.md`
- Modify: `docs/persistence-catalog.md`
- Modify: `docs/capability-seams.md`
- Modify: `docs/event-producer-consumer.md`
- Modify: `docs/graph-atlas.md`
- Modify: `docs/module-graph.md`
- Modify: `docs/cordis-api/inherited.md`
- Modify: `packages/core/session/src/known-event-types.ts`
- Modify: `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`
- Modify: `packages/extensions/tool-cordis/src/api-catalog.ts`

**Interfaces — Consumes:** Fact provider/tool/UI packages, Business bundle resolver, closed `SessionEventMap`, real Agent loop, current snapshot harness, documentation projection.

**Interfaces — Produces:** Business-only assembled capability, durable ignorable-compatible decision event, TypeScript/Python SDK projections, keyless real-loop transcript, current-state architecture and Phase 4B progress record.

- [ ] Add failing bundle-closure tests asserting Fact Provider and tool exist on Host, Fact UI exists on Browser, generated Remote connects them, and no Fact package/schema/UI row appears in Developer/Web/Headless/JiaxinAgent or Code Mode.
- [ ] 由 `@xagent/dsh-fact` 通过声明合并把 `fact/proposal-decided` 加入 `SessionEventMap`，作为 required-on-read 闭合事件并更新模型投影；补齐 `@mode`、payload `@param` 与所需 scope scan 注解，不得为插件行为修改核心 Agent loop。
- [ ] Add failing Session replay tests for all four terminal statuses, exact ordering with adjacent user/tool events, no automatic Agent wake-up and exactly-once model visibility on the next user-initiated Turn.
- [ ] 用同一个决定 payload 扩展 TypeScript SDK fake runtime／预期事件断言与 Python SDK fake runtime／预期事件断言，再运行两套专属客户端测试。
- [ ] Add a keyless runnable Business scenario using the real Agent loop: admitted evidence plus `propose_fact`, no-evidence proposal with reason, tool result admission, later decision event, and cited final-answer enforcement.
- [ ] Assemble packages in `xagent-business` only, add exact resolver dependencies and update lockfile. Do not use conditional runtime defaults to hide missing packages.
- [ ] Update package/root architecture and README prose in present tense, with one home per fact. Document authorization, admission, decision/outbox timing, UI visibility, cancellation and data rollback.
- [ ] Write the Phase 4B progress record with landed commits, remaining real-browser proof and exact verification commands; do not narrate reasoning or review history.
- [ ] Move the Agent Note from `proposed/architecture` to `implemented/architecture` only after the assembled keyless path is green, preserving its bilingual triplet and regenerating the manifest.
- [ ] Run `pnpm run test:snapshot -- -t "fact proposal approval"`; expect the keyless transcript to match its checked-in snapshot.
- [ ] 运行聚焦的 bundle、Fact event、`packages/sdk/client/tests/sdk-client.spec.ts`、`python/sdk/tests/test_client.py`、CLI 与 headless snapshot 测试；预期所有选中测试通过。
- [ ] Run `pnpm run doc-sync`; expect translation pairing, projected docs, catalogs, JSDoc and document budgets to pass.
- [ ] Commit: `feat(xagent): assemble fact approval in business`

---

### Task 9: Prove the Built Browser Flow and Prepare the PR

**Files:**

- Create: `apps/web/tests/xagent-fact-support.ts`
- Create: `apps/web/tests/xagent-fact-support.spec.ts`
- Create: `apps/web/tests/xagent-fact.e2e.ts`
- Create: `apps/web/tests/snapshots/xagent-fact-approval/` fixtures selected by the Browser harness
- Modify: `docs/superpowers/progress/2026-09-08-xagent-phase-4b.md`

**外部产物：** PR 描述，以及由 `record-browser-gif` 工作流生成的专用 GIF assets 分支。

**Interfaces — Consumes:** built Browser bundle, real FastAPI/PostgreSQL RLS, two authenticated accounts, Project Session, admitted artifact evidence, built Host, Fact Remote/UI, restartable test services.

**Interfaces — Produces:** deterministic real-stack E2E evidence, restart/replay proof, secret-clean GUI GIF attached to the PR, minimal sufficient pre-push verification record.

- [ ] Add support-unit tests before E2E code for deterministic account/project/artifact/session setup, evidence admission, service restart, manager/specialist switching and cleanup.
- [ ] Add the built Browser E2E and obtain RED for: specialist evidence-backed proposal, manager self-approval, evidence-free proposal with assertion reason, competing stale proposal conflict, exact revision history, citation opener, restart before decision delivery, and exactly-once Session/UI replay.
- [ ] Add negative Browser checks for Private Session, Code Mode, Developer/Web/Headless profiles, revoked manager membership, guessed proposal ID and duplicate decision submission.
- [ ] Ensure the test observes real PostgreSQL RLS and HTTP/Remote traffic; do not stub Fact endpoints, Session append or Agent loop.
- [ ] Prove no automatic Turn begins when the manager decides. Then initiate the next user Turn and assert the decision event appears once in model input.
- [ ] Restart Browser/Host/FastAPI at the specified checkpoints and prove pending proposals, confirmed heads, unconsumed Outbox and already-consumed event identities recover without duplication.
- [ ] Run `pnpm vitest run apps/web/tests/xagent-fact-support.spec.ts`; expect support tests to pass.
- [ ] Run the repository’s focused built Browser command for `apps/web/tests/xagent-fact.e2e.ts`; expect the real two-account flow to pass.
- [ ] Invoke the `record-browser-gif` skill against this PR’s real built server/model flow. Record proposal, manager approval, Fact revision and Session replay; inspect every frame for tokens, receipts, object keys, private URLs and test credentials before publishing the optimized GIF to its dedicated assets branch and attaching it to the PR.
- [ ] Invoke `dsh-pre-push-checks` and run only the smallest commands covering the outgoing diff, including focused Vitest/API/Browser tests, `pnpm run typecheck`, `pnpm run lint`, `pnpm run build`, `pnpm run hygiene`, `pnpm run doc-sync`, and `git diff --cached --check` when selected by the skill. Report exactly the commands actually run.
- [ ] Invoke `superpowers:requesting-code-review`; resolve every Critical/Important finding with another RED/GREEN cycle and rerun only invalidated checks.
- [ ] Update the progress record with final commit IDs, real E2E/GIF links and commands actually passed.
- [ ] Commit: `test(xagent): prove fact approval end to end`
- [ ] Push the Phase 4B branch, confirm PR base/head and labels, wait for required GitHub checks, and do not mark ready or merge until the official stack and CI state are green.

## Plan Self-Review Checklist

- [ ] Every confirmed product decision in the design appears in Global Constraints or an executable task.
- [ ] Every new wire field has one producer, one consumer, one strict decoder and one failure test.
- [ ] Every authoritative relation has RLS, grants, foreign keys, immutability and downgrade behavior.
- [ ] Every irreversible operation has idempotency, cancellation, concurrency, audit and rollback coverage.
- [ ] Every public event has Session replay, model projection, TypeScript SDK and Python SDK coverage.
- [ ] Every profile inclusion has a matching negative profile assertion.
- [ ] 扫描计划中的未完成标记、占位语和省略式实现说明；除这条检查本身外必须为零。
- [ ] Search code snippets and named interfaces for inconsistent status, path, field or error names; resolve all mismatches before Task 1.
- [ ] Confirm the final GUI proof uses the reviewed revision’s real server and model flow and contains no secrets.
