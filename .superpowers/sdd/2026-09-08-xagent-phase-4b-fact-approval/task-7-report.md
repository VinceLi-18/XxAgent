# Task 7 Report: Fact Review Workbench

## Implementation summary

- Added the optional root-scope single-occupant `xagent.workbench.facts` Slot. The Project details rail inserts one equal-width Fact tab only while an occupant is live; absent profiles retain the original three tabs, initial selection, keyboard order, and zero Fact Remote calls.
- Added `@xagent/dsh-ui-fact`, which mounts the generated Fact Remote and owns an in-memory controller for one authenticated Project Session. Account, connection generation, Project, Session, tab, or plugin changes synchronously clear state, abort request owners, and suppress late list, detail, decision, and refresh results.
- Added bounded current-head and proposal paging, stable identity de-duplication, typed values, proposal detail, immutable newest-first history, exact evidence navigation, and a compact split list/detail interface. The vertical revision ledger aligns status, value, proposer, confirmer, time, and each revision's evidence.
- Added role-aware approve, reject, and withdraw dialogs. Every deliberate action receives one fresh idempotency key; only an explicit retry after transport uncertainty reuses the complete prior intent. Conflicts refresh authoritative list/detail state, while stale permission closes further actions.
- Added a strict `propose_fact` ToolView that renders only closed server metadata `{ kind: 'xagent-fact', status: 'pending', proposalId }`. Running, error, and malformed-success states remain neutral and never expose arguments or result prose.
- Added reversible Slot, renderer, Remote, listener, observable, and controller ownership plus a relationship invariant over the live Fact occupant, ToolView, injected snapshot, and mounted Remote identity. An absent optional browser companion is valid.
- Added responsive semantic-token CSS, the shared focus-trapping/Escape-dismissable Modal, bilingual package documentation, current-state architecture prose, client/config catalogs, and the active Fact architecture note update. Business bundle composition, durable event projection, snapshots, SDK changes, and real Browser E2E remain outside Task 7.

## RED and focused GREEN evidence

The optional Slot selection ran before the Project workbench declared or observed a Fact occupant:

```sh
./node_modules/.bin/vitest run packages/xagent/ui-project/tests/details.client.spec.tsx packages/xagent/ui-project/tests/plugin.client.spec.tsx
```

RED result: `2 failed, 13 passed`; the fourth tab and live occupant availability were absent. After adding the child Slot and observable occupant state, the same selection passed `15` tests. The no-occupant case asserts the original three-tab geometry, default selection, keyboard order, and no Fact rendering.

The controller tests were introduced before `store.ts`, `service.ts`, `collections.ts`, and `decision.ts` existed. The first run failed at module resolution. The GREEN selection covers both first pages, frozen cursor ownership, stable ordering and caps, typed values, detail/history, exact evidence identity, manager/proposer/self-approval rules, idempotency retry, conflicts, permission loss, synchronous scope clearing, cancellation, disposal quiescence, late rejection, and browser-persistence scans.

The assembly tests initially failed because the generated Remote, Slot occupant, keyed ToolView, scope subscriptions, and relationship service were absent. Their GREEN run proves Remote calls start only for a connected, selected Fact tab with a matching Project Session; mismatched or absent scopes remain call-free, and disposal removes both registrations and the generated Remote.

The accessible dialog regression ran before the panel adopted the shared Modal:

```sh
./node_modules/.bin/vitest run packages/xagent/ui-fact/tests/fact-panel.client.spec.tsx -t 'role-aware'
```

RED result: `1 failed, 5 skipped`; focus remained outside the dialog. The shared Modal produced GREEN with initial focus inside, focus trapping, Escape dismissal, and focus restoration behavior inherited from the product primitive.

## Final verification

```sh
./node_modules/.bin/vitest run packages/xagent/ui-fact/tests packages/xagent/ui-project/tests/details.client.spec.tsx packages/xagent/ui-project/tests/plugin.client.spec.tsx --coverage.enabled --coverage.provider=v8 --coverage.include='packages/xagent/ui-fact/src/client/**/*.{ts,tsx}' --coverage.reporter=text
```

Result: `7` files and `50` tests passed. New Fact client source reached 100% statements (`381/381`), branches (`313/313`), functions (`106/106`), and lines (`306/306`) with no uncovered production file.

```sh
npm run typecheck -- --pretty false
npm run lint
env CI=true corepack pnpm run hygiene
npm run duplication
env CI=true corepack pnpm run doc-sync
```

Results: Host and Client typecheck and full lint exited `0`; hygiene completed package, publication, invariant, NodeNext, and runtime-closure checks; duplication reported `0` clones; doc-sync passed `28/28` gates. The sandboxed lint launcher could not create its tsx IPC socket and was rerun unchanged with narrow host permission. Hygiene first identified an unused test dependency, then required built outputs for the new package's publint check; removing the dependency, updating the lockfile with repository pnpm `11.7.0`, and narrowly building `@xagent/dsh-ui-fact` made the complete gate pass.

The first doc-sync run identified missing exported parameter/return contracts, the new client/config catalog entries, and the client-only relationship service's catalog ownership. Those sources and generated outputs were updated through their owners, the bilingual config catalog pair was re-recorded, and the final complete run passed. `git diff --check` and `git diff --cached --check` passed, and no generated `lib/` output is tracked.

## Self-review

- Re-read the generated Fact Remote and public types against every controller selector. No UI or Remote request accepts actor, role, project, permission revision, token, receipt, or ownership authority from component input.
- Verified the store is memory-only and contains neither browser-storage calls nor idempotency keys, tokens, receipts, URLs, or persisted evidence payloads. The controller retains a retry intent only during one live scope and clears it on every invalidation.
- Verified list and detail rows must match the active Project, evidence navigation requires every server evidence field plus the current Session, and stale operations cannot publish after scope loss or disposal.
- Verified manager approve/reject and proposer withdraw visibility follows the current loaded pending proposal. A manager who is also the proposer may self-approve; no label, model prose, or prior response grants authority.
- Verified all registrations and subscriptions are reversible effects and the invariant observes live owned relationships. Optional absence produces no failure.
- Kept the stateful lifecycle controller as one owner while extracting collection and decision functions. Further splitting would divide abort, epoch, scope, retry, and refresh ownership across services without deleting behavior.
- Confirmed the staged scope contains Task 7 source, tests, docs, generated client/config catalogs, workspace metadata, and this report only. No Business bundle, snapshot, SDK, real Browser E2E, GIF, or generated `lib/` artifact is included.

## Concerns

No blocking concerns. Task 8 must assemble the Fact browser plugin into the Business bundle and own durable decision-event projection and snapshot coverage. Task 9 owns the real Browser E2E and GIF.

The branch was not pushed.

## Fix round 1

The Fact occupant and `propose_fact` renderer now use declaration injection. A missing parent declaration leaves each contribution dormant instead of failing plugin startup; declaration collapse removes the entry, a later declaration reinstalls it, and plugin disposal prevents resurrection. The relationship check treats a missing optional declaration as dormant while continuing to require the exact component and injected controller whenever that declaration is live.

Revision evidence authorization now includes the selected immutable revision and every loaded history row. The regression fixture gives the older revision its own citation, Artifact, Version, index, generation, chunk, and line range so opening it cannot succeed through the current revision's evidence.

The view distinguishes a stable unavailable-scope empty state from an active load. Pending proposals occupy the named review list, terminal proposals occupy a separate named processed list with visible status, and current Facts have their own named list. Proposal and revision detail includes assertion reason, proposer and confirmer attribution, decision actor and time where present, distinct evidence actions, and the exact `No artifact evidence` status. The strict ToolView displays only its validated proposal ID and pending status. Focus selectors are limited to package classes.

A decision keeps all decision controls disabled while submission is active. A terminal success or error publishes refreshed heads, proposals, and selected detail only when all three authoritative reads succeed and pass identity checks. Any rejected, failed, cross-project, or mismatched response clears those views and their cursors, removes the old selection and pending action data, and displays a reload error. Transport uncertainty still retains only the explicit exact-key retry path.

The focused regression selection ran before the production changes:

```sh
./node_modules/.bin/vitest run packages/xagent/ui-fact/tests/plugin.client.spec.tsx packages/xagent/ui-fact/tests/store.client.spec.ts packages/xagent/ui-fact/tests/fact-panel.client.spec.tsx packages/xagent/ui-fact/tests/tool-view.client.spec.tsx packages/xagent/ui-fact/tests/styles.client.spec.ts
```

RED result: `13 failed, 28 passed`, plus the undeclared direct registration's unhandled rejection. The failures covered declaration lifecycle, history-only evidence, every post-decision refresh route, scope empty state, pending/terminal separation, ToolView identity and status, detail attribution and evidence-free wording, disabled submissions, named lists, and package-scoped focus selectors. The same selection then passed `41/41`; the final focused suite passed `42/42` after adding the mismatched revision-detail and non-target proposal fixtures needed for complete branch coverage.

```sh
./node_modules/.bin/vitest run packages/xagent/ui-fact/tests packages/xagent/ui-project/tests/details.client.spec.tsx packages/xagent/ui-project/tests/plugin.client.spec.tsx --coverage.enabled --coverage.provider=v8 --coverage.include='packages/xagent/ui-fact/src/client/**/*.{ts,tsx}' --coverage.reporter=text
```

Result: `7` files and `57` tests passed. Fact client source reached 100% statements (`412/412`), branches (`350/350`), functions (`115/115`), and lines (`333/333`).

```sh
npm run typecheck -- --pretty false
node --import tsx/esm scripts/run-oxlint.ts packages/xagent/ui-fact/src packages/xagent/ui-fact/tests
env CI=true corepack pnpm run doc-sync
git diff --check
```

Results: Host and Client typecheck exited `0`; scoped source and test lint exited `0`; doc-sync passed `28/28` gates in `47.90s`; the working diff passed the whitespace check. The scoped translation-pairing write and check confirmed the updated English and Chinese README. The sandbox blocked the pairing launcher's tsx IPC socket, so the unchanged command ran successfully with narrow host permission.
