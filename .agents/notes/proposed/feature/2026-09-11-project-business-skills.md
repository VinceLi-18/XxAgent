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

This proposal extends the [Business profile composition](../../implemented/feature/2026-08-22-xagent-profile-product-shell.md) with a governed provider while retaining its disabled filesystem provider and developer capabilities. The [authentication and Session isolation rules](../../implemented/architecture/2026-08-25-xagent-auth-session-runtime.md) remain authoritative. These records retain independent rationale; none is superseded by the storage foundation. The [approved design](../../../../docs/superpowers/specs/2026-09-11-xagent-phase-6-business-skill-design.md) defines the complete product flow.

## Alternatives considered

**Own governance in Session events.** Project-wide concurrent publication and authorization must survive individual Sessions and enforce PostgreSQL project access; the Session log owns execution evidence instead.

**Store Skills as workspace files.** File permissions cannot express project membership, exact tested publication, current-version selection, and formal audit without granting business users server access.

**Generate a plugin for every version.** Business instructions must not become arbitrary code deployment with restart and supply-chain consequences. A provider can reuse the registry without executing user code.

## Acceptance criteria

- Real PostgreSQL tests prove project RLS, worker denial, least-privilege API grants, immutable identities and versions, exact references, terminal retirement, and downgrade refusal before DDL when Skill data, test Sessions, or Skill audit exists.
- Governance tests prove exact-revision publication, concurrent edit conflicts, idempotency, stable-Skill authorization, rollback, and immediate revocation.
- Runtime and assembled snapshots prove both invocation forms, one-version turn pinning, per-tool authorization, logged bodies, historical markers, and test read-only isolation. Both SDK projections include the activation event.
- A real-service Browser recording verifies draft testing, publication, authorization, and Project Session invocation before this proposal moves to implemented.

## Risks

Read-only tests cannot execute production Fact writes, so publication must disclose those permissions and preserve the independent Fact approval checks. Each tool call adds backend latency and must fail closed when authorization is unavailable. Immutable publication and terminal retirement restrict repair; downgrade requires an empty Skill store, no test Sessions, and no Skill audit records. One Skill per turn deliberately excludes allowlist merging.
