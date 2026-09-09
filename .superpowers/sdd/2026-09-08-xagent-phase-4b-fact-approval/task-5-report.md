# Task 5 Report: Request-Scoped Fact Service Provider

## Implementation summary

- Added `@xagent/dsh-fact` as the complete Host Fact capability seam: the service contract, FastAPI-backed provider, and authenticated Typert Remote.
- Derived the user token, actor, permission revision, fixed project, backend Session, membership context, and cancellation signals only from the physical authenticated Project request. Anonymous, Private, missing-project, stale, and mismatched Session contexts fail before backend access.
- Issued one exact Ed25519 delegation for `propose_fact`, the current tool call, actor, Session, project, permission revision, issuer, audience, nonce, and 60-second lifetime. The public service result contains only `proposalId` and `pending` status.
- Preserved distinct private `xagentFact.receipts` and `xagentFact.outbox` registries. Receipt registration, result-sequence binding, replacement, range selection, acknowledgement commit, response-loss replay, rollback, and disposal are deterministic and expose no private value through Typert.
- Added bounded Outbox projection on `session/created` and `agent/pre-step`. One owner per Session pulls at most 32 rows, validates the fixed project and unique identities, appends ordinary `fact/proposal-decided` events, and never invokes Agent send, follow-up, or loop execution.
- Added strict reject-before-abort disposal. The service removes listeners, synchronously clears request scopes and both registries, aborts owned work, waits for every in-flight operation and Outbox owner to settle, and discards late results.
- Added relationship-based invariant checks for separate registry ownership, live Agent/Session/physical-scope ownership, Outbox owner state, and the live Typert service/namespace binding. The invariant companion accepts an absent optional provider.
- Added bilingual package documentation, the generated Cordis API/config catalogs and capability graphs, Host TypeScript registration, lockfile metadata, and package publication/hygiene metadata.

## RED and focused GREEN evidence

The first registry behavior test ran before the private registry implementation existed and failed at module resolution. After adding the registry, the focused selection passed and was expanded to cover deterministic ordering, partial acknowledgement, exact replay, replacement, identity conflicts, failed append rollback, Session cleanup, disposal, and relationship corruption.

The first provider selection ran against a registration-only skeleton:

```sh
pnpm exec vitest run packages/xagent/fact/tests/fact.spec.ts --reporter=dot
```

RED result: `4 failed, 7 skipped`; Project scope derivation, exact delegation, private receipt binding, and lifecycle behavior were absent. The focused cases passed after introducing the request-scoped provider and then expanded across Remote authority, physical inbox-to-tool propagation, cancellation, disposal, Outbox lifecycle delivery, response-loss replay, and no-Turn behavior.

Final self-review added a same-Session concurrent owner-replacement regression:

```sh
pnpm exec vitest run packages/xagent/fact/tests/fact.spec.ts -t 'concurrent physical-scope replacements serialize behind one Outbox owner' --reporter=dot
```

RED result: `1 failed`; three Outbox pulls started where only the initial owner and one serialized replacement were allowed. Re-reading the current owner after each settlement produced GREEN with `1 passed` and prevents two replacement scopes from starting concurrently.

The invariant selection first covered the explained absent-provider case, then the live relationships and corrupt Typert, registry, and owner cases. It passes without treating service presence or a fixed example as an invariant.

## Final verification

```sh
pnpm exec vitest run packages/xagent/fact/tests --coverage --coverage.include='packages/xagent/fact/src/**/*.ts' --reporter=dot
```

Result: `3 passed` test files, `38 passed` tests, and 100% statements (`452/452`), branches (`296/296`), functions (`92/92`), and lines (`384/384`).

```sh
pnpm run build
pnpm run typecheck -- --pretty false
pnpm run lint
pnpm run hygiene
pnpm run duplication
pnpm run doc-sync
```

Results: build, typecheck, lint, hygiene, and duplication exited successfully; doc-sync passed all `28` gates. The sandboxed lint and hygiene launchers initially could not create their tsx IPC sockets, so the unchanged commands were rerun with narrow host permission. Hygiene then identified the generated Typert `zod` reference and the built invariant's shared registry chunk; the package metadata and workspace gate now declare both. Duplication identified the intentionally parallel Fact/retrieval configuration schemas and the deliberately separate receipt/Outbox checkpoint implementations; narrow source annotations retain the required separate contracts, and the final gate reports no duplicates.

After the final source comments and generated-document refresh, these focused checks also passed:

```sh
node --import tsx scripts/run-oxlint.ts packages/xagent/fact scripts/check-workspace-constraints.ts scripts/gen-cordis-catalog.ts scripts/gen-doc-graphs.ts
pnpm exec tsc -p tsconfig.host.json --noEmit --pretty false
git diff --check
```

## Files changed

- `packages/xagent/fact/package.json`
- `packages/xagent/fact/tsconfig.json`
- `packages/xagent/fact/README.md`
- `packages/xagent/fact/README.zh.md`
- `packages/xagent/fact/README.i18n.yaml`
- `packages/xagent/fact/architecture.md`
- `packages/xagent/fact/src/index.ts`
- `packages/xagent/fact/src/types.ts`
- `packages/xagent/fact/src/receipt-registry.ts`
- `packages/xagent/fact/src/invariant.ts`
- `packages/xagent/fact/tests/fact.spec.ts`
- `packages/xagent/fact/tests/receipt-registry.spec.ts`
- `packages/xagent/fact/tests/invariant.spec.ts`
- `tsconfig.host.json`
- `pnpm-lock.yaml`
- `knip.json`
- `scripts/check-workspace-constraints.ts`
- `scripts/gen-cordis-catalog.ts`
- `scripts/gen-doc-graphs.ts`
- `packages/extensions/tool-cordis/src/api-catalog.ts`
- Generated bilingual config catalog, capability-seam graph, event producer/consumer graph, and web-server subsystem pages with their pairing sidecars.

## Self-review

- Re-read the Phase 4B design, Task 4 client/codec report, principal/request-context, retrieval-provider, Typert Remote, Session lifecycle, and invariant precedents. The provider calls only Task 4's strict Fact backend methods and retains the two exact private registry interfaces.
- Verified the model-facing path receives a physical Project scope only through authoritative inbox and pre-step lifecycle events, and only `propose_fact` receives that scope through tool execution. Other tools run without it.
- Verified Remote methods accept no actor, token, role, membership, permission revision, project authority, or ownership fields. Every physical Session selector must match the connection's immutable Session scope.
- Verified receipt values, user tokens, service credentials, and delegations do not enter public results, Session events, Typert methods, diagnostics, or logs.
- Verified Session-open and pre-step Outbox delivery uses `Session.append` only. Coalesced owners, serialized replacement, cancellation, malformed identity, project mismatch, append failure, exact response-loss replay, and disposal all retain or discard private state at the intended lifecycle point.
- Verified every listener and contribution has Cordis cleanup and disposal waits after rejecting new work and synchronously clearing public ownership state.
- Verified Task 6 tool registration, Task 7 browser UI, and Task 8 Business bundle wiring are absent.

## Concerns

No blocking concerns. Task 6 must emit the exact public Fact result metadata expected by receipt admission: `{ kind: 'xagent-fact', status: 'pending', proposalId }` on the successful `tool/result`. Outbox delivery intentionally pulls one 32-row page per Session-open or pre-step trigger; later rows wait for another trigger, as documented.

The branch was not pushed.
