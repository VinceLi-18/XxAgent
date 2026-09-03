# @xagent/dsh-ui-citation

English | [中文](README.zh.md)

`@xagent/dsh-ui-citation` renders the closed `xagent-cited-answer` result metadata for `submit_cited_answer` inside the existing Business conversation. Markdown blocks use the shared safe Markdown component with authored links kept inert. Citation blocks become keyboard-accessible “已验证资料” chips, and the quiet source strip lists each citation once in first-use order. Only those blocks create navigation actions; Markdown links, autolinks, URL-shaped inline code, and citation lookalikes remain text.

Selecting a chip sends only the current Session ID and citation ID to `xagentCitation/resolve`. The Host recovers the authenticated actor, account, permission revision, and persisted citation identity, then returns immutable Artifact, Version, Chunk, and line identities without a URL. The browser hands only the Artifact, Version, and line range to `xagentArtifactCitationOpener`; the Artifact controller re-reads detail and preview for that exact clean version.

One controller owns one account and Session scope and at most one resolution. Replacement, account or Session change, ToolView unmount, Remote failure, and plugin disposal cancel the request and suppress late Artifact publication. The UI never reads Tool arguments, result text, or Markdown as citation authority. Malformed or non-success metadata produces stable closed copy.

## Model Experience

### Verified cited answer

#### What the model sees

This package adds no model input. The terminal `submit_cited_answer` Tool and its canonical persisted result are owned by `@xagent/dsh-retrieval`; this package only renders that durable result.

#### Token effect

The package adds no prompt or output tokens.

#### KV Cache effect

The package does not read or write the model KV cache. Citation navigation is a user-only Browser and Host operation.

## Known Limitations and Deferred Work

- Citation navigation supports only persisted citations from the current authenticated top-level Session.
- The source strip intentionally shows stable short citation IDs rather than filenames, URLs, snippets, or model-authored labels.
- Non-text, non-clean, revoked, or mismatched Artifact versions fail closed because citation navigation requires an exact line highlight.
