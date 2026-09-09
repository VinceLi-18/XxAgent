# @xagent/dsh-fact

English | [中文](README.zh.md)

`@xagent/dsh-fact` provides the governed Fact service for XAgent Business Project Sessions. It prepares model-proposed facts for later human review, exposes authenticated browser reads and decisions, and appends durable decision events to the source Session log.

The service accepts proposal authority only from the physical authenticated request scope. It issues an exact, short-lived delegation for the current actor, permission revision, fixed project, Session, tool, and tool call. The browser Remote likewise derives the user token and fixed project from its connection scope; no caller supplies identity or ownership fields.

Proposal receipts and Outbox identities remain in separate private registries. Session persistence reads their sequence-bounded attachments and commits them only after FastAPI acknowledges the corresponding append. Session open and `agent/pre-step` pull at most 32 Outbox rows through one owner per Session, append ordinary `fact/proposal-decided` events, and never start a Turn.

## Model Experience

### Governed Fact lifecycle

#### What the model sees

The provider itself adds no prompt text or tool schema. A separate Consumer may return only a proposal ID and `pending` status. Outbox delivery appends `fact/proposal-decided` as a log-only, non-surface Session event; it is not model-visible until a separate Consumer explicitly projects it. Receipts, tokens, and evidence content are never projected.

#### Token effect

The provider and its decision event add no model tokens by themselves. A future Consumer may contribute only the event's bounded public fields when it explicitly projects them into a model request.

#### KV Cache effect

Outbox delivery appends Session history without scheduling a model request, so it neither invalidates nor extends a live KV Cache. Until a separate Consumer projects the event, later model requests also ignore it.

## Known Limitations and Deferred Work

- This package does not register the `propose_fact` model tool or its renderer; those are separate Business-profile plugins.
- Outbox delivery reads one page per Session-open or pre-step trigger. Additional rows wait for a later trigger.
- Private and anonymous Sessions cannot prepare, read, or decide governed facts.
