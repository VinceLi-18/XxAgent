# XAgent Phase 6 Business Skill Design

English | [中文](2026-09-11-xagent-phase-6-business-skill-design.zh.md)

**Status: chat design approved; written specification awaiting review**

**Date: 2026-09-11**

**Scope: project-scoped declarative Business Skill drafts, isolated tests, publication, authorization, invocation, rollback, retirement, and audit**

## 1. Background

XAgent Project Sessions already provide authenticated identity, project isolation, artifact retrieval, citations, Fact proposals, and durable approval. Phase 6 builds governed Business Skills on those capabilities so project members can reuse project-specific Markdown instructions without adding arbitrary code, filesystem, Shell, Workflow, or other developer tools to the Business Profile.

This phase skips Phase 5 and does not depend on document generation or template capabilities. The first Business Skill release orchestrates only the read-only retrieval tools and `propose_fact` that already belong to the `xagent-business` composition. `propose_fact` continues to create a pending Fact proposal; Skill publication authority does not replace Fact approval.

The existing `@deepseek-ai/dsh-skill` registry, `@deepseek-ai/dsh-tool-skill` catalog, and explicit `/skill-name` invocation define generic skill discovery and loading. Phase 6 adds a project-scoped provider and governance services without changing the agent loop. FastAPI and PostgreSQL continue to own Business Skill state and authorization, while the dsh Host maps authorized versions into the current Agent's skill registry and enforces tool policy.

## 2. Goals and non-goals

### 2.1 Goals

- Project Specialists and Managers can create, edit, and test declarative Skill drafts.
- Project Managers can publish, authorize, unauthorize, roll back, and retire Skills.
- Published versions are immutable, and the system can verify the exact relationship among a draft, its test results, and its published version.
- Only the authorized current version enters the skill catalog of an authenticated Project Session; both model discovery and user `/skill-name` invocation can load it.
- Each turn pins one Skill version and tool set; publication or rollback cannot change their behavior during that turn.
- Runtime execution policy enforces the tool allowlist rather than relying on prompt compliance.
- Draft tests run in isolated, read-only test Sessions and cannot write into ordinary Session history, the Fact approval queue, or other project data.
- Formal audit records cover governance and runtime authorization decisions, while the Session log can reconstruct the Skill content that the model actually saw.

### 2.2 Non-goals

- Do not execute user-supplied JavaScript, Python, Shell, or dynamic Workflow code.
- Do not provide cross-project, personal, or organization Skills, a Skill marketplace, import/export, or an external Skill repository.
- Do not load Business Skills in Private Sessions, the Developer Profile, Headless, or the ordinary Web Profile.
- Do not provide automated output-quality scoring, automatic approval, a publication-test bypass, or mandatory two-person publication approval.
- Do not let tests simulate writes, create fake approvals, or use a disposable test database.
- Do not let Skill authorization extend project membership, artifact permissions, or Fact approval permissions.
- Do not implement Phase 5 document generation, templates, or export capabilities.

## 3. Roles and permissions

FastAPI re-reads project membership and account state during every governance or runtime request. A role, project, or permission revision supplied by the Browser has no authorization authority.

| Operation | Specialist | Manager |
|---|---:|---:|
| View project Skills and versions | Yes | Yes |
| Create a Skill and draft | Yes | Yes |
| Edit a draft and tool selection | Yes | Yes |
| Start a test and record a human verdict | Yes | Yes |
| Publish an exact draft revision | No | Yes |
| Authorize or unauthorize | No | Yes |
| Select a historical version as current | No | Yes |
| Retire a Skill | No | Yes |
| Invoke an authorized Skill | Yes | Yes |

A Manager may publish a Skill they created or tested. Publication does not require a second Manager, but it must satisfy the exact-revision test requirement. Members can operate only on records in their projects; an invisible Skill and an absent Skill return the same result.

## 4. System responsibilities

### 4.1 FastAPI and PostgreSQL

FastAPI owns Skill identity, drafts, immutable versions, test runs, project authorization, the current-version pointer, retirement state, and formal AuditEvents. Every user endpoint and internal Host endpoint verifies the Principal, active login, permission revision, and project membership inside the application transaction; PostgreSQL row-level security supplies a second project-isolation check.

FastAPI performs publication, rollback, authorization, and retirement. The dsh Host does not persist governance state that could compete with the database. Host caches may accelerate catalog reads only; stale cache state, backend unavailability, or a version mismatch must deny loading or execution.

### 4.2 dsh Host

A new XAgent Business Skill capability seam comprises a Service Definition, a Service Provider that calls FastAPI, and runtime Consumers. A Consumer registers a project-scoped skill provider only for a Project Session Agent that carries an authenticated physical-request context. The provider captures that Agent and Session rather than guessing the project from the generic skill lookup `cwd`.

The provider maps authorized current versions returned by the backend to `SkillCandidate` and `SkillDefinition` values. `locator` and `metadata` may carry provider-private handles, version identities, tool sets, and content digests, but the generic catalog, model tool result, and Browser response expose no database ID, delegation token, audit ID, or internal authorization revision.

The `xagent-business` composition re-enables `@deepseek-ai/dsh-tool-skill` while keeping `skill-filesystem` disabled. The Business provider therefore reuses the existing model catalog, `skill` loader tool, and `/skill-name` parsing. Other Profiles retain their current skill composition.

### 4.3 Browser Remote and client

A new Host Remote provides the Browser governance entry point. The Remote obtains the user token from the authenticated Connection and calls a closed set of FastAPI operations; request bodies cannot supply a Principal or override project scope. A new client plugin registers a Skills page in the project details area and reuses the project-selection, account-switch cleanup, operation-shield, and error-display conventions.

## 5. Data model

### 5.1 `business_skills`

Each row represents one stable Skill identity inside a project. It contains at least `id`, `project_id`, an immutable project-unique kebab-case `slug`, a display name, `current_version_id`, status, creator, and timestamps. `slug` is the public name used by `/skill-name` and the model catalog; the display name exists only in the governance UI.

Status is `active` or `retired`. Retirement is terminal in the first release: it clears authorization and forbids new drafts, publication, and restoration, while preserving historical versions, tests, and audit. Restoring the same business procedure requires a new Skill with a new `slug`.

### 5.2 `business_skill_drafts`

Each active Skill has at most one mutable draft. The draft stores Markdown instructions, the catalog description, the user-selected primary tools, an increasing `revision`, a normalized content digest, editor, and timestamps. Editing a published Skill copies its current version into a draft. Draft writes use optimistic concurrency and require the revision read by the client.

Every change to the instructions, catalog description, or primary-tool selection increments the revision and changes the digest. The display name does not enter a model request and can change independently; `slug` is immutable.

### 5.3 `business_skill_versions`

Publication copies one draft revision into an immutable, project-monotonic version. The version stores the catalog description, Markdown instructions, user-selected primary tools, the fully resolved tool set at publication, a tool-policy digest, source draft revision, publisher, and publication time. Database constraints and service write paths both forbid updating or deleting version content.

`business_skills.current_version_id` points to the current published version. Publishing a new version or selecting a historical version atomically changes only that pointer. An already authorized stable Skill uses the new current version in later turns without requiring reauthorization.

### 5.4 `business_skill_test_runs`

A test record identifies the Skill, exact draft revision, draft digest, tool-policy digest, isolated test Session, run status, termination reason, human verdict, actor, and timestamps. Run status and human verdict are separate. Only a test that completes normally, attempts no forbidden operation, and receives a human pass verdict can satisfy publication.

A failed, cancelled, or rejected test does not lock the draft. Tests remain as history after the draft or tool-policy digest changes, but they cannot authorize publication of the new content.

### 5.5 `business_skill_authorizations`

An authorization applies to the stable Skill inside its project, not to one version. While an effective authorization exists, the current published version enters later Project Session catalogs. Removing authorization immediately blocks new loads and causes the next tool call in an active turn to fail.

### 5.6 Audit

The existing AuditEvent records creation, draft updates, test starts and verdicts, publication, authorization, unauthorization, rollback, load denial, tool-authorization denial, and retirement. Audit data may contain internal correlation IDs; the Browser receives only the public Skill name, version number, status, and time needed by the product.

## 6. Draft testing

### 6.1 Test Session

When a test starts, FastAPI creates a durable Project Session with `purpose = business_skill_test` for the exact draft revision and links it to the test record. Ordinary Session lists, project conversation history, title generation, and ordinary resume endpoints exclude this purpose. The Skills UI opens the test transcript through a dedicated Remote. The test Session still uses the production Session event log, so its execution remains replayable and auditable without entering members' ordinary business conversations.

One test run executes one user-supplied scenario in one turn. The Browser Remote first asks FastAPI to create the test record and test Session in one transaction. The Host test runner then injects the exact draft as a user-explicit Skill and submits the scenario. After the turn completes, fails, or is cancelled, the Host settles run status through an idempotent internal endpoint. A different scenario creates a different test run rather than appending a turn to the same test Session.

The test Session pins the draft content and tool-policy digest at test start. A later edit changes neither the completed run nor its record and cannot make it satisfy publication of a new revision.

### 6.2 Read-only composition

The Business Skill service's test runner creates a dedicated Agent and registers the draft provider and final read-only `tools/pre-execute` policy in that Agent's scope. The test Agent sees only skill loading, project discovery, and artifact retrieval. `@xagent/dsh-tool-fact` explicitly excludes `purpose = business_skill_test`, so it never registers `propose_fact` for that Agent. The purpose check and pre-execution denial together prevent a configuration error from exposing a write tool.

A selected write tool may appear in the prospective publication configuration, but the test never simulates it. The UI marks unexecuted write permissions, and a Manager must still confirm that the version includes production write access. Read-only means that the run cannot mutate project artifacts, Facts, approvals, or governance state. Session events, retrieval receipts, citation relations, and audit still follow existing durability requirements and can refer only to the test Session.

Test success means the Session completed normally, backend authorization remained valid, Skill content entered the model request, every invoked tool belonged to the test read-only set, and no cancellation, tool denial, or execution error occurred. A Specialist or Manager then records a human pass or reject verdict. The first release does not score output quality automatically.

## 7. Publication, authorization, rollback, and retirement

### 7.1 Publication transaction

A publication request contains the Skill, expected draft revision, and an idempotency key. In one transaction, FastAPI revalidates Manager role and project membership; locks the stable Skill and draft; verifies the Skill is active and the revision and digest are unchanged; and finds at least one successful, human-passed test with the same revision and tool-policy digest. It then inserts the immutable version, advances `current_version_id`, and writes the audit record.

A Manager cannot bypass testing. A concurrent edit returns `409`; a missing qualifying test returns a precondition failure. Reusing an idempotency key with the same request returns the stored result, while using it with different content returns an idempotency conflict.

### 7.2 Authorization and version switching

Publication does not create the initial authorization automatically. After a Manager explicitly authorizes the stable Skill, its current version enters the project catalog. Publishing or rolling back an already authorized Skill changes the version used by later turns, while a turn already in progress keeps its pinned version.

Rollback may select only a historical published version of the same Skill and writes an audit record. It does not copy the version, change its publisher or publication time, or require another test of immutable historical content.

### 7.3 Retirement

The retirement transaction revalidates Manager role, locks the Skill, removes its authorization, and changes status to `retired`. Later catalog reads and loads hide that Skill. A running turn is denied when its next tool call reauthorizes. Retirement deletes no version, test Session, Session event, or audit record.

## 8. Catalog, loading, and turn binding

### 8.1 Visibility

Every Project Session catalog resolution returns only Skills whose current actor still has project access and that are published, authorized, and active. Unpublished, unauthorized, retired, cross-project, and backend-denied Skills do not enter the catalog. Private Sessions and non-Business Profiles do not register the provider.

The model loads a catalog Skill through the existing `skill` tool, and the user invokes it explicitly through `/skill-name`. Both paths call the same provider load operation. FastAPI revalidates the Session, project, membership, authorization, state, and current version before returning the body.

### 8.2 Turn pinning

When a turn first loads a Business Skill successfully, the Consumer creates an Agent-scoped runtime binding containing the provider-private stable Skill identity, exact version, tool-policy digest, and complete tool set. Reloading the same Skill in that turn returns the same version. Loading a different Business Skill is denied so two allowlists cannot merge or replace one another.

Turn completion, failure, cancellation, Agent disposal, and service replacement clear the binding. Publication, rollback, and ordinary permission-revision changes do not replace an active binding; they affect later turns only. Unauthorization and retirement take effect when the next tool call reauthorizes.

### 8.3 Session recording

Skill content enters the Session log through the existing `skill` tool result or `skill-invocation` injection, so the event log can reconstruct model-visible content. The generic Skill Consumer adds a load-observation event. The XAgent Consumer responds by appending a `business-skill/activated` Session event with the public `slug`, public version number, invocation form, activation turn, and tool-policy digest, but no database ID or credential.

Business Skill instructions apply only to the activation turn. During `agent/turn-stopping`, the XAgent Consumer uses the existing Session surface replacement to replace that turn's Business Skill tool result or injection with an instruction-free historical-use marker before allowing the turn to end. The original append event remains available to the human transcript, audit, and exact request reconstruction. Later `deriveMessages()` calls return only the marker, so publication, rollback, or a later invocation never asks the model to follow multiple body versions simultaneously.

The model invocation path and user-explicit invocation path continue to use the same `renderSkillContent()` output. The load-observation event and end-of-turn replacement use existing skill, agent, and Session extension points and do not change the agent loop. The new Session event updates the expected TypeScript and Python SDK event projections in the same change.

## 9. Tool policy

### 9.1 Declared and complete sets

The draft stores the primary tools selected by the user. The first release's closed selection set is `list_accessible_projects`, `search_artifacts`, and `propose_fact`. FastAPI rejects unknown names. The Host also intersects the backend set with the `xagent-business` safe set and fails the load if any tool is missing or differs.

Publication resolves and stores the complete tool set. `search_artifacts` automatically includes the dynamic terminal tool `submit_cited_answer`. Skill loading retains the framework `skill` tool, but the Business provider rejects an attempt to load another Business Skill in the same turn. Composition-bundle invariants and tests keep the backend allowlist, Host safe set, mounted tools, and companion-tool relations symmetric.

The tool resolver has an explicit version, and its digest enters test and publication records. A resolver or companion-tool change invalidates an older draft test for publication and requires a test under the current tool policy.

### 9.2 Production execution

After a Business Skill activates, an Agent-scoped tool restriction removes every global tool outside the complete set from the model catalog. An unavoidable asynchronous `tools/pre-execute` policy also runs before every call. The listener delegates through `next()` only after sending the Session, pinned Skill version, tool name, and current physical-request context to FastAPI.

FastAPI revalidates the active account, login, permission revision, project membership, Skill authorization, active state, pinned version ownership, and membership of the tool in that version's complete set. The pinned version does not need to remain the current pointer, so ordinary publication or rollback does not interrupt an active turn. Unauthorization and retirement must deny it.

Backend unavailability, cancellation, version mismatch, an unknown tool, or an unverifiable response returns a stable denial without running the tool body. The denial enters the Session log as a normal tool result and prevents further Business Skill tool execution. The system never falls back to prompt-only enforcement or a cached execution permission.

### 9.3 Writes

`propose_fact` only prepares an immutable Fact proposal and returns `pending`. Business Skill authorization cannot approve, confirm, or write a ProjectFactRevision. The existing Fact service continues to validate evidence, idempotency, conflicts, and approval. The draft-test composition does not register `propose_fact`, so a test cannot create a proposal.

## 10. Governance UI

The project details area gains a Skills section. Its list shows name, `slug`, status, current version, authorization state, draft revision, latest test result, and update time. The details view contains the draft editor, primary-tool selector, test records, version history, and an audit summary.

Specialists and Managers can create, edit, start a test, view the isolated test transcript, and record a human verdict. Managers additionally see publication, authorization, unauthorization, version switching, and retirement operations. Editing a published Skill automatically creates a draft from the current version; the UI never updates a version record directly.

Dangerous operations use explicit confirmation text. Publication confirmation lists the version, qualifying test, and production write tools. Retirement confirmation states that retirement is terminal and unauthorization is immediate. Account or project changes cancel requests and clear the client Skill store. The Browser does not persist Skill bodies, authorization, or test transcripts in local storage.

Ordinary members discover Skills through the Project Session catalog and need not enter the governance UI. Catalog changes use the existing `@deepseek-ai/dsh-tool-skill` replacement-catalog event. A new version, authorization change, or retirement takes effect no later than catalog resolution at the next `agent/pre-step`.

## 11. Error handling

| Condition | External result | System behavior |
|---|---|---|
| Draft revision conflict | `409` | Do not overwrite; the client refreshes before retrying |
| No qualifying test | Precondition failure | Do not publish or start an automatic test |
| Non-Manager governance request | `403` | Preserve state and write denial audit |
| Invisible or cross-project Skill | `404` | Do not reveal existence |
| Backend or authorization unavailable | Stable service-unavailable error | Do not load, execute, or use stale permission |
| Test attempts a write tool | Stable read-only denial | Do not run the tool body; fail the test |
| Turn attempts a second Business Skill | Stable conflict error | Preserve the first binding |
| Tool is outside the complete set | Stable permission denial | Do not run the tool body; record Session and formal audit |
| Active Skill becomes unauthorized or retired | Deny the next tool call | Remove further execution eligibility and preserve written logs |
| Runtime cancellation | Cancellation result | Await authorization settlement and reject late permission |

A failed test does not retry automatically or prevent further edits. The client offers retry only for explicitly retryable reads. Publication, authorization, rollback, and retirement use idempotency keys, so a Browser timeout cannot prove that an operation did not occur.

## 12. Security and durability requirements

- Browser Remotes, skill locators, model catalogs, and tool results cannot accept or expose a Principal, database ID, internal permission revision, service token, delegation token, or AuditEvent ID.
- FastAPI validates project scope in an RLS transaction. Host scope selects only the request context and cannot replace database authorization.
- Published version content, complete tool set, and tool-policy digest are immutable. Only the stable Skill's current-version pointer can change.
- Model-visible Skill catalogs and bodies must enter the Session log. Host-private bindings and authorization credentials must not enter model requests.
- Test Sessions use the same durable event mechanism as ordinary Sessions, but immutable purpose excludes them from ordinary lists and execution endpoints.
- Tool catalog restriction and pre-execution authorization jointly enforce least privilege; catalog hiding cannot replace execution denial.
- Authorization can only narrow existing project and tool permission. It cannot grant artifact, Fact, or Session access that the actor does not already hold.

## 13. Package and service boundaries

Implementation is expected to add or modify the following independent units; the implementation plan will define the task split:

- `services/api`: models, Alembic migration, RLS, governance services, internal runtime endpoints, AuditEvents, and API tests.
- `@xagent/dsh-business-skill`: Service Definition, FastAPI Provider, Agent-scoped catalog, version binding, load-observation Consumer, and pre-execution authorization.
- `@xagent/dsh-ui-business-skill`: generated Remote client, project governance UI, and isolated test transcript.
- `@deepseek-ai/dsh-tool-skill`: generic, provider-neutral Skill load-observation event with no XAgent policy.
- `@xagent/dsh-session-persistence-api`: test Session purpose handling and protocol codecs for the new Session event.
- `@xagent/dsh-authorization`: closed Skills Remote method table and Project Session request scope.
- `@xagent/dsh-tool-fact`: refuse to register a write tool for a Business Skill test Session.
- `@deepseek-ai/dsh-xagent-business`: enable the generic skill tool, mount Business Skill and UI plugins, and extend complete-composition invariants.

Any generic-package change provides only reusable events or types and reads no XAgent Principal, project, or FastAPI state. Business behavior remains in `packages/xagent/` and `services/api`.

## 14. Verification strategy

### 14.1 FastAPI and PostgreSQL

- Test schemas, foreign keys, uniqueness, immutable versions, and state constraints, plus migration upgrade and downgrade.
- Test the authorization matrix for Specialists, Managers, non-members, disabled accounts, revoked logins, and permission-revision changes.
- Test RLS denial for cross-project reads and writes, including internal runtime endpoints.
- Test concurrent draft updates, duplicate publication, idempotency conflicts, and authorization-versus-retirement races.
- Test exact revision, draft digest, and tool-policy digest validity.
- Test Session purpose isolation and exclusion from ordinary Session lists.

### 14.2 dsh Host

- Verify that only Project Sessions in `xagent-business` register the Business provider; other Profiles and Private Sessions have an empty Business Skill catalog.
- Test authorized catalog mapping, model loading, `/skill-name`, catalog replacement, and fail-closed backend behavior.
- Test same-turn version pinning, second-Skill denial, end-of-turn surface replacement, and cancellation cleanup. Later model requests must not contain old Skill instructions.
- Test tool catalog restriction, authorization before every `tools/pre-execute`, and immediate denial after unauthorization or retirement.
- Test primary and companion-tool closure, including `search_artifacts` with `submit_cited_answer` and `propose_fact` with existing Fact approval.
- Test replay and unknown-event handling for the new Session event, plus the expected TypeScript and Python SDK projections.
- Test dependency closure, tool closure, and disabled developer-tool invariants for the `xagent-business` and test compositions.

### 14.3 Product flow

- Browser component tests cover concurrent draft edits, test state, publication preconditions, permission-based control visibility, account or project switching, and dangerous-operation confirmation.
- A keyless snapshot through a real runnable example records catalog discovery, explicit user invocation, production retrieval, Fact pending, unauthorization denial, and test read-only denial.
- FastAPI and Host integration tests use real PostgreSQL RLS and do not replace authorization outcomes with mocks.
- The PR includes a GUI GIF recorded from the real service and model flow, covering draft testing, publication and authorization, and Project Session invocation. A failed recording means product acceptance has not passed.
- Relevant checks follow the repository's pre-push policy. Documentation runs at least `pnpm run doc-sync`, `pnpm run lint`, and `git diff --check`.

## 15. Acceptance criteria

Phase 6 is complete after the following end-to-end flow passes:

1. A Specialist creates a Skill in a project, edits its Markdown instructions, and selects retrieval and Fact primary tools.
2. The system creates an isolated test Session that permits project discovery and artifact retrieval while actually denying `propose_fact` and every write operation.
3. After the test completes normally, the actor records a human pass. Editing the draft makes that test ineligible for publication.
4. A Manager publishes the exact draft revision, creating an immutable version. An untested revision cannot be published.
5. A Manager authorizes the Skill. Project members see it in later Project Session catalogs and can load it through the model or `/skill-name`.
6. The turn pins its version and tool set. Every tool call reauthorizes before execution, and a tool outside the allowlist does not run.
7. `propose_fact` creates only a pending proposal, and existing Fact approval still decides whether to write a confirmed Fact.
8. When a Manager publishes another version or rolls back, an active turn keeps its version and later turns use the new current pointer.
9. After a Manager unauthorizes or retires the Skill, the catalog hides it and the next tool call in an active turn is denied.
10. After the turn ends, later model requests see only an instruction-free historical-use marker. The original log can still reconstruct the catalog and body seen during the activation turn.
11. Formal audit can correlate governance and runtime denials, and no user interface exposes an internal identifier or credential.

## 16. Alternatives considered

### 16.1 Own the Skill lifecycle in Session events

Rejected. The Session log appropriately owns model execution and replay, but not project governance shared across Sessions and members. Storing drafts, publication, and authorization in one Session would create competing sources of truth and make RLS, concurrent editing, and Manager actions depend on a conversation lifecycle.

### 16.2 Store Business Skills as repository or workspace files

Rejected. Business users must not receive server-file or Git permissions, and a file provider cannot naturally express project membership, publication transactions, test evidence, a current-version pointer, and formal audit. `skill-filesystem` remains disabled in the Business Profile.

### 16.3 Generate a Cordis plugin for each published version

Rejected. Dynamic plugin deployment would turn business-content publication into code deployment and add restart, supply-chain, and rollback risks. A project-scoped provider reuses the existing Skill Registry without executing arbitrary code.

## 17. Known trade-offs and follow-up work

Strict read-only testing cannot exercise the actual `propose_fact` write path. Publication confirmation must therefore display production write tools clearly, while existing Fact integration tests continue to verify that tool's security properties. The first release prioritizes tests that cannot contaminate business data and does not create fake approvals or disposable databases.

Every tool call reaches FastAPI, trading latency for immediate unauthorization and retirement. The implementation may reuse connections and keep a short-lived catalog cache, but it cannot cache execution permission. Performance optimization and batch authorization are outside the first release.

One turn permits only one Business Skill, avoiding ambiguous tool-set merging. Multi-Skill composition, organization sharing, automated evaluation, configurable approval policy, retirement restoration, and document tools require separate future designs.
