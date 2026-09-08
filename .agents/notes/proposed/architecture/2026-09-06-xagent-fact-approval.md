# Agent Note: Governed Project Fact Approval

Status: proposed

English | [中文](2026-09-06-xagent-fact-approval.zh.md)

## Problem

Project Sessions can retrieve and cite project evidence, but no durable path lets an Agent propose a business fact for later human review. Treating a live user-approval result as that authority would lose the decision across restarts, couple review to one Turn, and leave FastAPI unable to enforce the project, evidence, revision, and reviewer relationships atomically.

The first governed write also needs to enter the source Session history without allowing a database decision to start an Agent Turn. The proposal result must become reviewable only when the matching public tool result is durably admitted, and retries or concurrent decisions must not duplicate a Fact revision, audit outcome, or Session projection.

## Proposal

FastAPI and PostgreSQL will own typed project Facts, immutable proposals, exact evidence, authorization, decisions, idempotency, audit, and delivery state. The first implementation will govern only the project Fact object instead of introducing a generic approval framework before another approved object exists.

### Durable approval

A specialist or manager with current access to a Project Session may propose a Fact. A manager with current membership in that project may approve or reject it, including their own proposal, and the proposer may withdraw it. Global role alone never bypasses current project membership or row-level security.

The public lifecycle is `pending -> confirmed | rejected | withdrawn | conflicted`; every terminal state is irreversible. Approval runs as one serializable FastAPI transaction that locks the proposal and current head. A matching base revision creates the next positive immutable revision, advances the same project and field head, records the decision and audit, and inserts one Outbox row. A changed head produces `conflicted`, audit, and Outbox state without creating a revision.

### Receipt-bound admission

Proposal preparation creates a hidden `prepared` proposal with a five-minute admission deadline and a random receipt stored only as a digest. FastAPI binds the preparation to the authenticated actor, source Session and project, tool call, permission revision, canonical payload hash, and source event sequence.

The proposal becomes `pending` only when Session append admits the matching public `tool/result` and private receipt attachment in one transaction. The receipt is consumed exactly once and never enters public tool results, Session events, model content, Browser state, logs, or audit. Expired or unmatched preparations remain invisible and cannot become reviewable.

### Exact evidence and immutable Facts

Proposal evidence references at most 64 distinct citation IDs already admitted for the source Session. Each evidence row preserves both the durable admitted-evidence identity and the exact Artifact text-chunk line range; filenames, URLs, object keys, and model-supplied Artifact identities have no authority. An evidence-free proposal requires a bounded non-empty assertion reason.

`project_fact_revisions` stores typed values and a positive content revision unique within one project field. `project_fact_heads` has one row per project and field and uses a composite reference so the head cannot point across projects or fields. Confirmed revisions and the candidate fields of terminal proposals are immutable.

### Outbox projection

Each terminal proposal owns exactly one immutable `business_outbox` row for aggregate kind `fact_proposal`. The Fact UI reads FastAPI directly; the Outbox exists only to project the decision into the source Session's durable event log.

The Host pulls bounded rows for the source Session and appends a closed `fact/proposal-decided` event. FastAPI validates the Outbox identity, proposal, Session, payload hash, and event identity, then marks the row consumed in the same transaction that admits the Session event. A lost response can replay without adding another event, and a decision event never starts a Turn.

### Authorization and audit

Every operation rechecks the authenticated account, permission revision, role, project membership, and related rows through PostgreSQL row-level security. Prepared proposals are hidden from product reads. Guessed identifiers, revoked membership, and a manager without project membership reveal no Fact data. The application role receives only the DML needed by the Fact API, while `xagent_worker` receives no access to Fact relations.

Fact audit actions contain only identities, counts, hashes, stable outcomes, and latency. An action-aware database validator rejects Fact content, reason text, evidence text, credentials, tokens, receipts, URLs, and object keys before an audit row can be stored.

## Alternatives considered

**Use the live DSH user-approval capability.** That decision authorizes one operation in a live Turn and cannot represent asynchronous review, PostgreSQL authorization, immutable business history, or restart recovery. It remains unchanged and does not authorize a Fact proposal.

**Make approval a generic multi-object framework.** Only one governed object has approved semantics. A generic aggregate layer would freeze unproven abstractions, so the first schema accepts only `fact_proposal` and can be generalized after a second object establishes shared requirements.

**Write proposals directly as pending.** A database row could then outlive a failed or cancelled Session append while no authoritative tool result exists. Receipt-bound admission keeps product visibility aligned with the durable Session record.

**Append the decision directly during approval.** FastAPI cannot depend on a live Host or start an Agent Turn. A single-aggregate Outbox makes the database decision atomic while Session delivery remains replayable and independently recoverable.

**Trust citation or chunk fields supplied by the model.** Those fields can name inaccessible or mismatched evidence. Composite references to admitted evidence and the exact immutable chunk range make the database enforce the authorized identity.

## Acceptance criteria

- Seven Fact relations enforce closed value, lifecycle, aggregate, operation, field-key, revision, identity, and uniqueness rules, including same-project and same-field head references and exact admitted-evidence ranges.
- Database triggers reject mutation of confirmed revisions, terminal proposals, decision Outbox rows, and invalid head advancement; the migration rejects a non-empty downgrade before any schema change.
- Row-level security admits only current project members for their permitted actions, hides prepared proposals from product reads, and denies all Fact access to the worker role.
- Proposal admission consumes only a matching unexpired digest-backed receipt; approval or conflict writes proposal, revision when applicable, head, audit, idempotency, and one Outbox row atomically.
- Outbox delivery is bounded and exactly-once at Session append, creates no Agent Turn, and exposes no receipt, token, evidence text, URL, or object key.

## Risks

Composite references and mutation triggers make the first migration intentionally strict; application transactions must acquire rows in the prescribed order and cannot repair inconsistent data through compatibility fallbacks. Downgrade is available only when all seven Fact relations are empty, so rollback of deployed business data requires a reviewed backup.

The single-object Outbox and Fact-specific idempotency store duplicate some structure that a later governed object may also need. Generalization is deferred until another approved object supplies concrete shared semantics; any later migration must preserve the existing Fact identities and authorization guarantees.
