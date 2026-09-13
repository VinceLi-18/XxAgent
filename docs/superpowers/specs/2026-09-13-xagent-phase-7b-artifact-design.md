# XAgent Phase 7B Artifact Detail Projection Design

English | [中文](2026-09-13-xagent-phase-7b-artifact-design.zh.md)

## Scope and delivery

Phase 7B moves Artifact detail summary derivation into the existing TypeScript backend client. It covers detail queries, upload completion, scan retries, and conversion of their persisted idempotency snapshots. Public browser Remote methods, result types, and visual behavior remain unchanged. This is a reference specification for one migration batch, not authorization to execute a production migration.

Implementation starts from the latest main after Phase 7A integration is checked. Publish Phase 7B independently; do not add its implementation to the Phase 7A PR. Confirm the current Alembic head before allocating the next revision; never rewrite a historical migration.

## Ownership and exclusions

FastAPI owns authentication, current read/edit authorization, RLS, context normalization, scan status, safe version-field disclosure, transactions, audit, request hashes, idempotency, and background jobs. TypeScript receives authorized data and derives the browser detail summary. No database credentials, new Cordis service, authorization cache, or additional HTTP request are introduced.

Artifact list responses keep their existing SQL/Python ownership and summary format; they must not carry full version histories merely to relocate computation. Download URLs, scanning, Docling, OCR, Office processing, embedding, Fact approvals, Outbox events, Session formats, and UI design are outside this batch.

## Internal protocol and projection

All three detail-producing endpoints require `schema_version: 2` in their request bodies and return a detail object containing exactly `schema_version: 2`, `id`, `display_name`, `scope`, `can_edit`, and `versions`. Existing operation-specific request fields remain required. The detail route gets its own request model; the list route retains its empty request. Missing or unsupported request versions fail with HTTP 422 before a write or idempotent replay. The Host rejects missing, old, or unknown response versions using its existing schema-error mapping.

Version entries retain their existing names, optional-field omission rules, and validation. Private scope contains only its kind; project scope also contains its authorized project ID. FastAPI must not expose owner IDs, object keys, staging credentials, or undisclosed hashes. Hashes remain available only under the existing clean/quarantined disclosure rule.

The Host validates the complete detail before publishing it: nonempty bounded versions, unique version IDs and numbers, strictly descending positive version numbers, valid statuses, and all existing size/hash/scope constraints. It does not silently sort, deduplicate, drop bad entries, or publish partial results. It derives the latest version and status from the first entry and the latest clean version from the first clean entry; the public optional clean-version field is absent when none exists. Pending, scanning, failed, and quarantined latest versions do not hide an older clean version.

## Durable snapshots and request identity

Upload completion and scan retry persist this same version 2 detail in `result.detail`. Replays return the stored detail after the existing current-authorization checks, not a newly queried detail. Worker progress and later versions must not change the replayed snapshot.

The operation names remain `artifact.upload.complete` and `artifact.version.retry`. Preserve actor IDs, idempotency keys, request hashes, outer result IDs, timestamps, and expiry. The transport version is not part of the business request hash; adding it must not make a valid migrated retry conflict. Do not change operation names to evade old keys, clear records, extend expiry, or issue duplicate writes.

Stored snapshots are a durable input and require explicit format validation before return. Unsupported or malformed stored details fail with a stable service-unavailable response, with no new write or silent fallback. Runtime code supports only version 2; historical conversion belongs solely to the migration.

## Data migration and reverse conversion

Add one transactional Alembic data revision targeting only rows of `xagent_idempotency_keys` whose operation is upload completion or scan retry, including expired rows. Other operations and all other columns remain unchanged. Use the configured migration role; do not broaden application grants or disable RLS in runtime code.

Upgrade validates each legacy detail against the emitted legacy format and verifies its summary agrees with its stored versions. It then removes `latest_version`, `latest_status`, and `latest_clean_version`, and adds `schema_version: 2`. Every retained JSON value and optional-field omission remains unchanged. The migration reads only each saved snapshot, never live Artifact/version state, external storage, or a worker.

Reverse conversion validates version 2 and reconstructs the three legacy summary fields from those saved versions, removes the protocol version, and omits the clean-version field when no clean version exists. It applies both to converted records and to records newly written by version 2. Supported legacy snapshots must round-trip with JSON equality, including nested values and omission semantics; JSONB key ordering is irrelevant.

An invalid target record aborts the entire transaction and leaves the Alembic revision unchanged. Do not repair guessed values, skip expired records, log snapshot contents, or commit batches independently. Migration diagnostics identify the operation and violated field rule without exposing tokens, object keys, filenames, or snapshot content. The migration implementation is self-contained and does not import mutable application projection helpers.

## Deployment and rollback

Use a maintenance window: stop admission and drain in-flight requests for both affected write operations, stop the old Host/API instances, back up the affected data using the deployment's protected backup procedure, and run the data upgrade. Deploy the matching version 2 Host/API pair, run authenticated query/completion/retry and replay smokes, then reopen traffic. Mixed-version rolling deployment is unsupported; abort on a failed drain, backup, migration, or smoke.

Rollback also requires stopped admission and drained writers. Use the new release's migration tooling to reverse this data revision before starting the matching old Host/API pair. Verify replay against saved expected responses, then reopen traffic. Restoring old binaries alone is insufficient. Neither direction changes immutable Artifact versions, processing jobs, request identity, or authorization policy.

## Verification and acceptance

- Host tests compare the unchanged public detail across query, completion, and retry, including old-clean/new-pending, no-clean, quarantined, and failed cases; reject empty, duplicate, unordered, oversized, malformed, and unsupported-version responses.
- API tests pin exact version 2 fields at all three endpoints and reject old/missing request versions before any version, job, or idempotency mutation. List, preview, download, upload initiation, and sensitive-field disclosure remain unchanged.
- PostgreSQL migration tests cover both operations, multiple actors, expired rows, unrelated operations, preserved hashes/expiry/outer IDs, exact upgrade/reverse round trips, new version 2 rows reversed for rollback, and all-or-nothing failure on invalid records.
- Replay tests cross a real migration and process restart, advance worker state, then retry the original request. Public results stay equal to the original response, side-effect counts do not increase, and current revocation still denies access. Include concurrent same-key retries and different-input conflicts.
- The real Artifact Loader scenario exercises the public Remote path; the Docker Artifact pipeline covers upload, scan, retry, and read integration. No model-output or GUI change is intended; if implementation changes either, add the required snapshot or recorded GUI acceptance in the same change.
- Documentation covers protocol ownership, migration prerequisites, replay invariants, and data-aware rollback in the affected READMEs and the owning Artifact Agent Note. Run focused package/API tests, migration checks, build, lint, doc-sync, and diff checks; distinguish planned checks from executed evidence.

## Implementation sequence

1. Add failing protocol, projection, and durable replay regressions with explicit expected public responses.
2. Implement the Python version 2 detail and Host projection together, retaining authorization and business request identity.
3. Add the self-contained data migration and reverse conversion, then prove transactional failure and JSON round-trip behavior on PostgreSQL.
4. Complete all caller fixtures and assembled acceptance, update owning documentation, and rehearse deployment and rollback on disposable data.

The implementation plan must name exact test commands, files, migration parent, and expected failures against the chosen main revision. This specification contains no claim that the migration or its tests have been implemented.
