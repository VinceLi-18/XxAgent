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

  it('keeps a required Wine Windows job, a non-blocking native Windows job with failover, and a master-only standby', () => {
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

    // windows-native: non-blocking native job with failover, runs windows-complete.
    // Its pool is resolved by the Windows-specific switch.
    expect(typeof windowsNative['runs-on']).toBe('string')
    expect(windowsNative['runs-on']).toContain('DSH_CI_FAILOVER_WINDOWS')
    expect(windowsNative['runs-on']).not.toContain('DSH_CI_FAILOVER_LINUX')
    expect(windowsNative['runs-on']).toContain('self-hosted')
    expect(windowsNative['runs-on']).toContain('dsh-win-ci')
    expect(windowsNative['runs-on']).toContain('dsh-windows-2025-16core')
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

    // Linux failover is a separate switch: the three required Linux workers
    // and the verdict job resolve their pool through DSH_CI_FAILOVER_LINUX,
    // never the Windows switch.
    for (const [jobName, job] of [['node-24', node24], ['node-24-coverage', node24Coverage], ['node-24-consumers', node24Consumers]] as const) {
      expect(typeof job['runs-on']).toBe('string')
      expect(job['runs-on'], `${jobName} runs-on must use the Linux failover switch`).toContain('DSH_CI_FAILOVER_LINUX')
      expect(job['runs-on'], `${jobName} runs-on must not use the Windows failover switch`).not.toContain('DSH_CI_FAILOVER_WINDOWS')
      expect(job['runs-on']).toContain('vm-backup')
    }
    expect(aggregate['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(aggregate['runs-on']).not.toContain('DSH_CI_FAILOVER_WINDOWS')
    expect(aggregate['runs-on']).toContain('vm-backup')
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
          image: 'pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b',
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
    const api = composeService(compose, 'api')
    const worker = composeService(compose, 'worker')
    const postgres = composeService(compose, 'postgres')
    const roles = composeService(compose, 'roles')
    const migrate = composeService(compose, 'migrate')
    const minio = composeService(compose, 'minio')
    const clamav = composeService(compose, 'clamav')
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
    expect(roles.depends_on).toMatchObject({
      postgres: { condition: 'service_healthy' },
    })
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
    expect(migrate.depends_on).toMatchObject({
      roles: { condition: 'service_completed_successfully' },
    })
    expect(worker.depends_on).toMatchObject({
      migrate: { condition: 'service_completed_successfully' },
      minio: { condition: 'service_healthy' },
      clamav: { condition: 'service_healthy' },
      embedding: { condition: 'service_healthy' },
    })
    expect(durationSeconds(worker.stop_grace_period)).toBeGreaterThanOrEqual(90)
    expect(minio.healthcheck.test).toEqual(['CMD', 'mc', 'ready', 'local'])
    expect(clamav.image).toMatch(/^clamav\/clamav-debian:1\.4(?:$|\.)/)
    expect(clamav).not.toHaveProperty('platform')
  })

  it('assembles an isolated real artifact pipeline for Docker tests', () => {
    const compose = loadWorkflow('services/api/compose.test.yml')
    const packageJson = loadWorkflow('package.json')
    const api = composeService(compose, 'api')
    const worker = composeService(compose, 'worker')
    const postgres = composeService(compose, 'postgres')
    const roles = composeService(compose, 'roles')
    const migrate = composeService(compose, 'migrate')
    const minio = composeService(compose, 'minio')
    const clamav = composeService(compose, 'clamav')
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
      'embedding',
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
    expect(worker.command).toEqual([
      'xagent-api', 'worker',
      '--lease-seconds', '8',
      '--heartbeat-seconds', '2',
      '--poll-seconds', '0.2',
    ])
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
    expect(roles.depends_on).toMatchObject({
      postgres: { condition: 'service_healthy' },
    })
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
    expect(migrate.depends_on).toMatchObject({
      roles: { condition: 'service_completed_successfully' },
    })
    expect(worker.depends_on).toMatchObject({
      migrate: { condition: 'service_completed_successfully' },
      minio: { condition: 'service_healthy' },
      clamav: { condition: 'service_healthy' },
      embedding: { condition: 'service_healthy' },
    })
    expect(api.depends_on).toMatchObject({
      migrate: { condition: 'service_completed_successfully' },
      minio: { condition: 'service_healthy' },
      embedding: { condition: 'service_healthy' },
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
      'timeout-minutes': 45,
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
    expect(e2eStep.run).toContain('verify_model_snapshot.py --allow-absent')
    expect(e2eStep.run).toContain('verify_model_snapshot.py --cache-dir')
    expect(e2eStep.run.indexOf('verify_model_snapshot.py --allow-absent')).toBeLessThan(
      e2eStep.run.indexOf('docker compose -f services/api/compose.test.yml up -d --build --wait'),
    )
    expect(e2eStep.run.indexOf('verify_model_snapshot.py --cache-dir')).toBeLessThan(
      e2eStep.run.indexOf('pytest tests/e2e/test_artifact_pipeline.py'),
    )
    expect(aggregate.needs).toContain('xagent-artifact-e2e')

    const restoreCache: unknown = (artifactE2e.steps as unknown[]).find(
      step => isRecord(step) && step.name === 'Restore pinned BGE-M3 cache',
    )
    const prepareCache: unknown = (artifactE2e.steps as unknown[]).find(
      step => isRecord(step) && step.name === 'Prepare private model cache',
    )
    if (!isRecord(restoreCache) || !isRecord(restoreCache.with)
      || !isRecord(prepareCache) || typeof prepareCache.run !== 'string') {
      throw new TypeError('Artifact E2E must restore and prepare the private model cache')
    }
    expect(restoreCache.with.key).toBe(
      "bge-m3-5617a9f61b028005a4858fdac845db406aefb181-${{ hashFiles('services/embedding/uv.lock', 'services/embedding/bge-m3-snapshot.json') }}",
    )
    expect(prepareCache.run).toContain('install -d -o 65532 -g 65532 -m 0755')
    expect(prepareCache.run).toContain('chmod -R u=rwX,go=rX')
    expect(prepareCache.run).not.toContain('0777')
    expect(prepareCache.run).not.toContain('a+rwX')
  })

  it('assembles a health-ordered private CPU retrieval topology', () => {
    const production = loadWorkflow('services/api/compose.yml')
    const test = loadWorkflow('services/api/compose.test.yml')
    const packageJson = loadWorkflow('package.json')
    if (!isRecord(packageJson.scripts)) {
      throw new TypeError('package.json must define retrieval test scripts')
    }

    for (const [name, compose] of [['production', production], ['test', test]] as const) {
      const api = composeService(compose, 'api')
      const worker = composeService(compose, 'worker')
      const postgres = composeService(compose, 'postgres')
      const embedding = composeService(compose, 'embedding')
      if (!isRecord(api.environment)
        || !isRecord(worker.environment)
        || !isRecord(api.depends_on)
        || !isRecord(worker.depends_on)
        || !isRecord(embedding.build)
        || !isRecord(embedding.environment)
        || !isRecord(embedding.healthcheck)
        || !isRecord(embedding.deploy)
        || !isRecord(embedding.deploy.resources)
        || !isRecord(embedding.deploy.resources.limits)) {
        throw new TypeError(`${name} retrieval deployment must define bounded service wiring`)
      }

      expect(postgres.image).toMatch(/^pgvector\/pgvector:pg16@sha256:[0-9a-f]{64}$/)
      expect(embedding.build.context).toBe('../embedding')
      expect(embedding).not.toHaveProperty('ports')
      expect(embedding.environment).toMatchObject({
        HF_HUB_OFFLINE: '${HF_HUB_OFFLINE:-false}',
        OMP_NUM_THREADS: '2',
        MKL_NUM_THREADS: '2',
        TOKENIZERS_PARALLELISM: 'false',
      })
      expect(embedding.deploy.resources.limits).toMatchObject({ cpus: '2', memory: '6G' })
      expect(embedding.healthcheck.test).toEqual([
        'CMD',
        'python',
        '-c',
        expect.stringContaining("assert len(body['vectors'][0]) == 1024"),
      ])
      expect(durationSeconds(embedding.healthcheck.timeout)).toBeLessThanOrEqual(120)
      expect(durationSeconds(embedding.healthcheck.interval)).toBeLessThanOrEqual(15)
      expect(embedding.healthcheck.retries).toBeLessThanOrEqual(20)
      expect(durationSeconds(embedding.healthcheck.start_period)).toBeLessThanOrEqual(600)
      expect(api.environment.EMBEDDING_URL).toBe('http://embedding:8000')
      expect(api.environment.HF_HOME).toBe('/tmp/xagent-huggingface')
      expect(api.environment.HF_HUB_OFFLINE).toBe('${HF_HUB_OFFLINE:-false}')
      expect(api.volumes).toEqual([
        '${XAGENT_EMBEDDING_CACHE_DIR:-./.cache/huggingface}:/tmp/xagent-huggingface:ro',
      ])
      expect(worker.environment.EMBEDDING_URL).toBe('http://embedding:8000')
      expect(worker.environment.HF_HOME).toBe('/tmp/xagent-huggingface')
      expect(worker.environment.HF_HUB_OFFLINE).toBe('${HF_HUB_OFFLINE:-false}')
      expect(worker.volumes).toEqual([
        '${XAGENT_EMBEDDING_CACHE_DIR:-./.cache/huggingface}:/tmp/xagent-huggingface:ro',
      ])
      expect(api.environment).not.toHaveProperty('DATABASE_WORKER_URL')
      expect(api.environment).not.toHaveProperty('POSTGRES_WORKER_PASSWORD')
      expect(api.depends_on).toMatchObject({ embedding: { condition: 'service_healthy' } })
      expect(worker.depends_on).toMatchObject({
        postgres: { condition: 'service_healthy' },
        migrate: { condition: 'service_completed_successfully' },
        minio: { condition: 'service_healthy' },
        clamav: { condition: 'service_healthy' },
        embedding: { condition: 'service_healthy' },
      })
    }

    expect(packageJson.scripts['api:test:retrieval']).toBe(
      'python3 services/embedding/verify_model_snapshot.py --cache-dir "${XAGENT_EMBEDDING_CACHE_DIR:-services/api/.cache/huggingface}" && JX_TEST_DATABASE_URL=postgresql+asyncpg://postgres:xagent-api-test@127.0.0.1:55432/xagent_api_test JX_ALLOW_SCHEMA_DROP=yes XAGENT_RETRIEVAL_E2E=1 uv run --python 3.11 --directory services/api --extra dev pytest tests/e2e/test_retrieval_pipeline.py tests/e2e/test_retrieval_worker_recovery.py',
    )
    expect(readFileSync(resolve(root, 'services/api/.dockerignore'), 'utf8').split('\n')).toContain('.cache/')
    expect(readFileSync(resolve(root, 'services/api/pyproject.toml'), 'utf8')).toContain(
      'exclude = ["/.cache"]',
    )

    const embeddingDockerfile = readFileSync(
      resolve(root, 'services/embedding/Dockerfile'),
      'utf8',
    )
    const baseImages = embeddingDockerfile.match(/^(?:FROM\s+|COPY --from=)\S+/gm) ?? []
    expect(baseImages).toHaveLength(2)
    expect(baseImages).toEqual([
      'FROM python:3.11-slim@sha256:9c900dea9e8fb7e16277c179b555cc72d29a352dbc33cff48ad5a0412fd5bfc7',
      'COPY --from=ghcr.io/astral-sh/uv:0.8.15@sha256:a5727064a0de127bdb7c9d3c1383f3a9ac307d9f2d8a391edc7896c54289ced0',
    ])
    expect(readFileSync(resolve(root, 'services/embedding/.dockerignore'), 'utf8').split('\n')).toEqual(
      expect.arrayContaining(['.venv/', '.pytest_cache/', '**/__pycache__/', 'tests/']),
    )

    const modelManifest = loadWorkflow('services/embedding/bge-m3-snapshot.json')
    expect(modelManifest).toMatchObject({
      schema_version: 1,
      model_id: 'BAAI/bge-m3',
      revision: '5617a9f61b028005a4858fdac845db406aefb181',
      source: 'https://huggingface.co/api/models/BAAI/bge-m3/revision/5617a9f61b028005a4858fdac845db406aefb181?blobs=true',
    })
    if (!Array.isArray(modelManifest.files)) {
      throw new TypeError('BGE-M3 manifest must define the complete runtime file set')
    }
    const manifestFiles = modelManifest.files as unknown[]
    expect(manifestFiles.map(file => isRecord(file) ? file.path : undefined)).toEqual([
      '1_Pooling/config.json',
      'config.json',
      'config_sentence_transformers.json',
      'modules.json',
      'pytorch_model.bin',
      'sentence_bert_config.json',
      'sentencepiece.bpe.model',
      'special_tokens_map.json',
      'tokenizer.json',
      'tokenizer_config.json',
    ])
    for (const file of manifestFiles) {
      if (!isRecord(file)) throw new TypeError('BGE-M3 manifest entries must be objects')
      expect(typeof file.path).toBe('string')
      expect(typeof file.size).toBe('number')
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(file.huggingface_blob_id).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  it('runs a bounded retrieval lane and proves exact Compose cleanup', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const retrievalE2e = workflowJob(workflow, 'xagent-retrieval-e2e')
    const aggregate = workflowJob(workflow, 'all-checks-passed')
    if (!Array.isArray(retrievalE2e.steps) || !Array.isArray(aggregate.needs)) {
      throw new TypeError('Retrieval E2E and aggregate jobs must define steps and dependencies')
    }

    expect(retrievalE2e).toMatchObject({
      if: "github.event_name == 'pull_request'",
      name: 'python 3.11 / xagent retrieval docker e2e',
      'timeout-minutes': 45,
      env: {
        XAGENT_RETRIEVAL_E2E: '1',
        XAGENT_RETRIEVAL_E2E_URL: 'http://127.0.0.1:58000',
        XAGENT_RETRIEVAL_E2E_SERVICE_TOKEN: 'xagent-e2e-service-token-test-only-0001',
      },
    })
    const e2eStep = (retrievalE2e.steps as unknown[]).find(
      step => isRecord(step) && step.name === 'Run real retrieval pipeline',
    )
    if (!isRecord(e2eStep) || typeof e2eStep.run !== 'string') {
      throw new TypeError('Retrieval E2E job must run the real pipeline')
    }
    expect(e2eStep.run).toContain('trap cleanup EXIT')
    expect(e2eStep.run).toContain('verify_model_snapshot.py --allow-absent')
    expect(e2eStep.run).toContain('docker compose -f services/api/compose.test.yml up -d --build --wait')
    expect(e2eStep.run).toContain('verify_model_snapshot.py --cache-dir')
    expect(e2eStep.run.indexOf('verify_model_snapshot.py --allow-absent')).toBeLessThan(
      e2eStep.run.indexOf('docker compose -f services/api/compose.test.yml up -d --build --wait'),
    )
    expect(e2eStep.run.indexOf('verify_model_snapshot.py --cache-dir')).toBeLessThan(
      e2eStep.run.indexOf('pytest tests/e2e/test_retrieval_pipeline.py'),
    )
    expect(e2eStep.run).toContain('tests/e2e/test_retrieval_pipeline.py')
    expect(e2eStep.run).toContain('tests/e2e/test_retrieval_worker_recovery.py')
    expect(e2eStep.run).toContain('docker compose -f services/api/compose.test.yml down --volumes --remove-orphans')
    expect(e2eStep.run).toContain('docker rm --force xagent-stale-worker')
    expect(e2eStep.run).toContain(
      'docker container ls --all -q --filter label=com.docker.compose.project=xagent-api-test',
    )
    expect(e2eStep.run).toContain(
      'docker volume ls -q --filter label=com.docker.compose.project=xagent-api-test',
    )
    expect(e2eStep.run).toContain(
      'docker network ls -q --filter label=com.docker.compose.project=xagent-api-test',
    )
    expect(aggregate.needs).toContain('xagent-retrieval-e2e')

    const prepareCache: unknown = (retrievalE2e.steps as unknown[]).find(
      step => isRecord(step) && step.name === 'Prepare private model cache',
    )
    if (!isRecord(prepareCache) || typeof prepareCache.run !== 'string') {
      throw new TypeError('Retrieval E2E must prepare the private model cache')
    }
    expect(prepareCache.run).toContain('install -d -o 65532 -g 65532 -m 0755')
    expect(prepareCache.run).toContain('chmod -R u=rwX,go=rX')
    expect(prepareCache.run).not.toContain('0777')
    expect(prepareCache.run).not.toContain('a+rwX')

    const restoreCache: unknown = (retrievalE2e.steps as unknown[]).find(
      step => isRecord(step) && step.name === 'Restore pinned BGE-M3 cache',
    )
    if (!isRecord(restoreCache) || !isRecord(restoreCache.with)) {
      throw new TypeError('Retrieval E2E must restore the pinned model cache')
    }
    expect(restoreCache.with.key).toBe(
      "bge-m3-5617a9f61b028005a4858fdac845db406aefb181-${{ hashFiles('services/embedding/uv.lock', 'services/embedding/bge-m3-snapshot.json') }}",
    )
  })

  it('keeps the real retrieval acceptance adversarial and branch-observable', () => {
    const pipeline = readFileSync(
      resolve(root, 'services/api/tests/e2e/test_retrieval_pipeline.py'),
      'utf8',
    )
    const recovery = readFileSync(
      resolve(root, 'services/api/tests/e2e/test_retrieval_worker_recovery.py'),
      'utf8',
    )
    const hybridUnit = readFileSync(
      resolve(root, 'services/api/tests/retrieval/test_hybrid_search.py'),
      'utf8',
    )

    expect(pipeline).toContain('test_real_hybrid_branches_and_final_domain_tie_break')
    expect(pipeline).toContain('vector_top_40')
    expect(pipeline).toContain('lexical_rank')
    expect(pipeline).toContain('trigram_score')
    expect(pipeline).toContain('candidate_count')
    expect(pipeline).toContain('artifact_order_opposes_lower_keys')
    expect(pipeline).toContain('ordinal_order_opposes_chunk_id')
    expect(hybridUnit).toContain('test_rrf_version_fallback_for_unreachable_live_head_pair')
    expect(recovery).toContain('xagent-stale-worker')
    expect(recovery).toContain('active-replacement')
    expect(recovery).toContain('superseded')
    expect(recovery).toContain('stale-owner-resumed')
    expect(recovery).toContain('failed:invalid-utf8:dead:invalid-utf8')
    expect(recovery).not.toContain('{"failed:invalid-utf8", "none"}')
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
  it('keeps complete wheel validation separate from protected public publication', () => {
    const workflow = loadWorkflow('.github/workflows/python-release.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const pullRequest = workflowEvent(workflow, 'pull_request')
    const build = workflowJob(workflow, 'build')
    const pythonCompat = workflowJob(workflow, 'python-compat')
    const validate = workflowJob(workflow, 'validate')
    const publishRuntime = workflowJob(workflow, 'publish-runtime')
    const publishSdk = workflowJob(workflow, 'publish-sdk')
    if (!isRecord(dispatch.inputs)
      || !isRecord(dispatch.inputs.publish)
      || !Array.isArray(pythonCompat.steps)
      || !Array.isArray(validate.steps)
      || !Array.isArray(publishRuntime.steps)
      || !Array.isArray(publishSdk.steps)) {
      throw new TypeError('Python release workflow must define publish input and release steps')
    }

    expect(dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: false })
    expect(pullRequest).toEqual({ types: ['labeled'] })
    expect(build).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' || github.event.label.name == 'python-release-dry-run'",
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64',
        release: true,
      },
    })
    expect(pythonCompat.strategy).toMatchObject({ matrix: { python: ['3.10', '3.14'] } })
    expect(JSON.stringify(pythonCompat.steps)).toContain('deepseek-harness-sdk==${{ steps.compatibility-version.outputs.version }}')
    const validateSteps = JSON.stringify(validate.steps)
    const authorize = validate.steps.filter(isRecord).find(step => step.name === 'Authorize publication request')
    if (!isRecord(authorize) || typeof authorize.run !== 'string') {
      throw new TypeError('Python release validation must authorize publication requests')
    }
    expect(validateSteps).toContain('PUBLIC_PYPI_RELEASE_ENABLED')
    expect(authorize).toMatchObject({
      env: {
        PYPI_PUBLISHER_REPOSITORY: '${{ vars.PYPI_PUBLISHER_REPOSITORY }}',
        REPOSITORY: '${{ github.repository }}',
      },
    })
    expect(authorize.run).toContain('[ "$REPOSITORY" = "$PYPI_PUBLISHER_REPOSITORY" ]')
    expect(validateSteps).toContain('100000000')
    expect(publishRuntime).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: 'validate',
      environment: 'pypi-runtime',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    expect(publishSdk).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: ['validate', 'publish-runtime'],
      environment: 'pypi',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    const runtimeSteps = publishRuntime.steps.filter(isRecord)
    const sdkSteps = publishSdk.steps.filter(isRecord)
    const runtimePublish = runtimeSteps.find(step => step.name === 'Publish runtime wheels')
    const sdkPublish = sdkSteps.find(step => step.name === 'Publish SDK wheel')
    const runtimeHashes = runtimeSteps.find(step => step.name === 'Verify release artifact hashes')
    const sdkHashes = sdkSteps.find(step => step.name === 'Verify release artifact hashes')
    expect([...runtimeSteps, ...sdkSteps].some(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )).toBe(false)
    expect([...runtimeSteps, ...sdkSteps].filter(
      step => step.uses === 'pypa/gh-action-pypi-publish@release/v1',
    )).toHaveLength(2)
    expect(runtimePublish).toMatchObject({
      with: { 'packages-dir': 'dist/runtime/', attestations: false },
    })
    expect(sdkPublish).toMatchObject({
      with: { 'packages-dir': 'dist/sdk/', attestations: false },
    })
    expect(runtimeHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
    expect(sdkHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
  })

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
  it('uses explicit review handoff events without rerunning when a draft becomes ready', () => {
    const lifecycle = loadWorkflow('.github/workflows/issue-lifecycle.yml')
    const lifecyclePullRequest = workflowEvent(lifecycle, 'pull_request')
    const lifecycleReview = workflowEvent(lifecycle, 'pull_request_review')
    const lifecycleJob = workflowJob(lifecycle, 'lifecycle')
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const policyPullRequest = workflowEvent(policy, 'pull_request')

    expect(lifecyclePullRequest.types).not.toContain('ready_for_review')
    expect(lifecyclePullRequest.types).toContain('review_requested')
    expect(lifecycleReview.types).toEqual(['submitted'])
    expect(lifecycleJob.if).toBe(
      "${{ github.event_name != 'pull_request_review' || (github.event.action == 'submitted' && github.event.review.state == 'changes_requested') }}",
    )
    expect(policyPullRequest.types).toContain('ready_for_review')
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
