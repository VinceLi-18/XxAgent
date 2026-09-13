# XAgent Phase 7A Workbench Implementation Plan

> Execute this plan inline with `superpowers:executing-plans`; track each task below.

English | [中文](2026-09-13-xagent-phase-7a-workbench.zh.md)

**Goal:** Derive the existing browser workbench Session scopes and counts in TypeScript.

**Architecture:** FastAPI returns one authorized version 2 Bootstrap dataset. The existing backend client validates and projects it before the request-scoped Project Remote exposes it.

**Tech Stack:** TypeScript, Cordis, Vitest, FastAPI, SQLAlchemy, PostgreSQL, pytest.

**Spec:** [Phase 7A design](../specs/2026-09-13-xagent-phase-7a-workbench-design.md).

## Constraints

Keep the public Remote types, authentication, transactions, worker ownership, and project-detail SQL aggregation unchanged. Ship Host/API together; no database migration, compatibility fallback, new package, or additional HTTP request.

## Task 1: Internal Bootstrap and Host projection

Files: [workbench service](../../../services/api/app/services/workbench.py), [route](../../../services/api/app/api/routes/internal_workbench.py), [backend client](../../../packages/xagent/backend-client/src/index.ts), and [client tests](../../../packages/xagent/backend-client/tests/backend-client.spec.ts).

Consumes: current authorized `list_sessions()` output and workbench account/context/project data. Produces: internal `{schema_version: 2, account, capabilities, context, projects, sessions}` and unchanged `XAgentWorkbenchBootstrap`.

- [x] Replace the client fixture with version 2 `sessions`, including two runtime IDs and four null IDs; assert the same two public scopes and private/project counts of 2/4. Add empty-project and invalid null-scope cases. Run the client test file and observe rejection by the version 1 parser.
- [x] Replace Python count accumulation with minimal Session records. Require version 2 only at the Bootstrap route. Validate each Host record, count null and non-null IDs, omit null IDs from public scopes, reject duplicate non-null IDs and missing projects, and request version 2 from bootstrap/create/select flows.
- [x] Run `pnpm exec vitest run packages/xagent/backend-client/tests/backend-client.spec.ts packages/xagent/project/tests/project.spec.ts` and require all tests to pass.

The counting operation is:

```javascript
if (visibility === 'private') privateCount += 1
else projectCounts[projectId] += 1
if (sessionId !== null) sessionScopes.push(scope)
```

## Task 2: PostgreSQL and caller regression

Files: [workbench API tests](../../../services/api/tests/api/test_internal_workbench.py), [internal Session API tests](../../../services/api/tests/api/test_internal_sessions.py), and [hidden-test regression](../../../services/api/tests/test_workbench.py). Search all tracked Bootstrap callers and update only internal Bootstrap payloads and wire expectations.

Consumes: the version 2 route. Produces: real-database evidence for the authorized dataset and unchanged public Host results.

- [x] Assert exact minimal `sessions` records; include conversations without runtime headers, hidden Business Skill tests, private project-reference revocation, and version 1 rejection. Keep create/context/project requests at version 1.
- [x] Run `pnpm run api:test tests/api/test_internal_workbench.py tests/api/test_internal_sessions.py tests/api/test_workbench_concurrency.py tests/security/test_workbench_rls.py tests/test_workbench.py` against the repository's disposable test database, with `JX_TEST_DATABASE_URL` and `JX_ALLOW_SCHEMA_DROP=yes` explicitly set.
- [x] Search for obsolete Bootstrap `session_scopes`/`session_summary` fixtures and version 1 requests, then update applicable assembled acceptance callers.

## Task 3: Documentation and verification

Files: owning backend-client and Project READMEs, [API README](../../../services/api/README.md), and an implemented architecture Agent Note with bilingual counterparts.

- [x] Document ownership, null-header counting, version mismatch rejection, and paired rollback; audit existing workbench/auth notes for supersession.
- [x] Run focused type checks, `pnpm run lint`, `pnpm run doc-sync`, and `git diff --check`; record bilingual consistency with `pnpm run verify-translation-pairing --write` for each edited pair.
- [x] Inspect the final diff for credentials, generated-file drift, unrelated changes, and unsupported claims; report remaining verification gaps explicitly.

## Execution evidence

The focused Vitest command passes 345 tests; the documented PostgreSQL command passes 31 tests. `pnpm exec tsc -b packages/xagent/backend-client packages/xagent/project` and `pnpm run build` pass. `pnpm run lint` completes its Host build; its IPC-blocked lint step passes separately through `pnpm run lint:contracts-ready` with host permission. `pnpm run doc-sync` passes all 28 checks. The real Loader acceptance command `pnpm run test:e2e apps/cli/tests/xagent-retrieval-runtime.e2e.ts` passes all three cases, including public Bootstrap scopes and counts, using server-generated Session IDs and the Phase 6 skill catalog. `git diff --check` passes. The dedicated `xagent-phase7a-test` PostgreSQL container, volume, and network are removed after testing. The artifact E2E Bootstrap request is updated but the full artifact/model pipeline is not rerun for this response-preserving migration. Changes remain local on `codex/phase7a-workbench-projection`.
