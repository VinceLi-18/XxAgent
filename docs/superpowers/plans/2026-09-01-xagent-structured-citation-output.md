# XAgent Structured Citation Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task. Each task ends at an independent commit and fresh review boundary; do not start the next task while the current review has an open Critical or Important finding.

**Goal:** Replace free-text citation recognition with a closed Native-only `submit_cited_answer` protocol, render its authoritative result in Business Web, and complete the remaining Phase 4A retrieval composition and end-to-end acceptance.

**Architecture:** FastAPI/PostgreSQL remain the authority for evidence, authorization, receipt admission, RLS, citation identity, and immutable locator resolution. Host reconstructs admitted evidence for one authenticated Agent request, registers an Agent-scoped terminal tool, validates and reauthorizes only structured citation blocks, and commits the canonical answer only after the authoritative `tools/result`. Business Web renders that result through a keyed Tool view and resolves clicks through an authenticated Typert Remote; Markdown is never an authorization input.

**Tech Stack:** TypeScript, Cordis scoped contexts, DSH Agent/Tools/Session, Typert, React 18, Vitest, FastAPI, SQLAlchemy async, PostgreSQL 16 with pgvector, BAAI/bge-m3 CPU embedding, Playwright, Docker Compose.

**Spec:** [XAgent 结构化引用终稿设计](../specs/2026-09-01-xagent-structured-citation-output-design.md)

## Global Constraints

- Tasks 1–7 and their persisted evidence/receipt contracts remain intact. This plan supersedes the old Phase 4A plan from Task 8 onward.
- Only XAgent Business receives the terminal tool, citation Remote, and citation UI. Developer, ordinary Web, Headless, Code Mode, nested dispatch, and JiaxinAgent must remain free of them.
- Only canonical `citation` blocks authorize or navigate. Markdown, HTML, entities, Unicode lookalikes, tool arguments, and fallback text never acquire citation capability.
- Every wire object is closed and bounded before allocation or network calls: 64 KiB aggregate JSON, 256 blocks, 64 citation blocks, and no unknown fields.
- Successful publication is two-phase: stage by exact `ToolExecution`, then commit only after a successful authoritative `tools/result`. Cancellation, projection failure, append failure, account change, Session disposal, and service disposal discard the stage and reach quiescence.
- Each task must use behavioral RED before production edits, rerun the narrow GREEN suite, then run the listed repository gates. Record sandbox-only failures and rerun the unchanged command on the host according to `AGENTS.md`.
- Do not preserve the free-text scanner for compatibility. Phase 4A is not merged to `main`; the final tree has one structured protocol.
- Do not push, open a PR, record a GIF, or begin the next task until the current task has an independent review verdict of Ready.

---

### Task 8: Replace Free-Text Citation Enforcement with a Terminal Tool

**Files:**

- Create under `packages/xagent/retrieval/src/`: `cited-answer.ts`, `cited-answer-policy.ts`
- Create under `packages/xagent/retrieval/tests/`: `cited-answer.spec.ts`, `cited-answer-policy.spec.ts`
- Delete the retrieval citation scanner, free-text policy, and custom-event source modules.
- Delete their scanner and policy unit-test modules.
- Modify: `packages/xagent/retrieval/src/index.ts`
- Modify: `packages/xagent/retrieval/src/types.ts`
- Modify: `packages/xagent/retrieval/src/invariant.ts`
- Modify: `packages/xagent/retrieval/tests/retrieval.spec.ts`
- Modify: `packages/xagent/retrieval/tests/invariant.spec.ts`
- Modify: `packages/xagent/retrieval/package.json`
- Modify: `packages/xagent/retrieval/README.md`
- Modify: `packages/xagent/retrieval/README.zh.md`
- Modify: `packages/xagent/retrieval/architecture.md`
- Modify: `packages/xagent/session-persistence-api/src/index.ts`
- Modify: `packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts`
- Modify: `packages/core/session/src/known-event-types.ts`
- Modify: `services/api/app/api/routes/internal_sessions.py`
- Modify: `services/api/tests/api/test_internal_sessions.py`
- Modify: `.agents/notes/proposed/architecture/2026-08-28-xagent-rag-retrieval.md`
- Modify generated citation/event/config documentation and pairing records selected by `doc-sync`
- Modify: `pnpm-lock.yaml`
- Modify: `THIRD_PARTY_NOTICES.md`

**Interfaces — Consumes:** admitted retrieval evidence reconstructed from the current Session; exact authenticated Agent request scope; `XAgentRetrievalBackend.authorizeCitations`; scoped `agent.ctx.tools`, `agent.ctx.systemPrompt`, Tool waterfalls, and authoritative `tools/result`.

**Interfaces — Produces:** closed `XAgentCitedAnswer`; Agent-scoped Native-only `submit_cited_answer`; request-owned terminal lifecycle; stable `CITATION_INVALID`/`CITATION_FAILED`; deterministic fallback render and presentation metadata.

- [ ] **Step 1: Write normalization and closed-schema RED tests**

Define the public canonical value and a pure parser boundary:

```ts
export type XAgentCitedAnswerBlock =
  | { readonly type: 'markdown'; readonly text: string }
  | { readonly type: 'citation'; readonly id: string }

export interface XAgentCitedAnswer {
  readonly schemaVersion: 1
  readonly blocks: readonly XAgentCitedAnswerBlock[]
  readonly citationIds: readonly string[]
}

export declare function normalizeCitedAnswer(
  value: unknown,
  allowedIds: ReadonlySet<string>,
): XAgentCitedAnswer

export declare function renderCitedAnswer(value: XAgentCitedAnswer): string
```

Test exact closure, UTF-8 sizing before network calls, 1–256 blocks, at least one non-empty Markdown and one citation, at most 64 citation blocks, allowed-ID membership, adjacent citation collapse, nonadjacent placement preservation, first-use `citationIds`, deterministic render, and non-mutation of Markdown. Add a property test asserting that authorized IDs equal normalized citation blocks for arbitrary Unicode Markdown.

```bash
CI=true corepack pnpm exec vitest run packages/xagent/retrieval/tests
```

Expected RED: `cited-answer.ts` and its exports do not exist.

- [ ] **Step 2: Implement the pure canonical protocol**

Use a closed discriminated union and a fatal UTF-8 byte count. Do not parse Markdown or normalize Unicode. Use a stable `XAgentCitedAnswerError` with only bounded reason codes; never include rejected text in the error. Produce presentation metadata with the same canonical structure:

```ts
export interface XAgentCitedAnswerMeta {
  readonly kind: 'xagent-cited-answer'
  readonly schemaVersion: 1
  readonly blocks: readonly (
    | { readonly type: 'markdown'; readonly text: string }
    | { readonly type: 'citation'; readonly id: string }
  )[]
  readonly citationIds: readonly string[]
}
```

Rerun Step 1 until GREEN.

- [ ] **Step 3: Write real Agent-loop and lifecycle RED tests**

Cover these behaviors through the production Retrieval Service and Tool Runtime, not a fake policy function:

1. the tool and prompt appear only for the exact evidence-bearing request on `agent.ctx`;
2. `nativeOnly` removes it from Code SDK and nested dispatch;
3. ordinary assistant text and reasoning are suppressed while tool/protocol chunks survive;
4. an exact successful `ToolExecution` stages the canonical answer, calls `concludeTurn()`, invokes `authorizeCitations` once with `citationIds`, and commits only after successful `tools/result`;
5. a failed result, projection failure, append failure, request/connection abort, account/revision replacement, Session disposal, and Retrieval disposal publish nothing and await settlement;
6. one invalid attempt can retry within the same protected request; the second invalid attempt or a finished response without successful terminal output yields stable `CITATION_FAILED`;
7. siblings, queued prompts, and steering own independent attempts and identities;
8. tools before the terminal call settle normally; parallel terminal dispatch and later same-response calls are denied.

Use the repository precedent in `packages/subagent/subagent-in-process-driver/src/structured.ts`: register on `agent.ctx`, validate inside the definition, stage by exact `ToolExecution`, observe authoritative `tools/result`, and use a monotonic request-level guard.

```bash
CI=true corepack pnpm exec vitest run \
  packages/xagent/retrieval/tests/retrieval.spec.ts \
  packages/core/agent-loop/tests
```

Expected RED: no terminal tool exists and the old stream scanner still owns publication.

- [ ] **Step 4: Implement request-owned structured publication**

Install the terminal runtime only after the request's evidence checkpoint has settled. The request owner must hold:

```ts
interface CitedAnswerRequestOwner {
  readonly agent: object
  readonly identity: object
  readonly allowed: ReadonlyMap<string, object>
  readonly signal: AbortSignal
  readonly settlement: Promise<void>
  attempts: 0 | 1 | 2
  close(): void
}
```

Register the tool and order-190 prompt on `agent.ctx`. Its `output.render` calls `renderCitedAnswer`; its `output.presentationMeta` returns only the closed canonical meta. The execute body validates, stages by exact execution, reauthorizes with a fresh delegation nonce, calls `concludeTurn()`, and returns the canonical value. Commit the owner only from the authoritative result observer. Close admission before aborting and awaiting all owners during disposal.

The stream waterfall for a protected request must yield tool calls and terminal protocol chunks while dropping assistant text and reasoning. It must not buffer, hash, spool, parse, or persist rejected prose.

- [ ] **Step 5: Remove scanner-era protocol and persistence surface**

Delete the scanner/policy/custom event modules and their tests. Remove `xagent/citation-correction` and `xagent/citation-failure` from known event registries, Host persistence validation, FastAPI append schemas, generated event catalogs, and Agent Note prose. Delete `mdast-util-from-markdown`, `@types/mdast`, and `entities` from the retrieval importer if `rg` confirms no other direct use, regenerate the lockfile offline, and regenerate third-party notices. Keep receipt append, evidence events, RLS, and citation authorization unchanged.

```bash
rg -n "citation-scanner|citation-correction|citation-failure|mdast-util-from-markdown|from 'entities'" \
  packages/xagent/retrieval packages/xagent/session-persistence-api packages/core/session services/api/app
CI=true corepack pnpm exec vitest run \
  packages/xagent/retrieval/tests \
  packages/xagent/session-persistence-api/tests \
  packages/core/agent-loop/tests \
  packages/core/tools/tests
JX_TEST_DATABASE_URL="$JX_TEST_DATABASE_URL" services/api/.venv/bin/pytest -q \
  services/api/tests/test_internal_sessions.py
corepack pnpm install --lockfile-only --offline
CI=true corepack pnpm run typecheck
CI=true corepack pnpm run lint:contracts-ready
CI=true corepack pnpm run doc-sync
```

Expected GREEN: no production scanner/custom correction event remains; all structured, lifecycle, persistence, and adjacent Agent-loop suites pass.

- [ ] **Step 6: Commit and request independent review**

```bash
git diff --check
git add packages/xagent/retrieval packages/xagent/session-persistence-api packages/core/session \
  services/api docs .agents/notes pnpm-lock.yaml THIRD_PARTY_NOTICES.md
git commit -m "feat: submit structured xagent answers"
```

The reviewer must probe schema closure, Unicode Markdown non-authority, exact execution commit, one-retry ownership, cancellation/disposal quiescence, and absence of scanner-era production paths.

---

### Task 9: Add Citation Remote, Structured Tool View, and Immutable Navigation

**Files:**

- Create workspace package `@xagent/dsh-ui-citation` with `package.json`, `tsconfig.json`, and `tsdown.config.ts`
- Create its client files: `index.ts`, `CitedAnswerView.tsx`, `service.ts`, `citation.module.css`, and `locales.ts`
- Create its tests: `cited-answer-view.client.spec.tsx`, `service.client.spec.ts`, and `plugin.client.spec.tsx`
- Modify: `packages/xagent/retrieval/src/index.ts`
- Modify: `packages/xagent/retrieval/src/types.ts`
- Modify: `packages/xagent/retrieval/tests/retrieval.spec.ts`
- Modify: `packages/xagent/retrieval/package.json`
- Modify: `packages/xagent/authorization/src/index.ts`
- Modify: `packages/xagent/authorization/tests/authorization.spec.ts`
- Modify: `packages/xagent/ui-artifact/src/client/index.ts`
- Modify: `packages/xagent/ui-artifact/src/client/service.ts`
- Modify: `packages/xagent/ui-artifact/src/client/ArtifactPanel.tsx`
- Modify: `packages/xagent/ui-artifact/tests/plugin.client.spec.tsx`
- Modify: `packages/xagent/ui-artifact/tests/artifact-panel.client.spec.tsx`
- Create the package's `README.md`, `README.zh.md`, and `architecture.md`
- Modify: `packages/xagent/ui-artifact/README.md`
- Modify: `packages/xagent/ui-artifact/architecture.md`
- Modify: `pnpm-lock.yaml`

**Interfaces — Consumes:** canonical `tool/result.meta`; keyed `tool.call.toolview`; authenticated Principal request scope; persisted citation identity; existing FastAPI `resolveCitation`; Artifact detail/preview controller.

**Interfaces — Produces:** fixed `xagentCitation/resolve` Typert Remote; strict Browser controller; structured answer renderer; keyboard-accessible verified citation chips and first-use source strip; `openCitation` of an immutable Version and line range.

- [ ] **Step 1: Write Remote authorization and client lifecycle RED tests**

Add a closed Browser Remote contract that accepts only Session ID and citation ID; actor, user token, permission revision, Artifact identity, and delegation are never Browser parameters:

```ts
export interface XAgentCitationRemote {
  resolve(
    sessionId: string,
    citationId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly artifactId: string
    readonly versionId: string
    readonly chunkId: string
    readonly lineStart: number
    readonly lineEnd: number
  }>
}
```

The Host service must run inside the existing authenticated request scope, reconstruct the persisted citation identity for that Session, mint a fresh exact delegation, call `resolveCitation`, map only stable closed errors, and return Artifact/version/chunk/line identities without storage URLs.

```bash
CI=true corepack pnpm exec vitest run \
  packages/xagent/retrieval/tests/retrieval.spec.ts \
  packages/xagent/authorization/tests/authorization.spec.ts
corepack pnpm --filter @xagent/dsh-ui-citation exec vitest run tests
```

Expected RED: `xagentCitation` Remote, authorizer method table, and UI package do not exist.

- [ ] **Step 2: Implement the authenticated citation Remote**

Publish `XAgentCitationRemoteService` from the retrieval package alongside `XAgentRetrievalService`. Reuse `XAgentAuthenticatedRequestScope` and a request-local `AsyncLocalStorage` as Project/Artifact do. Extend `XAgentAuthorizationService` with exactly `xagentCitation/resolve`; unknown methods, anonymous requests, nested scopes, service replacement, account mismatch, cancellation, and disposal fail closed.

Prove the Remote looks up the persisted public citation before minting delegation, does not accept caller-supplied Artifact identities, and never caches a resolved locator or URL.

- [ ] **Step 3: Write structured Tool view RED tests**

Test pending, success, failure, replay, and malformed metadata through actual `ToolCallBlock` fixtures. The view must:

- read only closed `kind: 'xagent-cited-answer'` success metadata;
- render Markdown blocks with the existing safe Markdown component;
- render citation blocks in position as “已验证资料” buttons;
- render a first-use, deduplicated source strip;
- leave citation-like Markdown as noninteractive text;
- fall back to a stable error for malformed metadata rather than reading `tool/call.arguments` or result text;
- preserve keyboard order, focus visibility, accessible names, and narrow-screen wrapping.

- [ ] **Step 4: Implement Browser controller and Artifact handoff**

Mount retrieval's generated Remote in `ui-citation`. Register `CitedAnswerView` at key `submit_cited_answer` in `tool.call.toolview`. A controller owns one account/Session scope and one active resolution request. On click, it sends only the current Session ID and citation ID, then calls a narrow Artifact controller handoff:

```ts
interface XAgentArtifactCitationOpener {
  openCitation(input: {
    readonly artifactId: string
    readonly versionId: string
    readonly lineStart: number
    readonly lineEnd: number
  }): Promise<void>
}
```

`ui-artifact` re-reads current detail/preview, selects the exact immutable Version, and highlights the range. Account/Session change, unmount, revocation, Remote failure, and disposal abort the old request, clear locator state and preview URLs, and prevent late publication.

- [ ] **Step 5: Run UI, Remote, accessibility, and lifecycle gates**

```bash
CI=true corepack pnpm exec vitest run \
  packages/xagent/retrieval/tests \
  packages/xagent/authorization/tests \
  packages/xagent/ui-artifact/tests \
  packages/xagent/ui-project/tests \
  packages/client/ui-tool/tests
corepack pnpm --filter @xagent/dsh-ui-citation exec vitest run tests
corepack pnpm install --lockfile-only --offline
CI=true corepack pnpm run typecheck
CI=true corepack pnpm run lint:contracts-ready
CI=true corepack pnpm run doc-sync
```

- [ ] **Step 6: Commit and request independent review**

```bash
git diff --check
git add packages/xagent pnpm-lock.yaml docs
git commit -m "feat: render xagent cited answers"
```

The reviewer must independently verify that raw Markdown cannot acquire click capability, Remote inputs contain no identity aliases or bearer values, and scope changes cancel both citation resolution and Artifact preview publication.

---

### Task 10: Compose the Real CPU Retrieval Stack and CI Lane

**Files:**

- Modify: `services/api/compose.yml`
- Modify: `services/api/compose.test.yml`
- Modify: `services/api/.env.example`
- Modify: `services/api/README.md`
- Modify: `services/api/app/cli.py`
- Modify: `services/api/app/worker.py`
- Create: `services/api/tests/e2e/test_retrieval_pipeline.py`
- Create: `services/api/tests/e2e/test_retrieval_worker_recovery.py`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `scripts/ci-workflow.spec.ts`

**Interfaces — Consumes:** PostgreSQL+pgvector, MinIO, ClamAV, API, artifact/index worker, CPU embedding image, pinned BGE model/tokenizer cache.

**Interfaces — Produces:** healthy service-only embedding/index topology; real hybrid pipeline and recovery tests; bounded `xagent-retrieval-e2e` CI lane; no public embedding port.

- [ ] **Step 1: Write deployment and pipeline RED tests**

```bash
CI=true corepack pnpm exec vitest run scripts/ci-workflow.spec.ts
XAGENT_RETRIEVAL_E2E=1 pnpm run api:test -- \
  tests/e2e/test_retrieval_pipeline.py tests/e2e/test_retrieval_worker_recovery.py
```

Expected RED: Compose lacks the complete pgvector/embedding/index health chain and CI lacks the retrieval lane.

- [ ] **Step 2: Add health-ordered CPU services**

Use PostgreSQL 16 with pgvector. Keep embedding on the service-only network. API and worker receive only the internal embedding origin; worker alone receives worker database credentials. Embedding health proves the pinned model is loaded and returns dimension 1024. API's service-token tokenizer relay retains the existing 8 KiB raw UTF-8, 49,163-byte escaped body, 512-byte response, manual redirect, timeout, cancellation, and no-log boundaries.

- [ ] **Step 3: Add real pipeline and recovery acceptance**

Upload clean bilingual text through the Phase 3B path; wait for indexing; prove dense, English lexical, Chinese trigram, top-40 and tie ordering; replace with v2 while v1 remains searchable; prove atomic head switch; restart the worker during a lease and reclaim after expiry; prove binary, unsupported, quarantined, stale, and superseded inputs never publish an index.

Add a real authorize/resolve sequence over the generated citations. The test must not depend on the removed free-text scanner.

- [ ] **Step 4: Run once with unconditional cleanup**

```bash
docker compose -f services/api/compose.test.yml up -d --build --wait
XAGENT_RETRIEVAL_E2E=1 pnpm run api:test -- \
  tests/e2e/test_retrieval_pipeline.py tests/e2e/test_retrieval_worker_recovery.py
docker compose -f services/api/compose.test.yml down --volumes --remove-orphans
```

After `finally`, query exact Compose project labels for containers, volumes, and networks and require all three to be empty.

- [ ] **Step 5: Run gates, commit, and request review**

```bash
CI=true corepack pnpm run api:build
CI=true corepack pnpm run typecheck
CI=true corepack pnpm run lint:contracts-ready
git diff --check
git add services/api .github/workflows/ci.yml package.json scripts/ci-workflow.spec.ts
git commit -m "test: verify xagent retrieval stack"
```

The review must inspect image provenance, model pinning, credentials, service exposure, bounded health waits, failure cleanup, and CI time/resource limits.

---

### Task 11: Compose Structured Retrieval Only into XAgent Business

**Files:**

- Modify: `packages/bundle/xagent-business/cordis.patch.yml`
- Modify: `packages/bundle/xagent-business/package.json`
- Modify: `packages/bundle/xagent-business/tests/business-closure.spec.ts`
- Modify: `apps/cli/package.json`
- Create: `apps/cli/tests/xagent-retrieval-runtime.e2e.ts`
- Modify: `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`
- Modify generated config, Cordis, capability, event, and tool catalogs selected by repository gates
- Modify: `pnpm-lock.yaml`

**Interfaces — Consumes:** authenticated retrieval provider, retrieval tools, terminal cited-answer runtime, citation Remote/UI, Artifact UI handoff, backend/embedding configuration.

**Interfaces — Produces:** Business-only Host/Browser composition; exact three Native-only model tools; authenticated citation Remote; Developer/Web/Headless dumps with none of the new packages, tools, Remote, or slots.

- [ ] **Step 1: Write composition and non-composition RED tests**

```bash
CI=true corepack pnpm exec vitest run \
  packages/bundle/xagent-business/tests/business-closure.spec.ts \
  apps/cli/tests/xagent-retrieval-runtime.e2e.ts
```

Expected RED: Business lacks retrieval, `submit_cited_answer`, citation Remote, and Tool view; non-Business absence assertions already pass.

- [ ] **Step 2: Mount in dependency order**

Host order: authentication and Session persistence, retrieval provider, retrieval tools, then the request-scoped terminal runtime owned by retrieval. Browser order: project UI, artifact UI, then citation UI. Pass backend origin, exact service token, delegation issuer/audience/private key, and tokenizer relay configuration only to Host. Browser receives no service token, user token, receipt, embedding origin, delegation key, nonce, object key, or signed URL.

- [ ] **Step 3: Verify real Loader and profile isolation**

Using a real authenticated Loader connection, create Private and Project Sessions and inspect native tool schemas. Business must expose exactly `list_accessible_projects`, `search_artifacts`, and request-scoped `submit_cited_answer`; the terminal tool appears only after admitted evidence and is absent from Code Mode. Verify `xagentCitation/resolve` only inside authenticated scope and the keyed Tool view only in Business Web.

Run Developer, ordinary Web, and Headless dumps and assert that retrieval packages, three tool names, `xagentCitation`, and `ui-citation` are absent. Audit JiaxinAgent manifests read-only and record that it has no DSH profile.

- [ ] **Step 4: Run generators and repository gates**

```bash
corepack pnpm run gen-config-catalog
corepack pnpm run gen-cordis-catalog
corepack pnpm install --lockfile-only --offline
CI=true corepack pnpm exec vitest run \
  packages/bundle/xagent-business/tests/business-closure.spec.ts \
  apps/cli/tests/xagent-retrieval-runtime.e2e.ts
CI=true corepack pnpm run typecheck
CI=true corepack pnpm run build
CI=true corepack pnpm run lint:contracts-ready
CI=true corepack pnpm run hygiene
CI=true corepack pnpm run doc-sync
```

- [ ] **Step 5: Commit and request independent review**

```bash
git diff --check
git add packages/bundle/xagent-business apps/cli packages/extensions/cordis-client-runner \
  docs pnpm-lock.yaml
git commit -m "feat: compose xagent structured retrieval"
```

Review the complete Business closure and the complete absence surface for every other profile; do not accept package-name-only checks without runtime tool/Remote/slot assertions.

---

### Task 12: Prove the Full Browser Flow, Finalize Documentation, and Record the GIF

**Files:**

- Create: `apps/web/tests/xagent-structured-retrieval.e2e.ts`
- Create: `apps/web/tests/xagent-structured-retrieval-support.ts`
- Create: `apps/web/tests/xagent-structured-retrieval-support.spec.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/architecture.zh.md`
- Modify: `packages/xagent/retrieval/README.md`
- Modify: `packages/xagent/retrieval/README.zh.md`
- Modify: `packages/xagent/retrieval/architecture.md`
- Create or complete: `packages/xagent/tool-retrieval/README.md`
- Create or complete: `packages/xagent/tool-retrieval/README.zh.md`
- Create or complete: `packages/xagent/tool-retrieval/architecture.md`
- Modify the Task 9 `@xagent/dsh-ui-citation` README, Chinese README, and architecture document
- Move/update the active RAG Agent Note triplet according to archive policy
- Create: `docs/superpowers/progress/2026-09-01-xagent-phase-4a.md`
- Update the Phase 4A SDD ledger and final task report

**Interfaces — Consumes:** production Business composition, real CPU retrieval stack, structured terminal tool, canonical Tool UI, citation Remote, Artifact immutable navigation.

**Interfaces — Produces:** one fresh full-stack acceptance lane; reproducible key/no-key provenance; optimized browser GIF; final implemented architecture and clean Phase 4A handoff.

- [ ] **Step 1: Write helper and full-flow RED tests**

The support suite must own spawn-time `close` tracking, bounded TERM/KILL teardown, query/token redaction, exact Compose labels, fresh profile homes, and deterministic fixture identities. The browser test must cover:

1. login, project creation, upload, clean/index-ready state;
2. Private Session cross-project hybrid retrieval and Project Session fixed-project retrieval;
3. canonical `submit_cited_answer` result with interleaved Markdown/citation blocks;
4. citation-like Markdown remaining noninteractive;
5. live and replay Tool views matching exactly;
6. chip click resolving and opening the immutable Artifact Version/line range;
7. one invalid structured submission retry and second stable failure;
8. mid-request revocation/account switch publishing no partial answer and clearing UI state;
9. code/nested/profile isolation and complete teardown.

```bash
CI=true corepack pnpm exec vitest run \
  apps/web/tests/xagent-structured-retrieval-support.spec.ts \
  apps/web/tests/xagent-structured-retrieval.e2e.ts
```

Expected RED: the final Business composition and browser flow are not yet proven together.

- [ ] **Step 2: Run the production-built full flow**

Build Host, Client, Web, API, worker, and embedding artifacts first. Run one fresh named Compose project and one fresh browser context. If a configured model key is available, use the real model and require an actual `submit_cited_answer` call. If no key exists, use the repository's deterministic model adapter and state `modelRound=false` in provenance; do not imply a real model round.

The deterministic adapter must still traverse the real Agent Loop, Tool Runtime, Session checkpoint, FastAPI authorization, PostgreSQL RLS, Remote, and Browser rendering paths.

- [ ] **Step 3: Record and verify the required GIF**

Use the `record-browser-gif` skill against the same production-built server and fresh flow. Capture login/project scope, retrieval, structured answer, verified citation chip, source strip, immutable Artifact locator, replay, and account isolation. Store frames and GIF under the repository's ignored `.playwright-mcp/` path, publish the GIF only to the dedicated assets branch during PR preparation, and record dimensions, frame count, duration, size, SHA-256, demonstrated commit, model provenance, and cleanup evidence.

Visually inspect decoded representative frames. Reject any frame containing password, bearer token, delegation, object key, signed URL, internal query, or secret environment value.

- [ ] **Step 4: Finalize docs and Agent Notes**

Document the current structured trust boundary, not the abandoned scanner review history. Search the tracked tree and require no production/documentation claim that Markdown `[资料N]` is parsed for authority:

```bash
rg -n "citation-scanner|citation-correction|citation-failure|解析.*\[资料|扫描.*引用" \
  packages services docs .agents/notes
```

Move the RAG Agent Note from proposed to implemented only after the full flow passes. Audit related active notes with `dsh-archive-agent-notes`; archive or delete only when the skill's future-decision-value rules require it. Keep the structured-output design and this plan as historical decision records.

- [ ] **Step 5: Run final Phase 4A gates**

```bash
JX_TEST_DATABASE_URL="$JX_TEST_DATABASE_URL" services/api/.venv/bin/pytest -q
CI=true corepack pnpm exec vitest run packages/xagent apps/cli/tests apps/web/tests/xagent-structured-retrieval-support.spec.ts
CI=true corepack pnpm run typecheck
CI=true corepack pnpm run build
CI=true corepack pnpm run lint
CI=true corepack pnpm run hygiene
CI=true corepack pnpm run doc-sync
CI=true corepack pnpm run test:web:built
git diff --check
```

After all commands settle, remove the exact test Compose project, volumes, networks, temporary worktree, browser/server children, and overlay image. Preserve unrelated user data and pre-existing Docker volumes.

- [ ] **Step 6: Commit, final review, and PR handoff**

```bash
git add apps/web docs packages/xagent .agents/notes
git commit -m "docs: complete xagent structured retrieval"
```

Request one final independent review of the entire structured-output range. It must verify product behavior, security boundaries, profile isolation, generated docs, GIF provenance, resource cleanup, exact change scope, and the absence of scanner-era production paths. Only a Ready verdict permits pre-push checks and PR creation against remote `main`.
