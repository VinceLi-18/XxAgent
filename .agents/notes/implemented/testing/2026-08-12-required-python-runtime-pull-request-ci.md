# Agent Note: Required Python runtime pull-request validation

Status: implemented

English | [中文](2026-08-12-required-python-runtime-pull-request-ci.zh.md)

## Problem

The complete Python SDK pytest suite uses fake runtime peers, while Node snapshots exercise different clients and expected outputs. Without a required native carrier job, the real Python client, packaged JSON-RPC executable, executable-specific snapshot, wheel artifacts, and clean installation would meet only in optional builds. A runtime event or closure change could therefore merge with a stale Python projection or broken wheel path and fail only when an operator later built the application carriers.

## Decision

Every pull request has a required `python-runtime` job in [CI](../../../../.github/workflows/ci.yml). It calls the shared [single-executable builder](../../../../.github/workflows/build-exe-for-python-sdk.yml) for `node24-linux-x64` without a path filter and participates in `all checks passed`. The called workflow builds the real executable, runs all keyless Python full-turn and direct-binary scenarios including both committed snapshots, builds the SDK and runtime wheels, installs them into a clean virtual environment, checks the executable and native addon's GLIBC requirements, and runs the installed wheels in a manylinux 2.28 container.

The required job and the private multi-platform artifact build described by the [application distribution decision](../process/2026-09-06-private-application-distribution.md) use the same builder. Its concurrency key includes the caller workflow, so required CI and an explicit full-platform validation for the same ref do not cancel each other. Platform-independent runtime, SDK, and snapshot behavior needs one merge-blocking native carrier, while architecture-specific executable, addon, wheel-tag, and deployment-target behavior still needs the complete linux-x64, linux-arm64, and macos-arm64 matrix before operators retain an application artifact set.

The advanced executable snapshot normalizes opaque session, message, subagent, and workflow-run identifiers before comparison. A newly persisted workflow event therefore changes the reviewed expected output without making a random run identifier part of that output. The minimal scenario's [model-visible snapshot](2026-08-13-python-minimal-model-visible-snapshot.md) covers the assembled system prompt, tool schemas, and message list that this one tokenizes.

## Alternatives considered

**Run the complete native matrix on every pull request.** This duplicates platform-independent full-turn and snapshot behavior across three jobs and consumes ARM64 Linux and macOS capacity on every change. The private tag pipeline retains that evidence when operators require all three artifacts.

**Run the snapshot against the development Node carrier.** This catches protocol and event projection drift but does not prove pkg assembly, the deployed runtime closure, native addon staging, wheel construction, exact dependency pins, or clean installation. The required Linux executable path covers the application carrier directly.

**Select the job with path filters or labels.** Python behavior depends on shared agent, session, workflow, subagent, plugin-loading, and packaging code outside `python/`. An incomplete dependency filter recreates the delayed failure, and a label leaves the evidence optional.

## Consequences

Every pull request pays for one standard-hosted Linux executable and wheel build, and `all checks passed` waits for it. This makes the first-party Python carrier a merge-time requirement and reuses the application artifact builder instead of maintaining a smaller substitute pipeline.

One required architecture cannot detect macOS or Linux ARM64 packaging regressions. Explicit full-platform validation remains mandatory before retaining a complete private artifact set and owns those platform-specific results.
