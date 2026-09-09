# @xagent/dsh-ui-fact

English | [中文](README.zh.md)

`@xagent/dsh-ui-fact` adds an optional Fact tab to the XAgent Project Session details panel and owns the keyed `propose_fact` ToolView. Each contribution waits for its parent Slot declaration, disappears when that declaration collapses, and returns when the owner remounts. The tab appears only while its root-scoped Slot occupant is live; compositions without this package retain the original three tabs and make no Fact calls.

The browser controller derives one exact authorized Project Session from the connected Host generation, current account, server-issued `sessionScopes`, selected project, current Session, and active Fact tab. It keeps bounded current-head, proposal, detail, and revision-history pages only in memory. Pending proposals appear in the review list; terminal proposals appear separately with their status. Any account, project, Session, tab, or connection change synchronously clears the view, aborts owned requests, and rejects late results.

Managers may approve or reject pending proposals, including their own; a proposer may withdraw their pending proposal. These controls are affordances only: FastAPI reauthorizes every action. Each new intent receives one key held only in controller memory, and an uncertain transport or `service-unavailable` result exposes an explicit retry that reuses that exact key and request. A terminal result must refresh current heads, proposals, and selected detail together; any failed or invalid response clears those views, closes stale decision controls, and displays a reload error. Stale permission disables further decisions.

Fact evidence opens only when every server-issued evidence identity matches the selected proposal, current revision, or loaded history and Session. The handoff passes the immutable Artifact, Version, and line range to `xagentArtifactCitationOpener`; the browser never treats Tool arguments, URLs, filenames, result prose, receipts, or model text as authority. Evidence-free proposals and revisions display the stable `No artifact evidence` status. The `propose_fact` renderer accepts only the closed public metadata `{ kind: "xagent-fact", status: "pending", proposalId }`, displays that validated ID and status, and otherwise shows a neutral running/failure state or closed alert.

## Model Experience

### Fact review

#### What the model sees

This package adds no model input. `@xagent/dsh-tool-fact` owns the model-facing tool and persisted public result; this package renders that result and human review state.

#### Token effect

The package adds no prompt or output tokens.

#### KV Cache effect

The package does not read or write model KV cache. Fact review is a user-only Browser and Host operation.

## Known Limitations and Deferred Work

- The workbench shows a compact list/detail view with a bounded newest-first revision ledger; it does not provide field search or bulk decisions.
- Browser state is intentionally non-durable. Reload and reconnect restore data from the authorized Remote.
- Bundle composition, snapshot coverage, SDK fixtures, and real-browser end-to-end coverage are owned by the following integration tasks.
