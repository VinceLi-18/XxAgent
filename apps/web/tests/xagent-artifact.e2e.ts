import type { ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { probeFreePort, REPO_ROOT, requireDist, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'
import {
  browserDiagnosticUrl,
  redactBrowserDiagnosticText,
  spawnOwnedChild,
  stopChildProcess,
  type OwnedChildProcess,
} from './xagent-artifact-support.ts'

const SERVICE_TOKEN = 'xagent-e2e-service-token-test-only-0001'
const API_IMAGE = process.env.XAGENT_TASK10_API_IMAGE ?? 'xagent-api:test'
const PASSWORD = 'Task10-Artifact-2026!'
const FILENAME = '交付说明.txt'
const FIRST_BODY = '第一版：客户交付说明。'
const SECOND_BODY = '第二版：客户交付说明已复核。'

function compose(project: string, override: string, args: readonly string[], input?: string): string {
  return execFileSync('docker', [
    'compose', '--project-name', project,
    '--file', join(REPO_ROOT, 'services/api/compose.test.yml'),
    '--file', override,
    ...args,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 600_000,
    env: {
      ...process.env,
      HF_HUB_OFFLINE: 'true',
      XAGENT_EMBEDDING_CACHE_DIR: join(REPO_ROOT, 'services/api/.cache/huggingface'),
    },
    ...(input === undefined ? {} : { input }),
  }).trim()
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

async function login(page: Page, email: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '登录工作空间' })
  await dialog.getByRole('textbox', { name: '邮箱' }).fill(email)
  await dialog.getByLabel('密码').fill(PASSWORD)
  await dialog.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByText(email, { exact: true }).waitFor({ timeout: 30_000 })
}

async function dismissOnboarding(page: Page): Promise<void> {
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  await continueButton.waitFor({ timeout: 5_000 }).catch(() => undefined)
  if (await continueButton.isVisible().catch(() => false)) await continueButton.click()
  const later = page.getByRole('button', { name: '稍后配置', exact: true })
  await later.waitFor({ timeout: 5_000 }).catch(() => undefined)
  if (await later.isVisible().catch(() => false)) await later.click()
}

function account(project: string, override: string, email: string, role: 'manager' | 'specialist'): void {
  compose(project, override, ['exec', '-T', 'api', 'xagent-api', 'account', 'create', '--email', email, '--role', role])
  compose(
    project,
    override,
    ['exec', '-T', 'api', 'xagent-api', 'account', 'set-password', '--email', email],
    `${PASSWORD}\n${PASSWORD}\n`,
  )
}

function isInfrastructureCredential(key: string): boolean {
  return /^(?:AWS|S3)_/.test(key)
    || /(?:^|_)(?:DATABASE|POSTGRES|MINIO|CLAMAV|OBJECT_STORAGE)(?:_|$)/.test(key)
    || /^PG(?:DATABASE|HOST|PASSFILE|PASSWORD|PORT|SERVICE|USER)$/.test(key)
}

function withoutInfrastructureCredentials(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !isInfrastructureCredential(key)),
  )
}

describe('XAgent Business 真实资料生命周期', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
  const project = `xagent-task10-${suffix}`
  const managerEmail = `manager.task10.${suffix}@example.test`
  const specialistEmail = `specialist.task10.${suffix}@example.test`
  const projectName = `Task10 资料项目 ${suffix}`
  const root = mkdtempSync(join(tmpdir(), 'xagent-task10-e2e-'))
  const override = join(root, 'compose.override.yml')
  let composeOwned = false
  let dsh: OwnedChildProcess | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let baseUrl = ''
  const browserDiagnostics: string[] = []

  beforeAll(async () => {
    requireDist()
    const apiPort = await probeFreePort()
    const minioPort = await probeFreePort()
    const postgresPort = await probeFreePort()
    writeFileSync(override, `services:\n  api:\n    image: ${API_IMAGE}\n    environment:\n      PYTHONPATH: /app\n      MINIO_PUBLIC_ENDPOINT: 127.0.0.1:${minioPort}\n    ports: !override\n      - 127.0.0.1:${apiPort}:8000\n  worker:\n    image: ${API_IMAGE}\n    environment:\n      PYTHONPATH: /app\n  roles:\n    image: ${API_IMAGE}\n    environment:\n      PYTHONPATH: /app\n  migrate:\n    image: ${API_IMAGE}\n    environment:\n      PYTHONPATH: /app\n  minio:\n    ports: !override\n      - 127.0.0.1:${minioPort}:9000\n  postgres:\n    ports: !override\n      - 127.0.0.1:${postgresPort}:5432\n`)
    composeOwned = true
    try {
      compose(project, override, [
        'up', '--detach', process.env.XAGENT_TASK10_NO_BUILD === '1' ? '--no-build' : '--build', '--wait',
      ])
      account(project, override, managerEmail, 'manager')
      account(project, override, specialistEmail, 'specialist')

      const dshPort = await probeFreePort()
      baseUrl = `http://127.0.0.1:${dshPort}`
      const inheritedEnvironment = {
        ...process.env,
        AWS_SECRET_ACCESS_KEY: '不得进入 DSH',
        JX_TEST_DATABASE_URL: '不得进入 DSH',
        PGPASSWORD: '不得进入 DSH',
      }
      const { privateKey } = generateKeyPairSync('ed25519')
      const dshEnvironment = {
        ...withoutInfrastructureCredentials(inheritedEnvironment),
        DSH_HOME: join(root, 'home'),
        DSH_AGENTS_HOME: join(root, 'agents'),
        XAGENT_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
        XAGENT_SERVICE_TOKEN: SERVICE_TOKEN,
        XAGENT_ALLOWED_ORIGINS: baseUrl,
        XAGENT_ALLOW_INSECURE_COOKIE: '1',
        XAGENT_DELEGATION_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        XAGENT_DELEGATION_ISSUER: 'xagent-artifact-web-e2e',
        XAGENT_DELEGATION_AUDIENCE: 'xagent-fastapi-artifact-web-e2e',
      }
      expect(Object.keys(dshEnvironment).filter(isInfrastructureCredential)).toEqual([])
      dsh = spawnOwnedChild(process.execPath, [
        join(REPO_ROOT, 'apps/cli/lib/bin.js'), '--profile', 'xagent-business',
        '--host', '127.0.0.1', '--port', String(dshPort),
      ], {
        cwd: root,
        env: dshEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      await waitForLine(dsh.child, /dsh web: (http:\/\/[^\s]+)/, 'XAgent Business')
      browser = await chromium.launch({ headless: true })
      page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE })
      page.on('console', (message) => {
        browserDiagnostics.push(`console:${message.type()}:${redactBrowserDiagnosticText(message.text())}`)
      })
      page.on('pageerror', (error) => {
        browserDiagnostics.push(`pageerror:${redactBrowserDiagnosticText(error.message)}`)
      })
      page.on('requestfailed', (request) => {
        browserDiagnostics.push(
          `requestfailed:${browserDiagnosticUrl(request.url())}:${redactBrowserDiagnosticText(
            request.failure()?.errorText ?? '未知错误',
          )}`,
        )
      })
      page.on('response', (response) => {
        if (response.status() >= 400) {
          browserDiagnostics.push(`response:${String(response.status())}:${browserDiagnosticUrl(response.url())}`)
        }
      })
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
      await page.getByRole('dialog', { name: '登录工作空间' }).waitFor({ timeout: 30_000 })
    } catch (error) {
      const logs = compose(project, override, ['logs', '--no-color']).slice(-12_000)
      throw new Error(`真实资料栈启动失败：${String(error)}\n${logs}`)
    }
  }, 600_000)

  afterAll(async () => {
    const cleanupErrors: string[] = []
    await browser?.close().catch((error: unknown) => { cleanupErrors.push(`browser: ${String(error)}`) })
    await stopChildProcess(dsh).catch((error: unknown) => { cleanupErrors.push(`dsh: ${String(error)}`) })
    if (composeOwned) {
      try {
        compose(project, override, ['down', '--volumes', '--remove-orphans'])
      } catch (error) {
        cleanupErrors.push(`compose down: ${String(error)}`)
      }
      const residue = [
        execFileSync('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`], { encoding: 'utf8' }).trim(),
        execFileSync('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], { encoding: 'utf8' }).trim(),
        execFileSync('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], { encoding: 'utf8' }).trim(),
      ].filter(Boolean)
      if (residue.length > 0) cleanupErrors.push(`Docker 残留：${residue.join(', ')}`)
    }
    rmSync(root, { recursive: true, force: true })
    if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join('\n'))
  }, 180_000)

  it('上传、扫描、详情、预览、新版本、栏位折叠和账号切换均保持服务器范围', async () => {
    onTestFailed(async () => {
      if (page !== undefined) await saveFailureShot(page, 'xagent-artifact')
      browserDiagnostics.push(compose(project, override, ['logs', '--no-color']).slice(-12_000))
    })
    const activePage = page!
    await login(activePage, managerEmail)
    await dismissOnboarding(activePage)
    await activePage.getByRole('button', { name: '新建项目', exact: true }).click()
    const createDialog = activePage.getByRole('dialog', { name: '新建项目' })
    await createDialog.getByRole('textbox', { name: '项目名称' }).fill(projectName)
    await createDialog.getByRole('button', { name: '创建', exact: true }).click()
    await createDialog.waitFor({ state: 'hidden' })

    await activePage.getByRole('tab', { name: '资料', exact: true }).click()
    const artifactPanel = activePage.getByRole('tabpanel', { name: '资料' })
    await artifactPanel.getByLabel('上传资料').setInputFiles({
      name: FILENAME, mimeType: 'text/plain', buffer: Buffer.from(FIRST_BODY),
    })
    await artifactPanel.getByRole('heading', { name: FILENAME, level: 3 }).waitFor({ timeout: 30_000 })
    await expect.poll(async () => await artifactPanel.locator('[data-status="clean"]').count(), {
      timeout: 120_000,
      message: `资料未完成真实 ClamAV 扫描。${browserDiagnostics.join(' | ')}`,
    }).toBeGreaterThan(0)
    await artifactPanel.getByText('安全版本 v1', { exact: true }).waitFor()

    await artifactPanel.getByRole('button', { name: '预览安全版本 v1', exact: true }).click()
    const preview = activePage.getByRole('dialog', { name: `${FILENAME} 全屏预览` })
    const previewText = preview.getByText(FIRST_BODY, { exact: true })
    const previewError = artifactPanel.getByRole('alert')
    await Promise.race([
      previewText.waitFor({ timeout: 30_000 }),
      previewError.waitFor({ timeout: 30_000 }),
    ])
    if (await previewError.isVisible()) {
      throw new Error(
        `真实文本预览失败：${redactBrowserDiagnosticText(await previewError.textContent() ?? '')}。${browserDiagnostics.join(' | ')}`,
      )
    }
    await preview.getByRole('button', { name: '关闭预览' }).click()
    await preview.waitFor({ state: 'hidden' })

    await artifactPanel.getByLabel('上传新版本').setInputFiles({
      name: FILENAME, mimeType: 'text/plain', buffer: Buffer.from(SECOND_BODY),
    })
    await expect.poll(async () => await artifactPanel.locator('[data-status="clean"]').count(), {
      timeout: 120_000,
      message: `新版本未完成真实 ClamAV 扫描。${browserDiagnostics.join(' | ')}`,
    }).toBe(2)
    await artifactPanel.getByText('安全版本 v2', { exact: true }).waitFor()
    await artifactPanel.getByRole('button', { name: '预览安全版本 v2', exact: true }).click()
    await activePage.getByRole('dialog', { name: `${FILENAME} 全屏预览` })
      .getByText(SECOND_BODY, { exact: true }).waitFor({ timeout: 30_000 })
    await activePage.getByRole('button', { name: '关闭预览' }).click()

    await activePage.setViewportSize({ width: 900, height: 900 })
    const drawerTrigger = activePage.getByRole('button', { name: '打开上下文栏' })
    await drawerTrigger.waitFor()
    await drawerTrigger.click()
    const drawer = activePage.getByRole('dialog', { name: '上下文栏' })
    await drawer.getByRole('heading', { name: FILENAME, level: 3 }).waitFor()
    await drawer.getByRole('button', { name: '关闭上下文栏' }).click()
    expect(await drawerTrigger.getAttribute('aria-expanded')).toBe('false')
    await drawerTrigger.click()
    expect(await drawerTrigger.getAttribute('aria-expanded')).toBe('true')
    await activePage.setViewportSize({ width: 1440, height: 900 })

    await activePage.getByRole('button', { name: '退出登录', exact: true }).click()
    await activePage.getByRole('dialog', { name: '登录工作空间' }).waitFor()
    expect(await activePage.getByText(FILENAME, { exact: true }).count()).toBe(0)
    await login(activePage, specialistEmail)
    expect(await activePage.getByText(FILENAME, { exact: true }).count()).toBe(0)
  })
})
