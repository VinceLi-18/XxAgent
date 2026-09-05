# native/

English | [中文](README.zh.md)

Native source maintained as part of the private XxAgent application. The [`landlock-run/` workspace](landlock-run/README.md) owns the Landlock self-restrict-then-exec launcher consumed by the harness, including its architecture, internal three-package workspace family, platform support, development workflow, and [private artifact validation](landlock-run/docs/release.md).

## Workspace and application boundary

`landlock-run/` and its packages belong to the repository's root pnpm workspace and lockfile. Harness consumers use the current workspace entry package during development and CI, so a launcher contract change and its consumer update can land and be tested together.

The main repository's `Landlock Run` workflow builds and tests each supported architecture, then rehearses the package payload used by the application. The entry package retains platform packages as optional dependencies, so pnpm stages only the package matching the host operating system and CPU. No workflow publishes the family to npm.
