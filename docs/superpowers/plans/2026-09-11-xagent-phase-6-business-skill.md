# XAgent Phase 6 Governed Business Skill Implementation Plan

English | [中文](2026-09-11-xagent-phase-6-business-skill.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver project-scoped declarative Business Skills with governed drafting, isolated testing, immutable publication, explicit authorization, version selection, terminal retirement, existing-catalog invocation, turn-pinned execution policy, and complete auditability in the `xagent-business` profile.

**Architecture:** FastAPI/PostgreSQL owns lifecycle, authorization, immutable versions, test records, and audit. A new `@xagent/dsh-business-skill` capability maps currently authorized project versions into the existing DSH Skill registry, records the exact activation in the Session log, pins one version per turn, and reauthorizes every tool call. A dedicated test Agent uses the production Session log but a hidden `business_skill_test` purpose and a strict read-only tool closure. The Browser governs Skills through a closed Host Remote and a new project-details UI. Generic DSH packages gain only a provider-neutral Skill-load event; the agent loop is unchanged.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy async, Alembic, PostgreSQL 16, TypeScript 6, Cordis, Typert, React 18, Vitest 4, Playwright, and Docker Compose.

**Spec:** [Phase 6 Business Skill Design](../specs/2026-09-11-xagent-phase-6-business-skill-design.md)

## Global Constraints

- Phase 5 remains skipped. This change adds no document generation, templates, exports, arbitrary code, Shell, filesystem, dynamic Workflow, Subagent, or marketplace capability.
- Business Skills exist only in authenticated Project Sessions assembled by `xagent-business`. Private Sessions, Developer, ordinary Web, Headless, and other profiles expose no Business Skill catalog, governance Remote, or UI.
- Specialists and Managers may create, edit, test, and record a human verdict. Only Managers may publish, authorize, unauthorize, select a historical version, or retire.
- FastAPI derives account, role, active login, permission revision, project membership, Session purpose, and Skill ownership. Browser and model inputs carry no Principal, database ID, internal revision, token, or audit ID.
- A draft is mutable through optimistic revision checks. Published versions are immutable. Authorization belongs to the stable Skill, and retirement is terminal.
- Publication requires one normally completed and human-passed test for the exact draft revision, draft digest, and current tool-policy digest. There is no bypass or automatic quality score.
- One test run owns one hidden Project Session, one scenario, and one turn. Test Agents never register `propose_fact` and deny every tool outside the resolved read-only closure before execution.
- One production turn may activate at most one Business Skill. It pins the exact version and complete tool set; publication and version switching affect later turns only.
- Unauthorization, retirement, permission revocation, backend failure, cancellation, version mismatch, and unknown tools fail closed at the next `tools/pre-execute` authorization. Every waterfall listener calls `next()` on the allow path.
- Skill bodies remain in the append log for audit and request reconstruction. At `agent/turn-stopping`, a Session surface replacement removes the instructions from later derived model history and leaves a public historical-use marker.
- The selected primary-tool set is closed to `list_accessible_projects`, `search_artifacts`, and `propose_fact`. The resolver retains `skill` and adds `submit_cited_answer` for `search_artifacts`. A resolver change increments its version and invalidates earlier draft tests.
- `propose_fact` remains a pending Fact proposal and never bypasses Fact approval. Business Skill authorization can only narrow existing project, artifact, Fact, and Session permissions.
- Every model-visible addition is logged. The new Session event updates both TypeScript and Python SDK expected outputs and adds a keyless snapshot through a real runnable example.
- Every task begins with a precise RED test and the smallest GREEN implementation, updates affected JSDoc/README contracts, and ends in a separate commit. Before each push, use `dsh-pre-push-checks` to choose the smallest sufficient checks.
- This phase changes product-visible GUI behavior. Final acceptance must use `record-browser-gif` against the PR's real server and model flow and attach a secret-free GIF.

## Fixed Interfaces and Type Graph

```python
class XAgentSessionPurpose(str, Enum):
    CONVERSATION = "conversation"
    BUSINESS_SKILL_TEST = "business_skill_test"

class BusinessSkillStatus(str, Enum):
    ACTIVE = "active"
    RETIRED = "retired"

class BusinessSkillTestRunStatus(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

class BusinessSkillTestVerdict(str, Enum):
    PASS = "pass"
    REJECT = "reject"

BUSINESS_SKILL_SLUG_PATTERN = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
BUSINESS_SKILL_MAX_INSTRUCTIONS_BYTES = 64 * 1024
BUSINESS_SKILL_MAX_DESCRIPTION_BYTES = 2 * 1024
BUSINESS_SKILL_TOOL_POLICY_VERSION = 1
BUSINESS_SKILL_PRIMARY_TOOLS = frozenset({
    "list_accessible_projects", "search_artifacts", "propose_fact",
})
```

```ts
export type BusinessSkillPrimaryTool =
  | 'list_accessible_projects'
  | 'search_artifacts'
  | 'propose_fact'

export interface BusinessSkillActivatedEvent {
  readonly type: 'business-skill/activated'
  readonly data: {
    readonly slug: string
    readonly version: number
    readonly invocation: 'model-tool' | 'user-explicit'
    readonly turn: number
    readonly toolPolicyDigest: string
  }
}

export interface BusinessSkillLocator {
  readonly kind: 'xagent-business-skill'
  readonly slug: string
  readonly version: number
  readonly opaqueLoadKey: string
}

export interface BusinessSkillTurnBinding {
  readonly slug: string
  readonly version: number
  readonly opaqueVersionKey: string
  readonly toolPolicyDigest: string
  readonly completeTools: ReadonlySet<string>
  readonly turn: number
}
```

The policy resolver is deterministic: it always retains `skill`; it adds each selected primary tool; and selecting `search_artifacts` additionally adds `submit_cited_answer`. Test resolution removes `propose_fact` after resolving the production set and records it as an unexecuted production write permission. Both API and Host compute the SHA-256 digest from the policy version plus the sorted complete production set and reject a mismatch.

The closed Host/FastAPI paths are:

```text
POST /internal/xagent/business-skills/projects/{project_id}/list
POST /internal/xagent/business-skills/projects/{project_id}/create
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/detail
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/draft
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/tests/start
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/tests/{run_number}/settle
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/tests/{run_number}/verdict
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/tests/{run_number}/transcript
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/publish
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/authorization
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/current-version
POST /internal/xagent/business-skills/projects/{project_id}/{slug}/retire
POST /internal/xagent/business-skills/runtime/catalog
POST /internal/xagent/business-skills/runtime/load
POST /internal/xagent/business-skills/runtime/authorize-tool
```

Browser operations identify a Skill by project plus public `slug`, a version by positive public version number, and a test by positive public run number. Internal UUIDs and opaque runtime keys never cross the Browser Remote or enter model-visible data. Stable new errors are `business-skill-input-invalid`, `business-skill-revision-conflict`, `business-skill-test-required`, `business-skill-policy-changed`, `business-skill-not-authorized`, `business-skill-retired`, `business-skill-conflict`, `business-skill-tool-denied`, and `business-skill-test-read-only`; reuse `unauthenticated`, `forbidden`, `not-found`, `stale-permission`, `idempotency-conflict`, and `service-unavailable`.

---

### Task 1: Add the Active Agent Note and PostgreSQL Foundation

**Files:**

- Create: `.agents/notes/proposed/feature/2026-09-11-project-business-skills.md`
- Create: `.agents/notes/proposed/feature/2026-09-11-project-business-skills.zh.md`
- Create: `.agents/notes/proposed/feature/2026-09-11-project-business-skills.i18n.yaml`
- Create: `services/api/alembic/versions/018_xagent_business_skills.py`
- Create: `services/api/app/models/business_skills.py`
- Modify: `services/api/app/models/xagent_session.py`
- Modify: `services/api/app/models/__init__.py`
- Modify: `services/api/app/core/migration_config.py`
- Modify: `services/api/tests/conftest.py`
- Create: `services/api/tests/security/test_business_skill_schema.py`
- Create: `services/api/tests/security/test_business_skill_rls.py`
- Create: `services/api/tests/security/test_business_skill_grants.py`

**Interfaces — Consumes:** Alembic revision `017_fact_tool_call_identity`, accounts, projects, project memberships, XAgent Sessions, current actor/RLS helpers, API/worker roles, and existing AuditEvent storage.

**Interfaces — Produces:** `business_skills`, `business_skill_drafts`, `business_skill_versions`, `business_skill_test_runs`, `business_skill_authorizations`, immutable `xagent_sessions.purpose`, project-scoped RLS, least-privilege grants, constraints, and downgrade preflight.

- [ ] Write the bilingual proposed Agent Note with `Problem`, `Proposal`, `Alternatives considered`, `Acceptance criteria`, and `Risks`; record immutable versions, stable-Skill authorization, hidden test Sessions, turn pinning, and per-tool reauthorization.
- [ ] Add RED migration tests for revision `018`, all five Skill relations, `conversation | business_skill_test` Session purpose, project-unique immutable slug, one mutable draft, project-monotonic version/run numbers, same-Skill current-version foreign keys, and closed states.
- [ ] Add RED immutability tests proving version description, instructions, primary tools, complete tools, digests, source revision, and publication identity cannot update or delete.
- [ ] Add RED RLS/grant tests for same-project members, cross-project members, removed members, disabled accounts, guessed identifiers, API role access, and worker denial.
- [ ] Add empty upgrade/downgrade/upgrade coverage and a non-empty downgrade preflight that fails before DDL and preserves revision `018` plus data.
- [ ] Implement SQLAlchemy models and migration with composite foreign keys, unique constraints, action-aware audit validation, terminal-retirement constraints, and database immutability triggers.
- [ ] Run `pnpm run api:test:db:up` and `pnpm run api:test -- tests/security/test_business_skill_schema.py tests/security/test_business_skill_rls.py tests/security/test_business_skill_grants.py`; expect all selected tests to pass.
- [ ] Run `pnpm run verify-translation-pairing --write .agents/notes/proposed/feature/2026-09-11-project-business-skills.md`; expect the sidecar to update.
- [ ] Commit: `feat(xagent-api): add business skill storage foundation`

### Task 2: Implement Governance State Transitions

**Files:**

- Create: `services/api/app/schemas/business_skills.py`
- Create: `services/api/app/services/business_skill_policy.py`
- Create: `services/api/app/services/business_skills.py`
- Create: `services/api/app/api/routes/internal_business_skills.py`
- Modify: `services/api/app/services/audit.py`
- Modify: `services/api/app/main.py`
- Create: `services/api/tests/test_business_skill_governance.py`
- Create: `services/api/tests/test_business_skill_publication.py`
- Create: `services/api/tests/test_business_skill_audit.py`

**Interfaces — Consumes:** authenticated user token, current role/membership/permission revision, Skill slug, expected draft revision, selected primary tools, test records, current resolver version, and idempotency key.

**Interfaces — Produces:** bounded list/detail rows, optimistic draft edits, immutable publication, explicit authorization, current-version selection, terminal retirement, stable public errors, and redacted AuditEvents.

- [ ] Add RED schema tests for slug grammar, UTF-8 byte ceilings, Markdown/description emptiness, sorted unique primary tools, unknown fields/tools, positive revisions/version numbers, and bounded pages.
- [ ] Add RED authorization-matrix tests: Specialist create/edit/test/verdict succeeds; Specialist governance fails; current Manager governance succeeds; removed/disabled/stale/cross-project actors receive indistinguishable denial.
- [ ] Add RED draft tests for create, edit, exact replay, concurrent revision conflict, published-version-to-draft copy, display-name-only edit, and retired-Skill rejection.
- [ ] Add RED publication tests requiring the exact revision, content digest, and current policy digest with a completed human-pass test; cover missing/rejected/failed/cancelled/stale tests, duplicate request replay, idempotency conflict, and concurrent edit.
- [ ] Add RED authorization/version/retirement tests proving initial publication stays unauthorized, authorization follows the stable Skill, historical selection accepts only the same Skill, and retirement atomically clears authorization and cannot reverse.
- [ ] Implement strict Pydantic schemas, deterministic policy resolution/digesting, serializable state-transition transactions, public slug/version/run identifiers, and content-free audit details.
- [ ] Run `pnpm run api:test -- tests/test_business_skill_governance.py tests/test_business_skill_publication.py tests/test_business_skill_audit.py`; expect all selected tests to pass.
- [ ] Commit: `feat(xagent-api): govern business skill lifecycle`

### Task 3: Add Isolated Test Sessions and Runtime Authorization Endpoints

**Files:**

- Modify: `services/api/app/services/business_skills.py`
- Modify: `services/api/app/api/routes/internal_business_skills.py`
- Modify: `services/api/app/services/xagent_sessions.py`
- Modify: `services/api/app/api/routes/internal_sessions.py`
- Modify: `services/api/app/api/routes/internal_workbench.py`
- Modify: `services/api/app/schemas/business_skills.py`
- Create: `services/api/tests/test_business_skill_test_runs.py`
- Create: `services/api/tests/test_business_skill_runtime.py`
- Modify: `services/api/tests/api/test_internal_sessions.py`
- Modify: `services/api/tests/test_workbench.py`

**Interfaces — Consumes:** exact draft revision, one scenario, Project Session identity, service identity, authenticated actor, pinned opaque version key, requested tool name, and cancellation/idempotency state.

**Interfaces — Produces:** one hidden durable test Session per run, idempotent terminal settlement, dedicated transcript reads, authorized catalog entries, exact-version load responses, and per-call allow/deny decisions.

- [ ] Add RED transaction tests proving `tests/start` atomically creates a `business_skill_test` Project Session and run for the exact draft/policy digest, assigns one public run number, and never reuses a Session for another scenario.
- [ ] Add RED visibility tests proving ordinary Session list/bootstrap/history/resume/title paths exclude test Sessions while the dedicated transcript path reauthorizes project membership and returns their durable events.
- [ ] Add RED settlement tests for normal completion, tool denial, model failure, cancellation, exact idempotent replay, conflicting replay, and late settlement after request cancellation.
- [ ] Add RED catalog/load tests for active+published+authorized current versions only; cover Private/wrong-project/test Sessions, unknown slug, unauthorization, retirement, switched current version, stale permission, and backend failure.
- [ ] Add RED tool-authorization tests for pinned historical version acceptance after publication/rollback, denial after unauthorization/retirement/revoked membership, complete-set membership, opaque-key mismatch, cancellation, and content-free denial audit.
- [ ] Implement the transaction owners and closed endpoints. Lock membership, Session, Skill, draft/version, and authorization in stable order; never authorize from a cached catalog result.
- [ ] Run `pnpm run api:test -- tests/test_business_skill_test_runs.py tests/test_business_skill_runtime.py tests/api/test_internal_sessions.py tests/test_workbench.py`; expect all selected tests to pass.
- [ ] Commit: `feat(xagent-api): isolate business skill tests and runtime policy`

### Task 4: Extend the Strict Backend Client and Authenticated Session Scope

**Files:**

- Modify: `packages/xagent/backend-client/src/types.ts`
- Modify: `packages/xagent/backend-client/src/index.ts`
- Modify: `packages/xagent/backend-client/src/invariant.ts`
- Modify: `packages/xagent/backend-client/tests/backend-client.spec.ts`
- Modify: `packages/xagent/principal/src/types.ts`
- Modify: `packages/xagent/principal/src/index.ts`
- Modify: `packages/xagent/principal/tests/principal.spec.ts`
- Modify: `packages/xagent/session-persistence-api/src/index.ts`
- Modify: `packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts`
- Modify: `packages/xagent/authorization/src/index.ts`
- Modify: `packages/xagent/authorization/tests/authorization.spec.ts`

**Interfaces — Consumes:** closed FastAPI JSON, authenticated physical Connection, Session rows carrying immutable purpose, closed `xagentBusinessSkill` Remote methods, and existing token-scoped persistence.

**Interfaces — Produces:** strict Business Skill backend types/methods, validated `purpose` in `XAgentAuthenticatedSessionRequestScope`, ordinary-list filtering, and request-scoped authorization for every governance/test Remote operation.

- [ ] Add RED backend-client tests for every endpoint, exact JSON field/status unions, slug/version/run identifiers, AbortSignal forwarding, encoded path segments, malformed responses, unknown errors, and secret-free diagnostics.
- [ ] Add RED Principal tests requiring `purpose` on authenticated Session scopes and accepting only `conversation | business_skill_test` from FastAPI-owned Session rows.
- [ ] Add RED persistence tests that reject malformed purpose, never expose test Sessions from ordinary `list()`/bootstrap, and still load one authorized test Session through a dedicated method used only by the test runner.
- [ ] Add RED authorization tests for the exact Business Skill Remote method table, required `projectId`/`sessionId` extraction, Project Session matching, user-token isolation, unavailable provider, and unknown-method fail-closed behavior.
- [ ] Implement `XAgentBusinessSkillBackend`, strict parsers, Session-purpose propagation, and `XAgentBusinessSkillScopeRunner`; preserve all existing Project, Artifact, Citation, Fact, and Session authorization paths.
- [ ] Run `pnpm exec vitest run packages/xagent/backend-client/tests/backend-client.spec.ts packages/xagent/principal/tests/principal.spec.ts packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts packages/xagent/authorization/tests/authorization.spec.ts`; expect all selected tests to pass.
- [ ] Commit: `feat(xagent): add business skill backend contracts`

### Task 5: Publish a Provider-Neutral Skill Load Event

**Files:**

- Modify: `packages/skill/tool-skill/src/index.ts`
- Modify: `packages/skill/tool-skill/tests/tool-skill.spec.ts`
- Create: `packages/skill/tool-skill/tests/{invariant.spec.ts}`
- Modify: `packages/skill/tool-skill/README.md`
- Modify: `packages/skill/tool-skill/README.zh.md`
- Modify: `packages/skill/tool-skill/README.i18n.yaml`

**Interfaces — Consumes:** resolved `SkillDefinition`, captured Agent, existing `skill` tool execution, `/skill-name` injection, and the shared `renderSkillContent()` output.

**Interfaces — Produces:** awaited `skill/loaded` serial event with `{agent, definition, invocation, callId?}` after resolution and before model-visible admission; no XAgent types or policy.

- [ ] Add RED tests proving model-tool and user-explicit loads emit exactly once with the same definition/body semantics, correct invocation form, and model call ID only for the tool path.
- [ ] Add RED ordering/failure tests proving listeners finish before the result or injection is appended, a listener failure prevents the body from becoming model-visible, and list-only catalog resolution emits nothing.
- [ ] Add RED invariant coverage for load-after-resolution and no duplicate observation for one admission.
- [ ] Implement the merge-extensible typed event with complete `@mode`/`@param` JSDoc and awaited dispatch in both existing load paths; do not modify `agent-loop`.
- [ ] Update both READMEs, re-record their pair, and run `pnpm exec vitest run packages/skill/tool-skill/tests`; expect both focused test files to pass.
- [ ] Commit: `feat(skill): expose awaited load observation`

### Task 6: Create the Business Skill Service, Remote, and Project Provider

**Files:**

- Create: `packages/xagent/business-skill/package.json`
- Create: `packages/xagent/business-skill/tsconfig.json`
- Create: `packages/xagent/business-skill/src/types.ts`
- Create: `packages/xagent/business-skill/src/index.ts`
- Create: `packages/xagent/business-skill/src/invariant.ts`
- Create: `packages/xagent/business-skill/tests/business-skill.spec.ts`
- Create: `packages/xagent/business-skill/tests/invariant.spec.ts`
- Create: `packages/xagent/business-skill/README.md`
- Create: `packages/xagent/business-skill/README.zh.md`
- Create: `packages/xagent/business-skill/README.i18n.yaml`
- Modify: `tsconfig.host.json`

**Interfaces — Consumes:** authenticated Project Session scope, strict backend client, DSH Skill registry, generic load event, FastAPI public catalog fields plus opaque Host-only handles, and Browser governance calls.

**Interfaces — Produces:** `XAgentBusinessSkillService` Service Definition/Provider, `xagentBusinessSkill` Typert Remote, `XAgentBusinessSkillScopeRunner`, Agent-scoped `xagent-project` Skill provider, strict catalog candidates/definitions, and package relationship invariants.

- [ ] Add RED package tests showing only an authenticated `conversation` Project Session installs the provider; Private, test-purpose, stale, no-request, and disposed scopes install no catalog entries.
- [ ] Add RED catalog tests for bounded deterministic ordering, public slug/name/description, opaque locator ownership, current-version replacement, malformed backend data, duplicate slug/provider, and fail-closed backend errors.
- [ ] Add RED load tests for locator ownership, exact backend reauthorization, model-tool and `/slug` parity, immutable content/version mapping, unavailable authorization, and no internal key in catalog or rendered output.
- [ ] Add RED Remote tests for list/detail/create/draft/test/verdict/publish/authorization/version/retire methods, request-scope isolation, cancellation, stable error mapping, and no Principal/database identifier arguments.
- [ ] Implement the abstract capability contract, FastAPI provider, project-scoped registry consumer, Remote decorators, configuration, disposal, and relationship invariant. Register all effects through `ctx.effect()`/`ctx.on()`.
- [ ] Run `pnpm exec vitest run packages/xagent/business-skill/tests/business-skill.spec.ts packages/xagent/business-skill/tests/invariant.spec.ts`; expect all selected tests to pass.
- [ ] Run `pnpm run verify-translation-pairing --write packages/xagent/business-skill/README.md`; expect the sidecar to update.
- [ ] Commit: `feat(xagent): add governed business skill provider`

### Task 7: Enforce Turn Binding, Session Projection, and Per-Tool Authorization

**Files:**

- Modify: `packages/xagent/business-skill/src/types.ts`
- Create: `packages/xagent/business-skill/src/{turn-binding.ts}`
- Create: `packages/xagent/business-skill/src/{runtime-policy.ts}`
- Modify: `packages/xagent/business-skill/src/index.ts`
- Create: `packages/xagent/business-skill/tests/{runtime-policy.spec.ts}`
- Create: `packages/xagent/session-persistence-api/src/{business-skill-event-codec.ts}`
- Modify: `packages/xagent/session-persistence-api/src/index.ts`
- Modify: `packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts`
- Modify: `packages/core/session/src/known-event-types.ts`
- Modify: `packages/sdk/client/tests/fake-runtime.ts`
- Modify: `packages/sdk/client/tests/sdk-client.spec.ts`
- Modify: `python/sdk/tests/test_client.py`

**Interfaces — Consumes:** awaited `skill/loaded`, physical request scope captured from `agent/inbox/claimed`, current turn, resolved complete tools, `tools/pre-execute`, `agent/turn-stopping`, and Session surface replacement.

**Interfaces — Produces:** one pinned binding per turn, durable `business-skill/activated`, narrowed model tool catalog, asynchronous per-call authorization, second-Skill denial, later-history marker, and matching TypeScript/Python Session projections.

- [ ] Add RED turn tests for first activation, same-Skill reload, second-Skill conflict, later-turn repin, disposal/cancellation/failure cleanup, model-tool and user-explicit forms, and publication/rollback not changing an active binding.
- [ ] Add RED Session tests proving activation stores only slug/version/form/turn/digest, the append event preserves the exact original body, `agent/turn-stopping` replaces only that turn's Skill result/injection, and later `deriveMessages()` sees an instruction-free marker.
- [ ] Add RED policy tests proving the model catalog contains only `skill` plus the complete set after activation, `search_artifacts` retains `submit_cited_answer`, and unknown/missing/asymmetric backend tools fail loading.
- [ ] Add RED `tools/pre-execute` tests for `next()` on allow, no tool body on deny/error/cancel, every call reauthorization, pinned historical version, unauthorization/retirement/revocation denial, and no fallback to cached permission.
- [ ] Implement Agent-owned binding lifetime, typed ignorable Session event, strict codec, surface replacement, scoped restriction, and awaited waterfall listener. On a denial, return one stable reason and disable further bound-tool execution for the turn.
- [ ] Update TypeScript and Python SDK expected event sets and round-trip assertions in the same commit.
- [ ] Run `pnpm exec vitest run packages/xagent/business-skill/tests/{runtime-policy.spec.ts} packages/xagent/session-persistence-api/tests/session-persistence-api.spec.ts packages/sdk/client/tests/sdk-client.spec.ts` and `uv run --project python/sdk pytest python/sdk/tests/test_client.py`; expect all selected tests to pass.
- [ ] Commit: `feat(xagent): pin and enforce business skills per turn`

### Task 8: Implement the Read-Only Draft Test Runner

**Files:**

- Create: `packages/xagent/business-skill/src/{test-runner.ts}`
- Modify: `packages/xagent/business-skill/src/index.ts`
- Create: `packages/xagent/business-skill/tests/{test-runner.spec.ts}`
- Modify: `packages/xagent/tool-fact/src/index.ts`
- Modify: `packages/xagent/tool-fact/tests/tool-fact.spec.ts`
- Modify: `packages/xagent/tool-fact/tests/invariant.spec.ts`
- Modify: `packages/xagent/tool-fact/README.md`
- Modify: `packages/xagent/tool-fact/README.zh.md`
- Modify: `packages/xagent/tool-fact/README.i18n.yaml`

**Interfaces — Consumes:** `tests/start` response, exact draft content/policy digest, dedicated persisted test Session, Agent factory, one scenario, read-only resolved tool set, and terminal turn outcome.

**Interfaces — Produces:** one hidden test Agent/turn, user-explicit exact draft activation, strict read-only pre-execution policy, idempotent run settlement, and zero Fact proposal or project/governance write.

- [ ] Add RED test-runner tests for one Session/one scenario/one turn, exact draft injection before scenario, durable event ordering, normal settlement, model/tool failure, cancellation, disposal, and no second turn.
- [ ] Add RED closure tests showing only `skill`, selected read tools, and required read companions are visible/executable; selected `propose_fact` is reported as unexecuted production permission but is absent and denied.
- [ ] Add RED defense-in-depth tests proving `@xagent/dsh-tool-fact` refuses registration whenever authenticated Session purpose is `business_skill_test`, even if loaded into the test composition accidentally.
- [ ] Add RED isolation tests proving ordinary Session history/title/bootstrap stays untouched and late model/tool output cannot mutate a settled run.
- [ ] Implement the dedicated Agent lifecycle, exact draft provider, final read-only `tools/pre-execute` listener, settlement owner, and Fact-purpose exclusion.
- [ ] Run `pnpm exec vitest run packages/xagent/business-skill/tests/{test-runner.spec.ts} packages/xagent/tool-fact/tests/tool-fact.spec.ts packages/xagent/tool-fact/tests/invariant.spec.ts`; expect all selected tests to pass.
- [ ] Re-record the tool-fact README pair and commit: `feat(xagent): run isolated business skill tests`

### Task 9: Build the Project Governance UI

**Files:**

- Create: `packages/xagent/ui-business-skill/package.json`
- Create: `packages/xagent/ui-business-skill/tsconfig.json`
- Create: `packages/xagent/ui-business-skill/tsdown.config.ts`
- Create: `packages/xagent/ui-business-skill/src/index.ts`
- Create: `packages/xagent/ui-business-skill/src/invariant.ts`
- Create: `packages/xagent/ui-business-skill/src/css-modules.d.ts`
- Create: `packages/xagent/ui-business-skill/src/{client/index.ts,client/service.ts,client/store.ts,client/BusinessSkillPanel.tsx,client/business-skill.module.css}`
- Create: `packages/xagent/ui-business-skill/tests/store.client.spec.ts`
- Create: `packages/xagent/ui-business-skill/tests/business-skill-panel.client.spec.tsx`
- Create: `packages/xagent/ui-business-skill/tests/plugin.client.spec.tsx`
- Create: `packages/xagent/ui-business-skill/README.md`
- Create: `packages/xagent/ui-business-skill/README.zh.md`
- Create: `packages/xagent/ui-business-skill/README.i18n.yaml`
- Modify: `packages/xagent/ui-project/src/client/index.ts`
- Modify: `packages/xagent/ui-project/src/client/service.ts`
- Modify: `packages/xagent/ui-project/src/client/WorkbenchDetails.tsx`
- Modify: `packages/xagent/ui-project/tests/details.client.spec.tsx`
- Modify: `packages/xagent/ui-project/tests/plugin.client.spec.tsx`
- Modify: `tsconfig.client.json`

**Interfaces — Consumes:** generated `xagentBusinessSkill` Remote, selected account/project, current role, `xagent.workbench.skills` Slot, public slug/version/run records, and dedicated test transcript.

**Interfaces — Produces:** Skills tab, list/detail/editor/tool selector/test history/version history/audit summary, role-aware operations, confirmation dialogs, cancellable controller, and memory-only store.

- [ ] Add RED store/controller tests for account/project/connection generation changes, request cancellation, stale response suppression, deterministic pagination/selection, exact draft revision, idempotency-key reuse only for uncertain mutations, and full disposal.
- [ ] Add RED component tests for empty/loading/error/ready states, accessible keyboard tab navigation, slug/display/authorization/status/version fields, Markdown editing, closed tool choices, test scenario/result/verdict, and transcript view.
- [ ] Add RED permission tests proving Specialist actions stop at edit/test/verdict and Manager-only publish/authorize/unauthorize/version/retire controls never render for Specialists.
- [ ] Add RED confirmation tests: publication names the exact revision, qualifying test, and production write tools; retirement states terminal behavior and immediate unauthorization; stale revision forces refresh instead of overwrite.
- [ ] Add RED lifecycle/relationship tests for one Slot occupant, mounted Remote identity, account switch cleanup, project switch cleanup, and no localStorage/IndexedDB persistence.
- [ ] Implement the client package and extend the project details union/availability hooks with `skills`; use existing UI primitives and responsive visual language while keeping the feature visually distinct and task-focused.
- [ ] Run `pnpm exec vitest run packages/xagent/ui-business-skill/tests packages/xagent/ui-project/tests/details.client.spec.tsx packages/xagent/ui-project/tests/plugin.client.spec.tsx`; expect all selected tests to pass.
- [ ] Re-record the new README pair and commit: `feat(xagent-ui): add business skill governance`

### Task 10: Assemble the Business Profile and Real-Loop Snapshot

**Files:**

- Modify: `packages/bundle/xagent-business/cordis.patch.yml`
- Modify: `packages/bundle/xagent-business/package.json`
- Modify: `packages/bundle/xagent-business/src/invariant.ts`
- Modify: `packages/bundle/xagent-business/tests/business-closure.spec.ts`
- Modify: `packages/bundle/xagent-business/README.md`
- Create: `packages/bundle/xagent-business/{README.zh.md,README.i18n.yaml}`
- Create: `examples/headless-agent/tests/fixtures/xagent/business-skill/backend.ts`
- Create: `examples/headless-agent/tests/fixtures/xagent/business-skill/driver.ts`
- Create: `examples/headless-agent/tests/xagent-business-skill.snapshot.ts`
- Create: `examples/headless-agent/tests/expected/xagent-business-skill.txt`
- Modify: `examples/headless-agent/package.json`
- Modify: `tsconfig.host.json`
- Modify: `tsconfig.client.json`

**Interfaces — Consumes:** new Host/UI packages, generic `tool-skill`, disabled `skill-filesystem`, existing retrieval/Fact tools, full resolver symmetry, and the real Agent loop snapshot harness.

**Interfaces — Produces:** Business-only plugin composition, complete safe capability closure, keyless catalog/load/tool-denial/history-marker transcript, and no change to other profiles.

- [ ] Add RED bundle tests requiring `tool-skill`, Business Skill Host/UI plugins, and every dependency; require `skill-filesystem`, developer tools, and arbitrary execution capabilities to remain disabled.
- [ ] Add RED relationship invariants comparing API primary set, Host safe set, mounted tools, `search_artifacts -> submit_cited_answer`, test read-only closure, and exact Remote/provider availability.
- [ ] Add a real-loop keyless snapshot covering authorized catalog injection, `/skill-name` activation, one allowed retrieval call, denied second Business Skill, activation event, turn-end marker, and a next turn without stale instructions.
- [ ] Add a second snapshot case for model `skill` loading followed by backend unauthorization and pre-execution denial; the fixture must exercise the real provider/client path and Session persistence codec.
- [ ] Enable generic `tool-skill` without filesystem providers, mount the new packages, register TypeScript project references, generate Typert contracts, and update fixture manifests.
- [ ] Run `pnpm exec vitest run packages/bundle/xagent-business/tests/business-closure.spec.ts` and `pnpm run test:snapshot -- -t "xagent business skill"`; expect all selected tests and checked-in output to pass.
- [ ] Re-record the bundle README pair and commit: `feat(xagent): assemble phase 6 business skills`

### Task 11: Finish Documentation, Real-Stack Acceptance, and PR Evidence

**Files:**

- Modify: `.agents/notes/proposed/feature/2026-09-11-project-business-skills.md` and paired files, then move them to `.agents/notes/implemented/feature/`
- Modify: `docs/architecture.md`
- Modify: `docs/architecture.zh.md`
- Modify: `docs/architecture.i18n.yaml`
- Modify: `packages/xagent/README.md`
- Modify: `packages/xagent/README.zh.md`
- Modify: `packages/xagent/README.i18n.yaml`
- Create: `docs/superpowers/progress/2026-09-11-xagent-phase-6.md`
- Create: `docs/superpowers/progress/2026-09-11-xagent-phase-6.zh.md`
- Create: `docs/superpowers/progress/2026-09-11-xagent-phase-6.i18n.yaml`
- Modify: generated documentation catalogs selected by `pnpm run doc-sync`
- Create: PR GIF on the dedicated assets branch required by `record-browser-gif`

**Interfaces — Consumes:** complete implementation, real FastAPI/PostgreSQL stack, two project roles, a Project Session, real model flow, published/authorized Skill, isolated test Session, and all prior task evidence.

**Interfaces — Produces:** current bilingual architecture, implemented decision record, Phase 6 progress evidence, generated catalogs, real-stack role/runtime proof, secret-free GUI GIF, and minimal pre-push report.

- [ ] Add RED real-stack acceptance covering Specialist draft/test/pass, Manager publish/authorize, member `/slug` invocation with retrieval, `propose_fact` remaining pending, version publication affecting only a later turn, rollback, unauthorization denial on the next call, hidden test Session, and terminal retirement.
- [ ] Add concurrency acceptance for draft-edit conflict, duplicate publication idempotency, and authorization-versus-retirement; verify restart/replay preserves versions, activation event, test transcript, and historical marker.
- [ ] Update bilingual architecture/package docs with current behavior only. Move and rewrite the Agent Note into `implemented/feature` after every acceptance criterion has evidence; delete the proposed pair rather than leaving duplicate authority.
- [ ] Run `pnpm run verify-translation-pairing --write` for every changed bilingual pair, then run `CI=true pnpm run doc-sync`; expect every documentation gate to pass.
- [ ] Use `record-browser-gif` on the PR's real server and model flow. Record create/edit/test/verdict/publish/authorize/invoke, inspect the optimized GIF for readable state and no secrets, publish it to the assets branch, and attach it to the PR.
- [ ] Use `dsh-pre-push-checks` to select outgoing checks. At minimum run the changed API tests, changed Vitest files, focused snapshot, `pnpm run typecheck`, `pnpm run lint`, `pnpm run build`, `pnpm run hygiene`, `CI=true pnpm run doc-sync`, `git diff --cached --check`, and a secret scan over the exact diff; do not claim unrun checks.
- [ ] Commit documentation/evidence as `docs(xagent): complete phase 6 business skills`, request code review with `superpowers:requesting-code-review`, address findings with `superpowers:receiving-code-review`, and use `superpowers:finishing-a-development-branch` only after all selected checks pass.

## Plan Self-Review Checklist

- [ ] Every Phase 6 goal and non-goal maps to at least one task and one verification step.
- [ ] Every task names exact files, consumed/produced interfaces, a RED test, GREEN implementation, verification command, and commit boundary.
- [ ] No step contains `TBD`, `TODO`, “similar to”, “add tests”, an invented compatibility fallback, or a publication/test bypass.
- [ ] Python enums, Pydantic schemas, TypeScript unions, database checks, Typert methods, event codecs, UI state, and snapshot fixtures use the same closed values.
- [ ] Generic Skill changes contain no XAgent dependency, and no task modifies `agent-loop`.
- [ ] Test purpose, ordinary-session exclusion, Fact write exclusion, and read-only pre-execution denial are each verified independently.
- [ ] Catalog hiding, version pinning, model catalog restriction, per-call backend authorization, Session logging, and end-of-turn surface replacement each have direct behavior tests.
- [ ] Browser-visible payloads and model-visible content contain no database IDs, opaque keys, tokens, internal revisions, or AuditEvent IDs.
- [ ] The final task includes bilingual docs, Agent Note transition, both SDK projections, keyless real-loop snapshots, real-stack acceptance, and the required GUI GIF.
