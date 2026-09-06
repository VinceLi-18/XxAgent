# Agent Note: Private application distribution

Status: implemented

English | [中文](2026-09-06-private-application-distribution.zh.md)

## Problem

XxAgent contains the DSH application, XAgent business plugins, vendored Cordis, the native launcher, Python runtime, backend services, and deployment configuration in one private source repository. The inherited package release machinery instead treated those sources as several npm and PyPI products. Its DSH release set required only `@deepseek-ai/*` members even though the merged CLI depends on private `@xagent/*` packages, so neither excluding nor publicly publishing the XAgent packages produced an installable and confidential release.

## Decision

An authorized XxAgent repository revision is the application release unit. Operators build and deploy the CLI, Web application, FastAPI image, worker, embedding service, and migrations from that revision through the repository's source, build, and Compose entry paths.

Every JavaScript workspace manifest is private, declares no `publishConfig`, and identifies XxAgent as its source repository. Internal dependencies use `workspace:` so package names cannot fall back to registry copies. The existing `@deepseek-ai/*` and `@xagent/*` names remain internal module identifiers; changing those identifiers is not required to merge source ownership or application delivery.

The repository contains no npm or PyPI publication workflow, root publication command, or local registry publisher. CI may build native executables and Python wheels as private intermediate artifacts, but no workflow uploads a package to a public registry. Vendored Cordis retains upstream commit and license provenance in `vendor/README.md` while its manifests remain private application components.

Workspace constraints and workflow tests enforce the negative guarantee. Application builds, package invariants, NodeNext consumers, native checks, Python runtime builds, and real Compose acceptance remain the executable evidence for one revision.

## Alternatives considered

**Keep public DSH and install XAgent separately.** Rejected because the product is one private application and the CLI's shipped profiles already compose both source families. Splitting distribution would restore an external release dependency that the merged repository is intended to remove.

**Publish every workspace to a private package registry.** Rejected because no current consumer needs package-by-package installation. It would add registry ownership, credentials, version ordering, partial-publication recovery, and hundreds of independently addressable artifacts without changing the deployed application.

**Rename every inherited package to `@xagent/*` in the same migration.** Rejected because namespace cleanup is independent of distribution and would simultaneously change imports, Cordis configuration names, generated catalogs, plugin compatibility, and native/Python artifact identities. A later rename requires its own collision and compatibility audit.

## Consequences

XxAgent does not produce an npm-installable `@deepseek-ai/dsh` or public Python SDK. Authorized users obtain the repository revision and build its application artifacts; access control belongs to repository and deployment infrastructure rather than package-registry visibility.

The internal package graph remains modular and testable. Retaining inherited package names avoids an unrelated runtime migration, but maintainers must not infer upstream ownership or registry availability from a scope. `private: true`, XxAgent repository metadata, `workspace:` dependency checks, and the absence of publication workflows carry that meaning.

This decision supersedes the former npm family sequencing, public vendor/native access, in-repository Landlock publication, and Python registry-publication decisions. Their implemented records are archived as historical evidence. The artifact-first npm baseline proposal is rejected because a package registry is not the product delivery boundary. The native and Python build decisions remain active where they define application carriers and merge-time validation rather than registry upload.

A future private registry, public SDK, or namespace unification is a new distribution decision. It must define intended package consumers, registry and scope ownership, authentication, version transactions, install verification, provenance, and the application components that remain unpublished.
