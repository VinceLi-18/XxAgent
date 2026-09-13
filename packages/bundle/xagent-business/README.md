# XAgent Business Bundle

English | [中文](README.zh.md)

`@xagent/dsh-business` is the deny-by-default Business Profile layer, composed after `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`. It disables Shell, subprocess, filesystem access, arbitrary web access, code workers, Subagents, dynamic Workflows, filesystem Skills and Agent presets. The internal Workspace registry remains a Host dependency; its Browser entry and business Workspace RPC are unavailable.

The rosterless composition mounts authenticated Sessions, authorization, the project workbench, Artifacts, retrieval, Fact approval and [Business Skills](../../xagent/business-skill/README.md). FastAPI/PostgreSQL own business data. Generic `tool-skill` is enabled with the governed Agent-scoped provider; `skill-filesystem` remains disabled. The Browser mounts the generated Skill Remote and exactly one project Skills panel, alongside the existing Fact and citation surfaces.

## Deployment

Provide `XAGENT_API_ORIGIN`, `XAGENT_SERVICE_TOKEN`, allowed Browser origins and delegation signing configuration. Retrieval and Fact use `XAGENT_DELEGATION_PRIVATE_KEY`, `XAGENT_DELEGATION_ISSUER` and `XAGENT_DELEGATION_AUDIENCE`; user tokens come from authenticated physical requests. Missing configuration fails at load. Credentials, delegation proofs, receipts, object keys and storage URLs never enter Browser configuration.

The `xagent-business-skill` row supplies `maxCatalogEntries: 100`, `testProvider: deepseek-official` and `testModel: deepseek-v4-flash`. Deployments can patch these validated Host settings using the same provider/model routing as ordinary Agents. Browser test requests cannot select a provider or model.

The optional invariant companion checks model requests against the exact owned production policy or mounted test run. Tests retain their immutable selected read-only set; extra and missing tools fail, except the genuine deferred citation companion. Production completeness remains required after second-Skill conflicts and ordinary Skill errors; only the runtime policy's actual denial latch permits a terminating request to omit tools.

## Model Experience

### Governed turn instructions

#### What the model sees

An authenticated ordinary Project Session receives the authorized catalog. Explicit `/slug` and model `skill` loading pin one version and its closed tool set for one turn; a second Skill is denied. Every call reauthorizes against FastAPI. Turn end preserves the logged instructions but replaces their future model-history entry with a use marker. Project discovery is hidden and denied in unbound Project conversations. An active Skill or isolated read-only test may discover only its Session-fixed project; Private discovery retains its existing accessible-project behavior. Artifact search supplies `submit_cited_answer` only after admitted evidence. Test runs exclude production Fact writes.

#### Token effect

Authorized catalog entries and active instructions add bounded tokens. Tool schemas follow the current policy; retrieval results and Fact decision delivery add tokens only when admitted. Later turns retain the short Skill marker, not the old instructions.

#### KV Cache effect

Catalog, policy and evidence changes affect the Business request prefix. Developer, ordinary Web and Headless profiles do not mount this layer.

## Known Limitations and Deferred Work

- Account administration remains a server CLI operation.
- Read-only tests do not execute production Fact writes; publication discloses those excluded permissions.
- Profile-local directories organize runtime state; physical-request authorization and PostgreSQL RLS establish user isolation.
