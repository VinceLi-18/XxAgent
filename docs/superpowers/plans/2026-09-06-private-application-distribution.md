# XxAgent Private Application Distribution Implementation Plan

English | [中文](2026-09-06-private-application-distribution.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove public package publication from XxAgent and make every JavaScript workspace an internal component of one privately distributed application.

**Architecture:** An authorized repository revision is the release unit. Workspace packages remain modular and retain their current names, but constraints require private manifests, workspace-local dependency resolution, and XxAgent source ownership; CI validates application builds without publishing package registries.

**Tech Stack:** pnpm workspaces, TypeScript, Vitest, GitHub Actions, Docker Compose, Python/Hatch.

**Spec:** [Private application distribution design](../specs/2026-09-06-private-application-distribution-design.md)

## Global Constraints

- Preserve Cordis plugin and package boundaries; do not flatten runtime modules.
- Keep `@deepseek-ai/*` and `@xagent/*` names in this migration.
- Never edit archived Agent Note bodies or untracked credentials.
- Public npm and PyPI publication paths must be absent after the migration.
- Application build, native CI, Python build, and Compose acceptance remain available.

---

### Task 1: Encode the private-distribution policy

**Files:**
- Modify: `scripts/check-workspace-constraints.spec.ts`
- Modify: `scripts/ci-workflow.spec.ts`

**Interfaces:**
- Consumes: tracked workspace manifests, root scripts, and `.github/workflows`.
- Produces: behavior assertions rejecting publishable internal packages and public registry workflows.

- [ ] **Step 1: Write a workspace test that enumerates every tracked internal manifest and requires `private: true`, no `publishConfig`, XxAgent source ownership, and workspace-local internal dependencies.**
- [ ] **Step 2: Write a workflow test that rejects the four inherited publication workflows, public registry actions, and root publication commands.**
- [ ] **Step 3: Run `CI=true ./node_modules/.bin/vitest run scripts/check-workspace-constraints.spec.ts scripts/ci-workflow.spec.ts` and verify both assertions fail on the inherited publication state.**

### Task 2: Remove package publication and privatize manifests

**Files:**
- Modify: `scripts/check-workspace-constraints.ts`
- Modify: `package.json`
- Modify: `apps/*/package.json`
- Modify: `packages/*/*/package.json`
- Modify: `native/landlock-run/**/package.json`
- Modify through the vendoring transform: `scripts/rescope-vendor.ts`, `vendor/*/package.json`, `vendor/README.md`
- Delete: `.github/workflows/release.yml`
- Delete: `.github/workflows/release-vendor.yml`
- Delete: `.github/workflows/landlock-run-release.yml`
- Delete: `.github/workflows/python-release.yml`
- Delete: `scripts/release/*`
- Delete: `scripts/publish-npm-baseline.ts` and its owning tests

**Interfaces:**
- Consumes: Task 1 policy assertions.
- Produces: a repository with no package-registry publication entry point and private workspace manifests.

- [ ] **Step 1: Replace release-family branches in `checkWorkspace()` with one internal-manifest rule and keep the package payload/build invariants that still protect application artifacts.**
- [ ] **Step 2: Mechanically set `private: true`, remove `publishConfig`, and set repository-owned package source metadata to XxAgent without changing package names or dependency ranges.**
- [ ] **Step 3: Remove root publication scripts, obsolete release implementations, and public publication workflows while retaining CI and reusable application/native/Python build workflows.**
- [ ] **Step 4: Run the focused Vitest command and `pnpm run constraints`; verify GREEN.**

### Task 3: Replace superseded release documentation

**Files:**
- Modify: `README.md`, `README.zh.md`
- Create: `.agents/notes/implemented/process/2026-09-06-private-application-distribution.md`
- Create: `.agents/notes/implemented/process/2026-09-06-private-application-distribution.zh.md`
- Archive or reject: active npm, PyPI, and native publication Agent Notes after repairing inbound links
- Modify generated or owner documentation only through its owning generator

**Interfaces:**
- Consumes: the shipped private-distribution policy from Task 2.
- Produces: current-state private application instructions and one active decision owner.

- [ ] **Step 1: Replace npm installation and public-community instructions with authorized-checkout build and Compose deployment guidance.**
- [ ] **Step 2: Record the implemented private application decision, alternatives, consequences, retained internal package names, and deferred namespace migration in both languages.**
- [ ] **Step 3: Audit overlapping active publication notes; archive implemented decisions with no future authority, reject the obsolete baseline proposal when it remains a useful guardrail, and update partial owners that still govern native build or vendored provenance.**
- [ ] **Step 4: Re-record every changed bilingual pair and run the Agent Note archive verifier when any note is archived.**

### Task 4: Verify and publish the correction

**Files:**
- Modify only derivative catalogs or lockfile content produced by owning generators.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: verified commit and updated draft pull request.

- [ ] **Step 1: Run the focused workflow/constraint tests and `pnpm install --lockfile-only --offline`.**
- [ ] **Step 2: Run `pnpm run typecheck`, `pnpm run build`, `pnpm run hygiene`, `pnpm run lint`, and `pnpm run doc-sync` because the policy spans every package manifest, build artifact, and documentation owner.**
- [ ] **Step 3: Run `git diff --check`, inspect the exact changed scope, and confirm no workflow or root command can publish to npm or PyPI.**
- [ ] **Step 4: Commit, push normally, update the draft PR description, and inspect the new CI checks; report external repository-policy failures separately.**
