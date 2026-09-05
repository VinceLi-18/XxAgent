# Private artifact validation

The Landlock launcher is an internal component of the private XxAgent application. Its entry and platform package names organize the workspace and installed application payload; this repository does not publish them to npm.

## Versioning

The launcher workspace root and its three internal packages share one version. Update their manifest versions together with the root lockfile when a launcher protocol or binary change needs a new application carrier identity. Keep `workspace:*` dependencies in source so local builds cannot resolve a registry copy.

## Preflight

```sh
pnpm install --frozen-lockfile
pnpm --dir native/landlock-run build:ts
pnpm --dir native/landlock-run typecheck
pnpm --dir native/landlock-run test:entry
```

On a Linux host, also build and test the current architecture:

```sh
pnpm --dir native/landlock-run build:native
pnpm --dir native/landlock-run test:launcher
```

## Packed application rehearsal

The application uses the package payload to stage the launcher and its matching native binary. Rehearse that payload without publishing it:

```sh
node native/landlock-run/scripts/pack-release.mjs native/landlock-run/.release/npm --current-platform-only
node native/landlock-run/scripts/verify-packed-install.mjs native/landlock-run/.release/npm --current-platform-only
```

The pack helper uses `npm pack` for platform packages because `pnpm pack` strips the launcher's executable bit, and uses `pnpm pack` for the entry package so `workspace:` dependencies become exact local artifact versions. The verifier installs those tarballs into a temporary consumer and proves that the installed launcher is executable, byte-identical to the native build, and the expected architecture. Tarballs are disposable verification inputs and must not be uploaded to a package registry.

The repository's `Landlock Run` workflow repeats the build and packed-install rehearsal on each supported native runner. An authorized XxAgent repository revision, not a launcher package version or registry entry, is the deployable release unit.
