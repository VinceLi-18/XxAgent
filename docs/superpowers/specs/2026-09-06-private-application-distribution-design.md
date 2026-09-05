# XxAgent Private Application Distribution Design

English | [中文](2026-09-06-private-application-distribution-design.zh.md)

## Context

XxAgent contains the DeepSeek Harness application, its Cordis plugin packages, XAgent business packages, FastAPI services, workers, and deployment configuration in one private source repository. Workspace dependencies resolve the checked-in sources; package scopes remain module identifiers and do not identify an external source dependency.

The inherited release workflows still treat `@deepseek-ai/*`, the vendored framework, the Landlock launcher, and Python wheels as independently publishable public-registry products. The merged CLI also depends on private `@xagent/*` packages, so that public package graph cannot be installed as one coherent release.

## Decision

XxAgent is distributed as a private application from an authorized repository checkout. Operators build the CLI, Web application, FastAPI image, worker, embedding service, and database migrations from one reviewed revision and deploy them through the repository's application and Compose entry paths.

Every JavaScript workspace package is an internal component: its manifest sets `private: true`, declares no `publishConfig`, and uses the XxAgent repository as its source home. Existing `@deepseek-ai/*` and `@xagent/*` names remain stable internal module identifiers in this change; they do not create a registry dependency because every internal reference uses `workspace:`.

The repository exposes no npm or PyPI publication workflow, root publication command, or local registry-publish utility. Native and Python build workflows may continue producing private CI artifacts when another workflow consumes them, but no job can upload those artifacts to a public package registry.

Vendored Cordis remains a pinned third-party source layer with its upstream provenance recorded in `vendor/README.md`. Its workspace manifests are private application components and are never published from XxAgent.

## Distribution invariant

The workspace constraint check rejects any internal manifest without `private: true`, any `publishConfig`, any non-`workspace:` reference to another workspace member, and any source-home metadata that points a repository-owned package outside XxAgent. A workflow test rejects public package-registry actions and the known release workflow filenames.

Application validation remains behavior-based: build, type checking, package invariants, NodeNext consumption, native tests, Python runtime builds, and real Compose acceptance verify the same revision without converting internal packages into registry artifacts.

## Deferred identity migration

Renaming inherited `@deepseek-ai/*` identifiers to one XAgent namespace is independent of distribution and is deferred. That migration must first audit package-name collisions, Cordis configuration names, generated catalogs, external plugin compatibility, and native/Python artifact names.

## Consequences

An authorized checkout and its built application artifacts are the release unit. Consumers cannot install `@deepseek-ai/dsh` from npm or the Python SDK from PyPI from this repository. A later private registry product would require a new decision defining package consumers, registry ownership, authentication, versioning, and an independently verified install closure.
