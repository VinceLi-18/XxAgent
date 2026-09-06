# Python contributor workflows

English | [中文](development.zh.md)

Follow the workflow for the contributor outcome you need: build runtime artifacts, validate the SDK, run against source, or build private wheel artifacts. Package behavior belongs in the [SDK reference](sdk/README.md) and [runtime carrier reference](sdk-runtime/README.md).

## Build runtime artifacts

Platform executables are build artifacts and are not checked into git. Run the build from the repository root:

```sh
pnpm install
pnpm exec tsx scripts/build-exe-for-python-sdk.ts
```

Use `--skip-build` when the required `lib/` artifacts already exist, or `--targets=node24-linux-x64,node24-linux-arm64,node24-macos-arm64` to select platforms. Products land in `dist-exe/` and the script syncs the selected carriers into `python/sdk-runtime/`. macOS builds also sync the matching spawn helper required by `node-pty`.

## Validate the SDK

Keep the virtual environment outside `python/`, install the test group, and run the Python suite:

```sh
export UV_PROJECT_ENVIRONMENT="$PWD/tmp/py-sdk-venv"
uv sync --project python/sdk --group test
uv run --project python/sdk pytest
```

`python/sdk/tests/test_bundled_runtime.py` exercises available bundled carriers and skips a carrier when its artifact has not been built. For repository-wide test policy, see [Testing](../docs/testing.md).

That suite drives fake runtime peers. `scripts/smoke-python-runtime.py` drives the real packaged runtime instead, and the required `python-runtime` CI job runs every scenario against a freshly built executable:

```sh
uv run --project python/sdk python scripts/smoke-python-runtime.py \
  --scenario sdk-minimal --exe dist-exe/dsh-jsonrpc-agent-pkg-macos-arm64
```

Two scenarios compare committed expected output under `scripts/snapshots/python-sdk-single-exe/`. `minimal/model-visible.json` pins the checked-in minimal composition's assembled system prompts, advertised tool schemas, and model-visible messages, so a plugin that contributes an unintended system section or user message fails the job; it drops the dynamic runtime-context snapshot, which the same composition emits on macOS and not on Linux ([#2488](https://github.com/deepseek-harness/deepseek-harness/issues/2488)). `advanced/` pins the SDK result and the persisted session logs. Rerun the owning scenario with `--update-snapshots` and review that diff before committing it.

An interactive smoke test needs `DEEPSEEK_API_KEY` in the environment or repository-root `.env`:

```python
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness() as harness:
    print(harness.run("say hi").final_response)
```

## Run against Node source

Repository contributors can select either development carrier:

- Set `DSH_RUNTIME_MODE=node` to use the built Node carrier on system Node `>=22.19`. The build script refreshes this carrier, but distributions never include or auto-select it.
- Set `launch_args_override=("./node_modules/.bin/tsx", "packages/examples/jsonrpc-demo/src/bin.ts")` with the repository root as `cwd` to run unbuilt TypeScript source. Supply `cordis=...` when the default configuration is not suitable.

See `python/sdk/tests/manual_sdk_agent_smoke.py` for a complete source-mode invocation.

## Build private wheel artifacts

The root `package.json` version is authoritative for both Python distributions. The staging script injects that version into both wheels and pins the SDK to the same `deepseek-harness-runtime-bin` version.

Build the pure SDK wheel once and one runtime wheel on each native platform:

```sh
version="$(node -p "require('./package.json').version")"
python scripts/build-python-release.py --package sdk --output-dir dist-python
python scripts/build-python-release.py --package runtime --platform macos-arm64 --runtime-exe dist-exe/dsh-jsonrpc-agent-pkg-macos-arm64 --output-dir dist-python
pip install --find-links dist-python deepseek-harness-sdk=="$version"
```

The runtime carrier is wheel-only. A complete private artifact set contains the pure SDK wheel plus Linux x64, Linux arm64, and macOS 14-or-newer arm64 runtime wheels. A `python-v<repository-version>` GitLab tag is accepted only when it matches the repository version; prerelease repository versions such as `0.0.1-rc.1` use their normalized PEP 440 spelling, such as `0.0.1rc1`, inside wheel filenames and metadata.

## Validate the application carriers

The required GitHub `python-runtime` job builds the Linux x64 executable and wheel pair, installs it in a clean environment, and runs the SDK and direct-runtime scenarios on every pull request. The reusable `build-exe-for-python-sdk.yml` workflow can build selected platforms manually. A matching `python-v<repository-version>` GitLab tag builds all four wheels on their native runners and retains them as private CI artifacts for one week.

These workflows have no npm or PyPI upload step and require no registry publishing credential. They verify the Python carriers produced from the same authorized XxAgent revision as the Node application and backend services.

The wheels are application build artifacts, not independently released Python products. Install them only from the current checkout or an artifact set retained by that revision; the repository does not promise registry availability or cross-revision compatibility.
