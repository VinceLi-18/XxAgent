import type { ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { probeFreePort, REPO_ROOT, requireDist, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'
import {
  resolveArtifactEmbeddingCacheDir,
  resolveArtifactEmbeddingOffline,
  spawnOwnedChild,
  stopChildProcess,
  type OwnedChildProcess,
} from './xagent-artifact-support.ts'
import {
  FactE2eResourceOwner,
  factApprovalIdentity,
  factBrowserDiagnosticUrl,
  factChildEnvironment,
  factComposeOverride,
  factFilesContaining,
  factTrafficObserver,
  redactFactBrowserDiagnosticText,
  restartFactService,
  switchFactAccount,
} from './xagent-fact-support.ts'

const SERVICE_TOKEN = 'xagent-e2e-service-token-test-only-0001'
const PASSWORD = 'Phase4B-Fact-2026!'
const API_IMAGE = process.env.XAGENT_PHASE4B_API_IMAGE ?? 'xagent-api:test'
const EMBEDDING_IMAGE = process.env.XAGENT_PHASE4B_EMBEDDING_IMAGE ?? 'xagent-embedding:test'
const EVIDENCE_FILENAME = 'Phase4B-合同证据.txt'
const EVIDENCE_BODY = 'Phase4B 交付证据\n客户签署的交付条款确认目标日期为 2027-03-15。\n项目经理要求按此日期完成交付。'
const SEARCH_QUERY = '客户交付目标日期'
const MANAGER_PROMPT = '提交年度预算事实 810000，依据是已批准的年度计划。'
const EVIDENCE_PROMPT = '检索客户交付目标日期，并据此提交交付日期事实，最后给出带引用答复。'
const STALE_FIRST_PROMPT = '提交年度预算事实修订为 900000，依据是第一版预算复核。'
const STALE_SECOND_PROMPT = '提交年度预算事实修订为 950000，依据是第二版预算复核。'
const DECISION_PROMPT = '继续处理刚才的事实审批结果。'
const NO_REPLAY_PROMPT = '确认本轮没有重复的事实审批通知。'
const EXPECTED = join(REPO_ROOT, 'apps/web/tests/snapshots/xagent-fact-approval/state.expected.json')

type JsonObject = Record<string, unknown>

interface RpcResponse<T> {
  readonly status: number
  readonly result?: { readonly ok: true; readonly value: T } | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string }
  }
}

interface WorkbenchBootstrap {
  readonly account: { readonly id: string; readonly email: string; readonly role: 'manager' | 'specialist' }
  readonly context: { readonly kind: 'workbench' | 'project'; readonly projectId?: string }
  readonly projects: readonly { readonly id: string; readonly name: string }[]
  readonly sessionScopes: readonly {
    readonly sessionId: string
    readonly visibility: 'private' | 'project'
    readonly projectId?: string
  }[]
}

interface CreatedSession { readonly sessionId: string }

interface FactEvidence {
  readonly citationId: string
  readonly artifactId: string
  readonly versionId: string
  readonly indexId: string
  readonly indexGeneration: number
  readonly chunkId: string
  readonly lineStart: number
  readonly lineEnd: number
}

interface FactProposal {
  readonly id: string
  readonly projectId: string
  readonly fieldKey: string
  readonly label: string
  readonly value: JsonObject
  readonly proposerId: string
  readonly baseRevision: number
  readonly assertionReason?: string
  readonly status: 'pending' | 'confirmed' | 'rejected' | 'withdrawn' | 'conflicted'
  readonly decisionActorId?: string
  readonly decisionReason?: string
  readonly evidence: readonly FactEvidence[]
}

interface FactPage<T> { readonly items: readonly T[]; readonly nextCursor?: string }
interface FactRevision {
  readonly id: string
  readonly projectId: string
  readonly fieldKey: string
  readonly label: string
  readonly value: JsonObject
  readonly contentRevision: number
  readonly proposalId: string
  readonly proposerId: string
  readonly confirmedById: string
  readonly assertionReason?: string
  readonly evidence: readonly FactEvidence[]
  readonly createdAt: string
}
interface FactRevisionDetail { readonly revision: FactRevision; readonly history: readonly FactRevision[] }
interface FactDecision {
  readonly proposalId: string
  readonly status: 'confirmed' | 'rejected' | 'withdrawn'
  readonly factRevisionId?: string
  readonly contentRevision?: number
}
interface CapturedRequest { readonly sessionId?: string; readonly messages: readonly JsonObject[] }
interface LifecycleRecord { readonly type: string; readonly sessionId: string }

function compose(project: string, override: string, args: readonly string[], input?: string): string {
  return execFileSync('docker', [
    'compose', '--project-name', project,
    '--file', join(REPO_ROOT, 'services/api/compose.test.yml'),
    '--file', override,
    ...args,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 900_000,
    env: factChildEnvironment(process.env, {
      HF_HUB_OFFLINE: resolveArtifactEmbeddingOffline(process.env),
      XAGENT_EMBEDDING_CACHE_DIR: resolveArtifactEmbeddingCacheDir(
        process.env,
        join(REPO_ROOT, 'services/api/.cache/huggingface'),
      ),
    }),
    ...(input === undefined ? {} : { input }),
  }).trim()
}

function waitForLine(child: ChildProcess, pattern: RegExp, label: string, secrets: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => {
      reject(new Error(`${label} did not become ready before its deadline:\n${redactFactBrowserDiagnosticText(output, secrets)}`))
    }, 120_000)
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
      reject(new Error(`${label} exited before readiness (${code ?? 'signal'}):\n${redactFactBrowserDiagnosticText(output, secrets)}`))
    })
  })
}

async function waitForApi(origin: string): Promise<void> {
  await expect.poll(async () => {
    try { return (await fetch(`${origin}/api/v1/health`)).status } catch { return 0 }
  }, { timeout: 120_000, interval: 250 }).toBe(200)
}

function psql(project: string, override: string, sql: string, user = 'postgres'): string {
  return compose(project, override, [
    'exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', 'xagent_api_test', '-Atc', sql,
  ])
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function backendSessionId(sessionId: string): string {
  return sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
}

function account(project: string, override: string, email: string, role: 'manager' | 'specialist'): void {
  compose(project, override, ['exec', '-T', 'api', 'xagent-api', 'account', 'create', '--email', email, '--role', role])
  compose(project, override, ['exec', '-T', 'api', 'xagent-api', 'account', 'set-password', '--email', email],
    `${PASSWORD}\n${PASSWORD}\n`)
}

function usage(): JsonObject {
  return { type: 'usage', usage: { inputTokens: 32, outputTokens: 16, cacheReadTokens: 0, reasoningTokens: 0 } }
}

function toolCall(callId: string, name: string, args: JsonObject): JsonObject[] {
  const argumentsText = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsText } },
    usage(),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textAnswer(text: string): JsonObject[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    usage(),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function writeReplayLog(path: string, id: string, calls: readonly JsonObject[][]): void {
  const createdAt = 1_780_000_000_000
  const lines = [JSON.stringify({ id, version: 0, createdAt, seedLength: 0 })]
  let sequence = 0
  calls.forEach((chunks, callIndex) => {
    chunks.forEach((chunk) => {
      lines.push(JSON.stringify({
        type: 'assistant/chunk', seq: sequence++, time: createdAt + sequence,
        data: { turn: 1, step: callIndex + 1, chunk },
      }))
    })
  })
  writeFileSync(path, `${lines.join('\n')}\n`)
}

function writeReplayWorld(root: string): readonly string[] {
  const paths = [0, 1, 2, 3, 4].map(index => join(root, `replay-${String(index)}.jsonl`))
  writeReplayLog(paths[0]!, 'phase4b-manager', [
    toolCall('call-phase4b-manager-proposal', 'propose_fact', {
      field_key: 'budget.annual', label: '年度预算', value: { type: 'number', value: 810000 },
      assertion_reason: '已批准的年度计划',
    }),
    textAnswer('年度预算事实提案已提交。'),
  ])
  writeReplayLog(paths[1]!, 'phase4b-specialist', [
    toolCall('call-phase4b-evidence-search', 'search_artifacts', { query: SEARCH_QUERY }),
    toolCall('call-phase4b-evidence-proposal', 'propose_fact', {
      field_key: 'delivery.target_date', label: '目标交付日期', value: { type: 'date', value: '2027-03-15' },
      evidence_ids: ['[资料1]'],
      assertion_reason: '客户签署的交付条款',
    }),
    toolCall('call-phase4b-evidence-answer', 'submit_cited_answer', {
      blocks: [
        { type: 'markdown', text: '目标交付日期事实提案已提交。' },
        { type: 'citation', id: '[资料1]' },
      ],
    }),
    textAnswer('审批通知已进入本次真实用户请求。'),
    textAnswer('本轮没有重复审批通知。'),
  ])
  writeReplayLog(paths[2]!, 'phase4b-stale-first', [
    toolCall('call-phase4b-stale-first', 'propose_fact', {
      field_key: 'budget.annual', label: '年度预算', value: { type: 'number', value: 900000 },
      assertion_reason: '第一版预算复核',
    }),
    textAnswer('第一版预算事实提案已提交。'),
  ])
  writeReplayLog(paths[3]!, 'phase4b-stale-second', [
    toolCall('call-phase4b-stale-second', 'propose_fact', {
      field_key: 'budget.annual', label: '年度预算', value: { type: 'number', value: 950000 },
      assertion_reason: '第二版预算复核',
    }),
    textAnswer('第二版预算事实提案已提交。'),
  ])
  writeReplayLog(paths[4]!, 'phase4b-specialist-restart', [
    textAnswer('审批通知已进入本次真实用户请求。'),
    textAnswer('本轮没有重复审批通知。'),
  ])
  return paths
}

function writeRequestObserver(path: string): void {
  writeFileSync(path, [
    "import { appendFileSync } from 'node:fs'",
    "export const inject = ['llm']",
    'export function apply(ctx, config) {',
    '  const lifecycle = (type, sessionId) => appendFileSync(config.lifecycleFile, `${JSON.stringify({ type, sessionId })}\\n`, { mode: 0o600 })',
    "  lifecycle('host/start', '-')",
    "  ctx.on('session/created', session => lifecycle('session/created', session.id), { global: true })",
    "  ctx.on('agent/created', ({ agent }) => lifecycle('agent/created', agent.session.id), { global: true })",
    "  ctx.on('agent/session-start', ({ agent }) => lifecycle('agent/session-start', agent.session.id), { global: true })",
    "  ctx.on('agent/status', ({ agent, status }) => lifecycle(`agent/status:${status}`, agent.session.id), { global: true })",
    "  for (const event of ['inserted', 'claimed', 'discarded']) ctx.on(`agent/inbox/${event}`, ({ agent }) => lifecycle(`agent/inbox/${event}`, agent.session.id), { global: true })",
    "  ctx.on('agent/error', ({ agent, error }) => lifecycle(`agent/error:${error?.constructor?.name ?? typeof error}:${typeof error?.code === 'string' ? error.code : '-'}`, agent.session.id), { global: true })",
    "  ctx.on('session/event', (session, event) => {",
    "    if (event.type === 'turn/start') lifecycle(event.type, session.id)",
    "    if (event.type === 'turn/end') lifecycle(`${event.type}:${event.data.reason.kind}:${event.data.reason.kind === 'error' ? event.data.reason.error.code : '-'}`, session.id)",
    '  }, { global: true })',
    "  ctx.on('llm/stream', (options, next) => {",
    '    appendFileSync(config.file, `${JSON.stringify({ sessionId: options.sessionId, messages: options.messages })}\\n`, { mode: 0o600 })',
    '    return next()',
    '  })',
    '}',
    '',
  ].join('\n'))
}

function writeReplayPatch(
  path: string,
  replayPaths: readonly string[],
  observer: string,
  capture: string,
  lifecycle: string,
): void {
  writeFileSync(path, [
    '- id: llm-deepseek',
    '  disabled: true',
    '- id: session-title-llm',
    '  disabled: true',
    '- insert:',
    '    - id: phase4b-request-observer',
    `      name: ${JSON.stringify(observer)}`,
    '      config:',
    `        file: ${JSON.stringify(capture)}`,
    `        lifecycleFile: ${JSON.stringify(lifecycle)}`,
    '    - id: phase4b-llm-replay',
    `      name: ${JSON.stringify(join(REPO_ROOT, 'packages/test-support/llm-replay/lib/index.js'))}`,
    '      config:',
    `        file: ${JSON.stringify(replayPaths[0])}`,
    '        childFiles:',
    ...replayPaths.slice(1).map(item => `          - ${JSON.stringify(item)}`),
    '        providers:',
    '          - id: deepseek-official',
    '            name: Phase4B deterministic replay',
    '            models:',
    '              - id: deepseek-v4-flash',
    '                name: Phase4B deterministic replay',
    '                contextWindow: 131072',
    '        paceMs: 25',
    '',
  ].join('\n'))
}

async function browserRpc<T>(
  page: Page,
  method: string,
  args: Record<string, unknown>,
  payloadStyle: 'args' | 'direct' = 'args',
): Promise<RpcResponse<T>> {
  return await page.evaluate(async ({ rpcMethod, rpcArgs, rpcPayloadStyle }) => {
    const csrf = document.cookie.split(';').map(item => item.trim())
      .find(item => item.startsWith('xagent_csrf='))?.slice('xagent_csrf='.length)
    const response = await fetch(`/api/${rpcMethod}`, {
      method: 'POST', credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(csrf === undefined ? {} : { 'x-xagent-csrf': decodeURIComponent(csrf) }),
      },
      body: JSON.stringify({
        type: 'client-request', rpcId: crypto.randomUUID(), method: rpcMethod,
        payload: rpcPayloadStyle === 'direct' ? rpcArgs : { args: rpcArgs },
      }),
    })
    let result: RpcResponse<T>['result']
    try { result = (await response.json() as { result?: RpcResponse<T>['result'] }).result } catch { result = undefined }
    return { status: response.status, ...(result === undefined ? {} : { result }) }
  }, { rpcMethod: method, rpcArgs: args, rpcPayloadStyle: payloadStyle })
}

function value<T>(response: RpcResponse<T>): T {
  if (response.status !== 200 || response.result?.ok !== true) {
    throw new Error(`RPC failed: HTTP ${String(response.status)} ${JSON.stringify(response.result)}`)
  }
  return response.result.value
}

async function login(page: Page, email: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: '登录工作空间' })
  await dialog.getByRole('textbox', { name: '邮箱' }).fill(email)
  await dialog.getByLabel('密码').fill(PASSWORD)
  await dialog.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByText(email, { exact: true }).waitFor({ timeout: 30_000 })
}

async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.getByRole('dialog', { name: '登录工作空间' }).waitFor({ timeout: 30_000 })
}

async function dismissOnboarding(page: Page): Promise<void> {
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  await continueButton.waitFor({ timeout: 5_000 }).catch(() => undefined)
  if (await continueButton.isVisible().catch(() => false)) await continueButton.click()
  const later = page.getByRole('button', { name: '稍后配置', exact: true })
  await later.waitFor({ timeout: 5_000 }).catch(() => undefined)
  if (await later.isVisible().catch(() => false)) await later.click()
}

async function createProject(page: Page, name: string): Promise<string> {
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建项目' })
  await dialog.getByRole('textbox', { name: '项目名称' }).fill(name)
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  const bootstrap = value(await browserRpc<WorkbenchBootstrap>(page, 'xagentProject/bootstrap', {}))
  const project = bootstrap.projects.find(item => item.name === name)
  if (project === undefined) throw new Error(`created project ${name} was absent from bootstrap`)
  return project.id
}

async function uploadEvidence(page: Page): Promise<void> {
  await page.getByRole('tab', { name: '资料', exact: true }).click()
  const panel = page.getByRole('tabpanel', { name: '资料' })
  await panel.getByLabel('上传资料').setInputFiles({
    name: EVIDENCE_FILENAME, mimeType: 'text/plain', buffer: Buffer.from(EVIDENCE_BODY),
  })
  await panel.getByRole('heading', { name: EVIDENCE_FILENAME, level: 3 }).waitFor({ timeout: 30_000 })
  await expect.poll(async () => await panel.locator('[data-status="clean"]').count(), { timeout: 180_000 }).toBeGreaterThan(0)
}

async function sendNewPrompt(page: Page, prompt: string): Promise<string> {
  const sessionId = value(await browserRpc<CreatedSession>(page, 'session.create', {})).sessionId
  await page.reload({ waitUntil: 'domcontentloaded' })
  const blank = page.getByRole('button', { name: /^xagent-phase4b-e2e-/u }).first()
  await blank.waitFor({ timeout: 30_000 })
  await blank.click()
  await sendPrompt(page, prompt)
  return sessionId
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const textarea = page.locator('textarea').first()
  await expect.poll(async () => await textarea.isEditable(), { timeout: 30_000 }).toBe(true)
  await textarea.fill(prompt)
  await textarea.press('Enter')
}

function factProposals(project: string, override: string, fieldKey?: string): FactProposal[] {
  const where = fieldKey === undefined ? '' : ` WHERE field_key = ${sqlLiteral(fieldKey)}`
  return JSON.parse(psql(project, override, [
    "SELECT coalesce(jsonb_agg(jsonb_build_object('id', id::text, 'status', status, 'baseRevision', base_revision,",
    "'fieldKey', field_key, 'proposerId', proposer_id::text, 'decisionActorId', decision_actor_id::text,",
    "'assertionReason', assertion_reason) ORDER BY created_at, id), '[]'::jsonb)::text FROM fact_proposals",
    `${where};`,
  ].join(' '))) as FactProposal[]
}

function sessionTitle(project: string, override: string, sessionId: string): string {
  return psql(project, override, [
    "SELECT payload #>> '{data,title}' FROM xagent_session_events",
    `WHERE session_id = ${sqlLiteral(backendSessionId(sessionId))}::uuid AND event_type = 'session/title'`,
    'ORDER BY sequence DESC LIMIT 1;',
  ].join(' '))
}

function sessionEventCount(project: string, override: string, sessionId: string, eventType: string): number {
  return Number(psql(project, override, [
    'SELECT count(*) FROM xagent_session_events',
    `WHERE session_id = ${sqlLiteral(backendSessionId(sessionId))}::uuid AND event_type = ${sqlLiteral(eventType)};`,
  ].join(' ')))
}

function capturedRequests(path: string, sessionId: string): CapturedRequest[] {
  if (readFileSync(path, 'utf8').trim() === '') return []
  return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as CapturedRequest)
    .filter(item => item.sessionId === sessionId)
}

function lifecycleRecords(path: string, sessionId: string): LifecycleRecord[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as LifecycleRecord)
    .filter(record => record.sessionId === sessionId)
}

function countDecisionNotices(request: CapturedRequest): number {
  return (JSON.stringify(request.messages).match(/<fact-proposal-decisions>/gu) ?? []).length
}

function profileDump(root: string, profile: string): string {
  return execFileSync(process.execPath, [join(REPO_ROOT, 'apps/cli/lib/bin.js'), '--profile', profile, '--dump-config'], {
    cwd: root,
    env: factChildEnvironment(process.env, {
      DSH_HOME: join(root, `profile-${profile}`), DSH_AGENTS_HOME: join(root, `agents-${profile}`),
    }),
    encoding: 'utf8', timeout: 120_000,
  })
}

describe.skipIf(process.env.XAGENT_FACT_APPROVAL_E2E !== '1')(
  'XAgent Business Fact approval full stack',
  () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
    const identity = factApprovalIdentity(suffix)
    const ambientSecretName = 'XAGENT_PHASE4B_AMBIENT_SECRET'
    const ambientSentinel = `phase4b-ambient-secret-${suffix}`
    const resources = new FactE2eResourceOwner()
    const traffic = factTrafficObserver()
    let root = ''
    let override = ''
    let patch = ''
    let capture = ''
    let lifecycle = ''
    let observer = ''
    let replayPaths: readonly string[] = []
    let apiOrigin = ''
    let baseUrl = ''
    let projectId = ''
    let dshPort = 0
    let dshEnvironment: NodeJS.ProcessEnv = {}
    let dsh: OwnedChildProcess | undefined
    let browser: Browser | undefined
    let context: BrowserContext | undefined
    let page: Page | undefined
    let composeOwned = false
    const diagnostics: string[] = []
    const diagnosticSecrets = [ambientSentinel, SERVICE_TOKEN, PASSWORD]
    let dshOutput = ''

    const redact = (value: string): string => redactFactBrowserDiagnosticText(value, diagnosticSecrets)

    async function startHost(): Promise<OwnedChildProcess> {
      const owned = spawnOwnedChild(process.execPath, [
        join(REPO_ROOT, 'apps/cli/lib/bin.js'), '--profile', 'xagent-business', '--patch', patch,
        '--host', '127.0.0.1', '--port', String(dshPort),
      ], { cwd: root, env: dshEnvironment, stdio: ['ignore', 'pipe', 'pipe'] })
      const captureOutput = (chunk: Buffer): void => {
        dshOutput = `${dshOutput}${chunk.toString()}`.slice(-24_000)
      }
      owned.child.stdout?.on('data', captureOutput)
      owned.child.stderr?.on('data', captureOutput)
      await waitForLine(owned.child, /dsh web: (http:\/\/[^\s]+)/u, 'XAgent Business', diagnosticSecrets)
      return owned
    }

    async function startBrowser(storageState?: string): Promise<Browser> {
      const next = await chromium.launch({ headless: true, env: factChildEnvironment(process.env, {}) })
      context = await next.newContext({
        viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE,
        ...(storageState === undefined ? {} : { storageState }),
      })
      page = await context.newPage()
      page.on('console', (message) => {
        diagnostics.push(`console:${message.type()}:${redact(message.text())}`)
      })
      page.on('pageerror', (error) => {
        diagnostics.push(`pageerror:${redact(error.message)}`)
      })
      page.on('requestfailed', (request) => {
        diagnostics.push(`requestfailed:${factBrowserDiagnosticUrl(request.url())}:${redact(
          request.failure()?.errorText ?? '',
        )}`)
      })
      page.on('response', (response) => {
        const path = new URL(response.url()).pathname
        if (path.includes('xagentFact') || path.startsWith('/api/session.')) {
          traffic.record(response.request().method(), response.url(), response.status())
        }
        if (response.status() >= 500) diagnostics.push(`response:${String(response.status())}:${path}`)
      })
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
      return next
    }

    beforeAll(async () => {
      const previousAmbientSecret = process.env[ambientSecretName]
      process.env[ambientSecretName] = ambientSentinel
      resources.own('ambient secret sentinel', async () => {
        if (previousAmbientSecret === undefined) delete process.env.XAGENT_PHASE4B_AMBIENT_SECRET
        else process.env[ambientSecretName] = previousAmbientSecret
      })
      requireDist()
      root = mkdtempSync(join(tmpdir(), 'xagent-phase4b-e2e-'))
      override = join(root, 'compose.override.yml')
      patch = join(root, 'replay.patch.yml')
      capture = join(root, 'model-requests.jsonl')
      lifecycle = join(root, 'lifecycle.jsonl')
      observer = join(root, 'request-observer.mjs')
      replayPaths = writeReplayWorld(root)
      writeRequestObserver(observer)
      writeFileSync(capture, '', { mode: 0o600 })
      writeFileSync(lifecycle, '', { mode: 0o600 })
      writeReplayPatch(patch, replayPaths.slice(0, 4), observer, capture, lifecycle)
      const apiPort = await probeFreePort()
      const minioPort = await probeFreePort()
      const postgresPort = await probeFreePort()
      dshPort = await probeFreePort()
      apiOrigin = `http://127.0.0.1:${String(apiPort)}`
      baseUrl = `http://127.0.0.1:${String(dshPort)}`
      const { privateKey, publicKey } = generateKeyPairSync('ed25519')
      const rawPublicKey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64')
      const rawPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      diagnosticSecrets.push(rawPrivateKey)
      writeFileSync(override, factComposeOverride({
        apiImage: API_IMAGE, embeddingImage: EMBEDDING_IMAGE, apiPort, minioPort, postgresPort,
        delegationPublicKey: rawPublicKey,
      }))
      dshEnvironment = factChildEnvironment(process.env, {
        DSH_HOME: join(root, 'business-home'),
        DSH_AGENTS_HOME: join(root, 'business-agents'),
        XAGENT_API_ORIGIN: apiOrigin,
        XAGENT_SERVICE_TOKEN: SERVICE_TOKEN,
        XAGENT_ALLOWED_ORIGINS: baseUrl,
        XAGENT_ALLOW_INSECURE_COOKIE: '1',
        XAGENT_DELEGATION_PRIVATE_KEY: rawPrivateKey,
        XAGENT_DELEGATION_ISSUER: 'xagent-host',
        XAGENT_DELEGATION_AUDIENCE: 'xagent-api',
      })
      resources.own('temporary root', async () => { rmSync(root, { recursive: true, force: true }) })
      resources.own('Compose project', async () => {
        if (!composeOwned) return
        compose(identity.composeProject, override, ['down', '--volumes', '--remove-orphans'])
        const residue = [
          execFileSync('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${identity.composeProject}`], {
            encoding: 'utf8', env: factChildEnvironment(process.env, {}),
          }).trim(),
          execFileSync('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${identity.composeProject}`], {
            encoding: 'utf8', env: factChildEnvironment(process.env, {}),
          }).trim(),
          execFileSync('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${identity.composeProject}`], {
            encoding: 'utf8', env: factChildEnvironment(process.env, {}),
          }).trim(),
        ].filter(Boolean)
        if (residue.length > 0) throw new Error(`Docker residue: ${residue.join(', ')}`)
      })
      resources.own('Host', async () => { await stopChildProcess(dsh) })
      resources.own('Browser', async () => { await browser?.close() })
      composeOwned = true
      try {
        compose(identity.composeProject, override, [
          'up', '--detach', process.env.XAGENT_PHASE4B_NO_BUILD === '1' ? '--no-build' : '--build', '--wait',
        ])
        account(identity.composeProject, override, identity.managerEmail, 'manager')
        account(identity.composeProject, override, identity.specialistEmail, 'specialist')
        dsh = await startHost()
        browser = await startBrowser()
        await page!.getByRole('dialog', { name: '登录工作空间' }).waitFor({ timeout: 30_000 })
      } catch (error) {
        const logs = compose(identity.composeProject, override, ['logs', '--no-color', '--tail', '160']).slice(-12_000)
        throw new Error(`Phase4B stack startup failed: ${redact(String(error))}\n${redact(logs)}`)
      }
    }, 900_000)

    afterAll(async () => {
      await resources.dispose()
    }, 240_000)

    it('proves proposal, review, conflict, restart, projection, authorization, and replay through the built Browser', async () => {
      onTestFailed(async () => {
        if (page !== undefined) await saveFailureShot(page, 'xagent-fact-approval')
        const apiLogs = composeOwned
          ? compose(identity.composeProject, override, ['logs', '--no-color', '--tail', '500', 'api'])
            .split('\n')
            .filter(line => line.includes('/internal/xagent/facts/') || line.includes('/internal/xagent/sessions/'))
            .join('\n')
          : 'Compose not started'
        const workerLogs = composeOwned
          ? compose(identity.composeProject, override, ['logs', '--no-color', '--tail', '100', 'worker'])
          : 'Compose not started'
        const indexState = projectId === ''
          ? 'Project not created'
          : psql(identity.composeProject, override, [
            "SELECT i.status || ':' || j.status || ':' || j.attempts || ':' || coalesce(j.failure_code, '-')",
            'FROM artifact_text_indexes i JOIN artifact_index_jobs j ON j.index_id = i.id ORDER BY i.created_at;',
          ].join(' '))
        const sessionState = projectId === ''
          ? 'Project not created'
          : psql(identity.composeProject, override, [
            "SELECT sequence || ':' || event_type || ':' || coalesce(payload #>> '{data,error,code}',",
            "payload #>> '{data,reason,kind}', '-') FROM xagent_session_events ORDER BY created_at;",
          ].join(' '))
        const toolCallState = projectId === ''
          ? 'Project not created'
          : psql(identity.composeProject, override, [
            "SELECT sequence || ':' || coalesce(tool_call_id, '-') || ':' ||",
            "coalesce(payload #>> '{data,callId}', '-') || ':' || coalesce(payload #>> '{data,name}', '-')",
            "FROM xagent_session_events WHERE event_type = 'tool/call' ORDER BY created_at;",
          ].join(' '))
        const factAudit = projectId === ''
          ? 'Project not created'
          : psql(identity.composeProject, override,
            "SELECT action || ':' || result FROM audit_events WHERE action LIKE 'fact.%' ORDER BY created_at;")
        console.error(`Phase4B DSH diagnostics:\n${redact(dshOutput)}`
          + `\nPhase4B Browser diagnostics:\n${diagnostics.join('\n')}`
          + `\nPhase4B index state:\n${indexState}`
          + `\nPhase4B Session state:\n${sessionState}`
          + `\nPhase4B tool-call state:\n${toolCallState}`
          + `\nPhase4B Fact audit:\n${factAudit}`
          + `\nPhase4B lifecycle:\n${readFileSync(lifecycle, 'utf8')}`
          + `\nPhase4B worker diagnostics:\n${redact(workerLogs)}`
          + `\nPhase4B API diagnostics:\n${redact(apiLogs)}`)
      })
      const activePage = (): Page => page as Page
      await login(activePage(), identity.managerEmail)
      await dismissOnboarding(activePage())
      projectId = await createProject(activePage(), identity.projectName)
      await uploadEvidence(activePage())
      await expect.poll(() => psql(identity.composeProject, override, [
        'SELECT count(*) FROM artifact_search_heads h JOIN artifacts a ON a.id = h.artifact_id',
        `WHERE a.filename = ${sqlLiteral(EVIDENCE_FILENAME)};`,
      ].join(' ')), { timeout: 240_000, interval: 2_000 }).toBe('1')
      psql(identity.composeProject, override, [
        'INSERT INTO project_memberships (id, project_id, account_id)',
        `SELECT gen_random_uuid(), ${sqlLiteral(projectId)}::uuid, id FROM accounts`,
        `WHERE email IN (${sqlLiteral(identity.managerEmail)}, ${sqlLiteral(identity.specialistEmail)});`,
      ].join(' '))
      await activePage().reload({ waitUntil: 'domcontentloaded' })
      await activePage().getByRole('dialog', { name: '登录工作空间' }).waitFor({ timeout: 30_000 })
      await login(activePage(), identity.managerEmail)
      await activePage().getByRole('button', { name: identity.projectName, exact: true }).click()
      const managerAccountId = value(await browserRpc<WorkbenchBootstrap>(
        activePage(), 'xagentProject/bootstrap', {},
      )).account.id

      const managerSession = await sendNewPrompt(activePage(), MANAGER_PROMPT)
      const managerSuccess = activePage().getByText('年度预算事实提案已提交。', { exact: true })
      const managerFailure = activePage().getByText('本轮运行失败', { exact: true })
      await managerSuccess.or(managerFailure).first().waitFor({ timeout: 90_000 })
      if (await managerSuccess.count() === 0) throw new Error('manager Fact proposal turn failed')
      await activePage().getByRole('status').filter({ hasText: '事实提案' }).waitFor({ timeout: 30_000 })
      await activePage().getByRole('tab', { name: '事实', exact: true }).click()
      const factPanel = activePage().getByRole('region', { name: '事实审阅工作台' })
      const managerProposalRow = factPanel.getByRole('button', { name: /审阅提案“年度预算”/u })
      await managerProposalRow.waitFor({ timeout: 30_000 })
      await managerProposalRow.click()
      await factPanel.getByText('提案说明：').waitFor()
      await factPanel.getByRole('button', { name: '批准提案', exact: true }).click()
      const selfDialog = activePage().getByRole('dialog', { name: '批准事实提案' })
      await selfDialog.getByLabel('决定备注').fill('经理自审通过')
      await selfDialog.getByRole('button', { name: '确认批准' }).click()
      await factPanel.getByRole('button', { name: /打开当前事实“年度预算”/u }).waitFor({ timeout: 30_000 })
      const managerProposal = factProposals(identity.composeProject, override, 'budget.annual')[0]!
      expect(managerProposal).toMatchObject({ status: 'confirmed', baseRevision: 0, assertionReason: '已批准的年度计划' })

      const duplicate = await browserRpc<FactDecision>(activePage(), 'xagentFact/approve', {
        sessionId: managerSession, proposalId: managerProposal.id,
        input: { idempotencyKey: randomUUID(), decisionNote: '重复提交' },
      })
      expect(duplicate.result).toMatchObject({ ok: false, error: { code: 'fact-already-decided' } })
      const guessed = await browserRpc<FactProposal>(activePage(), 'xagentFact/proposal', {
        sessionId: managerSession, proposalId: '00000000-0000-0000-0000-000000000999',
      })
      expect(guessed.result).toMatchObject({ ok: false, error: { code: 'not-found' } })
      const guessedRevision = await browserRpc<JsonObject>(activePage(), 'xagentFact/revision', {
        sessionId: managerSession, revisionId: '00000000-0000-0000-0000-000000000998',
      })
      expect(guessedRevision.result).toMatchObject({ ok: false, error: { code: 'not-found' } })

      await switchFactAccount({
        logout: async () => { await logout(activePage()) },
        login: async (email, _password) => { await login(activePage(), email) },
      }, identity.specialistEmail, PASSWORD)
      const projectButton = activePage().getByRole('button', { name: identity.projectName, exact: true })
      await projectButton.click()
      await expect.poll(async () => await projectButton.getAttribute('aria-current')).toBe('page')
      const specialistAccountId = value(await browserRpc<WorkbenchBootstrap>(
        activePage(), 'xagentProject/bootstrap', {},
      )).account.id
      const specialistSession = await sendNewPrompt(activePage(), EVIDENCE_PROMPT)
      await activePage().getByRole('article', { name: '已验证回答' }).waitFor({ timeout: 120_000 })
      const evidenceProposal = factProposals(identity.composeProject, override, 'delivery.target_date')[0]!
      expect(evidenceProposal).toMatchObject({
        status: 'pending', baseRevision: 0, assertionReason: '客户签署的交付条款',
      })
      expect(psql(identity.composeProject, override, [
        'SELECT count(*) FROM fact_proposal_evidence',
        `WHERE proposal_id = ${sqlLiteral(evidenceProposal.id)}::uuid;`,
      ].join(' '))).toBe('1')
      await activePage().getByRole('tab', { name: '事实', exact: true }).click()
      await factPanel.getByRole('button', { name: /审阅提案“目标交付日期”/u }).click()
      expect(await factPanel.getByRole('button', { name: '批准提案' }).count()).toBe(0)
      await factPanel.getByRole('button', { name: '撤回提案' }).waitFor()

      await switchFactAccount({
        logout: async () => { await logout(activePage()) },
        login: async (email, _password) => { await login(activePage(), email) },
      }, identity.managerEmail, PASSWORD)
      await activePage().getByRole('button', { name: identity.projectName, exact: true }).click()
      const managerAgainstSpecialist = value(await browserRpc<FactPage<FactProposal>>(
        activePage(), 'xagentFact/list-proposals', {
          sessionId: specialistSession, input: { limit: 50 },
        }))
      const exactEvidenceProposal = managerAgainstSpecialist.items.find(item => item.id === evidenceProposal.id)
      if (exactEvidenceProposal === undefined) throw new Error('manager did not observe the specialist pending proposal')
      expect(exactEvidenceProposal).toMatchObject({
        id: evidenceProposal.id,
        projectId,
        fieldKey: 'delivery.target_date',
        label: '目标交付日期',
        value: { type: 'date', value: '2027-03-15' },
        proposerId: specialistAccountId,
        baseRevision: 0,
        assertionReason: '客户签署的交付条款',
        status: 'pending',
        evidence: [{ citationId: '[资料1]' }],
      })
      expect(exactEvidenceProposal?.decisionActorId).toBeUndefined()
      expect(exactEvidenceProposal?.decisionReason).toBeUndefined()
      expect(managerAgainstSpecialist.items.filter(item => item.id === evidenceProposal.id)).toHaveLength(1)

      const staleFirstSession = await sendNewPrompt(activePage(), STALE_FIRST_PROMPT)
      await activePage().getByText('第一版预算事实提案已提交。', { exact: true }).waitFor({ timeout: 90_000 })
      const staleSecondSession = await sendNewPrompt(activePage(), STALE_SECOND_PROMPT)
      await activePage().getByText('第二版预算事实提案已提交。', { exact: true }).waitFor({ timeout: 90_000 })
      const stale = factProposals(identity.composeProject, override, 'budget.annual').slice(1)
      expect(stale.map(item => item.baseRevision)).toEqual([1, 1])
      await activePage().getByRole('tab', { name: '事实', exact: true }).click()
      const pendingList = factPanel.getByRole('list', { name: '待审提案列表' })
      const staleFirstRow = pendingList.getByRole('button').filter({ hasText: '900,000' })
      await staleFirstRow.click()
      await factPanel.getByRole('button', { name: '批准提案' }).click()
      await activePage().getByRole('dialog', { name: '批准事实提案' })
        .getByRole('button', { name: '确认批准' }).click()
      await expect.poll(() => factProposals(identity.composeProject, override, 'budget.annual')[1]?.status).toBe('confirmed')
      const staleSecondRow = pendingList.getByRole('button').filter({ hasText: '950,000' })
      await staleSecondRow.click()
      await factPanel.getByRole('button', { name: '批准提案' }).click()
      await activePage().getByRole('dialog', { name: '批准事实提案' })
        .getByRole('button', { name: '确认批准' }).click()
      await expect.poll(() => factProposals(identity.composeProject, override, 'budget.annual')[2]?.status).toBe('conflicted')

      await factPanel.getByRole('button', { name: /打开当前事实“年度预算”/u }).click()
      const history = factPanel.getByRole('list', { name: '修订记录' })
      await history.waitFor()
      expect((await history.getByRole('listitem').allTextContents()).map(text => text.match(/v\d/u)?.[0]))
        .toEqual(['v2', 'v1'])

      const budgetHead = value(await browserRpc<FactPage<FactRevision>>(
        activePage(), 'xagentFact/list-heads', {
          sessionId: staleFirstSession, input: { limit: 50 },
        })).items.find(item => item.fieldKey === 'budget.annual')
      expect(budgetHead).toBeDefined()
      const budgetDetail = value(await browserRpc<FactRevisionDetail>(activePage(), 'xagentFact/revision', {
        sessionId: staleFirstSession, revisionId: budgetHead!.id,
      }))
      expect(budgetDetail.revision).toMatchObject({
        id: budgetHead!.id,
        projectId,
        fieldKey: 'budget.annual',
        label: '年度预算',
        value: { type: 'number', value: 900000 },
        contentRevision: 2,
        proposalId: stale[0]!.id,
        proposerId: managerAccountId,
        confirmedById: managerAccountId,
        assertionReason: '第一版预算复核',
      })
      expect(budgetDetail.history.map(item => ({
        value: item.value,
        revision: item.contentRevision,
        proposalId: item.proposalId,
        proposerId: item.proposerId,
        confirmedById: item.confirmedById,
      }))).toEqual([
        {
          value: { type: 'number', value: 900000 }, revision: 2, proposalId: stale[0]!.id,
          proposerId: managerAccountId, confirmedById: managerAccountId,
        },
        {
          value: { type: 'number', value: 810000 }, revision: 1, proposalId: managerProposal.id,
          proposerId: managerAccountId, confirmedById: managerAccountId,
        },
      ])

      const pendingStorageState = join(root, 'pending-browser-state.json')
      await context!.storageState({ path: pendingStorageState })
      browser = await restartFactService(browser!, async current => current.close(), async () => startBrowser(pendingStorageState))
      await activePage().getByText(identity.managerEmail, { exact: true }).waitFor({ timeout: 30_000 })
      await stopChildProcess(dsh)
      dsh = undefined
      await restartFactService(apiOrigin, async () => {
        compose(identity.composeProject, override, ['stop', 'api'])
      }, async () => {
        compose(identity.composeProject, override, ['up', '--detach', '--wait', 'api'])
        await waitForApi(apiOrigin)
        return apiOrigin
      })
      dsh = await startHost()
      await activePage().reload({ waitUntil: 'domcontentloaded' })
      await activePage().getByText(identity.managerEmail, { exact: true }).waitFor({ timeout: 30_000 })
      await activePage().getByRole('button', { name: identity.projectName, exact: true }).click()
      const pendingSession = activePage().getByRole('button')
        .filter({ hasText: sessionTitle(identity.composeProject, override, specialistSession) })
      await pendingSession.click()
      await activePage().getByText('目标交付日期事实提案已提交。', { exact: true }).waitFor({ timeout: 30_000 })
      const persistedFactMeta = JSON.parse(psql(identity.composeProject, override, [
        "SELECT payload #> '{data,meta}' FROM xagent_session_events",
        `WHERE session_id = ${sqlLiteral(backendSessionId(specialistSession))}::uuid`,
        "AND event_type = 'tool/result' AND payload #>> '{data,meta,kind}' = 'xagent-fact'",
        'ORDER BY sequence DESC LIMIT 1;',
      ].join(' '))) as JsonObject
      expect(persistedFactMeta).toEqual({
        kind: 'xagent-fact', status: 'pending', proposalId: evidenceProposal.id,
      })
      const pendingToolText = `事实提案 ${evidenceProposal.id} · 状态：待审`
      const pendingToolStatus = activePage().getByRole('status').filter({ hasText: pendingToolText })
      await pendingToolStatus.waitFor({ timeout: 30_000 })
      expect(await pendingToolStatus.allTextContents()).toEqual([pendingToolText])
      const afterPendingRestart = value(await browserRpc<FactPage<FactProposal>>(
        activePage(), 'xagentFact/list-proposals', {
          sessionId: specialistSession, input: { limit: 50 },
        }))
      expect(afterPendingRestart.items.filter(item => item.id === evidenceProposal.id)).toEqual([exactEvidenceProposal])

      await activePage().getByRole('tab', { name: '事实', exact: true }).click()
      const pendingRestartedFactPanel = activePage().getByRole('region', { name: '事实审阅工作台' })
      const evidenceRow = pendingRestartedFactPanel.getByRole('button', { name: /审阅提案“目标交付日期”/u })
      await evidenceRow.waitFor({ timeout: 30_000 })
      expect(await evidenceRow.count()).toBe(1)
      await evidenceRow.click()
      const turnCountBeforeDecision = psql(identity.composeProject, override, [
        'SELECT count(*) FROM xagent_session_events',
        `WHERE session_id = ${sqlLiteral(backendSessionId(specialistSession))}::uuid AND event_type = 'turn/start';`,
      ].join(' '))
      await pendingRestartedFactPanel.getByRole('button', { name: '批准提案' }).click()
      const evidenceDialog = activePage().getByRole('dialog', { name: '批准事实提案' })
      await evidenceDialog.getByLabel('决定备注').fill('合同证据已复核')
      await evidenceDialog.getByRole('button', { name: '确认批准' }).click()
      await expect.poll(() => factProposals(identity.composeProject, override, 'delivery.target_date')[0]?.status).toBe('confirmed')
      const decidedEvidence = value(await browserRpc<FactProposal>(activePage(), 'xagentFact/proposal', {
        sessionId: specialistSession, proposalId: evidenceProposal.id,
      }))
      expect(decidedEvidence).toMatchObject({
        id: evidenceProposal.id,
        proposerId: specialistAccountId,
        decisionActorId: managerAccountId,
        decisionReason: '合同证据已复核',
        status: 'confirmed',
      })
      expect(psql(identity.composeProject, override, [
        'SELECT count(*) FROM xagent_session_events',
        `WHERE session_id = ${sqlLiteral(backendSessionId(specialistSession))}::uuid AND event_type = 'turn/start';`,
      ].join(' '))).toBe(turnCountBeforeDecision)
      expect(psql(identity.composeProject, override, [
        'SELECT count(*) FROM business_outbox',
        `WHERE source_session_id = ${sqlLiteral(backendSessionId(specialistSession))}::uuid AND consumed_at IS NULL;`,
      ].join(' '))).toBe('1')

      const storageState = join(root, 'browser-state.json')
      await context!.storageState({ path: storageState })
      browser = await restartFactService(browser, async current => current.close(), async () => startBrowser(storageState))
      await activePage().getByText(identity.managerEmail, { exact: true }).waitFor({ timeout: 30_000 })
      await stopChildProcess(dsh)
      dsh = undefined
      await restartFactService(apiOrigin, async () => {
        compose(identity.composeProject, override, ['stop', 'api'])
      }, async () => {
        compose(identity.composeProject, override, ['up', '--detach', '--wait', 'api'])
        await waitForApi(apiOrigin)
        return apiOrigin
      })
      writeReplayPatch(patch, [replayPaths[4]!], observer, capture, lifecycle)
      dsh = await startHost()
      await activePage().reload({ waitUntil: 'domcontentloaded' })
      await activePage().getByText(identity.managerEmail, { exact: true }).waitFor({ timeout: 30_000 })

      await switchFactAccount({
        logout: async () => { await logout(activePage()) },
        login: async (email, _password) => { await login(activePage(), email) },
      }, identity.specialistEmail, PASSWORD)
      await activePage().getByRole('button', { name: identity.projectName, exact: true }).click()
      const onlySpecialistSession = activePage().getByRole('button')
        .filter({ hasText: sessionTitle(identity.composeProject, override, specialistSession) })
      await onlySpecialistSession.click()
      await activePage().getByText('目标交付日期事实提案已提交。', { exact: true }).waitFor({ timeout: 30_000 })
      const requestCountBefore = capturedRequests(capture, specialistSession).length
      expect(requestCountBefore).toBe(3)
      const lifecycleCountBefore = lifecycleRecords(lifecycle, specialistSession).length
      const turnEndsBeforeDecision = sessionEventCount(
        identity.composeProject, override, specialistSession, 'turn/end',
      )
      await sendPrompt(activePage(), DECISION_PROMPT)
      await expect.poll(
        () => {
          const recentLifecycle = lifecycleRecords(lifecycle, specialistSession).slice(lifecycleCountBefore)
          const failure = recentLifecycle.find(record => record.type.startsWith('agent/error:'))
          if (failure !== undefined) {
            throw new Error(`post-restart turn failed: ${failure.type}`)
          }
          return capturedRequests(capture, specialistSession).length
        },
        { timeout: 90_000 },
      ).toBe(4)
      await expect.poll(() => sessionEventCount(
        identity.composeProject, override, specialistSession, 'turn/end',
      ), { timeout: 90_000 }).toBe(turnEndsBeforeDecision + 1)
      const decisionRequest = capturedRequests(capture, specialistSession)[3]!
      expect(countDecisionNotices(decisionRequest)).toBe(1)
      expect(JSON.stringify(decisionRequest.messages)).toContain(evidenceProposal.id)
      expect(psql(identity.composeProject, override, [
        'SELECT count(*) FROM business_outbox',
        `WHERE source_session_id = ${sqlLiteral(backendSessionId(specialistSession))}::uuid AND consumed_at IS NULL;`,
      ].join(' '))).toBe('0')
      await sendPrompt(activePage(), NO_REPLAY_PROMPT)
      await expect.poll(
        () => capturedRequests(capture, specialistSession).length,
        { timeout: 90_000 },
      ).toBe(5)
      await expect.poll(() => sessionEventCount(
        identity.composeProject, override, specialistSession, 'turn/end',
      ), { timeout: 90_000 }).toBe(turnEndsBeforeDecision + 2)
      expect(countDecisionNotices(capturedRequests(capture, specialistSession)[4]!)).toBe(0)

      await activePage().getByRole('tab', { name: '事实', exact: true }).click()
      const restartedFactPanel = activePage().getByRole('region', { name: '事实审阅工作台' })
      const deliveryHead = restartedFactPanel.getByRole('button', { name: /打开当前事实“目标交付日期”/u })
      await deliveryHead.click()
      const deliveryHeadValue = value(await browserRpc<FactPage<FactRevision>>(
        activePage(), 'xagentFact/list-heads', {
          sessionId: specialistSession, input: { limit: 50 },
        })).items.find(item => item.fieldKey === 'delivery.target_date')
      if (deliveryHeadValue === undefined) throw new Error('confirmed delivery Fact was absent after restart')
      const deliveryDetail = value(await browserRpc<FactRevisionDetail>(activePage(), 'xagentFact/revision', {
        sessionId: specialistSession, revisionId: deliveryHeadValue.id,
      }))
      expect(deliveryDetail).toMatchObject({
        revision: {
          id: deliveryHeadValue.id,
          projectId,
          fieldKey: 'delivery.target_date',
          label: '目标交付日期',
          value: { type: 'date', value: '2027-03-15' },
          contentRevision: 1,
          proposalId: evidenceProposal.id,
          proposerId: specialistAccountId,
          confirmedById: managerAccountId,
          assertionReason: '客户签署的交付条款',
          evidence: [{ citationId: '[资料1]' }],
        },
      })
      expect(deliveryDetail.history).toEqual([deliveryDetail.revision])
      const evidenceButton = restartedFactPanel.getByRole('button', { name: /打开证据 \[资料1\]/u }).first()
      await evidenceButton.click()
      await activePage().getByText(/已定位安全版本/u).waitFor({ timeout: 30_000 })
      const preview = activePage().getByRole('dialog', { name: `${EVIDENCE_FILENAME} 全屏预览` })
      await preview.getByText(/已定位至不可变版本/u).waitFor({ timeout: 30_000 })
      await preview.getByRole('button', { name: '关闭预览' }).click()

      await activePage().getByRole('button', { name: '我的工作台', exact: true }).click()
      const privateSession = value(await browserRpc<CreatedSession>(activePage(), 'session.create', {})).sessionId
      await activePage().reload({ waitUntil: 'domcontentloaded' })
      expect(await activePage().getByRole('tab', { name: '事实', exact: true }).count()).toBe(0)
      const privateFacts = await browserRpc<FactPage<FactProposal>>(activePage(), 'xagentFact/list-proposals', {
        sessionId: privateSession, input: { limit: 50 },
      })
      expect(privateFacts.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })

      const businessDump = profileDump(root, 'xagent-business')
      expect(businessDump).toContain('@xagent/dsh-fact')
      expect(businessDump).toContain('@xagent/dsh-tool-fact')
      expect(businessDump).toContain('@xagent/dsh-ui-fact')
      for (const profile of ['xagent-developer', 'web', 'headless']) {
        const dump = profileDump(root, profile)
        expect(dump).not.toContain('@xagent/dsh-fact')
        expect(dump).not.toContain('@xagent/dsh-tool-fact')
        expect(dump).not.toContain('@xagent/dsh-ui-fact')
      }
      expect(businessDump).toMatch(/id: agent-presets[\s\S]*?disabled: true/u)

      const noContext = psql(identity.composeProject, override,
        'SET ROLE xagent_e2e_app; SELECT count(*) FROM fact_proposals; RESET ROLE;')
      expect(noContext.split('\n').find(line => /^\d+$/u.test(line))).toBe('0')
      const managerId = psql(identity.composeProject, override,
        `SELECT id::text FROM accounts WHERE email = ${sqlLiteral(identity.managerEmail)};`)
      const rlsVisible = psql(identity.composeProject, override, [
        'BEGIN; SET LOCAL ROLE xagent_e2e_app;',
        `SELECT set_config('app.actor_id', ${sqlLiteral(managerId)}, true);`,
        "SELECT set_config('app.actor_role', 'manager', true);",
        'SELECT count(*) FROM fact_proposals; COMMIT;',
      ].join(' ')).split('\n').filter(line => /^\d+$/u.test(line)).at(-1)
      expect(Number(rlsVisible)).toBeGreaterThanOrEqual(4)

      const exactOnce = JSON.parse(psql(identity.composeProject, override, [
        'SELECT jsonb_build_object(',
        "'proposals', (SELECT count(*) FROM fact_proposals WHERE id =",
        `${sqlLiteral(evidenceProposal.id)}::uuid),`,
        "'receipts', (SELECT count(*) FROM fact_proposal_receipts WHERE proposal_id =",
        `${sqlLiteral(evidenceProposal.id)}::uuid),`,
        "'consumedReceipts', (SELECT count(*) FROM fact_proposal_receipts WHERE proposal_id =",
        `${sqlLiteral(evidenceProposal.id)}::uuid AND consumed_at IS NOT NULL),`,
        "'revisions', (SELECT count(*) FROM project_fact_revisions WHERE proposal_id =",
        `${sqlLiteral(evidenceProposal.id)}::uuid),`,
        "'outbox', (SELECT count(*) FROM business_outbox WHERE aggregate_id =",
        `${sqlLiteral(evidenceProposal.id)}::uuid),`,
        "'consumedOutbox', (SELECT count(*) FROM business_outbox WHERE aggregate_id =",
        `${sqlLiteral(evidenceProposal.id)}::uuid AND consumed_at IS NOT NULL),`,
        "'decisionEvents', (SELECT count(*) FROM xagent_session_events WHERE session_id =",
        `${sqlLiteral(backendSessionId(specialistSession))}::uuid AND event_type = 'fact/proposal-decided'))::text;`,
      ].join(' '))) as JsonObject
      expect(exactOnce).toEqual({
        proposals: 1,
        receipts: 1,
        consumedReceipts: 1,
        revisions: 1,
        outbox: 1,
        consumedOutbox: 1,
        decisionEvents: 1,
      })
      const auditCounts = JSON.parse(psql(identity.composeProject, override, [
        "SELECT coalesce(jsonb_object_agg(action, total), '{}'::jsonb)::text FROM (",
        'SELECT action, count(*) AS total FROM audit_events',
        `WHERE details ->> 'proposal_id' = ${sqlLiteral(evidenceProposal.id)}`,
        'GROUP BY action ORDER BY action) observed;',
      ].join(' '))) as JsonObject
      expect(auditCounts).toEqual({
        'fact.admit': 1,
        'fact.approve': 1,
        'fact.confirm': 1,
        'fact.outbox.project': 1,
        'fact.prepare': 1,
      })

      psql(identity.composeProject, override, [
        'DELETE FROM project_memberships',
        `WHERE project_id = ${sqlLiteral(projectId)}::uuid AND account_id =`,
        `(SELECT id FROM accounts WHERE email = ${sqlLiteral(identity.specialistEmail)});`,
      ].join(' '))
      const revoked = await browserRpc<FactPage<FactProposal>>(activePage(), 'xagentFact/list-proposals', {
        sessionId: specialistSession, input: { limit: 50 },
      })
      expect(revoked).toEqual({ status: 401 })
      await activePage().reload({ waitUntil: 'domcontentloaded' })
      await activePage().getByRole('dialog', { name: '登录工作空间' }).waitFor({ timeout: 30_000 })

      const budget = factProposals(identity.composeProject, override, 'budget.annual')
      const delivery = factProposals(identity.composeProject, override, 'delivery.target_date')
      const summary = {
        selfApproval: { status: budget[0]?.status, baseRevision: budget[0]?.baseRevision },
        evidenceProposal: { status: delivery[0]?.status, evidenceCount: 1 },
        staleCompetition: budget.slice(1).map(item => ({ status: item.status, baseRevision: item.baseRevision })),
        revisionHistory: ['v2', 'v1'],
        decisionNotices: [countDecisionNotices(decisionRequest), countDecisionNotices(capturedRequests(capture, specialistSession)[4]!)],
        negativeCodes: ['fact-already-decided', 'not-found', 'not-found', 'session-not-found'],
        restarts: ['browser', 'host', 'fastapi'],
      }
      expect(summary).toEqual(JSON.parse(readFileSync(EXPECTED, 'utf8')))
      expect(traffic.entries().some(item => item.path === '/api/xagentFact/approve' && item.status === 200)).toBe(true)
      expect(traffic.entries().some(item => item.path.startsWith('/api/session.'))).toBe(true)
      const apiLogs = compose(identity.composeProject, override, ['logs', '--no-color', 'api'])
      const allServiceLogs = compose(identity.composeProject, override, ['logs', '--no-color'])
      expect(apiLogs).toContain('/internal/xagent/facts/')
      expect(apiLogs).toContain('/internal/xagent/sessions/')
      expect(diagnostics.join('\n')).not.toMatch(/(?:receipt|delegation|object_key|signed_url|bearer\s+eyJ)/iu)
      await activePage().screenshot({ path: join(root, 'sentinel-check.png'), fullPage: true })
      expect(redact(ambientSentinel)).toBe('[REDACTED]')
      expect(JSON.stringify(dshEnvironment)).not.toContain(ambientSentinel)
      expect([dshOutput, diagnostics.join('\n'), businessDump, apiLogs, allServiceLogs].join('\n'))
        .not.toContain(ambientSentinel)
      expect(factFilesContaining(root, ambientSentinel)).toEqual([])
      expect(staleFirstSession).not.toBe(staleSecondSession)
    }, 900_000)
  },
)
