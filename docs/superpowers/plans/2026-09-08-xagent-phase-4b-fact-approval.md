# XAgent Phase 4B Fact Proposal and Approval Implementation Plan

English | [中文](2026-09-08-xagent-phase-4b-fact-approval.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first governed business write in `xagent-business`: an Agent in a Project Session submits a typed project Fact proposal, a manager reviews it asynchronously, FastAPI atomically confirms an immutable Fact revision, and the decision is projected exactly once into the source Session.

**Architecture:** FastAPI/PostgreSQL is the only source of truth for Facts, proposals, evidence, authorization, idempotency, audit, and Outbox delivery. Host package `@xagent/dsh-fact` derives identity and project scope from the current physical connection. `@xagent/dsh-tool-fact` registers `propose_fact` only in an authenticated Project Session, and admits its private receipt through a Session append sidecar. Browser package `@xagent/dsh-ui-fact` reads and decides only through the generated Remote. The Host appends closed Outbox decision events when the Session opens or before its next model request, but never starts a Turn automatically.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy async, Alembic, PostgreSQL 16, TypeScript, Cordis, Typert, React 18, Vitest, Playwright, and Docker Compose.

**Spec:** [Phase 4B Fact Proposal and Approval Design](../specs/2026-09-06-xagent-phase-4b-fact-approval-design.md)

## Global Constraints

- Fact writes exist only in authenticated Project Sessions assembled by `xagent-business`. Private and cross-project Sessions, Developer, ordinary Web, Headless, JiaxinAgent, and Code Mode expose no Fact tool schema, Remote, or UI.
- Specialists and managers may propose. Only a manager with current project access may approve or reject. Self-approval is valid. Only the proposer may withdraw their pending proposal.
- FastAPI/PostgreSQL derives actor, role, project, permission revision, base revision, evidence identity, and current head. Browser, model, and Host request arguments never supply these authorization facts.
- Values form the closed `text | number | boolean | date` union. Dates are exact `YYYY-MM-DD`, numbers are finite, and wire/API validation enforces the specification's byte limits for field keys, labels, values, and reasons.
- A proposal accepts at most 64 distinct citation IDs. A proposal with no evidence requires a non-empty assertion reason and always displays “No artifact evidence.”
- `prepared` is an internal state hidden for at most five minutes. A proposal becomes `pending` only when the matching public `tool/result` and private receipt are admitted atomically by Session append.
- Receipts are stored only as digests and travel only through the append sidecar. They never enter public tool results, Session events, model content, Browser state, logs, or audit.
- The public lifecycle is exactly `pending -> confirmed | rejected | withdrawn | conflicted`. Terminal states are immutable and approval has no asynchronous `executing` state.
- Approval uses a serializable transaction. Fact revision, head, proposal state, audit, and Outbox all commit or all roll back. A changed head creates a `conflicted` decision, audit, and Outbox row but no Fact revision.
- Fact and proposal pages contain at most 100 rows. Outbox pulls contain at most 32 rows and use stable cursor order.
- Outbox consumption and Session event append occur in one transaction. Replaying the same append after a lost response cannot add a second event. Cancellation cannot acknowledge an uncommitted event.
- Decision events never wake the Agent. They enter model input only on a later user-initiated Turn. Fact UI reads FastAPI directly and does not wait for Session projection.
- Existing `@deepseek-ai/dsh-user-approval` behavior remains unchanged and never authorizes a durable business proposal.
- Audit contains only IDs, counts, hashes, stable outcomes, and latency. It excludes Fact text, reason text, evidence text, token, receipt, URL, and object key.
- Any `SessionEventMap` change updates both TypeScript and Python SDK expected output. Any product-visible behavior adds a keyless snapshot through a real runnable example.
- Every non-trivial change maintains an active Agent Note in the same PR. Code, README, architecture, JSDoc, bilingual docs, and generated catalogs move together.
- Each behavior starts with a precise RED test and receives the smallest GREEN implementation. Each task ends in a separate commit. Before every push, use `dsh-pre-push-checks` to select the smallest sufficient checks.
- This PR changes GUI behavior, so final acceptance must use `record-browser-gif` against the PR's real server and model flow and attach a secret-free GIF.

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

The fixed Host/API paths are:

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

New stable errors are `fact-input-invalid`, `fact-evidence-invalid`, `fact-session-invalid`, `fact-receipt-invalid`, `fact-receipt-expired`, `fact-revision-conflict`, and `fact-already-decided`. Reuse `not-found`, `stale-permission`, `idempotency-conflict`, and `service-unavailable`. Browser/Host maps every unknown status, field, or malformed response to `service-unavailable` and never guesses compatibility.

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

**Interfaces — Consumes:** `accounts`, `projects`, `project_members`, `xagent_sessions`, `xagent_session_events`, `xagent_admitted_evidence`, `artifact_text_chunks`, current actor/RLS helpers, app/worker roles, and Alembic revision `015_citation_authorization`.

**Interfaces — Produces:** immutable `project_fact_revisions`, one-head-per-field `project_fact_heads`, `fact_proposals`, exact `fact_proposal_evidence`, digest-only `fact_proposal_receipts`, `fact_operation_idempotency`, single-aggregate `business_outbox`, RLS policies, grants, constraints, and downgrade preflight.

- [ ] Write the bilingual active Agent Note before schema code. Record the durable-approval, receipt admission, Outbox projection, and single-object decisions.
- [ ] Add RED migration tests for revision `016`, all seven relations, closed states, field key checks, positive content revisions, one head per project/field, and one Outbox row per terminal proposal.
- [ ] Add RED evidence tests requiring both durable admitted-evidence identity and exact chunk line range. Add the minimal unique chunk key for `(id,index_id,line_start,line_end)` and reject mismatched ranges.
- [ ] Add RED immutability tests for confirmed revisions and terminal proposals, plus same-project/same-field/next-revision head advancement.
- [ ] Add RED RLS tests for proposer, manager, unrelated member, revoked membership, guessed IDs, prepared product invisibility, manager without membership, and worker denial.
- [ ] Add RED grant tests proving the API role has only required DML and `xagent_worker` has no Fact relations access.
- [ ] Add empty upgrade/downgrade/upgrade coverage. Add a non-empty downgrade test that fails before DDL and preserves revision `016` plus all data.
- [ ] Implement models and migration with composite foreign keys for head and evidence identity integrity.
- [ ] Add an action-aware database audit validator for `fact_*` actions that rejects all content and secret keys.
- [ ] Run `pnpm run api:test:db:up` and `pnpm run api:test -- tests/security/test_fact_schema.py tests/security/test_fact_rls.py tests/security/test_fact_grants.py`; expect all selected tests to pass.
- [ ] Run `pnpm run verify-translation-pairing --write .agents/notes/proposed/architecture/2026-09-06-xagent-fact-approval.md`; expect its sidecar to update.
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

**Interfaces — Consumes:** service credential, current login/permission revision, Project Session, exact `propose_fact` delegation, admitted evidence, append idempotency, and `tool/result` event sequence.

**Interfaces — Produces:** immutable five-minute prepared proposal, opaque admission receipt, public `{proposalId,status:'pending'}`, private receipt attachment, and atomic `prepared -> pending` admission.

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

- [ ] Add RED validation tests for field regex, UTF-8 byte edges, finite numbers, calendar dates, duplicate/65th evidence IDs, missing no-evidence reason, unknown fields, and oversized requests.
- [ ] Add RED authorization tests for Private Session, wrong project, revoked login, stale permission, specialist/manager success, and indistinguishable guessed identities.
- [ ] Add RED exact-evidence tests proving citation IDs must already be admitted to the same Session and fixed project.
- [ ] Add RED idempotency tests for exact replay, hash conflict, and fresh private receipt rotation while one public prepared proposal remains stable.
- [ ] Add RED digest, entropy, TTL, single-use, exact-claim, cancellation, and lost-response receipt tests.
- [ ] Add RED append rollback tests proving failed event validation exposes no pending proposal and consumes no receipt; successful append persists both event and pending transition once.
- [ ] Implement shared canonical hashing and byte-aware Fact validation with no internal status/receipt in public schemas.
- [ ] Implement receipt issue/verify/consume using the Phase 4A digest-derived UUID pattern.
- [ ] Implement prepare/delegation/current-RLS authorization and derive the base revision from the current head.
- [ ] Extend Session append to correlate one attachment with one matching `tool/result` by event sequence and tool call ID.
- [ ] Add redacted preparation/admission/expiry/replay/denial audit events.
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

**Interfaces — Consumes:** pending proposal, current manager/project access, admitted evidence, current Fact head, operation idempotency, and source Session append.

**Interfaces — Produces:** bounded pages/details, confirmed revisions/heads, terminal decisions, redacted audit, ordered Outbox, and exactly-once decision event admission.

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

- [ ] Add RED page/detail tests for stable cursor order, 100-row caps, hidden internal states, typed values, history, assertion reason, and exact evidence.
- [ ] Add RED authorization tests for specialist decisions, manager without membership, revoked/stale manager, guessed IDs, self-approval, and reviewer evidence reauthorization.
- [ ] Add RED withdrawal tests for proposer-only pending withdrawal and terminal immutability.
- [ ] Add RED serializable races for identical replay, competing decisions, and two same-base proposals producing one confirmation plus one revision conflict.
- [ ] Inject RED failures after revision/head/proposal/audit/Outbox writes and prove complete rollback.
- [ ] Add RED Outbox tests for the 32-row cap, stable order, restart, cancellation, malformed identity, response loss, and no Agent wake-up.
- [ ] Add RED audit coverage for every preparation, admission, expiry, decision, conflict, projection, replay, and denial outcome; scan for forbidden content.
- [ ] Implement RLS-backed query/detail routes and opaque cursors.
- [ ] Implement withdraw/reject/approve with operation idempotency and deterministic serializable locks.
- [ ] Reauthorize evidence against historical admission and the current reviewer's Artifact RLS.
- [ ] Insert one Outbox row for every terminal outcome, including rejected, withdrawn, and revision-conflicted outcomes.
- [ ] Implement Outbox pull and Session append admission; bind every identity and consume only inside the append transaction.
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

**Interfaces — Consumes:** closed FastAPI JSON, authenticated request metadata/CSRF, append sequence ranges, and existing retrieval attachments.

**Interfaces — Produces:** strict Fact types/errors/methods, bounded endpoint calls, and merged private receipt/Outbox attachments without log exposure.

- [ ] Add RED exact-decoder tests for all Fact values, states, pages, details, decisions, and events; reject unknown fields/tags, malformed dates/numbers/cursors, and bound overflow.
- [ ] Add RED tests proving Browser cannot send actor, role, membership, ownership, permission revision, or evidence authority fields.
- [ ] Add RED stable/unknown error mapping tests.
- [ ] Add RED append tests where retrieval, Fact receipt, and Outbox attachments coexist and commit only through the acknowledged sequence.
- [ ] Scan RED encodings/errors/snapshots for receipt and token leakage.
- [ ] Implement the closed parsers by reusing existing exact-object, UTF-8 byte, and bounded-array helpers.
- [ ] Implement fixed-path Fact methods with existing credentials, CSRF, abort, and timeout ownership.
- [ ] Extend persistence to collect/commit optional Fact sidecars while preserving byte-identical non-Business append requests.
- [ ] Preserve zero behavior when `xagentFact` is absent so non-Business profiles retain their current append body.
- [ ] Run `pnpm vitest run packages/xagent/backend-client/tests/backend-client.spec.ts packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts`; expect all selected tests to pass.
- [ ] Run `pnpm run typecheck -- --pretty false`; expect no errors from the protocol.
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

**Interfaces — Consumes:** Principal/request scope, fixed Project Session, current user token, backend client, checkpoint ranges, `agent/pre-step`, Session cancellation, and plugin lifecycle.

**Interfaces — Produces:** `XAgentFactService`, Typert Remote, private receipt registry, bounded Outbox delivery, and strict owner disposal.

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

- [ ] Obtain RED for service registration, Project scope derivation, Private/anonymous denial, and absent-plugin invariant.
- [ ] Add RED delegation tests for exact actor/Session/project/tool/tool-call/permission/nonce/60-second expiry and no caller authority.
- [ ] Add RED receipt registry tests for ordering, partial append, commit, failed append, replacement, and disposal.
- [ ] Add RED lifecycle tests proving reject-before-abort, in-flight settlement, synchronous clear, and late-result discard.
- [ ] Add RED Outbox delivery tests at Session open and `agent/pre-step`, with 32-row coalesced pulls and no loop execution.
- [ ] Implement the Service Definition/Provider seam with the established request-context pattern.
- [ ] Implement Remote read/decision methods that derive identity from the physical connection.
- [ ] Implement the private registry; expose no receipt-bearing Typert method.
- [ ] Implement Outbox projection as Session lifecycle and pre-step effects with one owner per Session.
- [ ] Implement relationship-based invariants.
- [ ] Run `pnpm vitest run packages/xagent/fact/tests`; expect all Fact provider tests to pass.
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

**Interfaces — Consumes:** Fact service, authenticated Project request scope, scoped tool registry, exact tool call ID, and cited-answer policy.

**Interfaces — Produces:** native-only `propose_fact`, generic render intent, minimal public result, private receipt registration, and zero schema outside the exact scope.

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

- [ ] Add RED assembled-schema tests for exact authenticated Project/Native registration and immediate disposal on scope changes.
- [ ] Add RED closed JSON schema tests for tagged values, extra fields, evidence cap, and no-evidence reason.
- [ ] Add RED execution/secrecy tests for derived Session/tool call, cancellation, minimal public result, and private receipt registration.
- [ ] Add RED cancellation tests where unadmitted prepared proposals remain hidden until expiry.
- [ ] Add RED retrieval interaction tests proving proposal success does not conclude the Turn and cited-answer enforcement remains active.
- [ ] Add RED evidence-free/reason success and missing-reason failure tests.
- [ ] Implement scoped registration through `agent.ctx.tools.register()` with its disposer owned by the effect.
- [ ] Implement concise model-visible JSDoc for every field and public result.
- [ ] Implement relationship-based invariants for the scoped tool registration and Fact service.
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

**Interfaces — Consumes:** generated Fact Remote, workbench project scope, `xagent.workbench.facts` slot, existing citation opener, and Browser lifecycle.

**Interfaces — Produces:** Business Facts tab, current heads, pending review, typed detail/history, role-aware actions, Tool renderer, and exact evidence navigation.

- [ ] Add RED ui-project tab/empty-slot tests and prove profiles without an occupant make no Fact Remote call.
- [ ] Add RED store tests for pages, cursors, typed values, conflicts, detail refresh, and late-result rejection.
- [ ] Add RED specialist/manager/proposer/self-approval/permission-loss action tests.
- [ ] Add RED detail tests for revisions, attribution, assertion reason, evidence-free status, and exact citation opener input.
- [ ] Add RED connection/account/project/Session/disposal cancellation tests.
- [ ] Add RED persistence scans proving no Fact cache, content, reason, receipt, token, key, URL, or evidence payload is stored.
- [ ] Add keyboard and accessible-name coverage for tabs, lists, dialogs, decisions, and errors.
- [ ] Implement the dedicated slot, localized UI, CSS, and memory-only scope state.
- [ ] Implement approve/reject/withdraw with one idempotency key per user initiation and retain it only for an explicit retry after transport uncertainty.
- [ ] Render Tool state only from server proposal identity/status; never infer approval from model text or arguments.
- [ ] Implement the UI invariant over registered slot, renderer, and service relationships.
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

**Interfaces — Consumes:** Fact packages, Business resolver, closed `SessionEventMap`, real Agent loop, snapshot harness, and docs projection.

**Interfaces — Produces:** Business-only capability, durable decision event, both SDK projections, keyless real-loop transcript, current architecture, and progress record.

- [ ] Add RED bundle closure and negative-profile assertions for Host, Browser, Remote, tool schema, and UI row.
- [ ] Declaration-merge `fact/proposal-decided` from `@xagent/dsh-fact` as a required-on-read closed event with complete event JSDoc and model projection; do not modify the core Agent loop for plugin behavior.
- [ ] Add RED replay tests for every terminal state, adjacent-event order, no wake-up, and once-only next-Turn visibility.
- [ ] Extend the TypeScript SDK fake runtime/expected event assertions and Python SDK fake runtime/expected event assertions with the same decision payload, then run both dedicated client suites.
- [ ] Add a keyless real-loop Business scenario for evidence-backed and reason-backed proposals, admission, later decision, and cited final-answer enforcement.
- [ ] Assemble only `xagent-business`, declare exact resolver dependencies, and update the lockfile.
- [ ] Update package/root architecture and README prose in present tense, covering authorization, timing, UI, cancellation, and rollback.
- [ ] Write the Phase 4B progress record with landed commits, remaining Browser proof, and exact verification commands.
- [ ] Move the Agent Note to `implemented/architecture` only after the assembled keyless path is green.
- [ ] Run `pnpm run test:snapshot -- -t "fact proposal approval"`; expect the checked-in transcript to match.
- [ ] Run focused bundle, Fact event, `packages/sdk/client/tests/sdk-client.spec.ts`, `python/sdk/tests/test_client.py`, CLI, and headless snapshot tests; expect all selected tests to pass.
- [ ] Run `pnpm run doc-sync`; expect pairing, projection, catalogs, JSDoc, and budgets to pass.
- [ ] Commit: `feat(xagent): assemble fact approval in business`

---

### Task 9: Prove the Built Browser Flow and Prepare the PR

**Files:**

- Create: `apps/web/tests/xagent-fact-support.ts`
- Create: `apps/web/tests/xagent-fact-support.spec.ts`
- Create: `apps/web/tests/xagent-fact.e2e.ts`
- Create: `apps/web/tests/snapshots/xagent-fact-approval/` fixtures selected by the Browser harness
- Modify: `docs/superpowers/progress/2026-09-08-xagent-phase-4b.md`

**External artifacts:** PR description and the dedicated GIF assets branch produced by the `record-browser-gif` workflow.

**Interfaces — Consumes:** built Browser/Host, real FastAPI/PostgreSQL RLS, two accounts, Project Session, admitted evidence, Fact Remote/UI, and restartable services.

**Interfaces — Produces:** deterministic real-stack E2E evidence, restart/replay proof, secret-clean GUI GIF, and minimal pre-push evidence.

- [ ] Add RED support tests for deterministic setup, evidence admission, restart, account switching, and cleanup.
- [ ] Add RED built Browser coverage for specialist evidence proposal, manager self-approval, reason-backed proposal, stale competition, exact history, citation opener, restart, and exactly-once replay.
- [ ] Add negative Browser checks for Private Session, Code Mode, non-Business profiles, revoked membership, guessed ID, and duplicate decision submission.
- [ ] Observe real PostgreSQL RLS and HTTP/Remote traffic; do not stub Fact endpoints, Session append, or Agent loop.
- [ ] Prove decisions do not start a Turn, then start a user Turn and observe one decision event in model input.
- [ ] Restart Browser, Host, and FastAPI at defined checkpoints and prove pending/head/Outbox recovery without duplication.
- [ ] Run `pnpm vitest run apps/web/tests/xagent-fact-support.spec.ts`; expect support tests to pass.
- [ ] Run the repository's focused built Browser command for `apps/web/tests/xagent-fact.e2e.ts`; expect the real two-account flow to pass.
- [ ] Invoke `record-browser-gif` against the PR's real built server/model flow. Record proposal, approval, revision, and replay; inspect every frame for secrets before publishing to the dedicated assets branch and attaching it to the PR.
- [ ] Invoke `dsh-pre-push-checks` and run only selected focused tests/gates. Report exactly the commands actually run.
- [ ] Invoke `superpowers:requesting-code-review`; resolve each Critical/Important finding with RED/GREEN and rerun invalidated checks.
- [ ] Update the progress record with final commit IDs, E2E/GIF links, and commands actually passed.
- [ ] Commit: `test(xagent): prove fact approval end to end`
- [ ] Push the Phase 4B branch, verify PR base/head/labels, wait for required checks, and do not mark ready or merge before official stack and CI are green.

## Plan Self-Review Checklist

- [ ] Every confirmed product decision is represented by a Global Constraint or executable step.
- [ ] Every wire field has one producer, one consumer, one strict decoder, and one failure test.
- [ ] Every authoritative relation has RLS, grants, foreign keys, immutability, and downgrade behavior.
- [ ] Every irreversible operation has idempotency, cancellation, concurrency, audit, and rollback coverage.
- [ ] Every public event has Session replay, model projection, TypeScript SDK, and Python SDK coverage.
- [ ] Every positive profile inclusion has a matching negative profile assertion.
- [ ] Scan for unfinished markers, placeholder prose, and omitted implementation directions; none may remain beyond this check itself.
- [ ] Scan code snippets and named interfaces for inconsistent status, path, field, or error names and resolve every mismatch before Task 1.
- [ ] Confirm final GUI proof uses the reviewed revision's real server/model flow and contains no secrets.
