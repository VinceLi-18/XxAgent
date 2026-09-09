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

## Review fix round 1

### Root causes and corrections

- Physical authorization had no closed `xagentFact` namespace, no Fact scope-runner dependency, and no authenticated Session-restore scope. Added the exact seven-method table, resolved the Fact service per request, derived one Project Session from the authenticated connection and authoritative backend Session list, rejected anonymous, Private, missing, duplicate, and mismatched Sessions, and ran the complete Remote operation through `fact.withRequest`. An explicit `session/create` restore now runs within the same derived authenticated Session scope so `session/created` Outbox delivery sees the physical request.
- Source-plane tests loaded the built Fact entry because `@xagent/dsh-fact` was absent from the root TypeScript paths. That split Typert's private marker identity, so a real Loader composition could install the service while Gateway discovered no methods. Added the source paths and package graph edges, then covered the real Loader, registry, Gateway, authorizer, Session store, and Fact provider together.
- Outbox delivery checked ownership only after the pull. Added a single live-owner predicate covering service acceptance, owner state, request and connection cancellation, current owner-map identity, and the live Session registry relationship. It is checked before each reservation and append; a reservation made concurrently with cancellation is discarded. A microtask boundary after synchronous append lets observer-triggered Session disposal finish before another row is considered.
- The package invariant asserted fixed Typert metadata. It now inspects only the two authoritative mutable registries and live Agent/Session/Outbox ownership. Companion HMR coverage observes the first registration, disposes its fiber, reinstalls it, and observes the replacement registration.
- Package and architecture prose now states that `fact/proposal-decided` is a log-only, non-surface event with zero model-token and KV-cache effect until a separate Consumer projects it. Chinese Fact prose uses the glossary terms for provider, consumer, registry, receipt, identity, attachment, append, commit, plugin, and Turn. Generated graphs and catalogs were changed only through their owning generators, and every reviewed bilingual pair was re-recorded.

### RED evidence

The first authorization selection covered all seven Fact methods, anonymous and unknown calls, and explicit Session restore before implementation. It failed nine cases: admitted operations had no Fact scope, unknown and anonymous calls fell through, and restore exposed no authenticated Session scope.

The first real Loader composition loaded `ctx.xagentFact` but Gateway did not claim `xagentFact/list-heads`; cold-open Outbox delivery consequently appended no event. This isolated the missing source-plane alias rather than a service implementation error.

The first multi-row Outbox regressions both failed with two registered and appended decisions after the first synchronous observer aborted the request or disposed the Session; the required count was one. The first revised invariant case also failed because changing fixed Typert metadata still raised a runtime invariant error.

The repository duplication gate later found two Fact/Citation authorization clones (`17` duplicated lines, `151` tokens). A private `runInSessionScope` helper removed the duplication without combining either namespace's closed method table or changing its error messages.

### GREEN and final verification

```sh
./node_modules/.bin/vitest run packages/xagent/authorization/tests/authorization.spec.ts packages/xagent/authorization/tests/fact-loader-composition.spec.ts --reporter=dot
```

Result: `2` files and `91` tests passed. The Loader composition proves an authenticated Fact Remote reaches FastAPI through Gateway and Authorizer, an explicit cold Session open delivers one Outbox decision with no `turn/start`, and anonymous and Private calls are denied before the Fact backend.

```sh
./node_modules/.bin/vitest run packages/xagent/fact/tests packages/xagent/authorization/tests --coverage --coverage.include='packages/xagent/{fact,authorization}/src/**/*.ts' --reporter=dot
```

Result: `5` files and `133` tests passed; statements `726/726`, branches `571/571`, functions `133/133`, and lines `608/608` are all 100%.

```sh
./node_modules/.bin/tsc -b packages/xagent/fact packages/xagent/authorization --pretty false
./node_modules/.bin/tsc -p tsconfig.host.json --noEmit --pretty false
node --import tsx scripts/run-oxlint.ts packages/xagent/fact packages/xagent/authorization scripts/gen-doc-graphs.ts
env CI=true corepack pnpm run lint
env CI=true corepack pnpm run hygiene
env CI=true corepack pnpm run duplication
env CI=true corepack pnpm run doc-sync
git diff --check
```

Results: both TypeScript programs and both lint selections passed; hygiene completed its package, publication, invariant, NodeNext, and runtime-closure checks; duplication reported `0` clones; doc-sync passed `28/28` gates; the diff check was clean. The sandboxed tsx launchers failed only because IPC sockets were denied and were rerun unchanged with narrow host permission. The lockfile was regenerated with the repository's Corepack-pinned pnpm `11.7.0` and contains only the expected authorization importer edges.

### Review self-check and concerns

- The authorization table exactly matches the seven Task 5 Typert exports and accepts no authority fields from browser payloads.
- The derived Fact scope retains the authenticated physical connection, user token, Principal, exact Session, fixed project, and both cancellation signals only for the operation lifetime.
- The separate `xagentFact.receipts` and `xagentFact.outbox` registries and Task 4 codecs are unchanged. Delegation remains exactly 60 seconds.
- Outbox delivery uses only `Session.append`, revalidates the current live owner before every row mutation, and never starts a Turn.
- Runtime invariants observe mutable package-owned relationships only; Loader/build coverage retains responsibility for Typert metadata.

No blocking concerns. Model projection of the durable decision event remains deferred to the separate Consumer owned by Task 8. The branch was not pushed.
