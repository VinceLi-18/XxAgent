# XAgent Phase 7B Artifact Implementation Plan

English | [中文](2026-09-13-xagent-phase-7b-artifact.zh.md)

## Goal and architecture

Implement the approved [Artifact specification](../specs/2026-09-13-xagent-phase-7b-artifact-design.md): TypeScript derives public detail summaries from authorized version 2 data; FastAPI retains authorization, writes, and durable replay. A transactional Alembic revision converts saved snapshots in both directions. This execution reference starts from main `527bf675e32a75d873f18f1938b9fc1d9b76a864` in the existing isolated worktree.

Tech stack: TypeScript, Cordis, Vitest, FastAPI, Pydantic, SQLAlchemy, PostgreSQL, Alembic, pytest, Docker Compose. Execute sequentially with TDD and a task-scoped independent review after each task.

## Global Constraints

- The three detail-producing routes require request `schema_version: 2` and return exactly `schema_version`, `id`, `display_name`, `scope`, `can_edit`, and `versions`; public Remote types and UI behavior do not change.
- FastAPI retains current authorization, RLS, safe field disclosure, transactions, audit, and jobs. The list protocol and Python list summaries stay unchanged. Do not add services, caches, database credentials, or HTTP requests.
- Replay uses validated saved version 2 detail after current authorization. Preserve operation names, actor/key/hash, outer IDs, timestamps, and expiry. The transport version is excluded from business hashes. Corrupt snapshots fail with a stable service-unavailable response without new writes or fallback.
- Migration reads only stored JSON, includes expired target rows, preserves unrelated rows and retained values, validates before conversion, and aborts the entire transaction on invalid input. Runtime supports only version 2; the migration is self-contained and reversible.
- Do not push, deploy, or mutate production data. Use only a dedicated disposable test database. Preserve unrelated work and historical migrations; no GUI or Session-format changes.

## Task 1: Implement the paired runtime protocol and durable validation

Files: modify `services/api/app/schemas/artifacts.py`, `services/api/app/services/artifacts.py`, `services/api/app/api/routes/internal_artifacts.py`, `packages/xagent/backend-client/src/index.ts`, and affected direct caller fixtures. Tests live in `packages/xagent/backend-client/tests/backend-client.spec.ts`, `services/api/tests/api/test_artifact_queries.py`, `test_artifact_uploads.py`, `test_artifact_reads.py`, `test_artifact_upload_concurrency.py`, `test_artifact_retry_concurrency.py`, and `services/api/tests/security/test_artifact_access.py`. Update owning runtime README statements in `services/api/README.md` and `packages/xagent/backend-client/README.md`; assembled acceptance and operational documentation belong to Task 3.

- [ ] Add failing tests that pin exact v2 fields for query, completion, and retry, require the version even on replay, and compare explicit unchanged public details. Cover older clean plus each newer non-clean status, no clean version, malformed/empty/duplicate/unordered/over-1000 histories, invalid scope/size/hash, and absent/old/unknown versions. The expected RED is v2 rejection or obsolete summary keys, not an infrastructure error.
- [ ] Give detail queries a separate required-version model; keep list requests empty. Complete and retry retain all existing fields. Separate the detail response from the list summary model. Emit only authorized metadata and version entries, retaining optional omissions and clean/quarantined hash disclosure.
- [ ] Validate durable replay data explicitly at its input point; use existing error conventions for a stable 503 without leaking validation inputs. Verify corruption of each saved detail fails without job/version/key mutation. Keep current authorization before replay and retain explicit business-hash inputs.
- [ ] Parse exact v2 fields in the backend client, retain the existing bound of 1000 versions and strict descending uniqueness validation, derive latest fields after full validation, and omit the optional clean field if absent. Add `schema_version: 2` only to the three internal request bodies.
- [ ] Update direct API and backend fixtures together. Prove same-key concurrency creates no extra work, changed business input still conflicts, worker advancement leaves replay unchanged, and revocation denies it. Leave migration and process-restart acceptance to Tasks 2 and 3.
- [ ] Run the focused commands below, self-review, and commit only this task's paths. Record RED and GREEN outputs in the task report; do not run the entire repository suite.

```sh
pnpm exec vitest run packages/xagent/backend-client/tests/backend-client.spec.ts packages/xagent/artifact/tests
JX_TEST_DATABASE_URL=postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:55432/xagent_api_test JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test tests/api/test_artifact_queries.py tests/api/test_artifact_uploads.py tests/api/test_artifact_reads.py tests/api/test_artifact_upload_concurrency.py tests/api/test_artifact_retry_concurrency.py tests/security/test_artifact_access.py --tb=short
git diff --check
```

## Task 2: Implement transactional snapshot upgrade and downgrade

Create `services/api/alembic/versions/021_artifact_detail_snapshots.py` with revision `021_artifact_detail_snapshots` and parent `020_skill_test_policy` (confirmed in `020_business_skill_test_policy.py`). Create `services/api/tests/security/test_artifact_snapshot_migration.py`; reuse disposable database and Alembic configuration patterns from `services/api/tests/conftest.py` and existing schema tests. Update current-head assertions in `services/api/tests/security/test_business_skill_schema.py`, preserving historical revision targets. Do not change Task 1's runtime API.

- [ ] Write PostgreSQL tests before the revision. Seed both operations, multiple actors, private/project scopes, expired records, clean and no-clean histories, optional-field omissions, and an unrelated operation. Capture all columns before migration. Expected RED: Alembic cannot resolve the new revision.
- [ ] Implement self-contained validation of the actual legacy emitted detail and version 2 saved detail. Validate exact fields, types, safe disclosure, ordered unique nonempty bounded versions, and legacy summary agreement. Do not import mutable application helpers or read live Artifact tables.
- [ ] Upgrade removes the three legacy derived summary keys and adds `schema_version: 2` only in `result.detail`; downgrade derives those fields from the saved ordered versions and omits `latest_clean_version` when absent. Preserve outer IDs and all retained JSON values without normalization. Validate outer operation-specific result IDs and their relationship to saved detail where the existing operation guarantees it.
- [ ] Apply conversion within Alembic's single transaction, with a stable operation-and-field-rule diagnostic free of snapshot values. Verify multiple target rows roll back together, the revision stays unchanged, and both upgrade and downgrade reject malformed or unsupported saved data, including expired data.
- [ ] Prove exact legacy JSON round trips and downgrade of newly emitted v2 snapshots; compare actor/key/hash/creation/expiry/outer IDs and unrelated rows unchanged. Tests must verify database state, not just pure helpers.
- [ ] Run the command below, self-review, and commit the migration and its tests. Record RED/GREEN and transaction evidence in the report.

```sh
JX_TEST_DATABASE_URL=postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:55432/xagent_api_test JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test tests/security/test_artifact_snapshot_migration.py --tb=short
JX_TEST_DATABASE_URL=postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:55432/xagent_api_test JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test tests/security/test_business_skill_schema.py -k 'revision_018 or empty_schema_round_trip' --tb=short
git diff --check
```

## Task 3: Verify assembled replay, deployment, and rollback

Modify `apps/cli/tests/xagent-artifact-runtime.e2e.ts` and `services/api/tests/e2e/test_artifact_pipeline.py`; add process-restart migration acceptance in `services/api/tests/api/test_artifact_snapshot_replay.py` with a narrowly scoped subprocess helper under `services/api/tests/` if needed. Provision Node, the frozen pnpm workspace, and `pnpm run build:lib:host` in `.github/workflows/ci.yml`'s `xagent-api` job so this cross-language acceptance executes in CI. Its projection bridge imports the built backend client under plain Node, following the subprocess testing policy; do not duplicate the projection or skip for missing dependencies. Update `services/api/README.md`, `packages/xagent/backend-client/README.md`, `packages/xagent/artifact/README.md`, and the existing `.agents/notes/implemented/architecture/2026-08-25-xagent-artifact-processing.md` pair. The active writer updates its own bilingual counterparts and records hashes, without delegating translation.

- [ ] Update the real Cordis Loader fixture to assert all three v2 requests and unchanged public detail fields; keep public/UI fixtures unchanged. Run it through its existing e2e configuration.
- [ ] Add a regression spanning real PostgreSQL migration and a terminated/restarted API process for both write operations. Save the original public result, migrate legacy saved snapshots, advance worker state, and replay with the same business identity through the restarted process. Compare public results and persisted side-effect counts, then revoke current access and verify denial. Use the production TypeScript projection for the public comparison rather than duplicating it in Python; the existing Loader may provide the bridge. RED must expose the missing assembled guarantee or obsolete fixture.
- [ ] Rehearse data downgrade on disposable fixtures and verify the old expected snapshot values, including records created by v2. Do not start mixed-version production instances. Preserve concurrency and changed-input coverage from Task 1.
- [ ] Run the Docker Artifact pipeline with its documented test-only authentication, real scanning, retry, and read path. Use Compose project `xagent-phase7b-test` consistently via `COMPOSE_PROJECT_NAME`; never tear down another project's services. If required infrastructure is unavailable after safe checks, report the exact gap without claiming acceptance passed.
- [ ] Document maintenance-window admission stop, writer drain, old-instance shutdown, protected backup, migration, matching Host/API deployment, authenticated smokes, and reopen/abort conditions. Rollback must run the new tooling's data downgrade before the old pair starts. Explain snapshot-only replay and current authorization in the owning note, keeping procedures in the API README.
- [ ] Run focused validation below plus the API replay file and the Docker command from the API README with the dedicated project. Re-record every changed bilingual pair, self-review, and commit. Record actual commands/results separately from any blocked acceptance.

```sh
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/xagent-artifact-runtime.e2e.ts
JX_TEST_DATABASE_URL=postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:55432/xagent_api_test JX_ALLOW_SCHEMA_DROP=yes pnpm run api:test tests/api/test_artifact_snapshot_replay.py --tb=short
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
git diff --check
```

## Completion

Obtain a whole-branch review against `527bf675e32a75d873f18f1938b9fc1d9b76a864`. Resolve material findings and report the branch, actual validation, any unexecuted acceptance, and deployment prerequisites. Do not publish or merge without user authorization.
