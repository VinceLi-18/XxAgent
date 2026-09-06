# Agent Note: XAgent private-repository CI activation

Status: implemented

English | [中文](2026-09-06-xagent-private-repository-ci.zh.md)

## Problem

XAgent inherits DeepSeek Harness workflows whose default runner labels and repository automation assume the upstream enterprise environment. The private `VinceLi-18/XxAgent` repository has standard GitHub-hosted capacity but no access to the upstream Linux or Windows larger-runner labels, no real-API secret, and no GitHub App or Project configuration for Issue lifecycle mutation. Pull requests therefore leave required jobs queued indefinitely and report configuration failures unrelated to the change under review.

## Decision

The three required Node 24 Linux jobs default to `ubuntu-latest`, and the independent native Windows job defaults to `windows-latest`. The existing `DSH_CI_FAILOVER_LINUX` and `DSH_CI_FAILOVER_WINDOWS` selectors remain available for an explicitly configured self-hosted pool, but XAgent does not assume that either pool exists. Worker and snapshot concurrency stays within standard GitHub-hosted capacity.

Real-API e2e runs require the repository variable `XAGENT_REAL_API_E2E_ENABLED=true`. Fork and Dependabot pull requests remain excluded, and an enabled run fails during preflight when `DEEPSEEK_API_KEY_EXTERNAL` is absent. The unset variable skips the job instead of turning missing repository setup into a product failure.

Read-only pull request policy targets `VinceLi-18/XxAgent`. Issue lifecycle mutation requires `XAGENT_ISSUE_LIFECYCLE_ENABLED=true` and obtains its repository coordinates from the event. The variable remains unset until this repository has matching GitHub App credentials and Project ownership support; enabling mutation without those prerequisites is a configuration error.

This decision overrides only the default runner assignment and automatic activation assumptions inherited from [larger hosted runners](2026-07-22-evidence-based-larger-hosted-runners.md), the [CI failover runbook](2026-07-26-ci-failover-runbook.md), [native Windows pull-request CI](2026-08-08-native-windows-pull-request-ci.md), [real-API e2e CI](../testing/2026-06-19-real-api-e2e-ci.md), and [event-directed pull-request review status](2026-08-10-event-directed-pr-review-status.md). Those notes remain active because their job decomposition, trust rules, failover design, and lifecycle semantics still govern their mechanisms.

## Alternatives considered

Keep the upstream enterprise runner labels. Rejected because this repository cannot allocate those runners, so required jobs never produce evidence.

Delete the inherited workflows. Rejected because the portable checks remain valid and provide useful review evidence once their repository-owned prerequisites are explicit.

Treat absent secrets or App credentials as successful jobs. Rejected because that produces a false green result. Optional capabilities skip while disabled and fail loudly after their explicit opt-in.

Enable Issue lifecycle mutation before configuring its App and Project. Rejected because it gives the workflow neither the required authority nor a valid Project target.

## Consequences

XAgent pull requests obtain results from runner pools available to the repository, at lower parallelism than the upstream enterprise installation. Real-API provider coverage and automatic Issue lifecycle mutation are intentionally absent until a maintainer provisions their prerequisites and enables the corresponding repository variable. Workflow tests pin the standard runner defaults, bounded concurrency, repository coordinates, and both opt-in conditions.
