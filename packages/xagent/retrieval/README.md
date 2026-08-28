# XAgent Retrieval

English | [中文](README.zh.md)

`@xagent/dsh-retrieval` is the read-only Artifact retrieval service for the XAgent Host. Every call accepts only the physical request scope established by the authenticated prompt and reads its Principal, user token, connection, Session visibility, fixed project, and tool call identity. The service issues a delegation token for that call and makes exactly one FastAPI request. It does not cache authorization, projects, or evidence, and it never returns partial results after a backend failure.

A Private Session search must explicitly provide canonical Project UUIDs and/or `includePrivate`. A Project Session uses only its Session-fixed project and rejects caller selectors. `listAccessibleProjects` is available only in Private Sessions, accepts an optional bounded project-name query, and returns at most 20 accessible projects. Missing authentication scope, Session, signer, or service fails closed. Known backend failures map to stable codes; all other failures map to `service-unavailable`.

Every XAgent inbox insertion records either its authenticated scope or an invalid sentinel. A valid binding includes the prompt request and physical connection lifetimes and is activated only when the Agent claims that message. Missing, expired, cancelled, disconnected, or mixed claimed bindings reject the step; an empty internal continuation alone may retain the running scope. Cancellation, discard, replacement, turn end, Agent disposal, and service disposal clear the corresponding private scope without adding Session events.

The opaque receipt returned by FastAPI enters the in-memory registry before the public result returns. A final successful Native result marks it published; a blocked, cancelled, failed, or terminally unappendable result confirms non-publication and discards it. A published receipt binds only when Session, tool call, and payload hash all match. Disposal closes admission, discards continuations that can no longer publish, cancels active requests, and awaits backend settlement without depending on its own post-execute waterfall. Bound sidecars remain available for exact persistence append windows until remote confirmation.

## Model Experience

### Retrieval evidence

#### What the model sees

The model sees only accessible project names returned by `list_accessible_projects`, or up to eight authorized Artifact excerpts with short `[资料N]` IDs returned by `search_artifacts`. It never sees user tokens, delegation tokens, receipts, internal URLs, object keys, or backend error details.

#### Token effect

Project lists or Artifact excerpts add tool-result tokens only when the model calls a retrieval tool. The service does not preload Artifact content into the prompt.

#### KV Cache effect

Tool results become Session events and therefore change the cache prefix after that tool call. Authentication scope, delegation tokens, and receipts never enter a model request.

## Known Limitations and Deferred Work

- This package owns Host retrieval, delegation, and receipt lifetime; FastAPI owns hybrid ranking, RLS, citation ordinals, and receipt consumption.
- The Session persistence provider supplies remote append and confirmation for receipt sidecars; the registry performs no disk or network persistence.
- Retrieval owns an HTTP tokenizer provider fixed to `BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181`. Service loading rejects another identity or revision. The provider accepts at most 8 KiB of query UTF-8, combines caller cancellation with a five-second timeout, rejects redirects and non-exact responses, and reads at most 512 response bytes. Each search calls the service-only embedding `/token-count` endpoint before FastAPI retrieval; queries of at most 512 exact tokens reach retrieval, while 513-token queries do not.
