# XAgent Phase 6 governed Business Skill acceptance record

English | [中文](2026-09-11-xagent-phase-6.zh.md)

Phase 6 adds governed, reusable project Business Skills to XAgent Business. FastAPI and PostgreSQL own the project lifecycle, while the Host reuses the generic Skill registry and real Agent loop without granting business users filesystem access or executable plugin deployment. Developer, ordinary Web, Headless, JiaxinAgent, Private Sessions, Code Mode, and unbound Project conversations do not receive the Business Skill governance surface or runtime provider.

## Delivered capability

The backend stores a stable project-local slug, one mutable optimistic draft, immutable published versions, isolated test records, stable-Skill authorization, terminal retirement, idempotent mutation results, and redacted audit events. Specialists and Managers may create, edit, test, inspect transcripts, and record verdicts; only Managers may publish an exactly tested revision, authorize or unauthorize production use, select a historical version, or retire a Skill. PostgreSQL constraints, triggers, row-level policy, the least-privilege application role, and explicit lock order enforce the same relationships beneath the FastAPI checks.

Each draft test uses a durable `business_skill_test` Project Session that is absent from ordinary Session lists and restore paths. The Host atomically mounts the real Agent factory header and startup events before one executor obtains ownership. Test execution uses the normal Skill admission and model loop but exposes only the selected read tools and their required read-only companions; `propose_fact` is reported as an unexecuted production write instead of being simulated. The immutable transcript and terminal outcome remain readable to current project members after settlement or retirement.

## Runtime and model behavior

An authenticated ordinary Project Session discovers only currently published and authorized entries. Explicit `/slug` invocation and model `skill` invocation load the exact immutable version through the shared registry. One turn pins one version and complete tool set, filters inherited and Agent-local schemas, and reauthorizes every imminent tool call through FastAPI. Publication or rollback changes only a later turn; unauthorization, retirement, account or membership revocation, cancellation, and backend unavailability deny the next call without executing its body.

The ignorable `business-skill/activated` event records only the slug, public version, invocation form, turn, and policy digest. Raw instructions remain in the append-only log for exact replay, while a completed turn's model history replaces the admitted body with an instruction-free use marker. Restart repair preserves the original event sequence, test transcript, immutable versions, activation record, and historical marker without reviving old instructions beside a later version.

## Product surface

The project details panel provides a Business Skill tab with a Draft → Test → Publish → Authorize dossier, immutable version history, test transcript access, audit summary, rollback, unauthorization, and confirmed terminal retirement. Controls follow the current project role and are disabled while a conflicting mutation is in flight. Account, project, Session, role, or connection changes invalidate memory-only state and reject stale commands. Visible test states, termination reasons, verdicts, and audit action/results are localized instead of exposing protocol values. The Browser receives the public policy digest needed to match an exact draft, test, and publication; it receives no credential, internal record identity, opaque version key, or test Session identity.

## Acceptance evidence

Real FastAPI/PostgreSQL acceptance runs the complete Specialist test/pass and Manager publish/authorize path, then exercises runtime catalog/load/tool authorization, real retrieval over indexed project evidence, a production Fact proposal that remains pending for independent human approval, a second tested publication, historical pin authorization, rollback, immediate unauthorization denial, hidden test Sessions, durable transcript reads, immutable version replay, and terminal retirement. Concurrent acceptance proves one optimistic draft winner, exact duplicate publication replay, and retirement winning without residual authorization. The focused real-loop suites cover both invocation forms, same-turn pinning, later-turn version changes, retrieval tool execution, durable activation, crash repair, and instruction-free historical projection. The TypeScript and Python SDK fixtures both accept and preserve the activation event.

The checked-in keyless Loader snapshot boots a runnable fixture with the real Agent loop, production Business Skill provider, Retrieval, Fact, and isolated draft TestRunner. A production invocation leaves one `propose_fact` result pending; the draft test attempts the same write, records its denial, settles failed with `tool-denied`, and creates no second proposal. The fixture reads the deployment test provider and model route from the XAgent Business profile but does not boot the entire profile. Local Browser/GIF acceptance uses a strictly verified, offline BGE-M3 cache and one fresh isolated FastAPI/PostgreSQL/MinIO/ClamAV/embedding/Host stack with fresh Specialist and Manager browser contexts. The configured real model completes create, edit, read-only test, human verdict, publication, authorization, production invocation, and a pending Fact proposal in one unspliced run. The ignored evidence is inspected for readable state and secrets; it uses no test transport, synthetic UI state, persisted credential, or real customer data.

## Remaining release work

The implementation, deterministic acceptance, current bilingual documentation, implemented decision record, and local product-visible acceptance are complete. Publication still must push the final reviewed commit, publish the final GIF on the dedicated assets branch, attach it to the pull request, and wait for remote required checks. Those remote mutations are intentionally outside this local Task 11 execution.

## Agent Note result

The governed project Business Skill Agent Note is implemented and remains active because its project governance, isolated test ownership, immutable-version pinning, per-call authorization, cancellation, replay, and private runtime-identity decisions retain future design value. The generic Skill registry/catalog notes and the XAgent profile, authentication, Retrieval, and Fact notes remain separate authorities; none is superseded, redundant, rejected, or ready to archive.
