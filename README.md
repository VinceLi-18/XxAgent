# XxAgent

English | [中文](README.zh.md)

XxAgent is a privately distributed agent application that integrates its DeepSeek Harness and XAgent business sources in one repository.

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Distribution

An authorized repository revision is the release unit. The JavaScript workspaces, vendored Cordis sources, native launcher, Python runtime, FastAPI services, workers, and deployment configuration are internal application components and are not published to npm or PyPI.

The inherited `@deepseek-ai/*` and XAgent-owned `@xagent/*` package names remain internal module identifiers. Every internal dependency resolves through the current workspace rather than an external DSH package release.

## Run from source

Install the repository's supported Node.js and pnpm versions, then run:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

The complete Business deployment also needs the FastAPI, PostgreSQL, MinIO, ClamAV, worker, and embedding services described in the [API service guide](services/api/README.md).

## Contributing

Authorized contributors should follow [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
