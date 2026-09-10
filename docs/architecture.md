# DeepSeek Harness Architecture

English | [中文](architecture.zh.md)

Read this before changing anything under `packages/`. It assumes you know Cordis; if you do not, start with the [primer](cordis-primer.md) or the [tutorial](cordis-tutorial/index.md).

We recommend using an agent to explore the codebase and understand its architecture.

## Cordis

[Cordis](cordis-primer.md) is the framework under dsh: plugins contribute services, typed events, and reversible effects to a shared context. Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself, so every part is replaceable from configuration.

There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads.

## Profiles and bundles

A running `dsh` is a plugin tree composed at boot from ordered layers.

A **profile** is a named composition stored in the Harness home. It lists the bundles it stacks, holds any out-of-tree plugins it installs, and keeps the user's own `cordis.patch.yml`. `web` and `headless` ship as templates.

A **bundle** is a distribution format for Cordis config rows and the code they mount, so whatever it inserts stays patchable by the layers above it.

Each declares itself in its own `package.json` under a `dsh` field: `dsh.profile` lists a profile's bundles, and `dsh.bundle` points at a bundle's patch file.

[`dsh-base`](../packages/bundle/base/README.md) is the first layer of every profile: model adapters, tools, persistence, sandbox and approval policy, settings, credentials, telemetry. [`dsh-web-app`](../packages/bundle/web-app/README.md) adds the browser application; [`dsh-headless`](../packages/bundle/headless/README.md) adds a one-shot runner with no server at all.

Layers apply to an empty entry list in this order: each bundle in the profile's listed order, then the profile's `cordis.patch.yml`, then the home-level one, then any `--patch` overlay. A patch targets a row by id and replaces its whole config, or inserts new rows.

To see the tree your machine actually boots:

```sh
dsh --profile web --dump-config
```

Any row it prints can be replaced by a patch of your own.

Composition mechanics are in [app-boot](../packages/boot/app-boot/README.md#profiles); config fields are in the generated [config catalog](config-catalog.md).

### XAgent authenticated Business runtime

`xagent-business` keeps the dsh Host as the browser-facing process, but it does not use the local JSONL store as its session authority. The Host exchanges the browser's secure login cookie with the XAgent FastAPI service, derives an immutable principal for each physical connection, and passes that principal explicitly through RPC authorization. Browser payloads and identity-like headers never define the principal.

The XAgent authorization service validates every Session method against a closed method table. It binds the request to the authenticated connection, asks FastAPI for the required read or edit decision, and opens a narrowly scoped user-token lease around the remote persistence call. Unknown Workspace methods and all browser Workspace RPCs fail closed; the internal Workspace registry remains mounted only because the generic API gateway requires it during boot.

FastAPI owns passwords, revocable login records, permission revisions, account state, session headers, and append-only session events. PostgreSQL row-level security and the application transaction recheck the actor before each read or write. A private session is visible only to its owner, including to managers; invisible and absent sessions share the same not-found result. The Host never falls back to a profile-local session file when FastAPI is unavailable.

New-session publication is atomic across the runtime boundary: the remote header and seed event must commit before the Agent becomes visible. Restored sessions preserve interrupted durable tails; their provider-owned preparation remains rollbackable until Session creation, Agent creation, and session start all succeed, then appends the constructor-created suffix and any publication-time events remotely. Startup workspace discovery uses a separate bootstrap method; the XAgent provider intentionally returns no user sessions there because no authenticated principal exists yet.

`xagent-developer`, `web`, `headless`, and other upstream profiles retain their existing local persistence and do not load XAgent service credentials, authentication, authorization, or delegation keys. Profile directories remain an organization boundary, not a multi-user security boundary.

The Business project workbench keeps account capabilities, visible projects, the selected workbench or project context, and Session scope in FastAPI/PostgreSQL. `@xagent/dsh-project` exposes four request-scoped Remote methods whose user token comes only from the authenticated connection. `@xagent/dsh-ui-project` consumes their Bootstrap through reversible Slots for the project browser, central context marker, operation shield, and third-column details. It keeps no project cache in browser storage and discards late responses after an account change.

Business artifact management follows the same authenticated scope without adding model tools. FastAPI and PostgreSQL own private and project artifact permissions, immutable versions, the five scan states, audit, and a durable PostgreSQL processing queue; a separately credentialed worker scans staged content through ClamAV and promotes clean objects into a versioned private MinIO bucket. `@xagent/dsh-artifact` exposes only the fixed human-interface Remote and same-origin content proxy, while `@xagent/dsh-ui-artifact` occupies the project details Slot for upload, history, retry, preview, and download. The browser keeps artifact state only in memory, clears it on account or project changes, and never adds artifact content or signed reads to Session events or model requests.

Governed Fact access uses the same physical authorization path. `@xagent/dsh-authorization` resolves a unique Project Session from the authenticated connection and authoritative backend Session list, then runs each closed `xagentFact/*` Remote through `@xagent/dsh-fact`'s request scope. Session restore uses the same derived scope, allowing the provider to pull one bounded Outbox page when the Session opens. Delivery appends the log-only, non-surface `fact/proposal-decided` event and never starts a Turn. While that page remains unprojected or its notice remains live, the provider does not pull another page. The Fact plugin derives an ordered notice solely from unconsumed log events for the first model step of the next user-initiated Turn, then durably replaces the temporary notice after the downstream iterator's first result; same-Turn continuations, later Turns, and restart replay do not repeat it. `propose_fact` and the Fact Browser workbench are assembled only by `xagent-business`.

Business retrieval is assembled only in `xagent-business`. `@xagent/dsh-retrieval` binds each Native tool call to the authenticated physical request and Session scope, issues a fresh signed delegation, and sends one bounded request to FastAPI. Project Sessions use their fixed project; Private Sessions require explicit projects and/or private artifacts. FastAPI validates the delegation and one-use nonce, rechecks the login and permission revision in the serializable retrieval transaction, applies PostgreSQL RLS, and runs hybrid search over the current clean index heads. The opaque receipt remains a private persistence sidecar until the matching public `tool/result` is durably appended and the backend atomically admits its evidence identities.

After a non-empty evidence result reaches the next model request, Retrieval registers the Native-only terminal `submit_cited_answer` tool. The canonical result contains ordered Markdown and citation blocks; Markdown never grants citation authority, while only exact citation blocks are reauthorized and persisted. Receipt admission records each citation ID's exact Artifact Version, Index generation, and Chunk in an immutable relation independent of surface projection and the admitting actor's receipt. A cited-answer append binds only its current citation IDs to earlier rows through indexed, explicitly bounded reads; an append without a cited answer performs no provenance or history query. `@xagent/dsh-ui-citation` renders the durable result metadata identically live and after reload. Clicking a verified chip sends only the Session and citation IDs through the authenticated citation Remote; FastAPI resolves the durable answer-to-admission relation and reauthorizes that immutable evidence for the current actor, including after compaction or a scope-preserving fork. The Browser receives no storage URL, opens the Artifacts tab, re-reads the exact clean immutable version, and highlights the authorized line range.

`@xagent/dsh-ui-account` contributes the CSRF cookie header to the browser connection's generated Remote and existing Web API transports. This header service is inert without a contributor. Only `xagent-business` mounts these XAgent rows; the generic layout, Developer profile, and upstream profiles keep their prior UI and transport behavior.

## Core packages

Here are some core packages that contribute to the Cordis tree.

| Package | Owns | `ctx` key |
|---|---|---|
| [`core/session`](subsystems/session.md) | The append-only `SessionEvent` log and in-memory store | `ctx.sessions` |
| [`core/system-prompt`](subsystems/system-prompt.md) | Prompt-section and tool-schema assembly | `ctx.systemPrompt` |
| [`core/tools`](subsystems/tools.md) | The scoped tool registry and guarded execution pipeline | `ctx.tools` |
| [`core/agent`](subsystems/core.md) | The `Agent` interface, live registry, and `agent/*` events | `ctx.agents` |
| [`core/agent-loop`](subsystems/core.md) | The default driver implementing that interface | `ctx.agentLoop` |
| [`core/scope`](subsystems/scope.md) | The per-agent scoped-registration primitive | library, no key |
| [`llm/llm`](subsystems/llm-streaming.md) | Message and stream vocabulary plus the adapter seam | `ctx.llm` |

## Events

Events are the extension points, and picking the right domain is the first decision in most changes.

- **Session events** are durable facts appended to the log and broadcast through `session/event`. Use one when the fact must survive a reload.
- **Agent events** (`agent/*`) carry a live `Agent`: inbox, step, status, request, validation, continuation. Use one to observe or intercept work in flight.
- **Capability events** attach policy and adapters to a seam (`fs/*`, `tools/*`, `telemetry/*`) without importing the loop.

The [event map](event-producer-consumer.md) lists every event's producers and consumers.

## Turn flow

A **step** is one model request plus the tools it calls. A **turn** is zero or more steps: it opens before its first input is claimed and closes once nothing is owed.

```text
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step                   reject | enter(messages)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     append entered messages as user/message
     derive model history from the log
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

`turn/*`, `step/*`, `user/message`, `assistant/*`, and `tool/*` are durable session events; the rest are live extension points across three domains. `agent/pre-step`, `agent/request`, `llm/stream`, and the three `tools/*` events are waterfalls, whose listeners must call `next()` to delegate; `agent/turn-stopping` is serial and has no `next()`.

Input reaches the driver through one inbox. Some messages wake it immediately; injected context waits in the inbox until another message does.

`agent/pre-step` decides what the model sees. Listeners may rewrite the claimed messages or reject them outright; a rejected or empty first claim still closes a durable turn that spent no step, so the log records the attempt. Each step reads the prompt sections and tool schemas that plugins registered.

Details: the [sequence diagram](agent-lifecycle.md), the [tool pipeline](tool-execution-pipeline.md), and [cancellation and error recovery](subsystems/core.md#the-agent-handle).

## Session log

The session log is the source of the context the model sees. `deriveMessages()` projects model history from it, and raw `assistant/chunk` events preserve replay and UI fidelity. Fork, resume, transcripts, telemetry, and persistence all derive from this stream.

**Model-visible means logged.** Anything that reaches a model request must be reconstructable from the log, and a runtime invariant asserts it. This is why a new model-visible input requires a new session event: extend `SessionEventMap` and render from the log.

## Capability seams

A **seam** is a swappable capability with three roles: a **Service Definition** declaring the interface, a **Service Provider** implementing it, and a **Consumer** using it, commonly a model-facing tool. A package may combine roles, but one role alone is not a seam; adding a capability means designing all three ([capability graph](capability-seams.md)).

Seams are why one provider swap changes the whole product. Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks. [Subagent providers](subsystems/subagent.md) vary just as widely behind one interface, from a fresh child agent to a delegated turn in another product.

## Where new behavior goes

New behavior attaches to a documented extension point. Changing the loop itself updates this map.

| Goal | Mechanism |
|---|---|
| Add a model provider | register its adapter on `ctx.llm` |
| Add a model-facing capability | register on `ctx.tools`; its schema joins prompt assembly |
| Give one session a different capability set | compose an agent preset; a service row there needs an `isolate` realm |
| Add shell execution | register a `ctx.shell` backend; the local one spawns through `ctx.subprocess` |
| Add persistent terminal execution | register a `ctx.terminals` backend plus `dsh-tool-terminal` |
| Add a human command | register on `ctx.commands`; it dispatches without a model turn |
| Add background work | register on `ctx.jobs`; `job_*` tools collect or stop it |
| Add filesystem access or policy | register a `ctx.fs` provider or listen to `fs/*` events |
| Confine spawned processes | use a `ctx.sandbox` backend; consumers wrap argv before spawning |
| Intercept a request, tool, or turn | use its `agent/*` or `tools/*` event; `agent/turn-stopping` stops a turn |
| Add model-facing context | call `agent.inject()`; it lands in the next admitted request |
| Add UI or editor integration | drive `ctx.agents` and render from `session/event` |
| Add a Web Client Chat node | register a `ConversationNodeDefinition` + keyed renderer |
| Add durable session state | extend `SessionEventMap`; render and replay from the log |
| Generate session titles | register the sole `ctx.sessionTitle` provider |
| Manage a same-session objective | use `ctx.goals`; continue through `agent/*` |
| Fork a live session | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| Scope a registration to one agent | use that agent's `agent.ctx` |

The [extension cookbook](cookbook/extension-cookbook.md) maps features to capabilities and indexes the step-by-step guides for [packages](cookbook/adding-a-package.md), [tools](cookbook/adding-a-tool.md), [LLM adapters](cookbook/adding-an-llm-adapter.md), [Chat nodes](cookbook/adding-a-conversation-node.md), and [settings cards](cookbook/adding-a-settings-card.md).
