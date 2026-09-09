# @xagent/dsh-fact

English | [中文](README.zh.md)

`@xagent/dsh-fact` provides the governed Fact service for XAgent Business Project Sessions. It prepares model-proposed facts for later human review, exposes authenticated browser reads and decisions, and appends durable decision events to the source Session log.

The service accepts proposal authority only from the physical authenticated request scope. It issues an exact, short-lived delegation for the current actor, permission revision, fixed project, Session, tool, and tool call. The browser Remote likewise derives the user token and fixed project from its connection scope; no caller supplies identity or ownership fields.

Proposal receipts and Outbox identities remain in separate private registries. Session persistence reads their sequence-bounded attachments and commits them only after FastAPI acknowledges the corresponding append. Session open and `agent/pre-step` pull at most 32 Outbox rows through one owner per Session, append ordinary `fact/proposal-decided` events, and never start a Turn. A Session with an unprojected decision or live decision notice does not pull another page; the next page waits until the current page is durably consumed. The physical scope of each claimed inbox batch authorizes its complete model step; an error releases only active ownership and preserves later queued-message bindings.

## Model Experience

### Governed Fact lifecycle

#### What the model sees

The provider itself adds no standing prompt text or tool schema. The Project-only Consumer returns only a proposal ID and `pending` status. Outbox delivery appends `fact/proposal-decided` as a log-only, non-surface Session event. On the first model step of the next user-initiated Turn, the plugin projects the current page of at most 32 undelivered decisions in event order and durably replaces the temporary notice after the downstream iterator produces its first result. Same-Turn continuations, later Turns, and replay do not repeat the notice. Receipts, tokens, and evidence content are never projected.

#### Token effect

Outbox delivery adds no model tokens by itself. The next user-initiated request carries one bounded notice containing only the event's public fields; consuming it removes that notice from later request projections.

#### KV Cache effect

Outbox delivery appends Session history without scheduling a model request, so it neither invalidates nor extends a live KV Cache. The next user-initiated request adds one decision notice to its request prefix; the durable replacement prevents that notice from entering later request prefixes.

## Known Limitations and Deferred Work

- This package does not register the `propose_fact` model tool or its renderer; those are separate Business-profile plugins.
- Outbox delivery reads one page per Session-open or pre-step trigger. Additional rows wait for a later trigger.
- Private and anonymous Sessions cannot prepare, read, or decide governed facts.
