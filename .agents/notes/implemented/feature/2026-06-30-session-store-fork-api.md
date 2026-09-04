# Agent Note: SessionStore fork API

Status: implemented

English | [中文](2026-06-30-session-store-fork-api.zh.md)

## Problem

The event-sourced session log already has the primitive a fork needs: create a new session with a seed event prefix, then derive model history from that seeded log exactly as replay does. That primitive is intentionally low-level: `ctx.sessions.create(id, { seed, meta })` accepts any valid seed, but ordinary live-session branching needs policy around which prefix can be copied, which metadata is stamped on the child, and how errors are classified.

The semantic hazard is the fork boundary. A valid user-visible fork seed must be contiguous and end outside an active turn. Forking inside execution would copy an open `turn/start`, possibly an open `step/start`, and possibly dangling tool calls. That violates execution and provider-transcript invariants, and it creates a misleading child history that appears to have participated in an unfinished parent turn. Standalone context and plugin-owned log-only events are stable forkable history after a closed turn. The existing [subagent seam](2026-06-21-subagent-capability-seam.md) deliberately solves a different problem: tool-triggered subagent forks usually happen while the parent turn is open, so `dsh-subagent-fork-in-process` clips the seed to the parent's last completed-turn prefix. A general session fork should not silently clip; it should either fork the requested boundary or reject it.

## Decision

`dsh-session` owns ordinary live-session fork policy directly on `ctx.sessions`. There is no separate `dsh-session-fork` package or `ctx.sessionFork` service: the operation has no independent event vocabulary or lifecycle, and durable work delegates to the existing session store and persistence service. `SessionPersistence.fork(sourceId, throughSequence, operationId)` is the optional authority hook for a backend that owns Session identity or authorization scope. Each intentional client invocation sends one RPC, and the Host binds that RPC's branded request identity to the logical operation. It holds the source, inclusive cut, and operation identity fixed across at most one immediate provider-approved durable-fork recovery attempt; local backends return `undefined` and retain the in-process seed path.

The store exposes one operation:

```ts ignore-check
type SessionForkSource = Session | SessionId

class SessionStore extends Service {
  fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session
}
```

`boundary` is the inclusive source event `seq` to copy through. When omitted, it defaults to the source session's current last event; on an empty source, omitted `boundary` creates an empty child. Fork-specific validation checks that the requested boundary exists and that the selected prefix's latest turn boundary is not an unmatched `turn/start`. The selected prefix may therefore end at `turn/end` or at a later standalone event, then is deep-cloned into the child seed. The child inherits the source session's `cwd`, stamps `parentSession` to the source id, and sets `seedLength` to the copied prefix length. When `childSessionId` is omitted, `SessionStore` generates one using its existing id policy.

An empty prefix is forkable; any non-empty boundary must be a safe existing sequence outside an open turn. Typed errors distinguish missing sources, stale objects, duplicate child ids, invalid boundaries, and prefixes ending during execution. Broader log validation and crash repair remain with their existing owners.

### Host and browser adaptation

The Host `session.fork` RPC accepts `atSeq` as an anchor within the desired turn rather than as the store's inclusive safe boundary. It selects the first `turn/end` at or after that anchor; an omitted or past-end anchor selects the last completed turn. An anchor already in the log but not followed by a matching `turn/end` returns `fork-unavailable` and never falls back to an earlier turn, so a message action cannot silently omit the clicked message.

The Host composes the child from the source's logged provider, model, and reasoning target before it can run. With a local persistence backend, it creates the child through the agent registry with the selected seed and lineage. With a scope-owning remote backend, it first flushes the source, submits only the source ID, inclusive cut, and stable operation identity, and resumes the exact durable child Header returned by `SessionPersistence.fork`. The authoritative backend reauthorizes and locks the source in one transaction, assigns the child ID, and copies the exact event prefix plus backend-owned visibility, project references, and other authorization relations. An exact replay returns the same child, while the same identity with another cut conflicts. Neither current workspace selection nor caller-supplied target metadata can choose the child's scope. A provider may admit a failure for one immediate retry only when repeating the durable operation under the same identity is safe; XAgent admits only `service-unavailable`, leaving authorization, absence, conflict, and response validation terminal. The same classification permits one exact-child resume retry without another durable fork after the Header has been returned. The Host then attaches the child to the source Workspace and retries that phase once only for `EAGAIN`, `EBUSY`, or `ETIMEDOUT`, without repeating either successful durable phase. Any already-live child must match every authoritative Header field; a conflict fails closed. An attachment failure returns `workspace-attach-failed` with the already-published child id; the client reconciles that child into its summary list before surfacing the error. The Session-row action uses the last completed turn, while a message action supplies its event seq; both open the child after success, and lineage expansion makes it visible beneath the source.

## Alternatives considered

**Separate `ctx.sessionFork` service.** An earlier iteration shipped this as a separate service; it overfit the capability-seam pattern. The code had no swappable backend, no extra event surface, no independent ownership lifecycle, and no durable behavior beyond `ctx.sessions.create({ seed, meta })`. Keeping a separate package would make callers discover and install a second service just to perform policy around a session-store primitive.

**Two functions: `snapshot()` plus `fork()`.** This preserved a reusable seed/metadata computation, but the only supported consumer created a session immediately. It also made the API feel more abstract than the concrete operation users need. A single `fork()` with an explicit `boundary` keeps the API direct while still supporting previous-point forks.

**Silently clip open turns to the last completed boundary.** That is correct for `dsh-subagent-fork-in-process`, where delegation often starts while the parent turn is open and the child should inherit only the completed prefix. It is wrong for ordinary user/session branching because it hides that the requested fork point was not actually a valid boundary and silently drops the parent turn tail.

**Replay a fork across separate client RPCs.** Giving `SessionManager` a reusable carrier identity would make separate invocations ambiguous: a later user-intended fork must create another child, while an internal recovery must resolve the first child. Keeping identity ownership in one RPC preserves that distinction and lets the Host finish the bounded recovery before answering.

## Consequences

The public API stays small and discoverable: live session branching is part of `ctx.sessions`, next to `create({ seed })`, rather than a standalone service or a two-step helper pair. Local persistence continues through existing `session/created` and `session/flush` behavior: a forked child starts life with seeded events, so those backends persist that seed once and preserve `parentSession` / `seedLength` in the header. A remote backend that owns security scope must override `SessionPersistence.fork`, derive the durable child from the authorized source, use the Host-owned operation identity for idempotency, and return the server-owned identity for Host resume. It may also override `isForkRetryable(error)` with a fail-closed classification for the Host's single immediate recovery attempt; the default admits no failure.

The v1 scope still excludes ACP `session/fork`, unloaded persisted-session forking, model-facing tools, and subagent refactors. If a future ACP method is added, it should advertise the capability only after it has protocol and snapshot coverage; this Agent Note adds no ACP wire behavior, so no ACP snapshot is required. Fork-child replay remains covered by the existing [seed-boundary testing Agent Note](../testing/2026-06-22-fork-child-replay-seed-boundary.md); focused store, Host, carrier, and client tests pin the boundary and reconciliation contracts, while the real Chromium scenario pins the assembled message action and lineage tree.
