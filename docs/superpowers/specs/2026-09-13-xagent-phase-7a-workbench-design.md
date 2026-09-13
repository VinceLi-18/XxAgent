# XAgent Phase 7A Workbench Projection Design

English | [中文](2026-09-13-xagent-phase-7a-workbench-design.zh.md)

## Scope

Phase 7A migrates workbench Session scope and count projection into the existing TypeScript backend client consumed by the Cordis Project Remote. The browser's four Remote methods and Bootstrap result remain unchanged. This is the first batch of the [Python migration roadmap](2026-08-20-xagent-dsh-fork-integration-design.md#phase-7逐步迁移-python), not completion of Phase 7.

## Responsibilities

FastAPI retains authentication, account capabilities, project visibility, context normalization, Session visibility, private project-reference checks, and all database transactions. A single Bootstrap request returns the authorized account, projects, context, and minimal conversation Session rows. The Host derives `sessionScopes`, `privateCount`, and zero-initialized per-project counts from that response. No additional HTTP reads, database credentials, authorization cache, or Cordis service are introduced.

Each Session row contains only `session_id` (the runtime ID or null), `visibility`, and `project_id`. A conversation without a runtime header contributes to counts but not to the browser's Session scope map. Hidden Business Skill test Sessions never enter the response. Session titles, headers, log events, owner IDs, and internal database Session IDs are not transferred for this projection.

The internal Bootstrap request and response use `schema_version: 2`; the other workbench requests retain version 1. Both ends reject unsupported versions. The client rejects unknown fields, invalid scope/ID combinations, duplicate runtime IDs, and project Session rows referring to projects absent from the same response. Empty projects retain a zero count. Public Remote types remain unchanged.

Project-detail SQL aggregation remains in Python because it counts database rows without returning each row. Login, RLS, writes, idempotency, approval Outbox, Session persistence, and Python document/embedding workers remain under their existing owners.

## Failure and rollback

Existing request timeouts, response byte limits, cancellation, account binding, and transport error mapping continue to apply. No partial projection is published on a rejected response. Context selection and project creation still commit through their existing backend operations, then request a fresh version 2 Bootstrap.

Deploy Host and API together. A mismatched pair fails explicitly instead of accepting a stale response format. Rollback restores the matching previous Host/API pair; no schema migration or data conversion is required.

## Verification

Client tests pin unchanged public Bootstrap results for mixed private/project conversations, absent runtime headers, empty projects, and malformed responses. Project Remote tests retain cross-account and request-scope checks. Real PostgreSQL API tests verify current-member visibility, revoked membership, hidden test Sessions, null runtime headers, and rejection of version 1 Bootstrap requests. Existing model output and browser behavior do not change, so no new model transcript or GUI interaction is introduced.

Run the focused backend-client and Project Vitest files, the workbench/internal-session PostgreSQL tests, package type checks, lint, documentation checks, and `git diff --check`. Record commands actually executed in the handoff.
