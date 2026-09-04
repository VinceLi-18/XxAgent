import type { ChildProcess } from 'node:child_process'
import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { probeFreePort, REPO_ROOT, requireDist, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const POSTGRES_CONTAINER = 'xagent-api-test-postgres-1'
const POSTGRES_PASSWORD = 'xagent-api-test'
const APP_PASSWORD = 'phase3a-app-password'
const SERVICE_TOKEN = 'xagent-phase3a-service-token-00000001'
const MANAGER_EMAIL = 'manager.phase3a@example.test'
const SPECIALIST_EMAIL = 'specialist.phase3a@example.test'
const MANAGER_PASSWORD = 'Phase3A-Manager-2026!'
const SPECIALIST_PASSWORD = 'Phase3A-Specialist-2026!'
const PROJECT_NAME = 'Phase 3A 项目'

interface RpcResponse<T> {
  readonly status: number
  readonly result?: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
}

interface WorkbenchBootstrap {
  readonly account: { readonly email: string; readonly role: 'manager' | 'specialist' }
  readonly capabilities: readonly string[]
  readonly context: { readonly kind: 'workbench' | 'project'; readonly projectId?: string }
  readonly projects: readonly { readonly id: string; readonly name: string }[]
  readonly sessionScopes: readonly {
    readonly sessionId: string
    readonly visibility: 'private' | 'project'
    readonly projectId?: string
  }[]
}

interface CreatedSession {
  readonly sessionId: string
}

function waitForLine(child: ChildProcess, pattern: RegExp, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => {
      reject(new Error(`${label} 未在 90 秒内就绪：\n${output}`))
    }, 90_000)
    const read = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = pattern.exec(output)
      if (match?.[1] !== undefined) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`${label} 提前退出（${code ?? 'signal'}）：\n${output}`))
    })
  })
}

async function waitForHealth(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`FastAPI 提前退出（${child.exitCode ?? child.signalCode}）`)
    }
    try {
      if ((await fetch(`${origin}/api/v1/health`)).status === 200) return
    } catch {
      // Uvicorn 尚未绑定端口；继续轮询到明确期限。
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 100).unref() })
  }
  throw new Error('FastAPI 未在 60 秒内就绪')
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) }),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        resolve()
      }, 5_000).unref()
    }),
  ])
}

function dockerPsql(sql: string, database = 'postgres'): string {
  return execFileSync('docker', [
    'exec', POSTGRES_CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database, '-Atc', sql,
  ], { encoding: 'utf8' }).trim()
}

function runApiCommand(environment: NodeJS.ProcessEnv, args: readonly string[], input?: string): string {
  return execFileSync('uv', [
    'run', '--python', '3.11', '--project', join(REPO_ROOT, 'services/api'), ...args,
  ], {
    cwd: join(REPO_ROOT, 'services/api'),
    env: environment,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  }).trim()
}

async function browserRpc<T>(page: Page, method: string, payload: unknown): Promise<RpcResponse<T>> {
  return await page.evaluate(async ({ method: rpcMethod, payload: rpcPayload }) => {
    const generated = rpcMethod.startsWith('xagentProject.')
    const endpoint = generated ? rpcMethod.replace('.', '/') : rpcMethod
    const csrf = document.cookie.split(';')
      .map(item => item.trim())
      .find(item => item.startsWith('xagent_csrf='))
      ?.slice('xagent_csrf='.length)
    const response = await fetch(`/api/${endpoint}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(csrf === undefined ? {} : { 'x-xagent-csrf': decodeURIComponent(csrf) }),
      },
      body: JSON.stringify({
        type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint,
        payload: generated ? { args: rpcPayload } : rpcPayload,
      }),
    })
    let result: RpcResponse<T>['result']
    try {
      result = (await response.json() as { result?: RpcResponse<T>['result'] }).result
    } catch {
      result = undefined
    }
    return { status: response.status, ...(result === undefined ? {} : { result }) }
  }, { method, payload })
}

function value<T>(response: RpcResponse<T>): T {
  if (response.status !== 200 || response.result?.ok !== true) {
    throw new Error(`RPC 失败：HTTP ${response.status} ${JSON.stringify(response.result)}`)
  }
  return response.result.value
}

async function login(page: Page, email: string, password: string, diagnostics: string[]): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '登录工作空间' })
  await dialog.getByRole('textbox', { name: '邮箱' }).fill(email)
  await dialog.getByLabel('密码').fill(password)
  const responsePending = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/login')
  await dialog.getByRole('button', { name: '登录', exact: true }).click()
  const response = await responsePending
  const authenticated = page.getByText(email, { exact: true })
  const unavailable = page.getByText('认证服务暂时不可用，请稍后重试。', { exact: true })
  await Promise.race([
    authenticated.waitFor({ timeout: 30_000 }),
    unavailable.waitFor({ timeout: 30_000 }),
  ])
  if (await unavailable.isVisible()) {
    const sessionStatus = await page.evaluate(async () => (await fetch('/auth/session', { credentials: 'same-origin' })).status)
    const bootstrap = await browserRpc<WorkbenchBootstrap>(page, 'xagentProject.bootstrap', {})
    throw new Error(
      `登录后工作台不可用：login=${String(response.status())} session=${String(sessionStatus)} `
      + `bootstrap=${JSON.stringify(bootstrap)} diagnostics=${diagnostics.join(' | ')}`,
    )
  }
}

async function dismissOnboarding(page: Page): Promise<void> {
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  await continueButton.waitFor({ timeout: 5_000 }).catch(() => undefined)
  if (await continueButton.isVisible().catch(() => false)) await continueButton.click()
  const later = page.getByRole('button', { name: '稍后配置', exact: true })
  await later.waitFor({ timeout: 5_000 }).catch(() => undefined)
  if (await later.isVisible().catch(() => false)) await later.click()
}

describe('XAgent 项目工作台真实双账号流程', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
  const database = `xagent_phase3a_${suffix}_test`
  const applicationRole = `xagent_phase3a_${suffix}_app`
  const workerRole = `xagent_phase3a_${suffix}_worker`
  const root = mkdtempSync(join(tmpdir(), 'xagent-phase3a-e2e-'))
  const adminUrl = `postgresql+asyncpg://postgres:${POSTGRES_PASSWORD}@127.0.0.1:55432/${database}`
  const applicationUrl = `postgresql+asyncpg://${applicationRole}:${APP_PASSWORD}@127.0.0.1:55432/${database}`
  const apiEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: applicationUrl,
    DATABASE_ADMIN_URL: adminUrl,
    POSTGRES_APP_USER: applicationRole,
    POSTGRES_WORKER_USER: workerRole,
    JWT_SECRET_KEY: 'phase3a-e2e-jwt-secret-not-for-production',
    JWT_ISSUER: 'xagent-phase3a-e2e',
    JWT_AUDIENCE: 'xagent-phase3a-browser',
    XAGENT_SERVICE_TOKEN: SERVICE_TOKEN,
    MINIO_ENDPOINT: '127.0.0.1:1',
    MINIO_PUBLIC_ENDPOINT: '127.0.0.1:1',
    MINIO_ACCESS_KEY: 'phase3a-minio-access',
    MINIO_SECRET_KEY: 'phase3a-minio-secret',
    MINIO_SECURE: 'false',
    MINIO_PUBLIC_SECURE: 'false',
    CLAMAV_TIMEOUT: '1',
  }
  let api: ChildProcess | undefined
  let dsh: ChildProcess | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let baseUrl = ''
  let databaseCreated = false
  let roleCreated = false
  let workerRoleCreated = false
  const browserDiagnostics: string[] = []

  beforeAll(async () => {
    requireDist()
    dockerPsql(`CREATE ROLE ${applicationRole} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
    roleCreated = true
    dockerPsql(`CREATE ROLE ${workerRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
    workerRoleCreated = true
    dockerPsql(`CREATE DATABASE ${database}`)
    databaseCreated = true
    runApiCommand(apiEnvironment, ['alembic', '-c', join(REPO_ROOT, 'services/api/alembic.ini'), 'upgrade', 'head'])
    runApiCommand(apiEnvironment, ['xagent-api', 'account', 'create', '--email', MANAGER_EMAIL, '--role', 'manager'])
    runApiCommand(apiEnvironment, ['xagent-api', 'account', 'set-password', '--email', MANAGER_EMAIL], `${MANAGER_PASSWORD}\n${MANAGER_PASSWORD}\n`)
    runApiCommand(apiEnvironment, ['xagent-api', 'account', 'create', '--email', SPECIALIST_EMAIL, '--role', 'specialist'])
    runApiCommand(apiEnvironment, ['xagent-api', 'account', 'set-password', '--email', SPECIALIST_EMAIL], `${SPECIALIST_PASSWORD}\n${SPECIALIST_PASSWORD}\n`)

    const apiPort = await probeFreePort()
    const apiOrigin = `http://127.0.0.1:${apiPort}`
    api = spawn('uv', [
      'run', '--python', '3.11', '--project', join(REPO_ROOT, 'services/api'),
      'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(apiPort),
    ], {
      cwd: join(REPO_ROOT, 'services/api'), env: apiEnvironment, stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForHealth(apiOrigin, api)

    const dshPort = await probeFreePort()
    baseUrl = `http://127.0.0.1:${dshPort}`
    const { privateKey } = generateKeyPairSync('ed25519')
    dsh = spawn(process.execPath, [
      join(REPO_ROOT, 'apps/cli/lib/bin.js'), '--profile', 'xagent-business', '--host', '127.0.0.1', '--port', String(dshPort),
    ], {
      cwd: root,
      env: {
        ...process.env,
        DSH_HOME: join(root, 'home'),
        DSH_AGENTS_HOME: join(root, 'agents'),
        XAGENT_API_ORIGIN: apiOrigin,
        XAGENT_SERVICE_TOKEN: SERVICE_TOKEN,
        XAGENT_ALLOWED_ORIGINS: baseUrl,
        XAGENT_ALLOW_INSECURE_COOKIE: '1',
        XAGENT_DELEGATION_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        XAGENT_DELEGATION_ISSUER: 'xagent-project-workbench-e2e',
        XAGENT_DELEGATION_AUDIENCE: 'xagent-fastapi-project-workbench-e2e',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForLine(dsh, /dsh web: (http:\/\/[^\s]+)/, 'XAgent Business')
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE })
    page.on('console', (message) => { browserDiagnostics.push(`console:${message.type()}:${message.text()}`) })
    page.on('pageerror', (error) => { browserDiagnostics.push(`pageerror:${error.message}`) })
    page.on('response', (response) => {
      if (!response.url().includes('/api/xagentProject/bootstrap')) return
      void response.text().then((body) => {
        browserDiagnostics.push(`project-bootstrap:${String(response.status())}:${body}`)
      }, (error: unknown) => {
        browserDiagnostics.push(`project-bootstrap-read:${String(error)}`)
      })
    })
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    try {
      await page.getByRole('dialog', { name: '登录工作空间' }).waitFor({ timeout: 30_000 })
    } catch {
      await saveFailureShot(page, 'xagent-project-workbench-boot')
      const body = await page.locator('body').innerText().catch(() => '<body unavailable>')
      const boot = await page.evaluate(() => JSON.stringify((window as unknown as { __DSH_BOOT__?: unknown }).__DSH_BOOT__))
        .catch(() => '<boot unavailable>')
      throw new Error(`登录界面未出现。DOM：\n${body}\nBOOT：${boot}\n浏览器诊断：\n${browserDiagnostics.join('\n')}`)
    }
  }, 120_000)

  afterAll(async () => {
    await browser?.close().catch(() => {})
    await stop(dsh)
    await stop(api)
    if (databaseCreated) dockerPsql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    if (workerRoleCreated) dockerPsql(`DROP ROLE IF EXISTS ${workerRole}`)
    if (roleCreated) dockerPsql(`DROP ROLE IF EXISTS ${applicationRole}`)
    rmSync(root, { recursive: true, force: true })
  })

  it('隔离 Manager 与 Specialist 的登录、项目能力、上下文和 Session 范围', async () => {
    onTestFailed(async () => {
      if (page !== undefined) await saveFailureShot(page, 'xagent-project-workbench')
    })
    const activePage = page!
    const loginDialog = activePage.getByRole('dialog', { name: '登录工作空间' })
    await loginDialog.getByRole('textbox', { name: '邮箱' }).fill(MANAGER_EMAIL)
    await loginDialog.getByLabel('密码').fill('wrong-password')
    await loginDialog.getByRole('button', { name: '登录', exact: true }).click()
    await loginDialog.getByRole('alert').waitFor()
    expect(await loginDialog.getByRole('alert').textContent()).toBe('邮箱或密码错误')

    await login(activePage, MANAGER_EMAIL, MANAGER_PASSWORD, browserDiagnostics)
    await dismissOnboarding(activePage)
    await activePage.getByRole('button', { name: '新建项目', exact: true }).waitFor()
    await activePage.getByRole('heading', { name: '工作台', level: 2 }).waitFor()

    await activePage.getByRole('button', { name: '新建项目', exact: true }).click()
    const createDialog = activePage.getByRole('dialog', { name: '新建项目' })
    await createDialog.getByRole('textbox', { name: '项目名称' }).fill(PROJECT_NAME)
    await createDialog.getByRole('button', { name: '创建', exact: true }).click()
    await createDialog.waitFor({ state: 'hidden' })
    expect(await activePage.getByRole('button', { name: PROJECT_NAME, exact: true }).getAttribute('aria-current')).toBe('page')
    await activePage.getByRole('heading', { name: PROJECT_NAME, level: 2 }).waitFor()

    const projectBootstrap = value(await browserRpc<WorkbenchBootstrap>(activePage, 'xagentProject.bootstrap', {}))
    const project = projectBootstrap.projects.find(item => item.name === PROJECT_NAME)
    expect(projectBootstrap.account).toMatchObject({ email: MANAGER_EMAIL, role: 'manager' })
    expect(project).toBeDefined()
    expect(projectBootstrap.context).toEqual({ kind: 'project', projectId: project!.id })

    const projectSession = value(await browserRpc<CreatedSession>(activePage, 'session.create', {}))
    const afterProjectSession = value(await browserRpc<WorkbenchBootstrap>(activePage, 'xagentProject.bootstrap', {}))
    expect(afterProjectSession.sessionScopes).toContainEqual({
      sessionId: projectSession.sessionId, visibility: 'project', projectId: project!.id,
    })

    await activePage.getByRole('button', { name: '我的工作台', exact: true }).click()
    await activePage.getByRole('heading', { name: '工作台', level: 2 }).waitFor()
    const privateSession = value(await browserRpc<CreatedSession>(activePage, 'session.create', {}))
    const afterPrivateSession = value(await browserRpc<WorkbenchBootstrap>(activePage, 'xagentProject.bootstrap', {}))
    expect(afterPrivateSession.sessionScopes).toContainEqual({
      sessionId: privateSession.sessionId, visibility: 'private',
    })

    await activePage.getByRole('button', { name: '退出登录', exact: true }).click()
    await activePage.getByRole('dialog', { name: '登录工作空间' }).waitFor()
    expect(await activePage.getByText(PROJECT_NAME, { exact: true }).count()).toBe(0)
    await login(activePage, SPECIALIST_EMAIL, SPECIALIST_PASSWORD, browserDiagnostics)
    expect(await activePage.getByRole('button', { name: '新建项目', exact: true }).count()).toBe(0)
    expect(await activePage.getByText(PROJECT_NAME, { exact: true }).count()).toBe(0)

    const forbidden = await browserRpc<WorkbenchBootstrap>(activePage, 'xagentProject.create-project', {
      name: '越权项目', idempotencyKey: randomUUID(),
    })
    expect(forbidden.status).toBe(200)
    expect(forbidden.result).toMatchObject({ ok: false, error: { code: 'forbidden' } })

    expect(runApiCommand(apiEnvironment, [
      'xagent-api', 'account', 'capability', 'grant', '--email', SPECIALIST_EMAIL,
      '--capability', 'project.create', '--granted-by', MANAGER_EMAIL,
    ])).toContain('project.create')
    await expect.poll(async () => (await fetch(`${baseUrl}/auth/session`, {
      headers: { cookie: (await activePage.context().cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join('; ') },
    })).status, { timeout: 15_000 }).toBe(401)

    await activePage.reload({ waitUntil: 'domcontentloaded' })
    await activePage.getByRole('dialog', { name: '登录工作空间' }).waitFor()
    expect(await activePage.getByText(PROJECT_NAME, { exact: true }).count()).toBe(0)
    await login(activePage, SPECIALIST_EMAIL, SPECIALIST_PASSWORD, browserDiagnostics)
    await activePage.getByRole('button', { name: '新建项目', exact: true }).waitFor()
    expect(await activePage.getByText(PROJECT_NAME, { exact: true }).count()).toBe(0)
  })
})
