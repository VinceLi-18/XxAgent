import type { ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { probeFreePort, REPO_ROOT, requireDist, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'
import {
  spawnOwnedChild,
  stopChildProcess,
  type OwnedChildProcess,
} from './xagent-artifact-support.ts'
import {
  browserDiagnosticUrl,
  redactBrowserDiagnosticText,
  structuredRetrievalIdentity,
} from './xagent-structured-retrieval-support.ts'

const SERVICE_TOKEN = 'xagent-e2e-service-token-test-only-0001'
const PASSWORD = 'Task12-Structured-2026!'
const API_IMAGE = process.env.XAGENT_TASK12_API_IMAGE ?? 'xagent-api:test'
const EMBEDDING_IMAGE = process.env.XAGENT_TASK12_EMBEDDING_IMAGE ?? 'xagent-embedding:test'
const FIRST_FILENAME = 'Task12-Alpha-证据.txt'
const SECOND_FILENAME = 'Task12-Beta-证据.txt'
const RETRIEVAL_QUERY = '联合复核 预算 供应链 恢复计划'
const PRIVATE_PROMPT = '请跨两个项目检索联合复核、预算、供应链和恢复计划，并给出带资料引用的结论。'
const PROJECT_PROMPT = '请只在当前项目检索联合复核预算，并给出带资料引用的结论。'
const INVALID_PROMPT = '请检索后提交一个引用无效的结构化回答，以验证有界重试。'
const REVOCATION_PROMPT = '请检索后生成一个很长的带引用回答。'
const REVOCATION_PREAMBLE_DELTAS = 8
const REVOCATION_TOTAL_DELTAS = 240

interface RpcResponse<T> {
  readonly status: number
  readonly result?: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
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

interface CreatedSession {
  readonly sessionId: string
}

interface CitationEvidence {
  readonly citationId: string
  readonly artifactId: string
  readonly versionId: string
  readonly chunkId: string
  readonly displayName: string
  readonly versionNumber: number
  readonly lineStart: number
  readonly lineEnd: number
}

interface TerminalAttemptEvidence {
  readonly calls: readonly string[]
  readonly errorResults: readonly string[]
  readonly terminalFailures: number
}

type JsonObject = Record<string, unknown>

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
      reject(new Error(`${label} did not become ready before its deadline:\n${redactBrowserDiagnosticText(output)}`))
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
      reject(new Error(`${label} exited before readiness (${code ?? 'signal'}):\n${redactBrowserDiagnosticText(output)}`))
    })
  })
}

function account(project: string, override: string, email: string, role: 'manager' | 'specialist'): void {
  compose(project, override, ['exec', '-T', 'api', 'xagent-api', 'account', 'create', '--email', email, '--role', role])
  compose(project, override, ['exec', '-T', 'api', 'xagent-api', 'account', 'set-password', '--email', email],
    `${PASSWORD}\n${PASSWORD}\n`)
}

function deactivateAccount(project: string, override: string, email: string): void {
  compose(project, override, ['exec', '-T', 'api', 'xagent-api', 'account', 'deactivate', '--email', email])
}

function psql(project: string, override: string, sql: string): string {
  return compose(project, override, [
    'exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'xagent_api_test', '-Atc', sql,
  ])
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function backendSessionId(sessionId: string): string {
  return sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
}

function terminalAttemptEvidence(project: string, override: string, sessionId: string): TerminalAttemptEvidence {
  const id = sqlLiteral(backendSessionId(sessionId))
  return JSON.parse(psql(project, override, [
    'SELECT jsonb_build_object(',
    "'calls', coalesce((SELECT jsonb_agg(payload #>> '{data,callId}' ORDER BY sequence)",
    'FROM xagent_session_events',
    `WHERE session_id = ${id}::uuid AND event_type = 'tool/call'`,
    "AND payload #>> '{data,name}' = 'submit_cited_answer'), '[]'::jsonb),",
    "'errorResults', coalesce((SELECT jsonb_agg(payload #>> '{data,message,source,callId}' ORDER BY sequence)",
    'FROM xagent_session_events',
    `WHERE session_id = ${id}::uuid AND event_type = 'tool/result'`,
    "AND payload #>> '{data,message,content,0,isError}' = 'true'",
    "AND payload #>> '{data,message,source,callId}' IN (SELECT payload #>> '{data,callId}'",
    'FROM xagent_session_events',
    `WHERE session_id = ${id}::uuid AND event_type = 'tool/call'`,
    "AND payload #>> '{data,name}' = 'submit_cited_answer')), '[]'::jsonb),",
    "'terminalFailures', (SELECT count(*) FROM xagent_session_events",
    `WHERE session_id = ${id}::uuid AND event_type = 'turn/end'`,
    "AND payload #>> '{data,reason,error,code}' = 'CITATION_FAILED'))::text;",
  ].join(' '))) as TerminalAttemptEvidence
}

function citationEvidence(project: string, override: string, sessionId: string, citationId: string): CitationEvidence {
  const row = psql(project, override, [
    "SELECT jsonb_build_object('citationId', citation->>'id',",
    "'artifactId', i.artifact_id::text, 'versionId', i.version_id::text, 'chunkId', c.id::text,",
    "'displayName', a.filename, 'versionNumber', v.version_number,",
    "'lineStart', c.line_start, 'lineEnd', c.line_end)::text",
    'FROM xagent_session_events e',
    "CROSS JOIN LATERAL jsonb_array_elements(((e.payload #>> '{data,message,content,0,content,0,text}')::jsonb)->'citations') citation",
    "JOIN artifact_text_chunks c ON c.id = (citation->>'chunk_id')::uuid",
    'JOIN artifact_text_indexes i ON i.id = c.index_id',
    'JOIN artifacts a ON a.id = i.artifact_id',
    'JOIN artifact_versions v ON v.id = i.version_id',
    `WHERE e.session_id = ${sqlLiteral(backendSessionId(sessionId))}::uuid`,
    "AND e.event_type = 'tool/result' AND e.tool_call_id = 'task12-private-search'",
    `AND citation->>'id' = ${sqlLiteral(citationId)}`,
    "AND i.artifact_id = (citation->>'artifact_id')::uuid",
    "AND i.version_id = (citation->>'version_id')::uuid",
    "AND a.filename = citation->>'display_name'",
    "AND v.version_number = (citation->>'version_number')::integer",
    "AND c.line_start = (citation->>'line_start')::integer",
    "AND c.line_end = (citation->>'line_end')::integer;",
  ].join(' '))
  if (row === '') throw new Error(`durable citation ${citationId} did not match its Artifact Version and chunk`)
  return JSON.parse(row) as CitationEvidence
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

function protectedPartial(): JsonObject[] {
  const chunks: JsonObject[] = [{ type: 'block-start', index: 0, blockType: 'text' }]
  for (let index = 0; index < REVOCATION_TOTAL_DELTAS; index++) {
    chunks.push({ type: 'text-delta', index: 0, text: 'partial-secret ' })
    if (index + 1 === REVOCATION_PREAMBLE_DELTAS) chunks.push(usage())
  }
  chunks.push(
    { type: 'block-end', index: 0, block: { type: 'text', text: 'partial-secret '.repeat(REVOCATION_TOTAL_DELTAS) } },
    { type: 'finish', reason: { kind: 'stop' } },
  )
  return chunks
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function projectIdPlaceholder(projectName: string): string {
  return `{{fromRequest:project_id[^0-9a-f]+([0-9a-f-]{36}).{0,50}name.{0,5}${escapeRegex(projectName)}}}`
}

function writeReplayLog(path: string, id: string, createdAt: number, calls: readonly JsonObject[][]): void {
  const lines = [JSON.stringify({ id, version: 0, createdAt, seedLength: 0 })]
  let sequence = 0
  calls.forEach((chunks, callIndex) => {
    chunks.forEach((chunk) => {
      lines.push(JSON.stringify({
        type: 'assistant/chunk',
        seq: sequence++,
        time: createdAt + sequence,
        data: { turn: 1, step: callIndex + 1, chunk },
      }))
    })
  })
  writeFileSync(path, `${lines.join('\n')}\n`)
}

function writeReplayWorld(root: string, identity: ReturnType<typeof structuredRetrievalIdentity>): readonly string[] {
  const paths = [0, 1, 2, 3].map(index => join(root, `replay-${String(index)}.jsonl`))
  writeReplayLog(paths[0]!, 'recorded-private', 1, [
    toolCall('task12-private-list', 'list_accessible_projects', {}),
    toolCall('task12-private-search', 'search_artifacts', {
      query: RETRIEVAL_QUERY,
      project_ids: [projectIdPlaceholder(identity.firstProjectName), projectIdPlaceholder(identity.secondProjectName)],
    }),
    toolCall('task12-private-invalid', 'submit_cited_answer', {
      blocks: [{ type: 'markdown', text: '需要修正引用。' }, { type: 'citation', id: '[资料999]' }],
    }),
    toolCall('task12-private-answer', 'submit_cited_answer', {
      blocks: [
        { type: 'markdown', text: '跨项目结论：预算与供应链需要联合复核；正文里的 [资料999](https://example.invalid/not-authority) 不是已验证资料。' },
        { type: 'citation', id: '[资料1]' },
        { type: 'markdown', text: '第二个项目补充了恢复计划。' },
        { type: 'citation', id: '[资料2]' },
      ],
    }),
  ])
  writeReplayLog(paths[1]!, 'recorded-project', 2, [
    toolCall('task12-project-search', 'search_artifacts', { query: RETRIEVAL_QUERY }),
    toolCall('task12-project-invalid', 'submit_cited_answer', {
      blocks: [{ type: 'markdown', text: '需要修正引用。' }, { type: 'citation', id: '[资料999]' }],
    }),
    toolCall('task12-project-answer', 'submit_cited_answer', {
      blocks: [
        { type: 'markdown', text: '当前项目的预算复核结论来自固定项目范围。' },
        { type: 'citation', id: '[资料1]' },
      ],
    }),
  ])
  writeReplayLog(paths[2]!, 'recorded-invalid', 3, [
    toolCall('task12-invalid-search', 'search_artifacts', { query: RETRIEVAL_QUERY }),
    toolCall('task12-invalid-answer-1', 'submit_cited_answer', {
      blocks: [{ type: 'markdown', text: '第一次无效。' }, { type: 'citation', id: '[资料999]' }],
    }),
    toolCall('task12-invalid-answer-2', 'submit_cited_answer', {
      blocks: [{ type: 'markdown', text: '第二次无效。' }, { type: 'citation', id: '[资料999]' }],
    }),
  ])
  writeReplayLog(paths[3]!, 'recorded-revocation', 4, [
    toolCall('task12-revocation-search', 'search_artifacts', { query: RETRIEVAL_QUERY }),
    protectedPartial(),
  ])
  return paths
}

async function browserRpc<T>(page: Page, method: string, payload: unknown): Promise<RpcResponse<T>> {
  return await page.evaluate(async ({ method: rpcMethod, payload: rpcPayload }) => {
    const generated = rpcMethod.startsWith('xagentProject.')
    const endpoint = generated ? rpcMethod.replace('.', '/') : rpcMethod
    const csrf = document.cookie.split(';').map(item => item.trim())
      .find(item => item.startsWith('xagent_csrf='))?.slice('xagent_csrf='.length)
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
    try { result = (await response.json() as { result?: RpcResponse<T>['result'] }).result } catch { result = undefined }
    return { status: response.status, ...(result === undefined ? {} : { result }) }
  }, { method, payload })
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
  const bootstrap = value(await browserRpc<WorkbenchBootstrap>(page, 'xagentProject.bootstrap', {}))
  const project = bootstrap.projects.find(item => item.name === name)
  if (project === undefined) throw new Error(`created project ${name} was absent from bootstrap`)
  return project.id
}

async function upload(page: Page, filename: string, body: string): Promise<void> {
  await page.getByRole('tab', { name: '资料', exact: true }).click()
  const panel = page.getByRole('tabpanel', { name: '资料' })
  await panel.getByLabel('上传资料').setInputFiles({ name: filename, mimeType: 'text/plain', buffer: Buffer.from(body) })
  await panel.getByRole('heading', { name: filename, level: 3 }).waitFor({ timeout: 30_000 })
  await expect.poll(async () => await panel.locator('[data-status="clean"]').count(), { timeout: 180_000 }).toBeGreaterThan(0)
}

async function waitForIndexed(project: string, override: string, filename: string): Promise<void> {
  await expect.poll(() => psql(project, override, [
    'SELECT count(*) FROM artifact_search_heads h',
    'JOIN artifacts a ON a.id = h.artifact_id',
    `WHERE a.filename = ${sqlLiteral(filename)};`,
  ].join(' ')), { timeout: 240_000, interval: 2_000 }).toBe('1')
}

async function sendNewPrompt(
  page: Page,
  prompt: string,
  visibility: 'private' | 'project',
  composeProject: string,
  override: string,
): Promise<string> {
  const sessionId = value(await browserRpc<CreatedSession>(page, 'session.create', {})).sessionId
  await page.reload({ waitUntil: 'domcontentloaded' })
  const blankSession = page.getByRole('button', { name: /^xagent-task12-e2e-/u }).first()
  await expect.poll(async () => await blankSession.count(), { timeout: 30_000 }).toBeGreaterThan(0)
  await blankSession.click()
  const textarea = page.locator('textarea').first()
  await expect.poll(async () => await textarea.isEditable(), { timeout: 30_000 }).toBe(true)
  let consecutiveIdle = 0
  await expect.poll(async () => {
    const active = psql(composeProject, override,
      "SELECT count(*) FROM pg_stat_activity WHERE datname = 'xagent_api_test' AND usename = 'xagent_e2e_app' AND state <> 'idle';")
    consecutiveIdle = active === '0' ? consecutiveIdle + 1 : 0
    return consecutiveIdle
  }, { timeout: 30_000, interval: 100 }).toBeGreaterThanOrEqual(3)
  expect(psql(composeProject, override, [
    'SELECT visibility FROM xagent_sessions',
    `WHERE id = ${sqlLiteral(backendSessionId(sessionId))}::uuid;`,
  ].join(' '))).toBe(visibility)
  await textarea.fill(prompt)
  await textarea.press('Enter')
  return sessionId
}

function profileDump(root: string, profile: string): string {
  return execFileSync(process.execPath, [
    join(REPO_ROOT, 'apps/cli/lib/bin.js'), '--profile', profile, '--dump-config',
  ], {
    cwd: root,
    env: { ...process.env, DSH_HOME: join(root, `profile-${profile}`), DSH_AGENTS_HOME: join(root, `agents-${profile}`) },
    encoding: 'utf8',
    timeout: 120_000,
  })
}

describe.skipIf(process.env.XAGENT_STRUCTURED_RETRIEVAL_E2E !== '1')(
  'XAgent Business structured retrieval full stack',
  () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
    const identity = structuredRetrievalIdentity(suffix)
    const frameRoot = process.env.XAGENT_TASK12_FRAMES_DIR
    let root = ''
    let override = ''
    let patch = ''
    let replayPaths: readonly string[] = []
    let composeOwned = false
    let dsh: OwnedChildProcess | undefined
    let browser: Browser | undefined
    let page: Page | undefined
    let baseUrl = ''
    let firstProjectId = ''
    let secondProjectId = ''
    const diagnostics: string[] = []
    let dshOutput = ''

    async function frame(name: string, anchor?: Locator, x = 300): Promise<void> {
      if (frameRoot === undefined || page === undefined) return
      mkdirSync(frameRoot, { recursive: true })
      const box = await anchor?.boundingBox()
      const y = Math.min(400, Math.max(0, Math.floor(box?.y ?? 100)))
      await page.screenshot({
        path: join(frameRoot, `${name}.png`),
        clip: { x, y, width: 1_100, height: 500 },
      })
    }

    beforeAll(async () => {
      requireDist()
      root = mkdtempSync(join(tmpdir(), 'xagent-task12-e2e-'))
      override = join(root, 'compose.override.yml')
      patch = join(root, 'replay.patch.yml')
      replayPaths = writeReplayWorld(root, identity)
      const apiPort = await probeFreePort()
      const minioPort = await probeFreePort()
      const postgresPort = await probeFreePort()
      const dshPort = await probeFreePort()
      baseUrl = `http://127.0.0.1:${String(dshPort)}`
      const { privateKey, publicKey } = generateKeyPairSync('ed25519')
      const rawPublicKey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64')
      const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      writeFileSync(override, [
        'services:',
        '  api:',
        `    image: ${API_IMAGE}`,
        '    environment:',
        '      PYTHONPATH: /app',
        `      MINIO_PUBLIC_ENDPOINT: 127.0.0.1:${String(minioPort)}`,
        `      XAGENT_DELEGATION_PUBLIC_KEY: ${rawPublicKey}`,
        '    ports: !override',
        `      - 127.0.0.1:${String(apiPort)}:8000`,
        '  worker:',
        `    image: ${API_IMAGE}`,
        '    environment:',
        '      PYTHONPATH: /app',
        '  roles:',
        `    image: ${API_IMAGE}`,
        '    environment:',
        '      PYTHONPATH: /app',
        '  migrate:',
        `    image: ${API_IMAGE}`,
        '    environment:',
        '      PYTHONPATH: /app',
        '  embedding:',
        `    image: ${EMBEDDING_IMAGE}`,
        '  minio:',
        '    ports: !override',
        `      - 127.0.0.1:${String(minioPort)}:9000`,
        '  postgres:',
        '    ports: !override',
        `      - 127.0.0.1:${String(postgresPort)}:5432`,
        '',
      ].join('\n'))
      writeFileSync(patch, [
        '- id: llm-deepseek',
        '  disabled: true',
        '- id: session-title-llm',
        '  disabled: true',
        '- insert:',
        '    - id: task12-llm-replay',
        `      name: ${JSON.stringify(join(REPO_ROOT, 'packages/test-support/llm-replay/lib/index.js'))}`,
        '      config:',
        `        file: ${JSON.stringify(replayPaths[0])}`,
        '        childFiles:',
        ...replayPaths.slice(1).map(path => `          - ${JSON.stringify(path)}`),
        '        providers:',
        '          - id: deepseek-official',
        '            name: Task12 deterministic replay',
        '            models:',
        '              - id: deepseek-v4-flash',
        '                name: Task12 deterministic replay',
        '                contextWindow: 131072',
        '        paceMs: 50',
        '',
      ].join('\n'))
      composeOwned = true
      try {
        compose(identity.composeProject, override, [
          'up', '--detach', process.env.XAGENT_TASK12_NO_BUILD === '1' ? '--no-build' : '--build', '--wait',
        ])
        account(identity.composeProject, override, identity.managerEmail, 'manager')
        account(identity.composeProject, override, identity.specialistEmail, 'specialist')
        dsh = spawnOwnedChild(process.execPath, [
          join(REPO_ROOT, 'apps/cli/lib/bin.js'), '--profile', 'xagent-business', '--patch', patch,
          '--host', '127.0.0.1', '--port', String(dshPort),
        ], {
          cwd: root,
          env: {
            ...process.env,
            DSH_HOME: join(root, 'business-home'),
            DSH_AGENTS_HOME: join(root, 'business-agents'),
            XAGENT_API_ORIGIN: `http://127.0.0.1:${String(apiPort)}`,
            XAGENT_SERVICE_TOKEN: SERVICE_TOKEN,
            XAGENT_ALLOWED_ORIGINS: baseUrl,
            XAGENT_ALLOW_INSECURE_COOKIE: '1',
            XAGENT_DELEGATION_PRIVATE_KEY: privateKeyPem,
            XAGENT_DELEGATION_ISSUER: 'xagent-host',
            XAGENT_DELEGATION_AUDIENCE: 'xagent-api',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const captureDshOutput = (chunk: Buffer): void => {
          dshOutput = `${dshOutput}${chunk.toString()}`.slice(-24_000)
        }
        dsh.child.stdout?.on('data', captureDshOutput)
        dsh.child.stderr?.on('data', captureDshOutput)
        await waitForLine(dsh.child, /dsh web: (http:\/\/[^\s]+)/u, 'XAgent Business')
        browser = await chromium.launch({ headless: true })
        page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE })
        page.on('console', (message) => { diagnostics.push(`console:${message.type()}:${redactBrowserDiagnosticText(message.text())}`) })
        page.on('pageerror', (error) => { diagnostics.push(`pageerror:${redactBrowserDiagnosticText(error.message)}`) })
        page.on('requestfailed', (request) => {
          diagnostics.push(`requestfailed:${browserDiagnosticUrl(request.url())}:${redactBrowserDiagnosticText(request.failure()?.errorText ?? '')}`)
        })
        page.on('response', (response) => {
          if (response.status() >= 500) diagnostics.push(`response:${String(response.status())}:${browserDiagnosticUrl(response.url())}`)
        })
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
        await page.getByRole('dialog', { name: '登录工作空间' }).waitFor({ timeout: 30_000 })
      } catch (error) {
        const logs = compose(identity.composeProject, override, ['logs', '--no-color', '--tail', '200']).slice(-12_000)
        throw new Error(`Task12 stack startup failed: ${String(error)}\n${redactBrowserDiagnosticText(logs)}`)
      }
    }, 900_000)

    afterAll(async () => {
      const errors: string[] = []
      await browser?.close().catch((error: unknown) => { errors.push(`browser: ${String(error)}`) })
      await stopChildProcess(dsh).catch((error: unknown) => { errors.push(`dsh: ${String(error)}`) })
      if (composeOwned) {
        try { compose(identity.composeProject, override, ['down', '--volumes', '--remove-orphans']) } catch (error) {
          errors.push(`compose down: ${String(error)}`)
        }
        const residue = [
          execFileSync('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${identity.composeProject}`], { encoding: 'utf8' }).trim(),
          execFileSync('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${identity.composeProject}`], { encoding: 'utf8' }).trim(),
          execFileSync('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${identity.composeProject}`], { encoding: 'utf8' }).trim(),
        ].filter(Boolean)
        if (residue.length > 0) errors.push(`Docker residue: ${residue.join(', ')}`)
      }
      if (root !== '') rmSync(root, { recursive: true, force: true })
      if (errors.length > 0) throw new Error(errors.join('\n'))
    }, 240_000)

    it('crosses production retrieval, terminal citation, replay, revocation, and profile isolation', async () => {
      onTestFailed(async () => {
        if (page !== undefined) await saveFailureShot(page, 'xagent-structured-retrieval')
        const events = firstProjectId.length === 0
          ? 'no project/session evidence available'
          : psql(identity.composeProject, override, [
            "SELECT sequence || ':' || event_type || ':' || coalesce(tool_call_id, '-') || ':'",
            "|| coalesce(payload #>> '{data,reason,error,code}', payload #>> '{data,message,content,0,isError}', '-')",
            'FROM xagent_session_events ORDER BY created_at DESC LIMIT 30;',
          ].join(' '))
        const audits = firstProjectId.length === 0
          ? 'no project/session evidence available'
          : psql(identity.composeProject, override,
            "SELECT action || ':' || result FROM audit_events WHERE action LIKE 'retrieval.%' ORDER BY created_at;")
        const receipts = firstProjectId.length === 0
          ? 'no project/session evidence available'
          : psql(identity.composeProject, override, [
            "SELECT session_id::text || ':' || kind || ':' || tool_call_id || ':'",
            "|| coalesce(citation_ordinal_start::text, '-') || ':' || coalesce(citation_ordinal_end::text, '-') || ':'",
            "|| CASE WHEN consumed_at IS NULL THEN 'pending' ELSE 'consumed' END || ':' || chunk_ids::text",
            'FROM xagent_retrieval_receipts ORDER BY issued_at;',
          ].join(' '))
        const apiLogs = compose(identity.composeProject, override, ['logs', '--no-color', '--tail', '120', 'api'])
        console.error(`Task12 DSH diagnostics:\n${redactBrowserDiagnosticText(dshOutput)}\nTask12 events:\n${events}`
          + `\nTask12 audits:\n${audits}\nTask12 receipts:\n${receipts}`
          + `\nTask12 API logs:\n${redactBrowserDiagnosticText(apiLogs)}`)
      })
      const activePage = page!
      await login(activePage, identity.managerEmail)
      await dismissOnboarding(activePage)
      const managerAccount = value(await browserRpc<WorkbenchBootstrap>(activePage, 'xagentProject.bootstrap', {})).account
      expect(managerAccount).toMatchObject({ email: identity.managerEmail, role: 'manager' })

      firstProjectId = await createProject(activePage, identity.firstProjectName)
      await upload(activePage, FIRST_FILENAME, [
        'Task12 Alpha 预算复核',
        '联合复核要求预算负责人确认季度额度。',
        '供应链恢复计划需要与预算同步审批。',
        '混合检索共享词：预算、联合复核、恢复计划和供应链。',
        'Alpha 的结论是先核对额度，再批准采购。',
      ].join('\n'))
      await waitForIndexed(identity.composeProject, override, FIRST_FILENAME)

      secondProjectId = await createProject(activePage, identity.secondProjectName)
      await upload(activePage, SECOND_FILENAME, [
        'Task12 Beta 供应链恢复计划',
        '联合复核要求供应链负责人确认恢复窗口。',
        '预算审批需要引用恢复计划的时间表。',
        '混合检索共享词：供应链、恢复计划、预算与联合复核。',
        'Beta 的结论是验证恢复窗口并保留回滚方案。',
      ].join('\n'))
      await waitForIndexed(identity.composeProject, override, SECOND_FILENAME)
      await frame('01-project-scopes', undefined, 20)

      const workbenchButton = activePage.getByRole('button', { name: '我的工作台', exact: true })
      await workbenchButton.click()
      await expect.poll(async () => await workbenchButton.getAttribute('aria-current')).toBe('page')
      const privateSession = await sendNewPrompt(
        activePage, PRIVATE_PROMPT, 'private', identity.composeProject, override,
      )
      const privateAnswer = activePage.getByRole('article', { name: '已验证回答' })
      const privateFailure = activePage.getByText('本轮运行失败', { exact: true })
      await privateAnswer.or(privateFailure).first().waitFor({ timeout: 90_000 })
      if (await privateAnswer.count() === 0) throw new Error('private cited-answer request failed')
      expect(await privateAnswer.count()).toBe(1)
      expect(await privateFailure.count()).toBe(0)
      const correctionState = activePage.getByRole('status').filter({ hasText: '引用验证未通过，回答未发布' })
      expect(await correctionState.count()).toBe(1)
      const liveText = await privateAnswer.innerText()
      const liveHtml = await privateAnswer.innerHTML()
      expect(liveText).toContain('跨项目结论')
      expect(liveText).toContain('第二个项目补充了恢复计划')
      expect(await privateAnswer.getByRole('button', { name: '已验证资料 [资料1]' }).count()).toBe(2)
      expect(await privateAnswer.getByRole('button', { name: '已验证资料 [资料2]' }).count()).toBe(2)
      expect(await privateAnswer.getByRole('button', { name: /资料999/u }).count()).toBe(0)
      expect(await privateAnswer.getByRole('link').count()).toBe(0)
      await privateAnswer.getByRole('navigation', { name: '已验证资料来源' }).waitFor()
      await frame('02-structured-answer', correctionState)

      expect(terminalAttemptEvidence(identity.composeProject, override, privateSession)).toEqual({
        calls: ['task12-private-invalid', 'task12-private-answer'],
        errorResults: ['task12-private-invalid'],
        terminalFailures: 0,
      })

      expect(psql(identity.composeProject, override, [
        'SELECT count(DISTINCT project_id) FROM xagent_session_project_refs',
        `WHERE session_id = ${sqlLiteral(backendSessionId(privateSession))}::uuid;`,
      ].join(' '))).toBe('2')
      expect(psql(identity.composeProject, override, [
        'SELECT count(*) FROM artifact_text_chunks c JOIN artifact_text_indexes i ON i.id = c.index_id',
        "WHERE i.status = 'ready' AND i.vector_dimensions = 1024 AND length(c.normalized_text) > 0;",
      ].join(' '))).toMatch(/^[2-9]\d*$/u)

      await activePage.reload({ waitUntil: 'domcontentloaded' })
      const replayedAnswer = activePage.getByRole('article', { name: '已验证回答' })
      await replayedAnswer.waitFor({ timeout: 30_000 })
      expect(await replayedAnswer.innerText()).toBe(liveText)
      expect(await replayedAnswer.innerHTML()).toBe(liveHtml)
      await frame('03-replayed-answer', replayedAnswer)

      const expectedCitation = citationEvidence(identity.composeProject, override, privateSession, '[资料1]')
      expect(expectedCitation.citationId).toBe('[资料1]')
      expect([FIRST_FILENAME, SECOND_FILENAME]).toContain(expectedCitation.displayName)
      const resolvedCitation = value(await browserRpc<{
        artifactId: string
        versionId: string
        chunkId: string
        lineStart: number
        lineEnd: number
      }>(activePage, 'xagentCitation/resolve', {
        args: { sessionId: privateSession, citationId: '[资料1]' },
      }))
      expect(resolvedCitation).toEqual({
        artifactId: expectedCitation.artifactId,
        versionId: expectedCitation.versionId,
        chunkId: expectedCitation.chunkId,
        lineStart: expectedCitation.lineStart,
        lineEnd: expectedCitation.lineEnd,
      })
      await replayedAnswer.getByRole('button', { name: '已验证资料 [资料1]' }).first().click()
      await activePage.getByText(
        `已定位安全版本，第 ${String(expectedCitation.lineStart)}–${String(expectedCitation.lineEnd)} 行`,
        { exact: true },
      ).waitFor({ timeout: 30_000 })
      const preview = activePage.getByRole('dialog', { name: `${expectedCitation.displayName} 全屏预览` })
      await preview.getByText(
        `已定位至不可变版本，第 ${String(expectedCitation.lineStart)}–${String(expectedCitation.lineEnd)} 行`,
        { exact: true },
      ).waitFor({ timeout: 30_000 })
      expect(await preview.locator('[data-citation-line="true"]').count())
        .toBe(expectedCitation.lineEnd - expectedCitation.lineStart + 1)
      expect(await preview.innerText()).not.toContain(RETRIEVAL_QUERY)
      await frame('04-immutable-citation', preview, 0)
      await preview.getByRole('button', { name: '关闭预览' }).click()

      const firstProjectButton = activePage.getByRole('button', { name: identity.firstProjectName, exact: true })
      await firstProjectButton.click()
      await expect.poll(async () => await firstProjectButton.getAttribute('aria-current')).toBe('page')
      const projectSession = await sendNewPrompt(
        activePage, PROJECT_PROMPT, 'project', identity.composeProject, override,
      )
      await activePage.getByRole('article', { name: '已验证回答' }).waitFor({ timeout: 90_000 })
      expect(psql(identity.composeProject, override, [
        "SELECT visibility || ':' || project_id::text FROM xagent_sessions",
        `WHERE id = ${sqlLiteral(backendSessionId(projectSession))}::uuid;`,
      ].join(' '))).toBe(`project:${firstProjectId}`)
      expect(JSON.parse(psql(identity.composeProject, override, [
        "SELECT jsonb_build_object('projectIds', project_ids, 'scope', scope)::text",
        'FROM xagent_retrieval_receipts',
        `WHERE session_id = ${sqlLiteral(backendSessionId(projectSession))}::uuid`,
        "AND kind = 'artifact_search' AND consumed_at IS NOT NULL;",
      ].join(' ')))).toMatchObject({
        projectIds: [firstProjectId],
        scope: { kind: 'project', project_ids: [firstProjectId], include_private: false },
      })

      const invalidSession = await sendNewPrompt(
        activePage, INVALID_PROMPT, 'project', identity.composeProject, override,
      )
      const terminalFailure = activePage.getByText('本轮运行失败', { exact: true })
      await terminalFailure.waitFor({ timeout: 90_000 })
      expect(await terminalFailure.count()).toBe(1)
      expect(await activePage.getByRole('status').filter({ hasText: '引用验证未通过，回答未发布' }).count()).toBe(2)
      expect(terminalAttemptEvidence(identity.composeProject, override, invalidSession)).toEqual({
        calls: ['task12-invalid-answer-1', 'task12-invalid-answer-2'],
        errorResults: ['task12-invalid-answer-1', 'task12-invalid-answer-2'],
        terminalFailures: 1,
      })

      const revocationSession = await sendNewPrompt(
        activePage, REVOCATION_PROMPT, 'project', identity.composeProject, override,
      )
      await expect.poll(() => psql(identity.composeProject, override, [
        'SELECT count(*) FROM xagent_session_events',
        `WHERE session_id = ${sqlLiteral(backendSessionId(revocationSession))}::uuid`,
        "AND event_type = 'assistant/chunk' AND payload #>> '{data,chunk,type}' = 'usage'",
        'AND sequence > (SELECT sequence FROM xagent_session_events',
        `WHERE session_id = ${sqlLiteral(backendSessionId(revocationSession))}::uuid`,
        "AND event_type = 'tool/result' AND tool_call_id = 'task12-revocation-search');",
      ].join(' ')), { timeout: 60_000, interval: 100 }).toBe('1')
      const stopGenerating = activePage.getByRole('button', { name: '停止生成', exact: true })
      await stopGenerating.waitFor({ timeout: 30_000 })
      expect(psql(identity.composeProject, override, [
        'SELECT count(*) FROM xagent_session_events',
        `WHERE session_id = ${sqlLiteral(backendSessionId(revocationSession))}::uuid`,
        "AND event_type = 'turn/end';",
      ].join(' '))).toBe('0')
      expect(await activePage.locator('body').innerText()).not.toContain('partial-secret')
      deactivateAccount(identity.composeProject, override, identity.managerEmail)
      expect(psql(identity.composeProject, override, [
        'SELECT is_active::text FROM accounts',
        `WHERE id = ${sqlLiteral(managerAccount.id)}::uuid AND email = ${sqlLiteral(identity.managerEmail)};`,
      ].join(' '))).toBe('false')
      await expect.poll(() => compose(identity.composeProject, override, [
        'logs', '--no-color', '--tail', '80', 'api',
      ]).split('\n').some(line => line.includes(
        `/internal/xagent/sessions/${backendSessionId(revocationSession)}/append`,
      ) && line.includes('401 Unauthorized')), { timeout: 30_000, interval: 500 }).toBe(true)
      expect(await activePage.locator('body').innerText()).not.toContain('partial-secret')
      expect(psql(identity.composeProject, override, [
        'SELECT count(*) FROM xagent_session_events',
        `WHERE session_id = ${sqlLiteral(backendSessionId(revocationSession))}::uuid`,
        "AND payload::text LIKE '%partial-secret%';",
      ].join(' '))).toBe('0')
      expect(psql(identity.composeProject, override, [
        'SELECT count(*) FROM xagent_session_events',
        `WHERE session_id = ${sqlLiteral(backendSessionId(revocationSession))}::uuid`,
        "AND event_type = 'tool/result' AND payload::text LIKE '%xagent-cited-answer%';",
      ].join(' '))).toBe('0')
      await activePage.getByRole('button', { name: '退出登录', exact: true }).click()
      await activePage.getByRole('dialog', { name: '登录工作空间' }).waitFor({ timeout: 30_000 })
      expect(await stopGenerating.count()).toBe(0)
      expect(await activePage.locator('body').innerText()).not.toContain('partial-secret')

      await login(activePage, identity.specialistEmail)
      const specialistBootstrap = value(await browserRpc<WorkbenchBootstrap>(activePage, 'xagentProject.bootstrap', {}))
      expect(specialistBootstrap.account).toMatchObject({ email: identity.specialistEmail, role: 'specialist' })
      expect(specialistBootstrap.account.id).not.toBe(managerAccount.id)
      expect(specialistBootstrap.projects).toEqual([])
      expect(specialistBootstrap.sessionScopes).toEqual([])
      expect(await activePage.getByText(identity.firstProjectName, { exact: true }).count()).toBe(0)
      expect(await activePage.getByText(identity.secondProjectName, { exact: true }).count()).toBe(0)
      expect(await activePage.getByRole('article', { name: '已验证回答' }).count()).toBe(0)
      await frame('05-account-isolation', undefined, 20)

      const businessDump = profileDump(root, 'xagent-business')
      expect(businessDump).toContain('@xagent/dsh-retrieval')
      expect(businessDump).toContain('@xagent/dsh-tool-retrieval')
      expect(businessDump).toContain('@xagent/dsh-ui-citation')
      expect(businessDump).toMatch(/id: tool-subagent[\s\S]*?disabled: true/u)
      for (const profile of ['xagent-developer', 'web', 'headless']) {
        const dump = profileDump(root, profile)
        expect(dump).not.toContain('@xagent/dsh-retrieval')
        expect(dump).not.toContain('@xagent/dsh-tool-retrieval')
        expect(dump).not.toContain('@xagent/dsh-ui-citation')
      }
      expect(diagnostics.join('\n')).not.toContain(RETRIEVAL_QUERY)
      expect(diagnostics.join('\n')).not.toMatch(/(?:receipt|delegation|object_key|signed_url|bearer\s+eyJ)/iu)
      expect(JSON.parse(psql(identity.composeProject, override, [
        'SELECT jsonb_agg(id::text ORDER BY id)::text FROM projects',
        `WHERE id IN (${sqlLiteral(firstProjectId)}::uuid, ${sqlLiteral(secondProjectId)}::uuid);`,
      ].join(' '))) as unknown).toEqual([firstProjectId, secondProjectId].sort())
    }, 900_000)
  },
)
