# XAgent Fact Proposal Tool

English | [中文](README.zh.md)

`@xagent/dsh-tool-fact` registers the Native-only `propose_fact` model tool for an authenticated Project Session. The Consumer captures the physical request scope and provisionally registers the schema in the matching Agent's tool registry when inbox work is admitted, before request assembly. A claimed batch promotes the registration only when every message has the same live scope. Scope replacement, request or connection cancellation, Turn completion, Agent failure, service replacement, and plugin disposal remove the registration. Anonymous and Private requests, another Session, a missing Fact service, and Code Mode expose no callable proposal schema.

The closed parameter schema accepts a field key, display label, one exact `text`/`number`/`boolean`/`date` tagged value, up to 64 structurally distinct admitted citation IDs, and an optional assertion reason. String `pattern`, array `maxItems`, and array `uniqueItems` are enforced by the shared JSON-value schema validator. The Consumer also enforces the FastAPI UTF-8 byte ceilings, field-key and citation syntax, Gregorian calendar dates, safe integral numbers, and the requirement for a non-blank assertion reason when no citation evidence is supplied.

Execution derives the runtime Session ID, exact tool call ID, and cancellation signal from `ToolRunContext`; model arguments cannot provide Principal, project, role, membership, permission revision, delegation, token, receipt, or internal status. The Fact service retains the preparation receipt privately. A success returns only `{ proposalId, status: 'pending' }`, renders through the generic tool presentation, and persists exactly `{ kind: 'xagent-fact', status: 'pending', proposalId }` as result metadata so the provider can bind the private receipt during Session admission.

`propose_fact` never concludes the Turn. When retrieval evidence activated the cited-answer policy, the model must still publish its final answer through `submit_cited_answer`; an evidence-free proposal reason is not an artifact citation. Cancellation waits for the called service to settle and suppresses any late public success.

## Model Experience

### Governed proposal preparation

#### What the model sees

During an authenticated Project Turn in Native mode, the model sees one closed `propose_fact` schema and a minimal pending result after success. The generic renderer shows the tool name, model arguments, and public result without any private receipt or credential.

#### Token effect

The fixed schema and descriptions add tokens only to eligible Project requests. Successful calls add only the proposal UUID and pending status to model-visible history.

#### KV Cache effect

The fixed definition is prefix-cache friendly within eligible Project requests. A proposal result changes the later prefix only through its small public content and metadata.

## Known Limitations and Deferred Work

- This Consumer prepares proposals only. FastAPI owns authorization, exact evidence admission, conflict handling, approval, rejection, withdrawal, audit, and expiry.
- Task-specific Fact cards and review controls belong to the Business UI Consumer; this package intentionally keeps generic render intent.
