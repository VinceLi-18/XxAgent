# XAgent Fact Architecture

This package owns one Host capability seam: the Fact Service Definition, its FastAPI-backed provider, and its Typert Remote. The service is available only when the Business composition installs it; the model-facing tool and browser presentation remain separate Consumers.

`proposeFact` receives business fields and a tool-call identity, then derives every authority field from `@xagent/dsh-principal`'s authenticated Project Session scope. Its delegation binds the current actor, permission revision, fixed project, backend Session, `propose_fact`, tool call, one-use nonce, issuer, audience, and a 60-second lifetime. The opaque user token and delegation never enter the public result, Session event, Remote schema, or logs.

FastAPI returns the public pending result together with a private admission receipt. The receipt registry retains one current receipt per Session/tool call and binds it only when the matching public `tool/result` is appended. The Outbox registry independently binds a backend Outbox identity to a Session event sequence. Persistence requests sequence-bounded attachments from both registries and commits only through the acknowledged sequence, so response-loss replay remains exact and a failed append consumes neither identity.

One Outbox owner may pull for a Session at a time. Session-open and `agent/pre-step` triggers with the same immutable physical scope share that owner. A different or cancelled scope closes the prior owner before replacement. The owner validates the fixed project and duplicate row identities, reserves each event sequence, and appends the closed decision event through `Session.append`; it never calls Agent send, follow-up, or loop APIs.

The appended `fact/proposal-decided` event is log-only and has no surface operation. This package does not project it into model history, so delivery has zero model-token and KV-cache effect until a separate Consumer performs that projection.

Disposal rejects new work before aborting owned operations, removes every effect, synchronously clears both registries and scope ownership, then awaits in-flight settlement. Results observed after request, connection, Session, or plugin cancellation are discarded.
