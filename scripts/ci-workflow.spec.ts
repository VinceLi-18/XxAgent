import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const runnerPrivatePnpmDestination = '${{ runner.temp }}/setup-pnpm'

describe('CI workflow', () => {
  it('isolates every pnpm action setup destination per runner', () => {
    const workflow: unknown = yaml.load(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'))
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError('CI workflow must define jobs')

    const setups = Object.entries(workflow.jobs).flatMap(([jobName, job]) => {
      if (!isRecord(job) || !Array.isArray(job.steps)) return []
      return job.steps.flatMap((step) => {
        if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) return []
        return [{ jobName, step }]
      })
    })

    expect(setups.length).toBeGreaterThan(0)
    for (const { jobName, step } of setups) {
      expect(step, `${jobName} must not share pnpm/action-setup's default destination`).toMatchObject({
        with: { dest: runnerPrivatePnpmDestination },
      })
    }
  })

  it('keeps required Windows coverage on runners available to the private repository', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs)
      || !isRecord(workflow.jobs.windows)
      || !isRecord(workflow.jobs['windows-native'])
      || !isRecord(workflow.jobs['wine-apt-cache'])
      || !isRecord(workflow.jobs['serial-windows'])
      || !isRecord(workflow.jobs['node-24'])
      || !isRecord(workflow.jobs['node-24-coverage'])
      || !isRecord(workflow.jobs['node-24-consumers'])
      || !isRecord(workflow.jobs['all-checks-passed'])) {
      throw new TypeError('CI workflow must define windows, windows-native, wine-apt-cache, serial-windows, node-24, node-24-coverage, node-24-consumers, and all-checks-passed jobs')
    }

    const windows = workflow.jobs.windows
    const windowsNative = workflow.jobs['windows-native']
    const wineAptCache = workflow.jobs['wine-apt-cache']
    const serialWindows = workflow.jobs['serial-windows']
    const node24 = workflow.jobs['node-24']
    const node24Coverage = workflow.jobs['node-24-coverage']
    const node24Consumers = workflow.jobs['node-24-consumers']
    const aggregate = workflow.jobs['all-checks-passed']
    if (!Array.isArray(windows.steps) || !Array.isArray(aggregate.needs)) {
      throw new TypeError('Windows job must define steps and the aggregate must define needs')
    }
    const commandSteps = windows.steps.filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))

    // Required PR job: Wine on ubuntu-latest, runs wine-windows-gates.sh.
    expect(windows['runs-on']).toBe('ubuntu-latest')
    expect(windows.name).toBe('windows node 24 / wine blocking')
    expect(windows.if).toBe("github.event_name == 'pull_request'")
    expect(commandSteps.some(step => step.run.includes('wine-windows-gates.sh'))).toBe(true)

    // windows-native stays non-blocking but must have a usable default pool.
    expect(typeof windowsNative['runs-on']).toBe('string')
    expect(windowsNative['runs-on']).toContain('DSH_CI_FAILOVER_WINDOWS')
    expect(windowsNative['runs-on']).not.toContain('DSH_CI_FAILOVER_LINUX')
    expect(windowsNative['runs-on']).toContain('self-hosted')
    expect(windowsNative['runs-on']).toContain('dsh-win-ci')
    expect(windowsNative['runs-on']).toContain('windows-latest')
    expect(windowsNative.name).toBe('windows node 24 / native complete')
    expect(windowsNative.if).toBe("github.event_name == 'pull_request'")
    expect(windowsNative.env).toMatchObject({
      DSH_COVERAGE_TEST_TIMEOUT_MS: '30000',
    })
    const nativeCommandSteps = (windowsNative.steps as unknown[]).filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))
    expect(nativeCommandSteps.map(step => step.run)).toContain('pnpm run check:ci:windows-complete')

    // wine-apt-cache: master-only, seeds the Wine apt cache.
    expect(wineAptCache.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    expect(wineAptCache['runs-on']).toBe('ubuntu-latest')

    // serial-windows: master-only standby, self-hosted, non-blocking.
    expect(serialWindows.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    expect(serialWindows['runs-on']).toEqual(['self-hosted', 'dsh-win-ci', 'windows'])
    expect(serialWindows.name).toBe('serial / windows (self-hosted standby)')

    // Aggregate: Wine `windows` required, native `windows-native` excluded.
    expect(aggregate.needs).toContain('windows')
    expect(aggregate.needs).not.toContain('windows-native')
    expect(aggregate.needs).not.toContain('serial-windows')

    // Linux failover remains available, while the default uses standard
    // GitHub-hosted capacity that belongs to this repository.
    for (const [jobName, job] of [['node-24', node24], ['node-24-coverage', node24Coverage], ['node-24-consumers', node24Consumers]] as const) {
      expect(typeof job['runs-on']).toBe('string')
      expect(job['runs-on'], `${jobName} runs-on must use the Linux failover switch`).toContain('DSH_CI_FAILOVER_LINUX')
      expect(job['runs-on'], `${jobName} runs-on must not use the Windows failover switch`).not.toContain('DSH_CI_FAILOVER_WINDOWS')
      expect(job['runs-on']).toContain('vm-backup')
      expect(job['runs-on']).toContain('ubuntu-latest')
    }
    if (!isRecord(node24.env) || !isRecord(node24Coverage.env) || !isRecord(node24Consumers.env)) {
      throw new TypeError('required Linux jobs must define environment limits')
    }
    expect(node24.env.DSH_GATE_CONCURRENCY).toContain("'8' || '2'")
    expect(node24Coverage.env.DSH_COVERAGE_MAX_WORKERS).toContain("'8' || '2'")
    expect(node24Coverage.env.DSH_GATE_CONCURRENCY).toContain("'3' || '2'")
    expect(node24Consumers.env.DSH_GATE_CONCURRENCY).toContain("'8' || '2'")
    expect(node24Consumers.env.DSH_OXLINT_THREADS).toContain("'8' || '2'")
    expect(node24Consumers.env.DSH_PUBLINT_CONCURRENCY).toContain("'8' || '2'")
    expect(node24Consumers.env.DSH_SNAPSHOT_MAX_CONCURRENCY).toContain("'12' || '4'")
    expect(aggregate['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(aggregate['runs-on']).not.toContain('DSH_CI_FAILOVER_WINDOWS')
    expect(aggregate['runs-on']).toContain('vm-backup')
  })

  it('prepares Python API tooling before browser-backed consumer gates', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs['node-24-consumers'])) {
      throw new TypeError('CI workflow must define the node-24-consumers job')
    }
    const job = workflow.jobs['node-24-consumers']
    if (!Array.isArray(job.steps)) throw new TypeError('node-24-consumers must define steps')

    const pythonIndex = job.steps.findIndex(step => (
      isRecord(step)
      && step.uses === 'actions/setup-python@v6.3.0'
      && isRecord(step.with)
      && step.with['python-version'] === '3.11'
    ))
    const uvIndex = job.steps.findIndex(step => (
      isRecord(step)
      && step.name === 'Install uv'
      && step.run === 'python -m pip install uv==0.11.23'
    ))
    const consumersIndex = job.steps.findIndex(step => (
      isRecord(step) && step.name === 'Run compatibility, snapshot, and artifact gates'
    ))

    expect(pythonIndex).toBeGreaterThanOrEqual(0)
    expect(uvIndex).toBeGreaterThan(pythonIndex)
    expect(consumersIndex).toBeGreaterThan(uvIndex)
  })

  it('exempts push from cancellation, so one master merge does not cancel the running drill', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs) || !isRecord(workflow.concurrency)) {
      throw new TypeError('CI workflow must define jobs and a workflow-level concurrency block')
    }

    // Cancellation applies to the whole superseded RUN, so this has to be
    // decided at workflow level and gated on the event: a job-level group
    // cannot exempt its job from its run being cancelled. Only push is exempt —
    // a drill takes longer than the interval between master merges. The negated
    // form is load-bearing: `== 'pull_request'` would also stop cancelling
    // workflow_dispatch, and a re-dispatched runner benchmark holds up to 12
    // larger runners for 15 minutes in this same group on master. The
    // expression is evaluated against the NEWLY TRIGGERED run, so a dispatch on
    // master still cancels a mid-flight drill; the runbook records that bound.
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name != 'push' }}")

    // Neither drill may carry a job-level group: it would not exempt the job
    // from run-scoped cancellation.
    for (const name of ['serial-linux-selfhosted', 'serial-windows']) {
      const job = workflow.jobs[name]
      if (!isRecord(job)) throw new TypeError(`${name} must be defined`)
      expect(job.concurrency).toBeUndefined()
      // Both stay master-push-only; that is what makes the push carve-out safe.
      expect(job.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    }

    // What bounds the cost of exempting push: a master push may only carry the
    // cache seeder and the two drills. Any job reachable on push would start
    // accumulating uncancelled runs, so the set is pinned here.
    //
    // Classification is an exact allowlist of the conditions in use, not a
    // substring match: `github.event_name != 'pull_request'` mentions
    // `pull_request` yet IS push-reachable, so matching on the event name alone
    // would silently misclassify it as gated.
    const NOT_PUSH_REACHABLE = new Set([
      "github.event_name == 'pull_request'",
      "always() && github.event_name == 'pull_request'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'larger-runner-benchmark'",
      "github.event_name == 'workflow_dispatch' && inputs.suite == 'consolidated-runner-benchmark'",
    ])
    const pushReachable = Object.entries(workflow.jobs)
      .filter(([, job]) => {
        if (!isRecord(job)) return false
        if (job.if === undefined) return true // unconditional: runs on every event
        if (job.if === false) return false // `if: false` parses as a boolean
        if (typeof job.if !== 'string') return true // unrecognized shape: surface it
        return !NOT_PUSH_REACHABLE.has(job.if.trim())
      })
      .map(([name]) => name)
      .sort()
    expect(pushReachable).toEqual(['serial-linux-selfhosted', 'serial-windows', 'wine-apt-cache'])

    // Why workflow_dispatch must keep cancelling: each benchmark fans out to a
    // dozen larger runners at once, in this same group on master. If it stopped
    // cancelling, a re-dispatch would queue ahead of a drill instead of
    // replacing the stale measurement.
    for (const name of ['larger-runner-benchmark', 'consolidated-runner-benchmark']) {
      const job = workflow.jobs[name]
      if (!isRecord(job) || !isRecord(job.strategy)) {
        throw new TypeError(`${name} must define a matrix strategy`)
      }
      expect(job.strategy['max-parallel']).toBe(12)
      expect(job['timeout-minutes']).toBe(15)
    }
  })

  it('keeps supported LSP source under native Windows coverage', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain('packages/lsp/lsp-stdio/src/connection.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/index.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/instance.ts')
  })

  it('requires one release-shaped Python runtime target on every pull request', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const pythonRuntime = workflowJob(workflow, 'python-runtime')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(aggregate.needs)) {
      throw new TypeError('CI aggregate must define required job dependencies')
    }

    expect(pythonRuntime).toMatchObject({
      if: "github.event_name == 'pull_request'",
      name: 'python runtime / release-shaped Linux x64',
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64',
        ci: true,
      },
    })
    expect(aggregate.needs).toContain('python-runtime')
  })

  it('requires the complete XAgent API suite on every pull request', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const xagentApi = workflowJob(workflow, 'xagent-api')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(xagentApi.steps)
      || !Array.isArray(aggregate.needs)
      || !isRecord(xagentApi.services)
      || !isRecord(xagentApi.services.postgres)
      || typeof xagentApi.services.postgres.options !== 'string') {
      throw new TypeError('XAgent API job must define steps, PostgreSQL options, and aggregate needs')
    }

    expect(xagentApi).toMatchObject({
      if: "github.event_name == 'pull_request'",
      name: 'python 3.11 / xagent api',
      env: {
        JX_TEST_DATABASE_URL: 'postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:5432/xagent_api_test',
        JX_ALLOW_SCHEMA_DROP: 'yes',
      },
      services: {
        postgres: {
          image: 'postgres:16-alpine',
          env: {
            POSTGRES_DB: 'xagent_api_test',
            POSTGRES_USER: 'postgres',
            POSTGRES_PASSWORD: 'xagent-api-test',
          },
          ports: ['5432:5432'],
        },
      },
    })
    expect(xagentApi.services.postgres.options).toContain('pg_isready -U postgres -d xagent_api_test')
    const commands = xagentApi.steps
      .filter((step): step is Record<string, unknown> & { run: string } => isRecord(step) && typeof step.run === 'string')
      .map(step => step.run)
    expect(commands).toEqual(expect.arrayContaining([
      'python -m pip install uv==0.11.23',
      'uv sync --python 3.11 --project services/api --extra dev --frozen',
      'uv run --python 3.11 --directory services/api --extra dev pytest',
      'uv build --python 3.11 --project services/api',
    ]))
    expect(aggregate.needs).toContain('xagent-api')
  })

  it('deploys the artifact worker with isolated credentials and healthy dependencies', () => {
    const compose = loadWorkflow('services/api/compose.yml')
    const environmentExample = readFileSync(resolve(root, 'services/api/.env.example'), 'utf8')
    const { api, worker, postgres, roles, migrate, minio, clamav } = artifactComposeServices(compose)
    if (!isRecord(api.environment)
      || !isRecord(worker.environment)
      || !isRecord(postgres.environment)
      || !isRecord(postgres.healthcheck)
      || !isRecord(roles.environment)
      || !isRecord(roles.depends_on)
      || !isRecord(migrate.environment)
      || !isRecord(migrate.depends_on)
      || !isRecord(worker.depends_on)
      || !isRecord(minio.healthcheck)) {
      throw new TypeError('Artifact deployment services must define environments, dependencies, and health checks')
    }

    expect(composeServiceNames(compose)).not.toContain('redis')
    expect(environmentExample).toContain(
      'DATABASE_URL=postgresql+asyncpg://${POSTGRES_APP_USER}@postgres:5432/${POSTGRES_DB}',
    )
    expect(environmentExample).toContain(
      'DATABASE_ADMIN_URL=postgresql+asyncpg://${POSTGRES_USER}@postgres:5432/${POSTGRES_DB}',
    )
    expect(environmentExample).toContain(
      'DATABASE_WORKER_URL=postgresql+asyncpg://${POSTGRES_WORKER_USER}@postgres:5432/${POSTGRES_DB}',
    )
    expect(environmentExample).not.toMatch(/DATABASE_\w+_URL=.*\$\{POSTGRES_\w*PASSWORD\}/)
    expect(api.environment).toMatchObject({
      DATABASE_URL: '${DATABASE_URL}',
      DATABASE_ADMIN_URL: '${DATABASE_ADMIN_URL}',
      POSTGRES_APP_PASSWORD: '${POSTGRES_APP_PASSWORD}',
      POSTGRES_PASSWORD: '${POSTGRES_PASSWORD}',
    })
    expect(worker.command).toEqual(['xagent-api', 'worker'])
    expect(worker.environment).toMatchObject({
      DATABASE_WORKER_URL: '${DATABASE_WORKER_URL}',
      POSTGRES_WORKER_PASSWORD: '${POSTGRES_WORKER_PASSWORD}',
      MINIO_ENDPOINT: '${MINIO_ENDPOINT}',
      MINIO_ACCESS_KEY: '${MINIO_ACCESS_KEY}',
      MINIO_SECRET_KEY: '${MINIO_SECRET_KEY}',
      MINIO_SECURE: '${MINIO_SECURE}',
      MINIO_BUCKET: '${MINIO_BUCKET:-xagent-private}',
      CLAMAV_HOST: '${CLAMAV_HOST:-clamav}',
      CLAMAV_PORT: '${CLAMAV_PORT:-3310}',
      CLAMAV_TIMEOUT: '${CLAMAV_TIMEOUT}',
    })
    for (const forbidden of [
      'DATABASE_URL',
      'DATABASE_ADMIN_URL',
      'POSTGRES_APP_USER',
      'POSTGRES_APP_PASSWORD',
      'POSTGRES_PASSWORD',
      'POSTGRES_WORKER_USER',
      'JWT_SECRET_KEY',
      'XAGENT_SERVICE_TOKEN',
    ]) {
      expect(worker.environment).not.toHaveProperty(forbidden)
    }
    for (const forbidden of ['DATABASE_WORKER_URL', 'POSTGRES_WORKER_USER', 'POSTGRES_WORKER_PASSWORD']) {
      expect(api.environment).not.toHaveProperty(forbidden)
    }
    expect(roles.command).toEqual(['xagent-api', 'roles', 'ensure'])
    expect(roles.environment).toMatchObject({
      DATABASE_ADMIN_URL: '${DATABASE_ADMIN_URL}',
      POSTGRES_PASSWORD: '${POSTGRES_PASSWORD}',
      POSTGRES_APP_USER: '${POSTGRES_APP_USER}',
      POSTGRES_APP_PASSWORD: '${POSTGRES_APP_PASSWORD}',
      POSTGRES_WORKER_USER: '${POSTGRES_WORKER_USER}',
      POSTGRES_WORKER_PASSWORD: '${POSTGRES_WORKER_PASSWORD}',
    })
    expectArtifactLifecycleOrder({ roles, migrate, worker })
    expect(postgres.healthcheck.test).toEqual([
      'CMD-SHELL',
      'pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}',
    ])
    expect(migrate.environment).toMatchObject({
      POSTGRES_PASSWORD: '${POSTGRES_PASSWORD}',
      POSTGRES_WORKER_USER: '${POSTGRES_WORKER_USER}',
    })
    expect(migrate.environment).not.toHaveProperty('POSTGRES_APP_PASSWORD')
    expect(migrate.environment).not.toHaveProperty('POSTGRES_WORKER_PASSWORD')
    expect(durationSeconds(worker.stop_grace_period)).toBeGreaterThanOrEqual(90)
    expect(minio.healthcheck.test).toEqual(['CMD', 'mc', 'ready', 'local'])
    expect(clamav.image).toMatch(/^clamav\/clamav-debian:1\.4(?:$|\.)/)
    expect(clamav).not.toHaveProperty('platform')
  })

  it('assembles an isolated real artifact pipeline for Docker tests', () => {
    const compose = loadWorkflow('services/api/compose.test.yml')
    const packageJson = loadWorkflow('package.json')
    const { api, worker, postgres, roles, migrate, minio, clamav } = artifactComposeServices(compose)
    if (!isRecord(packageJson.scripts)
      || !isRecord(api.environment)
      || !isRecord(worker.environment)
      || !isRecord(postgres.healthcheck)
      || !isRecord(roles.environment)
      || !isRecord(roles.depends_on)
      || !isRecord(worker.depends_on)
      || !isRecord(api.depends_on)
      || !isRecord(migrate.depends_on)
      || !isRecord(minio.healthcheck)) {
      throw new TypeError('Artifact test deployment must define API and worker wiring')
    }

    expect(packageJson.scripts['api:test:db:up']).toBe(
      'docker compose -f services/api/compose.test.yml up -d postgres --wait',
    )
    expect(composeServiceNames(compose).sort()).toEqual([
      'api',
      'clamav',
      'migrate',
      'minio',
      'postgres',
      'roles',
      'worker',
    ])
    expect(api.environment).not.toHaveProperty('DATABASE_WORKER_URL')
    expect(api.environment).not.toHaveProperty('POSTGRES_WORKER_PASSWORD')
    expect(api.environment).toMatchObject({
      DATABASE_URL: 'postgresql+asyncpg://xagent_e2e_app@postgres:5432/xagent_api_test',
      DATABASE_ADMIN_URL: 'postgresql+asyncpg://postgres@postgres:5432/xagent_api_test',
      POSTGRES_APP_PASSWORD: 'p@ss:word/%-e2e-app',
      POSTGRES_PASSWORD: 'xagent-api-test',
    })
    expect(worker.command).toEqual(['xagent-api', 'worker'])
    expect(worker.environment).toMatchObject({
      DATABASE_WORKER_URL: 'postgresql+asyncpg://xagent_e2e_worker@postgres:5432/xagent_api_test',
      POSTGRES_WORKER_PASSWORD: 'p@ss:word/%-e2e-worker',
      MINIO_BUCKET: 'xagent-private',
    })
    expect(roles.command).toEqual(['xagent-api', 'roles', 'ensure'])
    expect(roles.environment).toMatchObject({
      DATABASE_ADMIN_URL: 'postgresql+asyncpg://postgres@postgres:5432/xagent_api_test',
      POSTGRES_PASSWORD: 'xagent-api-test',
      POSTGRES_APP_USER: 'xagent_e2e_app',
      POSTGRES_APP_PASSWORD: 'p@ss:word/%-e2e-app',
      POSTGRES_WORKER_USER: 'xagent_e2e_worker',
      POSTGRES_WORKER_PASSWORD: 'p@ss:word/%-e2e-worker',
    })
    expectArtifactLifecycleOrder({ roles, migrate, worker })
    expect(postgres.healthcheck.test).toEqual([
      'CMD-SHELL',
      'pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}',
    ])
    expect(migrate.environment).toHaveProperty('POSTGRES_WORKER_USER')
    expect(migrate.environment).toMatchObject({
      DATABASE_ADMIN_URL: 'postgresql+asyncpg://postgres@postgres:5432/xagent_api_test',
      POSTGRES_PASSWORD: 'xagent-api-test',
    })
    expect(migrate.environment).not.toHaveProperty('POSTGRES_APP_PASSWORD')
    expect(migrate.environment).not.toHaveProperty('POSTGRES_WORKER_PASSWORD')
    expect(api.depends_on).toMatchObject({
      migrate: { condition: 'service_completed_successfully' },
      minio: { condition: 'service_healthy' },
    })
    expect(minio.healthcheck.test).toEqual(['CMD', 'mc', 'ready', 'local'])
    expect(clamav.image).toMatch(/^clamav\/clamav-debian:1\.4(?:$|\.)/)
    expect(clamav).not.toHaveProperty('platform')
  })

  it('runs the real artifact pipeline on pull requests with failure diagnostics and cleanup', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const artifactE2e = workflowJob(workflow, 'xagent-artifact-e2e')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(artifactE2e.steps) || !Array.isArray(aggregate.needs)) {
      throw new TypeError('Artifact E2E and aggregate jobs must define steps and dependencies')
    }

    expect(artifactE2e).toMatchObject({
      if: "github.event_name == 'pull_request'",
      name: 'python 3.11 / xagent artifact docker e2e',
      'timeout-minutes': 20,
    })
    const e2eStep = (artifactE2e.steps as unknown[]).find(
      step => isRecord(step) && step.name === 'Run real artifact pipeline',
    )
    if (!isRecord(e2eStep) || typeof e2eStep.run !== 'string') {
      throw new TypeError('Artifact E2E job must run the real pipeline')
    }
    expect(e2eStep.run).toContain('trap cleanup EXIT')
    expect(e2eStep.run).toContain('docker compose -f services/api/compose.test.yml up -d --build --wait')
    expect(e2eStep.run).toContain('tests/e2e/test_artifact_pipeline.py')
    expect(e2eStep.run).toContain('tests/e2e/test_compose_upgrade.py')
    expect(e2eStep.run).toContain('docker compose -f services/api/compose.test.yml logs')
    expect(e2eStep.run).toContain('docker compose -f services/api/compose.test.yml down --volumes --remove-orphans')
    expect(aggregate.needs).toContain('xagent-artifact-e2e')
  })

  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })
})

describe('E2B e2e workflow', () => {
  it('is manual-only and fails loud before running the focused live suite', () => {
    const workflow = loadWorkflow('.github/workflows/e2b-e2e.yml')
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs.e2b) || !Array.isArray(workflow.jobs.e2b.steps)) {
      throw new TypeError('E2B e2e workflow must define the e2b job steps')
    }

    const steps = workflow.jobs.e2b.steps.filter(isRecord)
    const preflight = steps.find(step => step.name === 'Preflight (require E2B API key)')
    const e2b = steps.find(step => step.name === 'E2B tests (live sandbox)')

    expect(preflight).toMatchObject({
      env: { E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}' },
    })
    expect(preflight?.run).toContain('E2B_API_KEY_EXTERNAL repository secret')
    expect(e2b).toMatchObject({
      env: {
        E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}',
        DSH_E2E_MAX_WORKERS: '1',
        DSH_EXAMPLE_MODE: 'lib',
      },
    })
    expect(e2b?.run).toContain('packages/e2b/e2b/tests/composition.e2e.ts')
  })
})

describe('Python release workflows', () => {
  it('exposes the native wheel builder to the release caller with normalized versions', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const call = workflowEvent(workflow, 'workflow_call')
    const plan = workflowJob(workflow, 'plan')
    const build = workflowJob(workflow, 'build')
    if (!isRecord(call.inputs) || !Array.isArray(plan.steps) || !Array.isArray(build.steps)) {
      throw new TypeError('Python wheel builder must define workflow_call inputs and plan steps')
    }

    const buildSteps: unknown[] = build.steps
    const manylinuxAddon = buildSteps.find(step => isRecord(step) && step.name === 'Rebuild Linux node-pty against manylinux 2.28')
    const macosCheck = buildSteps.find(step => isRecord(step) && step.name === 'Check macOS deployment target')
    const manylinuxSmoke = buildSteps.find(step => isRecord(step) && step.name === 'Run wheel in a manylinux 2.28 container')
    expect(call.inputs).toHaveProperty('targets')
    expect(call.inputs).toMatchObject({
      ci: { type: 'boolean', default: false },
      release: { type: 'boolean', default: false },
    })
    expect(workflow.concurrency).toMatchObject({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
    })
    expect(plan.if).toContain('inputs.ci')
    expect(plan.if).toContain('inputs.release')
    expect(JSON.stringify(plan.steps)).toContain('pep440_version')
    expect(JSON.stringify(workflow)).toContain('macosx_14_0_arm64')
    expect(manylinuxAddon).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_x86_64')
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_aarch64')
    expect(JSON.stringify(manylinuxAddon)).toContain('npm_config_build_from_source=true pnpm run install')
    expect(JSON.stringify(manylinuxAddon)).toContain('$HOME/setup-pnpm:$HOME/setup-pnpm:ro')
    expect(JSON.stringify(manylinuxAddon)).toContain('node-pty-glibc-versions.txt')
    expect(JSON.stringify(manylinuxAddon)).toContain('le 2.28')
    expect(macosCheck).toMatchObject({ if: "runner.os == 'macOS'" })
    expect(JSON.stringify(macosCheck)).toContain('scripts/check-macos-deployment-target.py')
    expect(JSON.stringify(macosCheck)).toContain('$EXE-spawn-helper')
    expect(manylinuxSmoke).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxSmoke)).toContain('-e DSH_TELEMETRY_DISABLED')
  })

  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('PLATFORM" = macos-arm64'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('"$EXE" "$EXE-spawn-helper"')
  })
})

describe('Issue lifecycle workflow', () => {
  it('uses the XxAgent repository and keeps mutation disabled without explicit credentials', () => {
    const lifecycle = loadWorkflow('.github/workflows/issue-lifecycle.yml')
    const lifecyclePullRequest = workflowEvent(lifecycle, 'pull_request')
    const lifecycleReview = workflowEvent(lifecycle, 'pull_request_review')
    const lifecycleJob = workflowJob(lifecycle, 'lifecycle')
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const policyPullRequest = workflowEvent(policy, 'pull_request')
    const issueConfig = JSON.parse(
      readFileSync(resolve(root, '.github/issue-management/config.json'), 'utf8'),
    ) as unknown
    if (!isRecord(issueConfig) || !Array.isArray(lifecycleJob.steps)) {
      throw new TypeError('Issue policy config and lifecycle steps must be defined')
    }
    const tokenStep = lifecycleJob.steps
      .filter(isRecord)
      .find(step => step.name === 'Create project token')
    if (!isRecord(tokenStep) || !isRecord(tokenStep.with)) {
      throw new TypeError('Issue lifecycle workflow must define the project token step')
    }

    expect(lifecyclePullRequest.types).not.toContain('ready_for_review')
    expect(lifecyclePullRequest.types).toContain('review_requested')
    expect(lifecycleReview.types).toEqual(['submitted'])
    expect(lifecycleJob.if).toContain("vars.XAGENT_ISSUE_LIFECYCLE_ENABLED == 'true'")
    expect(lifecycleJob.if).toContain("github.event_name != 'pull_request_review'")
    expect(tokenStep.with.owner).toBe('${{ github.repository_owner }}')
    expect(tokenStep.with.repositories).toBe('${{ github.event.repository.name }}')
    expect(issueConfig).toMatchObject({ organization: 'VinceLi-18', repository: 'XxAgent' })
    expect(policyPullRequest.types).toContain('ready_for_review')
  })
})

describe('Real API e2e workflow', () => {
  it('requires repository opt-in before allocating a secret-bearing runner', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const job = workflowJob(workflow, 'e2e')
    if (!Array.isArray(job.steps)) throw new TypeError('Real API e2e job must define steps')

    expect(job.if).toContain("vars.XAGENT_REAL_API_E2E_ENABLED == 'true'")
    expect(job.if).toContain("github.event_name != 'pull_request'")
    const preflight = job.steps
      .filter(isRecord)
      .find(step => step.name === 'Preflight (require DEEPSEEK_API_KEY)')
    expect(preflight).toMatchObject({
      env: { DEEPSEEK_API_KEY: '${{ secrets.DEEPSEEK_API_KEY_EXTERNAL }}' },
    })
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(pairing).toMatchObject({ exclude: ['.agents/notes/archived/**'] })
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function composeService(compose: Record<string, unknown>, service: string): Record<string, unknown> {
  if (!isRecord(compose.services) || !isRecord(compose.services[service])) {
    throw new TypeError(`compose must define the ${service} service`)
  }
  return compose.services[service]
}

function artifactComposeServices(compose: Record<string, unknown>): Record<
  'api' | 'worker' | 'postgres' | 'roles' | 'migrate' | 'minio' | 'clamav',
  Record<string, unknown>
> {
  return {
    api: composeService(compose, 'api'),
    worker: composeService(compose, 'worker'),
    postgres: composeService(compose, 'postgres'),
    roles: composeService(compose, 'roles'),
    migrate: composeService(compose, 'migrate'),
    minio: composeService(compose, 'minio'),
    clamav: composeService(compose, 'clamav'),
  }
}

function expectArtifactLifecycleOrder(services: {
  roles: Record<string, unknown>
  migrate: Record<string, unknown>
  worker: Record<string, unknown>
}): void {
  expect(services.roles.depends_on).toMatchObject({ postgres: { condition: 'service_healthy' } })
  expect(services.migrate.depends_on).toMatchObject({ roles: { condition: 'service_completed_successfully' } })
  expect(services.worker.depends_on).toMatchObject({
    migrate: { condition: 'service_completed_successfully' },
    minio: { condition: 'service_healthy' },
    clamav: { condition: 'service_healthy' },
  })
}

function composeServiceNames(compose: Record<string, unknown>): string[] {
  if (!isRecord(compose.services)) throw new TypeError('compose must define services')
  return Object.keys(compose.services)
}

function durationSeconds(value: unknown): number {
  if (typeof value !== 'string') throw new TypeError('duration must be a string')
  const match = /^(\d+)([sm])$/.exec(value)
  if (match === null) throw new TypeError(`unsupported duration: ${value}`)
  return Number(match[1]) * (match[2] === 'm' ? 60 : 1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
