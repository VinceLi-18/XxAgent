# Agent Note: Governed project Business Skills

Status: proposed

English | [中文](2026-09-11-project-business-skills.zh.md)

## Problem

Project members need reusable business instructions without acquiring server filesystem access or deploying executable plugins. A reusable procedure also needs evidence that its exact contents were tested, a durable publication identity, and permission that can be revoked during execution.

## Proposal

FastAPI and PostgreSQL own project-scoped stable Skill identities, one mutable draft per Skill, immutable published versions, isolated test records, authorization, and formal audit. A project-unique kebab-case slug is immutable. Version and test-run numbers increase across the project under a project row lock. Composite references keep each current version and test Session in its own Skill and project. Database triggers preserve publication content, tool sets, digests, source revision, publisher, and publication time.

Specialists and Managers may edit and test drafts; Managers may publish only the exact revision and digests of a normally completed, human-passed test. Authorization applies to the stable Skill, so publication and rollback change later turns without requiring another authorization. Retirement removes authorization and permanently prevents drafting, publication, and restoration while retaining history.

Each draft test owns one durable Project Session with immutable `business_skill_test` purpose, one scenario, and one turn. Dedicated transcript access keeps it outside ordinary conversation lists and resume paths. Its read-only Agent excludes `propose_fact` and denies forbidden tools before execution; test success never simulates a write or creates an approval. Production `propose_fact` continues to use [governed Fact approval](../../implemented/architecture/2026-09-06-xagent-fact-approval.md).

The start transaction creates an empty Session and retains the exact draft and scenario in its durable idempotent response. The Host admits those inputs through its normal Skill and turn operations, preserving the actual admission once in the event log. Only the starting actor can append while the run is active or settle its exact Session; terminal outcomes reject conflicting and late replies. Transcript reads remain available to current project members after settlement and retirement. Runtime decisions lock the Session before the Skill; the Skill lock serializes authorization changes while immutable version content needs no write privilege.

The Business provider reuses the [generic Skill registry](../../implemented/feature/2026-07-05-skill-system.md) and [catalog replacement](../../implemented/feature/2026-07-27-skill-catalog-hot-refresh.md). One turn pins one published Skill version and complete tool set. Every tool call reauthorizes current membership, active account, Skill authorization, and retirement state through FastAPI. Publication or rollback does not replace that pin; revocation denies the next call. The Session log retains the loaded body, and a turn-ending surface replacement leaves an instruction-free marker for later model requests.

The Host provider owns exact Agent/request registrations and private definition-to-version relations. Its public definitions contain no backend handles. The generic registry separates observation completeness from the optional `cacheable` flag: an authoritative Business catalog is publishable but never reused across physical-request reads. Returning an incomplete observation would suppress legitimate catalog publication; treating an authoritative observation as automatically cacheable would disclose one request's catalog to a concurrent read outside that request. Exact backend reauthorization remains mandatory for every load. The test Remote requires a separately registered executor before it can create an isolated run, preserving ownership of admission and settlement.

Each discovery owns its candidate observation independently: a registration-wide current-candidate slot would let concurrent reads or refresh invalidate an authorized in-flight load. Exact candidate ownership is weakly retained for the physical request, while every load still checks backend authorization. Provider disposal aborts the transport with its registration signal and awaits owned operations; post-response cancellation checks discard late results from transports that ignore abort. Transport-completion and provider-publication checks protect distinct Promise continuations: cancellation can occur between them, so the provider must recheck its scope and caller signal after its final await. This check is required even when optional invariant diagnostics are disabled.

Inbox insertion captures physical-request ownership, and claiming binds that owner to the exact turn. Ambient async context cannot authorize a later queued turn. An awaited execution listener delegates only after fresh backend authorization, and a final guard requires admission for that exact execution object; an earlier listener's allow cannot substitute for it. Request cancellation closes authorization immediately, but the Agent retains its pin, guard and dispatch wrapper until durable turn end or Agent disposal. An empty active-callback set does not prove that execution ended: approval publication can occur between callbacks and cancel the physical request before dispatch starts. The wrapper rechecks cancellation and combines the physical lifetime with the execution signal, while request teardown settles only the work it already owns. Projection runs outside synchronous Session append notifications to preserve atomic event publication.

Prompt assembly filters Agent-local tools as well as inherited registrations. Explicit invocation occurs after assembly, so activation narrows the pending array before the request header snapshots it. Model-tool invocation occurs after that request is logged and leaves its frozen array unchanged; the next assembly applies the pin. The activation record uses the existing ignorable envelope, which lets readers without the event declaration retain the log safely without changing its structural format version. Raw instructions remain in append records; only their current-turn model-history entries become use markers.

This proposal extends the [Business profile composition](../../implemented/feature/2026-08-22-xagent-profile-product-shell.md) with a governed provider while retaining its disabled filesystem provider and developer capabilities. The [authentication and Session isolation rules](../../implemented/architecture/2026-08-25-xagent-auth-session-runtime.md) remain authoritative. These records retain independent rationale; none is superseded by the storage foundation. The [approved design](../../../../docs/superpowers/specs/2026-09-11-xagent-phase-6-business-skill-design.md) defines the complete product flow.

Only durable `turn/end` closes the instruction lifetime: `agent/turn-stopping` can steer into another step of the same turn. Activation and recorded Skill calls identify completed instruction entries on Session startup as well as during live cleanup, so crash repair does not revive an old body alongside a new pin. Identity-preserving single-node replacements inherit the original admission, even when their append time falls in another turn. Cleanup replaces the current visible entry, including a pruned result, and recognizes an existing marker by content. Unrelated checkpoints cannot inherit Skill admission merely by replacing its history position. The [Session surface rules](../../implemented/architecture/2026-06-18-session-surface.md) independently enforce content-only tool-result replacement. Runtime callback `finally` blocks own execution settlement; an unloadable `tools/result` listener cannot own the promise that its own scope disposal awaits.

The declared retrieval pair remains complete even before evidence dynamically registers `submit_cited_answer`. This one exception requires the actual retrieval service and a live search definition recognized by its Consumer's private WeakSet. Definition copying and plugin unloading revoke that recognition. Name equality alone cannot establish ownership, and pre-registering a placeholder companion would falsely advertise executable evidence access.

Approval waits occur between pre-execution policy and tool dispatch, outside either callback. A prepended Agent-scoped approval listener always delegates and races the result against the physical lifetime. Teardown waits only for this cancellable callback, not an unresponsive answerer; the race consumes late rejection and preserves the cancelled decision. This protects the approval interval without extending the generic execution API or changing readonly approval requests.

## Alternatives considered

**Own governance in Session events.** Project-wide concurrent publication and authorization must survive individual Sessions and enforce PostgreSQL project access; the Session log owns execution evidence instead.

**Store Skills as workspace files.** File permissions cannot express project membership, exact tested publication, current-version selection, and formal audit without granting business users server access.

**Generate a plugin for every version.** Business instructions must not become arbitrary code deployment with restart and supply-chain consequences. A provider can reuse the registry without executing user code.

**Filter only the inherited tool registry.** Agent-owned registrations are not inherited entries and would remain model-visible. Assembly filtering plus exact-call execution authorization covers both registration origins without adding Business policy to the generic loop.

## Acceptance criteria

- Real PostgreSQL tests prove project RLS, worker denial, least-privilege API grants, immutable identities and versions, exact references, terminal retirement, and downgrade refusal before DDL when Skill data, test Sessions, or Skill audit exists.
- Governance tests prove exact-revision publication, concurrent edit conflicts, idempotency, stable-Skill authorization, rollback, and immediate revocation.
- Runtime and assembled snapshots prove both invocation forms, one-version turn pinning, per-tool authorization, logged bodies, historical markers, and test read-only isolation. Both SDK projections include the activation event.
- A real-service Browser recording verifies draft testing, publication, authorization, and Project Session invocation before this proposal moves to implemented.

## Risks

Read-only tests cannot execute production Fact writes, so publication must disclose those permissions and preserve the independent Fact approval checks. Each tool call adds backend latency and must fail closed when authorization is unavailable. Immutable publication and terminal retirement restrict repair; downgrade requires an empty Skill store, no test Sessions, and no Skill audit records. One Skill per turn deliberately excludes allowlist merging.
