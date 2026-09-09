# XAgent Phase 4B governed Fact acceptance record

English | [中文](2026-09-08-xagent-phase-4b.zh.md)

Phase 4B adds one governed Project Fact lifecycle to XAgent Business. FastAPI and PostgreSQL own proposal preparation, receipt-bound admission, immutable revisions, current heads, review decisions, audit, idempotency, row-level authorization, and the single-object Business Outbox. Developer, ordinary Web, Headless, JiaxinAgent, Private Sessions, and Code Mode do not receive the Fact write schema, Remote, or review UI.

## Delivered capability

Tasks 1–3 landed the strict schema, admission, decision, audit, and Outbox transactions in commits `8577e17`, `e278440`, `aa12b10`, `589dbe2`, `26ad88e`, `e024136`, `0e6a9cc`, and `4a6e463`. Tasks 4–5 landed the closed TypeScript client, Session codec and persistence sidecars, governed Host provider, authorization mapping, and Browser Remote in `a28ca4b`, `239eab4`, `d19190a`, and `82a3282`. Tasks 6–7 landed the Project-only Native proposal tool and Fact review workbench in `4612f30`, `1310613`, `373fd64`, `6c0ea37`, `6bbabb1`, and `25035b4`.

The Business bundle now installs the Fact provider, proposal Consumer, generated Remote, and browser workbench together. The Native schema appears only for a complete authenticated Project inbox batch and is absent from Code Mode and every non-Business shipped profile. Physical request and connection cancellation remain attached to the batch that supplied them, while an earlier Turn error releases active ownership without deleting a queued follow-up's authorization binding. Loader lifecycle corrections are isolated in `4804279`, `5dde934`, and `fa11891`.

## Decision delivery and model behavior

Review completion writes one required-on-read `fact/proposal-decided` event containing only the closed public proposal, project, field, label, terminal status, optional confirmed revision fields, and optional decision reason. Outbox delivery never calls Agent send or follow-up APIs. It pulls at most 32 decisions and waits for the current page to be durably consumed before pulling another. The Fact plugin derives that ordered page solely from the durable Session log and adds it only to the first model step of the next user-initiated Turn. It waits for the downstream iterator's first result, durably replaces the temporary notice, and flushes before yielding any chunk; downstream failure, cancellation, append failure, or flush failure leaves the decision available for exact retry. Same-Turn continuations, later Turns, and restart replay do not repeat a consumed notice.

The checked-in keyless Loader snapshot runs the real Agent loop, Retrieval and Fact providers, tool registry, receipt binding, Outbox pull, decision projection, and cited-answer terminal policy. It prepares one evidence-backed Fact and one reason-backed Fact, records their exact public pending results, binds both private Fact receipts and the Retrieval receipt to their public event sequences, presents the confirmed decision on exactly one later user Turn, and completes every evidence-bearing answer through `submit_cited_answer`.

## Product surface

The Project details panel exposes a fourth Fact tab only while the Business Fact UI occupant is live. It lists current heads, proposals, immutable revision history, and exact evidence references through the authenticated Remote. Managers may approve or reject and proposers may withdraw only while FastAPI reauthorizes the current project membership and role. Scope changes, connection changes, cancellation, and component disposal clear memory-only state and reject late results. Decision retries reuse an idempotency key only after an uncertain transport outcome. No receipt, bearer token, delegation, evidence text, URL, object key, or signed storage location enters the Browser or model decision notice.

## Verification status

Focused provider, proposal-tool, cited-answer, bundle closure, TypeScript SDK, Python SDK, CLI Loader, and headless snapshot suites cover the assembled paths. The final commands and results, including typecheck, lint, hygiene, duplication, documentation synchronization, generated-owner checks, and diff review, are recorded in the Task 8 report. The Fact event fields are identical across the Host, persistence codec, TypeScript fake runtime, Python fake runtime, Browser replay, and snapshot fixture.

## Remaining proof

Phase 4B Task 9 still owns the real Browser walkthrough, failure-state inspection, responsive interaction proof, and GIF. This record does not claim that Browser E2E evidence. Deployment rollback remains strict: a database downgrade is refused while any Fact relation or Fact audit row is non-empty, so deployed business data requires a reviewed backup before rollback.

## Agent Note result

The Fact approval Agent Note is implemented and remains active because its receipt admission, authorization, Outbox, asynchronous model-delivery, evidence, and browser-state decisions retain future design value. The active XAgent authentication, workbench, artifact, and Retrieval notes are related but not superseded: each owns a distinct security or capability seam. No active note in this scope qualifies for archive, rejection, consolidation, or deletion.
