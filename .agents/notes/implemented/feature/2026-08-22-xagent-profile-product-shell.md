# Agent Note: XAgent profile product shell over the dsh runtime

Status: implemented

English | [中文](2026-08-22-xagent-profile-product-shell.zh.md)

## Problem

XAgent needs business and developer entry points with distinct local state and a product-facing Web identity without replacing the installed `dsh` command or claiming that local directories provide multi-user authorization.

## Decision

`dsh --profile xagent-business` and `dsh --profile xagent-developer` keep the dsh command, `DSH_*` environment names, package namespace, and internal DSH protocols. Both templates compose `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`; the Business profile adds `@xagent/dsh-business`, while the Developer profile adds `@xagent/dsh-developer`.

Each profile resolves settings, credentials, attachments, and JSON storage below `$DSH_HOME/profiles/<profile>/data`; Developer sessions also remain there. Business disables local JSONL Session persistence and uses FastAPI/PostgreSQL as its sole Session authority under the [XAgent authentication and Session isolation decision](../architecture/2026-08-25-xagent-auth-session-runtime.md). The Business bundle disables Shell, file-system, web, subagent, dynamic-workflow, and file-skill rows. It also disables the agent-preset roster and browser entry, so Business sessions are rosterless: they mount neither shipped nor user-authored presets and expose no preset tool or file-skill catalog. The host model and agent loop still assemble a basic conversation. Its Web API proxy keeps unrelated endpoints available and returns the explicit `subagent service is unavailable in this deployment` error for subagent requests because the profile does not mount that service. The Developer bundle changes only those local-state paths and adds no business API, production credentials, or production session storage.

The XAgent Web shell supplies the XAgent name, icon, theme, and welcome text. One Web service process starts one profile; the browser does not switch profiles. Profile directories organize local runtime state only. They are not an authentication, authorization, tenant, or project-data security boundary.

## Alternatives considered

**Rename the command and every internal DSH identifier.** Rejected because the Phase 1 product shell needs a stable entry point while a global protocol and package rename would widen the change beyond the Profile behavior.

**Use one shared `$DSH_HOME` data directory for both XAgent profiles.** Rejected because settings, credentials, attachments, JSON storage, and Developer sessions would overlap despite different Profile responsibilities.

**Treat profile directories as multi-user isolation.** Rejected because path selection has no principal, authentication, session authorization, or row-level data policy; those controls belong to the later multi-user product layer.

**Keep subagent API calls silent in the Business profile.** Rejected because a disabled service must report its absence deterministically instead of suggesting a successful operation.

**Keep the standard preset while disabling its host services.** Rejected because a preset is a session composition that can reintroduce model-facing tools and local file skills; a user-authored preset is an equivalent composition path. Business therefore exposes no preset roster.

## Consequences

Business users receive a constrained rosterless Web composition and Developer users receive an isolated local development composition without changing dsh tooling. Business gives up per-session preset selection and locally authored presets. The remaining costs are independently persisted Profile-local settings and supporting state, a remote Session-service dependency for Business, and a visible unavailable error for Business subagent API calls. Rosterless composition remains a capability closure; Business multi-user security comes from principal-aware authentication, authorization, Session checks, protected storage, and PostgreSQL RLS.

`packages/boot/app-boot/tests/profile.spec.ts` verifies the XAgent templates and Profile data paths; `apps/cli/tests/profile-boot.spec.ts` verifies distinct launch-time paths; and both XAgent bundle tests verify the state-row expressions and the Business capability closure. `apps/cli/tests/xagent-business-rosterless.e2e.ts` creates a Business session through the real API proxy and verifies an empty preset roster, tool catalog, and file-skill catalog. The built CLI configuration checks load both Profile compositions.
