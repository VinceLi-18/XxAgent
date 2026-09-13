# XAgent Retrieval Tools

English | [中文](README.zh.md)

`@xagent/dsh-tool-retrieval` registers the two read-only model tools `list_accessible_projects` and `search_artifacts`. Both parameter schemas reject undeclared fields. Project discovery accepts an optional name query. Artifact search accepts a non-empty query, optional explicit Project UUIDs, and `include_private`. The descriptions require the model to ask the user when a project or private scope is ambiguous; it cannot choose the first same-name project or treat a Private Session as all projects.

The tools read the Session and tool call identity from the calling Agent, then forward cancellation to `ctx.xagentRetrieval`. They are Native-only: Code SDK generation and nested Code execution both exclude them, including the Code path of `both` mode. Tool content and replayable metadata never contain receipts. Public metadata is fixed to the retrieval kind, payload hash, and short citation IDs. A missing Agent, retrieval service, or backend capability returns a stable failure.

Host policy can identify the exact live Artifact search registration through `SEARCH_ARTIFACTS_TOOL` and `isArtifactSearchTool`. The predicate rejects copied definitions and expires when the defining plugin unloads; the identity is private and never enters schemas or wire data. This supports [Business Skill deferred companion admission](../business-skill/README.md#turn-binding-and-tools) without accepting arbitrary same-name tools.

## Model Experience

### Explicit retrieval scope

#### What the model sees

In Native mode, the model sees closed `list_accessible_projects` and `search_artifacts` schemas, scope-disambiguation instructions, and successful project lists or evidence with short citation IDs. Project discovery is visible in Private conversations or a permitting active Business Skill; Project and test discoveries return only their Session-fixed project. Code SDKs never declare these tools. An empty search uses a fixed Chinese message.

#### Token effect

The tool definitions add fixed schema and description tokens. Project lists or evidence text add tokens only after a call.

#### KV Cache effect

The fixed tool definitions can reuse the request-prefix cache. Each result varies by query and authorized scope and changes the cache prefix after its Session event.

## Known Limitations and Deferred Work

- This package does not decide permissions, ranking, or citation lifetime; the Host service and FastAPI provide those results.
- This package provides generic retrieval Tool results only. In the Business composition, `@xagent/dsh-retrieval` owns cited-answer enforcement and terminal publication, while `@xagent/dsh-ui-citation` owns the specialized durable-result view.
