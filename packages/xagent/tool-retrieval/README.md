# XAgent Retrieval Tools

English | [中文](README.zh.md)

`@xagent/dsh-tool-retrieval` registers the two read-only model tools `list_accessible_projects` and `search_artifacts`. Both parameter schemas reject undeclared fields. Project discovery accepts an optional name query. Artifact search accepts a non-empty query, optional explicit Project UUIDs, and `include_private`. The descriptions require the model to ask the user when a project or private scope is ambiguous; it cannot choose the first same-name project or treat a Private Session as all projects.

The tools read the Session and tool call identity from the calling Agent, then forward cancellation to `ctx.xagentRetrieval`. Tool content and replayable metadata never contain receipts. Public metadata is fixed to the retrieval kind, payload hash, and short citation IDs. A missing Agent, retrieval service, or backend capability returns a stable failure.

## Model Experience

### Explicit retrieval scope

#### What the model sees

The model sees closed schemas for `list_accessible_projects` and `search_artifacts`, scope-disambiguation instructions, and successful project lists or evidence with short citation IDs. An empty search uses a fixed Chinese message.

#### Token effect

The tool definitions add fixed schema and description tokens. Project lists or evidence text add tokens only after a call.

#### KV Cache effect

The fixed tool definitions can reuse the request-prefix cache. Each result varies by query and authorized scope and changes the cache prefix after its Session event.

## Known Limitations and Deferred Work

- This package does not decide permissions, ranking, or citation lifetime; the Host service and FastAPI provide those results.
- This package provides generic tool results only; citation enforcement, final-answer composition, and specialized UI presentation belong to later composition.
