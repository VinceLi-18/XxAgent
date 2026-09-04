# XAgent Retrieval

English | [中文](README.zh.md)

`@xagent/dsh-retrieval` is the read-only Artifact retrieval service for the XAgent Host. Model retrieval calls accept only the physical request scope established by the authenticated prompt and read its Principal, user token, connection, Session visibility, fixed project, and tool call identity. The service issues a delegation token for each call and makes exactly one FastAPI request. It does not cache authorization, projects, or evidence, and it never returns partial results after a backend failure.

A Private Session search must explicitly provide canonical Project UUIDs and/or `includePrivate`. A Project Session uses only its Session-fixed project and rejects caller selectors. `listAccessibleProjects` is available only in Private Sessions, accepts an optional bounded project-name query, and returns at most 20 accessible projects. Missing authentication scope, Session, signer, or service fails closed. Known backend failures map to stable codes; all other failures map to `service-unavailable`.

The request-scoped `xagentCitation/resolve` Browser Remote accepts only the current Session ID and a persisted `[资料N]` ID. The Typert gateway supplies the authenticated actor, account, permission revision, user token, physical connection, and request cancellation; anonymous, nested, mismatched, replaced, cancelled, and disposed scopes fail closed. Before minting a fresh exact delegation, the Remote reconstructs the citation's Artifact, Version, and Chunk identity from the live Session's canonical persisted Tool result. It returns only immutable Artifact, Version, Chunk, and line identities, never a storage URL, and retains no locator or URL cache. Its public failures are limited to `unauthenticated`, `session-not-found`, `citation-invalid`, and `service-unavailable`; backend codes outside that set collapse to `service-unavailable`.

Every XAgent inbox insertion records either its authenticated scope or an invalid sentinel. A valid binding includes the prompt request and physical connection lifetimes and is activated only when the Agent claims that message. Missing, expired, cancelled, disconnected, or mixed claimed bindings reject the step; an empty internal continuation alone may retain the running scope. Cancellation, discard, replacement, turn end, Agent disposal, and service disposal clear the corresponding private scope without adding Session events.

The opaque receipt returned by FastAPI enters the in-memory registry before the public result returns. A final successful Native result marks it published; a blocked, cancelled, failed, or terminally unappendable result confirms non-publication and discards it. A published receipt binds only when Session, tool call, and payload hash all match. Disposal closes admission, discards continuations that can no longer publish, cancels active requests, and awaits backend settlement without depending on its own post-execute waterfall. Bound sidecars remain available for exact persistence append windows until remote confirmation.

When a loop request contains a checkpointed non-empty Artifact search result, the service reconstructs short citation identities from the exact request messages and matching Session `tool/result` metadata. It then registers the Native-only `submit_cited_answer` tool and its order-190 instruction only on that Agent scope. The protected model stream drops ordinary assistant text and reasoning without buffering them while preserving tool and protocol chunks. Each tool-call index keeps its first disclosed identity: unnamed continuations inherit it, ordinary arguments remain unrestricted by the citation limit, terminal arguments are rejected above 64 KiB before forwarding, and a contradictory identity fails closed. Ordinary requests and empty searches retain the downstream stream unchanged.

The terminal tool accepts a closed ordered union of Markdown and citation blocks. Root closure and the one-to-256 block count are checked before complete serialization; streamed arguments and the complete JSON value are each limited to 64 KiB UTF-8. The answer requires at least one non-empty Markdown block and one citation block and permits at most 64 citation blocks. Markdown remains byte-for-byte model text and grants no citation authority: the service does not parse markup, raw HTML, character entities, or Unicode lookalikes. Citation blocks must name the current request's admitted short IDs; adjacent duplicate citations collapse, non-adjacent placement remains intact, and `citationIds` follows first use. Each attempt reauthorizes exactly those identities with the current authenticated scope and a fresh delegation nonce.

The request owner stages a valid answer by the exact `ToolExecution`, calls `concludeTurn()`, and treats only its authoritative successful `tools/result` as publication. One invalid submission may return the bounded `CITATION_INVALID` tool error for an immediate retry in the same request; a second invalid submission or a finished response without a successful terminal call yields stable `CITATION_FAILED`. Tools preceding the terminal call settle normally, while a monotonic guard remains active through the turn boundary to deny parallel terminal dispatch and every later call. Request or connection abort, account or Session replacement, Agent or Session disposal, and Retrieval disposal close admission, abort active authorization, publish no cited-answer metadata on failure, and retain draining owners until their protected iterators settle.

The Business composition pairs this service with `@xagent/dsh-tool-retrieval`, FastAPI/PostgreSQL receipt admission, remote Session persistence, and `@xagent/dsh-ui-citation`. Evidence becomes available to a later request only after the matching receipt sidecar and public Tool result commit together. The Browser renders only canonical persisted result metadata; citation clicks return through the authenticated Remote and reopen the exact clean immutable Artifact version and line range.

## Model Experience

### Retrieval evidence

#### What the model sees

The model sees only accessible project names returned by `list_accessible_projects`, or up to eight authorized Artifact excerpts with short `[资料N]` IDs returned by `search_artifacts`. An evidence-bearing request also sees `submit_cited_answer` and its terminal instruction; one invalid submission receives only a bounded tool error for the same request's retry. It never sees user tokens, delegation tokens, receipts, internal URLs, object keys, or backend error details.

#### Token effect

Project lists or Artifact excerpts add tool-result tokens only when the model calls a retrieval tool. The service does not preload Artifact content into the prompt.

#### KV Cache effect

Tool results become Session events and therefore change the cache prefix after that tool call. Authentication scope, delegation tokens, receipts, and suppressed assistant text or reasoning never enter a model request.

## Known Limitations and Deferred Work

- This package owns Host retrieval, delegation, receipt lifetime, and terminal cited-answer publication; FastAPI owns hybrid ranking, RLS, citation ordinals, and receipt consumption.
- The Session persistence provider supplies remote append and confirmation for receipt sidecars; the registry performs no disk or network persistence.
- The full Browser acceptance lane uses the production Business composition, real PostgreSQL RLS, scanning and CPU BGE-M3 indexing; a deterministic repository model adapter may drive the Agent Loop when no provider key is configured, but that mode does not claim a real model round.
- Retrieval owns an HTTP tokenizer provider fixed to `BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181`. Service loading rejects another identity or revision. The provider rejects malformed UTF-16, accepts at most 8 KiB of query UTF-8, bounds worst-case JSON escaping, combines caller cancellation with a five-second timeout, rejects redirects and non-exact responses, and reads at most 512 response bytes. It sends only the Host service token to the bounded FastAPI token-count relay on `backendOrigin`; FastAPI forwards to the service-only embedding endpoint without a user or delegation token. Queries of at most 512 exact tokens reach retrieval, while 513-token queries do not.
