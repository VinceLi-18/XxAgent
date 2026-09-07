// @vitest-environment jsdom
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { boot, composeEntries, healProfilesModuleFallback, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TOOL_RUNTIME_CODE_SCHEMAS } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocketTransport from 'ws'

const installAnchor = join(process.cwd(), 'apps/cli/package.json')
const actorId = '00000000-0000-0000-0000-000000000001'
const authSessionId = '00000000-0000-0000-0000-000000000101'
const projectId = '00000000-0000-0000-0000-000000000401'
const privateSessionId = 'session-00000000-0000-0000-0000-000000000711'
const projectSessionId = 'session-00000000-0000-0000-0000-000000000712'
const browserSessionId = 'session-00000000-0000-0000-0000-000000000713'
const artifactId = '00000000-0000-0000-0000-000000000501'
const versionId = '00000000-0000-0000-0000-000000000502'
const chunkId = '00000000-0000-0000-0000-000000000503'
const serviceToken = 'xagent-retrieval-loader-service-token'
const userToken = 'xagent-retrieval-loader-user-token'
const csrfToken = 'xagent-retrieval-loader-csrf-token'

interface StoredSession {
  readonly id: string
  readonly runtimeHeader: Record<string, unknown>
  readonly visibility: 'private' | 'project'
  readonly projectId: string | null
  lastEventSequence: number
  version: number
}

interface BackendObservation {
  readonly path: string
  readonly authorization: string | undefined
  readonly serviceToken: string | undefined
  readonly delegation: string | undefined
  readonly requestBody: unknown
}

interface RpcResponse<T> {
  readonly result?: { readonly ok: true; readonly value: T } | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${String(address.port)}`)
    })
  })
}

function close(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return Promise.resolve()
  server.closeAllConnections()
  return new Promise((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
}

async function freePort(): Promise<number> {
  const server = createServer()
  const origin = await listen(server)
  await close(server)
  return Number(new URL(origin).port)
}

async function requestBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  const value = Buffer.concat(chunks).toString('utf8')
  return value.length === 0 ? undefined : JSON.parse(value) as unknown
}

function searchResponse(receipt: string): Record<string, unknown> {
  const citations = [{
    id: '[资料1]',
    artifact_id: artifactId,
    version_id: versionId,
    chunk_id: chunkId,
    display_name: '季度纪要.pdf',
    version_number: 3,
    line_start: 7,
    line_end: 9,
    text: '结构化检索只进入 Business。',
    scope: 'project',
  }]
  const payload = { schema_version: 1, citations }
  return {
    ...payload,
    receipt,
    payload_sha256: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
  }
}

function backend(
  observations: BackendObservation[],
  stored: Map<string, StoredSession>,
): Server {
  let selectedProject: string | null = null
  let searchSequence = 0
  const bootstrap = (): Record<string, unknown> => ({
    schema_version: 1,
    account: {
      id: actorId,
      email: 'alice@example.test',
      role: 'specialist',
      permission_revision: 1,
    },
    capabilities: [],
    context: selectedProject === null
      ? { kind: 'workbench', project_id: null }
      : { kind: 'project', project_id: selectedProject },
    projects: [{ id: projectId, name: 'Alpha', created_at: '2026-09-01T00:00:00Z' }],
    session_scopes: [...stored.values()].map(session => ({
      session_id: `session-${session.id}`,
      visibility: session.visibility,
      project_id: session.projectId,
    })),
    session_summary: {
      private_count: [...stored.values()].filter(session => session.visibility === 'private').length,
      project_counts: {
        [projectId]: [...stored.values()].filter(session => session.projectId === projectId).length,
      },
    },
  })

  return createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://xagent.test').pathname
      const value = await requestBody(request)
      observations.push({
        path,
        authorization: request.headers.authorization,
        serviceToken: request.headers['x-xagent-service-token'] as string | undefined,
        delegation: request.headers['x-xagent-delegation'] as string | undefined,
        requestBody: value,
      })
      response.setHeader('content-type', 'application/json')
      if (path === '/api/v1/auth/login') {
        expect(value).toEqual({ email: 'alice@example.test', password: 'loader-password' })
        response.end(JSON.stringify({
          token_type: 'bearer',
          access_token: userToken,
          expires_at: '2026-09-05T00:00:00Z',
          csrf_token: csrfToken,
        }))
        return
      }
      if (path === '/internal/xagent/auth/introspect') {
        response.end(JSON.stringify({
          actor_id: actorId,
          role: 'specialist',
          permission_revision: 1,
          auth_session_id: authSessionId,
        }))
        return
      }
      if (path === '/internal/xagent/sessions/list') {
        response.end(JSON.stringify({
          schema_version: 1,
          sessions: [...stored.values()].map(session => ({
            id: session.id,
            visibility: session.visibility,
            project_id: session.projectId,
            runtime_header: session.runtimeHeader,
            last_event_sequence: session.lastEventSequence,
            version: session.version,
          })),
        }))
        return
      }
      if (path === '/internal/xagent/sessions') {
        const body = value as { session_id: string; runtime_header: Record<string, unknown>; events?: unknown[] }
        const visibility = selectedProject === null ? 'private' as const : 'project' as const
        stored.set(body.session_id, {
          id: body.session_id,
          runtimeHeader: body.runtime_header,
          visibility,
          projectId: selectedProject,
          lastEventSequence: (body.events?.length ?? 0) - 1,
          version: 1,
        })
        response.end(JSON.stringify({
          schema_version: 1,
          session: { id: body.session_id, visibility, project_id: selectedProject },
        }))
        return
      }
      if (/^\/internal\/xagent\/sessions\/[^/]+\/authorize$/u.test(path)) {
        response.statusCode = 204
        response.end()
        return
      }
      const append = /^\/internal\/xagent\/sessions\/([^/]+)\/append$/u.exec(path)
      if (append?.[1] !== undefined) {
        const id = decodeURIComponent(append[1])
        const session = stored.get(id)
        if (session === undefined) throw new Error(`append for unknown Session ${id}`)
        const body = value as { expected_sequence: number; events: unknown[] }
        session.lastEventSequence = body.expected_sequence + body.events.length
        session.version += 1
        response.end(JSON.stringify({
          schema_version: 1,
          last_event_sequence: session.lastEventSequence,
          version: session.version,
        }))
        return
      }
      if (path === '/internal/xagent/workbench/context') {
        const body = value as { kind: string; project_id: string | null }
        selectedProject = body.kind === 'project' ? body.project_id : null
        response.end(JSON.stringify({
          schema_version: 1,
          account_id: actorId,
          context: selectedProject === null
            ? { kind: 'workbench', project_id: null }
            : { kind: 'project', project_id: selectedProject },
        }))
        return
      }
      if (path === '/internal/xagent/workbench/bootstrap') {
        response.end(JSON.stringify(bootstrap()))
        return
      }
      if (path === '/internal/xagent/retrieval/token-count') {
        response.end(JSON.stringify({
          model: 'BAAI/bge-m3',
          revision: '5617a9f61b028005a4858fdac845db406aefb181',
          token_count: 6,
        }))
        return
      }
      if (path === '/internal/xagent/retrieval/search') {
        searchSequence += 1
        response.end(JSON.stringify(searchResponse(searchSequence === 1
          ? 'receipt_private_search_1'
          : `receipt_browser_search_${String(searchSequence)}`)))
        return
      }
      if (path === '/internal/xagent/retrieval/citations/authorize') {
        response.end(JSON.stringify({ schema_version: 1, authorized: true }))
        return
      }
      if (path === '/internal/xagent/retrieval/citations/resolve') {
        response.end(JSON.stringify({
          schema_version: 1,
          artifact_id: artifactId,
          version_id: versionId,
          chunk_id: chunkId,
          line_start: 7,
          line_end: 9,
        }))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ detail: { code: 'not-found' } }))
    })().catch((error: unknown) => {
      response.statusCode = 500
      response.end(JSON.stringify({ error: String(error) }))
    })
  })
}

function scriptedModel(requests: unknown[]): Server {
  return createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || !new URL(request.url ?? '/', 'http://model.test').pathname.endsWith('/chat/completions')) {
        response.statusCode = 404
        response.end()
        return
      }
      if (request.headers.authorization !== 'Bearer loader-model-key') {
        response.statusCode = 401
        response.end()
        return
      }
      const value = await requestBody(request)
      requests.push(value)
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const available = toolNames(value)
      if (available.length === 0) {
        response.write(`data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: '检索回答' }, finish_reason: null }],
        })}\n\n`)
        response.write(`data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }
      const answer = available.includes('submit_cited_answer')
        ? {
          name: 'submit_cited_answer',
          arguments: JSON.stringify({
            blocks: [
              { type: 'markdown', text: '结构化检索只进入 Business。' },
              { type: 'citation', id: '[资料1]' },
            ],
          }),
        }
        : {
          name: 'search_artifacts',
          arguments: JSON.stringify({ query: '结构化检索', project_ids: [projectId] }),
        }
      response.write(`data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: `loader-call-${String(requests.length)}`,
              type: 'function',
              function: answer,
            }],
          },
          finish_reason: null,
        }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })().catch((error: unknown) => {
      response.statusCode = 500
      response.end(JSON.stringify({ error: String(error) }))
    })
  })
}

function cookies(response: Response): { readonly cookie: string; readonly csrf: string } {
  const values = response.headers.getSetCookie()
  const session = values.find(value => value.startsWith('xagent_session='))?.split(';', 1)[0]
  const csrfCookie = values.find(value => value.startsWith('xagent_csrf='))?.split(';', 1)[0]
  if (session === undefined || csrfCookie === undefined) throw new Error('登录响应缺少认证 Cookie')
  return { cookie: `${session}; ${csrfCookie}`, csrf: csrfCookie.slice('xagent_csrf='.length) }
}

function rpcFetch(
  origin: string,
  method: string,
  payload: Record<string, unknown>,
  auth?: { readonly cookie: string; readonly csrf: string },
): Promise<Response> {
  return fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      ...(auth === undefined ? {} : { cookie: auth.cookie, 'x-xagent-csrf': auth.csrf }),
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `retrieval-runtime-${method}-${randomUUID()}`,
      method,
      payload,
    }),
  })
}

async function rpc<T>(
  origin: string,
  method: string,
  payload: Record<string, unknown>,
  auth?: { readonly cookie: string; readonly csrf: string },
): Promise<RpcResponse<T>> {
  const response = await rpcFetch(origin, method, payload, auth)
  expect(response.status).toBe(200)
  return await response.json() as RpcResponse<T>
}

function toolNames(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) throw new TypeError('model request must be an object')
  const tools = (value as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []
  return tools.map(tool => tool.function?.name).filter((name): name is string => name !== undefined).sort()
}

function codeToolNames(
  tools: Context['tools'],
  scope: Parameters<Context['tools']['schemas']>[0],
): string[] {
  const key = Object.getOwnPropertySymbols(tools).find(symbol => symbol.description === TOOL_RUNTIME_CODE_SCHEMAS.description)
  if (key === undefined) throw new Error('Loader ToolRuntime 缺少 Code Mode schema seam')
  const schemas = (tools as unknown as Record<symbol, (scope: unknown) => Array<{ name: string }>>)[key]
  if (typeof schemas !== 'function') throw new Error('Loader ToolRuntime Code Mode schema seam 不是函数')
  return schemas(scope).map(tool => tool.name).sort()
}

const RETRIEVAL_PACKAGE_NAMES = [
  '@xagent/dsh-retrieval',
  '@xagent/dsh-tool-retrieval',
  '@xagent/dsh-ui-citation',
] as const
const RETRIEVAL_TOOL_NAMES = ['list_accessible_projects', 'search_artifacts', 'submit_cited_answer'] as const
const FORBIDDEN_BROWSER_FIELDS = [
  'serviceToken', 'userToken', 'receipt', 'embeddingOrigin',
  'delegationPrivateKey', 'nonce', 'objectKey', 'signedUrl',
] as const

interface BrowserSlots {
  entries(name: string): Array<{
    readonly options: { readonly key?: string }
    readonly registrant?: string
  }>
  register(options: unknown, component: () => null): () => void
}

interface ClientModuleHost {
  graph(): WebBootGraph
}

interface WebBootGraph {
  readonly rev: string
  readonly entries: Array<{
    readonly id: string
    readonly url: string
    readonly rev: string
    readonly inject?: string[]
    readonly immediately?: boolean
  }>
}

interface BrowserModuleSystem {
  prefetch(id: string): Promise<void>
  registerStatic(id: string, module: unknown): void
}

interface ClientModulesRuntime {
  readonly ClientModuleSystem: new (options: {
    readonly modules: Array<{ readonly id: string; readonly url: string; readonly rev: string }>
    readonly staticModules: Record<string, unknown>
    readonly loadBundle: (url: string) => Promise<void>
  }) => BrowserModuleSystem
  parseBootManifest(graph: WebBootGraph): {
    readonly modules: Array<{ readonly id: string; readonly url: string; readonly rev: string }>
    readonly plugins: Array<{ readonly id: string; readonly immediately: boolean }>
  }
}

interface BrowserModuleGlobals {
  __ModuleLoader__?: unknown
  __DSH_MODULES__?: BrowserModuleSystem
}

interface BrowserProfile {
  readonly ctx: Context
  readonly graph: WebBootGraph
}

interface BrowserConnection {
  readonly api: {
    readonly constructor: { readonly name: string }
    readonly sessions: {
      create(payload: { readonly sessionId: string }): Promise<RpcResponse<{ readonly sessionId: string }>>
      prompt(payload: {
        readonly sessionId: string
        readonly mode: 'queue'
        readonly content: Array<{ readonly type: 'text'; readonly text: string }>
      }): Promise<RpcResponse<{ readonly accepted: boolean }>>
    }
  }
  readonly hostDescription: { getSnapshot(): unknown }
}

interface CitationRemote {
  resolve(sessionId: string, citationId: string): Promise<{
    readonly ok: boolean
    readonly value?: {
      readonly artifactId: string
      readonly versionId: string
      readonly chunkId: string
      readonly lineStart: number
      readonly lineEnd: number
    }
  }>
}

interface ProjectRemote {
  'select-context'(context: { readonly kind: 'workbench' }): Promise<{
    readonly ok: boolean
    readonly value?: { readonly context: { readonly kind: string } }
  }>
}

interface BrowserDom {
  readonly cookieJar: {
    getCookieString(url: string): Promise<string>
    setCookie(cookie: string, url: string): Promise<unknown>
    removeAllCookies(): Promise<void>
    getCookieStringSync(url: string): string
  }
  reconfigure(settings: { readonly url: string }): void
}

interface BrowserNetwork {
  login(): Promise<Response>
  restore(): Promise<void>
}

async function installBrowserNetwork(origin: string): Promise<BrowserNetwork> {
  const browserDom = (globalThis as typeof globalThis & { jsdom?: BrowserDom }).jsdom
  if (browserDom === undefined) throw new Error('Browser test requires Vitest jsdom')
  const dom = browserDom
  const previousUrl = location.href
  const nativeFetch = globalThis.fetch
  const nativeWebSocket = globalThis.WebSocket
  await browserDom.cookieJar.removeAllCookies()
  browserDom.reconfigure({ url: `${origin}/` })
  class BrowserWebSocket extends WebSocketTransport {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols ?? [], {
        headers: { cookie: dom.cookieJar.getCookieStringSync(String(url)), origin },
      })
      // Browser WebSocket error events do not become uncaught EventEmitter errors.
      this.on('error', () => {})
    }
  }
  globalThis.WebSocket = BrowserWebSocket as unknown as typeof WebSocket
  globalThis.fetch = async (input, init) => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    const url = new URL(rawUrl, location.href)
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    const sameOrigin = url.origin === location.origin
    if (sameOrigin && init?.credentials !== 'omit') {
      const cookie = await browserDom.cookieJar.getCookieString(url.href)
      if (cookie !== '') headers.set('cookie', cookie)
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') headers.set('origin', location.origin)
    }
    const response = await nativeFetch(url, { ...init, headers })
    if (sameOrigin) {
      for (const cookie of response.headers.getSetCookie()) {
        await browserDom.cookieJar.setCookie(cookie, url.href)
      }
    }
    return response
  }
  return {
    login: () => fetch('/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test', password: 'loader-password' }),
    }),
    restore: async () => {
      globalThis.fetch = nativeFetch
      globalThis.WebSocket = nativeWebSocket
      await browserDom.cookieJar.removeAllCookies()
      browserDom.reconfigure({ url: previousUrl })
    },
  }
}

function expectBrowserDataSafe(value: unknown, forbiddenValues: readonly string[]): void {
  const keys: string[] = []
  const strings: string[] = []
  const visit = (candidate: unknown): void => {
    if (typeof candidate === 'string') {
      strings.push(candidate)
      return
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (typeof candidate !== 'object' || candidate === null) return
    for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
      keys.push(key.replaceAll(/[-_]/gu, '').toLowerCase())
      visit(item)
    }
  }
  visit(value)
  for (const field of FORBIDDEN_BROWSER_FIELDS) {
    expect(keys.some(key => key.includes(field.toLowerCase())), `Browser field ${field}`).toBe(false)
  }
  for (const forbidden of forbiddenValues) {
    expect(strings.some(candidate => candidate.includes(forbidden)), `Browser value ${forbidden}`).toBe(false)
  }
}

const MODULES_ID = '@deepseek-ai/dsh-client-modules'

/** Read the registry-generated manifest from the same HTML endpoint as the production shell. */
async function servedBootGraph(origin: string): Promise<WebBootGraph> {
  const response = await fetch(origin)
  if (!response.ok) throw new Error(`Browser manifest endpoint returned ${String(response.status)}`)
  const html = await response.text()
  const prefix = '<script>window.__DSH_BOOT__ = '
  const start = html.indexOf(prefix)
  const end = start < 0 ? -1 : html.indexOf('</script>', start + prefix.length)
  if (start < 0 || end < 0) throw new Error('Browser manifest endpoint did not inject window.__DSH_BOOT__')
  return JSON.parse(html.slice(start + prefix.length, end)) as WebBootGraph
}

/** Load every served graph row through the production Browser module system and Cordis Loader. */
async function bootServedBrowser(origin: string, host: Context): Promise<BrowserProfile> {
  const modulesSpecifier: string = '@deepseek-ai/dsh-client-modules/client'
  const seedSpecifier: string = '@deepseek-ai/dsh-client-web/src/seed.ts'
  const clientModules = await import(modulesSpecifier) as unknown as ClientModulesRuntime
  const { getStaticModules } = await import(seedSpecifier) as unknown as {
    readonly getStaticModules: () => Record<string, unknown>
  }
  const registry = host.get('clientModules') as ClientModuleHost | undefined
  if (registry === undefined) throw new Error('Host profile has no ClientModuleRegistry')
  const graph = await servedBootGraph(origin)
  expect(graph).toEqual(registry.graph())
  const manifest = clientModules.parseBootManifest(graph)
  const win = globalThis as BrowserModuleGlobals
  const modules = new clientModules.ClientModuleSystem({
    modules: manifest.modules,
    staticModules: getStaticModules(),
    loadBundle: async (url) => {
      const response = await fetch(new URL(url, origin))
      if (!response.ok) throw new Error(`Browser bundle ${url} returned ${String(response.status)}`)
      ;(0, eval)(await response.text())
    },
  })
  modules.registerStatic(MODULES_ID, clientModules)
  win.__DSH_MODULES__ = modules
  await Promise.all(manifest.plugins.filter(row => row.immediately).map(row => modules.prefetch(row.id)))
  const browser = new Context()
  await browser.plugin(Loader)
  browser.loader.internal = modules as unknown as NonNullable<typeof browser.loader.internal>
  await browser.loader.create({ name: MODULES_ID })
  await Promise.all(manifest.plugins
    .filter(row => row.id !== MODULES_ID)
    .map(row => browser.loader.create({ name: row.id })))
  await browser.loader.await()
  return { ctx: browser, graph }
}

/** Clear page-global module registration state after one Browser Loader graph. */
async function disposeBrowser(browser: Context, host: Context): Promise<void> {
  const runner = [...browser.loader.entries()]
    .find(entry => entry.options.name === '@deepseek-ai/dsh-cordis-client-runner')
  if (runner !== undefined) {
    const inspect = host.get('cordisInspect') as {
      list(): Array<{ readonly platform: string }>
    } | undefined
    if (inspect !== undefined) {
      await vi.waitFor(() => {
        expect(inspect.list().some(row => row.platform === 'client')).toBe(true)
      })
    }
    await browser.loader.remove(runner.id)
    await browser.loader.await()
  }
  await browser.fiber.dispose()
  const win = globalThis as BrowserModuleGlobals
  delete win.__ModuleLoader__
  delete win.__DSH_MODULES__
  document.head.querySelectorAll('style[data-plugin]').forEach((style) => { style.remove() })
}

async function bootNonBusinessProfile(profileName: string, home: string): Promise<{
  readonly ctx: Context
  readonly dump: string
}> {
  const profile = loadProfile('dsh-test', profileName, installAnchor, home)
  mkdirSync(profile.dir, { recursive: true })
  const rootConfig = join(profile.dir, 'cordis.yml')
  writeFileSync(rootConfig, '[]\n')
  healProfilesModuleFallback(installAnchor, home)
  const layers = [...profile.layers.map(layer => layer.patches), profile.patches]
  const rows = composeEntries(layers)
  const ctx = await boot('dsh-test', rootConfig, [
    ...layers.flat(),
    { id: 'webserver', disabled: true },
    { id: 'web-runtime', disabled: true },
    { id: 'connection', disabled: true },
    { id: 'client-hmr', disabled: true },
    { id: 'modules', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] },
    { id: 'headless-startup', disabled: true },
    { id: 'headless-runner', disabled: true },
  ], (bootCtx) => {
    bootCtx.provide('dshProfileDataPath', (...segments: string[]) => join(profile.dir, 'data', ...segments))
    provideCmdline(bootCtx, { args: [], exit: () => {} })
  })
  return { ctx, dump: JSON.stringify(rows) }
}

async function bootBrowserHostProfile(profileName: string, home: string): Promise<{
  readonly ctx: Context
  readonly origin?: string
}> {
  const profile = loadProfile('dsh-test', profileName, installAnchor, home)
  mkdirSync(profile.dir, { recursive: true })
  const rootConfig = join(profile.dir, 'cordis.yml')
  writeFileSync(rootConfig, '[]\n')
  healProfilesModuleFallback(installAnchor, home)
  const web = profileName !== 'headless'
  const port = web ? await freePort() : undefined
  const patches: PatchOptions[] = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    { id: 'session-telemetry-otel', disabled: true },
    ...(web ? [
      { id: 'client-hmr', disabled: true },
      { id: 'web-runtime', config: { printUrl: false, surfaceContext: false, trustedHosts: [] } },
    ] : [
      { id: 'headless-startup', disabled: true },
      { id: 'headless-runner', disabled: true },
    ]),
  ]
  const loaded = await boot('dsh-test', rootConfig, patches, (bootCtx) => {
    bootCtx.provide('dshProfileDataPath', (...segments: string[]) => join(profile.dir, 'data', ...segments))
    provideCmdline(bootCtx, {
      args: port === undefined ? [] : ['--host', '127.0.0.1', '--port', String(port)],
      exit: () => {},
    })
  })
  return { ctx: loaded, ...(port === undefined ? {} : { origin: `http://127.0.0.1:${String(port)}` }) }
}

describe('XAgent Business 结构化检索真实 Loader 闭包', () => {
  const root = mkdtempSync(join(tmpdir(), 'xagent-retrieval-loader-'))
  const home = join(root, 'home')
  const observations: BackendObservation[] = []
  const stored = new Map<string, StoredSession>()
  const requestSchemas: Array<{ readonly native: string[]; readonly code: string[] }> = []
  const modelRequests: unknown[] = []
  const previousEnvironment = {
    DSH_HOME: process.env.DSH_HOME,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    XAGENT_API_ORIGIN: process.env.XAGENT_API_ORIGIN,
    XAGENT_SERVICE_TOKEN: process.env.XAGENT_SERVICE_TOKEN,
    XAGENT_ALLOWED_ORIGINS: process.env.XAGENT_ALLOWED_ORIGINS,
    XAGENT_ALLOW_INSECURE_COOKIE: process.env.XAGENT_ALLOW_INSECURE_COOKIE,
    XAGENT_DELEGATION_PRIVATE_KEY: process.env.XAGENT_DELEGATION_PRIVATE_KEY,
    XAGENT_DELEGATION_ISSUER: process.env.XAGENT_DELEGATION_ISSUER,
    XAGENT_DELEGATION_AUDIENCE: process.env.XAGENT_DELEGATION_AUDIENCE,
  }
  let backendServer: Server | undefined
  let modelServer: Server | undefined
  let ctx: Context | undefined
  let origin = ''
  let auth: { readonly cookie: string; readonly csrf: string } | undefined

  beforeAll(async () => {
    backendServer = backend(observations, stored)
    const backendOrigin = await listen(backendServer)
    modelServer = scriptedModel(modelRequests)
    const modelOrigin = await listen(modelServer)
    const port = await freePort()
    origin = `http://127.0.0.1:${String(port)}`
    const { privateKey } = generateKeyPairSync('ed25519')
    process.env.DSH_HOME = home
    process.env.DEEPSEEK_API_KEY = 'loader-model-key'
    process.env.XAGENT_API_ORIGIN = backendOrigin
    process.env.XAGENT_SERVICE_TOKEN = serviceToken
    process.env.XAGENT_ALLOWED_ORIGINS = origin
    process.env.XAGENT_ALLOW_INSECURE_COOKIE = '1'
    process.env.XAGENT_DELEGATION_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    process.env.XAGENT_DELEGATION_ISSUER = 'xagent-loader-test'
    process.env.XAGENT_DELEGATION_AUDIENCE = 'xagent-fastapi-loader-test'

    const profile = loadProfile('dsh-test', 'xagent-business', installAnchor, home)
    mkdirSync(profile.dir, { recursive: true })
    const rootConfig = join(profile.dir, 'cordis.yml')
    writeFileSync(rootConfig, '[]\n')
    healProfilesModuleFallback(installAnchor, home)
    const patches: PatchOptions[] = [
      ...profile.layers.flatMap(layer => layer.patches),
      ...profile.patches,
      { id: 'web-runtime', config: { printUrl: false, surfaceContext: false, trustedHosts: [] } },
      {
        id: 'connection',
        name: '@deepseek-ai/dsh-client-connection',
        inject: [],
        config: { trustedHosts: [] },
      },
      { id: 'client-hmr', disabled: true },
      { id: 'session-telemetry-otel', disabled: true },
      { id: 'llm-deepseek', config: { baseURL: modelOrigin } },
    ]
    ctx = await boot('dsh-test', rootConfig, patches, (bootCtx) => {
      bootCtx.provide('dshProfileDataPath', (...segments: string[]) => join(profile.dir, 'data', ...segments))
      provideCmdline(bootCtx, { args: ['--host', '127.0.0.1', '--port', String(port)], exit: () => {} })
      bootCtx.on('agent/request', ({ agent }, next) => {
        requestSchemas.push({
          native: bootCtx.tools.schemas(agent).map(tool => tool.name).sort(),
          code: codeToolNames(bootCtx.tools, agent),
        })
        return next()
      })
    })
    const login = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email: 'alice@example.test', password: 'loader-password' }),
    })
    expect(login.status).toBe(200)
    auth = cookies(login)
  }, 120_000)

  afterAll(async () => {
    try {
      await ctx?.fiber.dispose()
      await close(modelServer)
      await close(backendServer)
    } finally {
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('保持认证 Session、Native 工具、Code Mode 与 citation Remote 的完整闭包', { retry: 0 }, async () => {
    if (ctx === undefined || auth === undefined || modelServer === undefined) throw new Error('Business Loader 未启动')
    expect(await rpc(origin, 'session.create', { sessionId: privateSessionId }, auth)).toMatchObject({
      result: { ok: true, value: { sessionId: privateSessionId } },
    })
    const privateAgent = ctx.agents.get(SessionId(privateSessionId))
    expect(privateAgent).toBeDefined()
    if (privateAgent === undefined) throw new Error('Private Session 未发布')
    expect(ctx.tools.schemas(privateAgent).map(tool => tool.name).sort()).toEqual([
      'list_accessible_projects',
      'search_artifacts',
    ])
    expect(codeToolNames(ctx.tools, privateAgent)).toEqual([])

    const selected = await rpc(origin, 'xagentProject/select-context', {
      args: { context: { kind: 'project', projectId } },
    }, auth)
    expect(selected.result).toMatchObject({ ok: true, value: { context: { kind: 'project', projectId } } })
    expect(await rpc(origin, 'session.create', { sessionId: projectSessionId }, auth)).toMatchObject({
      result: { ok: true, value: { sessionId: projectSessionId } },
    })
    const projectAgent = ctx.agents.get(SessionId(projectSessionId))
    expect(projectAgent).toBeDefined()
    if (projectAgent === undefined) throw new Error('Project Session 未发布')
    expect(ctx.tools.schemas(projectAgent).map(tool => tool.name).sort()).toEqual([
      'list_accessible_projects',
      'search_artifacts',
    ])
    expect(stored.get(projectSessionId.slice('session-'.length))).toMatchObject({
      visibility: 'project',
      projectId,
    })
    expect(ctx.tools.schemas(ctx.agents.get(SessionId(privateSessionId))).map(tool => tool.name).sort()).toEqual([
      'list_accessible_projects',
      'search_artifacts',
    ])
    expect(await rpc(origin, 'session.prompt', {
      sessionId: privateSessionId,
      mode: 'queue',
      content: [{ type: 'text', text: '请检索并引用资料。' }],
    }, auth)).toMatchObject({ result: { ok: true, value: { accepted: true } } })

    await vi.waitFor(() => {
      expect(modelRequests.filter(value => toolNames(value).length > 0).length).toBeGreaterThanOrEqual(2)
      expect(requestSchemas.length).toBeGreaterThanOrEqual(2)
    }, { timeout: 20_000 })
    const toolRequests = modelRequests.filter(value => toolNames(value).length > 0)
    expect(toolNames(toolRequests[0])).toEqual([
      'list_accessible_projects',
      'search_artifacts',
    ])
    expect(toolNames(toolRequests[1])).toEqual([
      'list_accessible_projects',
      'search_artifacts',
      'submit_cited_answer',
    ])
    expect(requestSchemas.slice(0, 2)).toEqual([
      {
        native: ['list_accessible_projects', 'search_artifacts'],
        code: [],
      },
      {
        native: ['list_accessible_projects', 'search_artifacts', 'submit_cited_answer'],
        code: [],
      },
    ])
    expect(observations.some(item => item.path === '/internal/xagent/retrieval/citations/authorize')).toBe(true)
    expect(toolRequests).toHaveLength(2)
    await vi.waitFor(() => {
      const search = observations.find(item => item.path === '/internal/xagent/retrieval/search')
      expect(search).toMatchObject({
        authorization: `Bearer ${userToken}`,
        serviceToken,
      })
      expect(search?.delegation).toEqual(expect.any(String))
      expect(observations.some(item => item.path.includes('/append')
        && JSON.stringify(item.requestBody).includes('receipt_private_search_1'))).toBe(true)
    }, { timeout: 20_000 })
    const anonymous = await rpcFetch(origin, 'xagentCitation/resolve', {
      args: { sessionId: privateSessionId, citationId: '[资料1]' },
    })
    expect(anonymous.status).toBe(401)
    expect(await anonymous.text()).toBe('unauthenticated')

    const authenticated = await rpc<{
      artifactId: string
      versionId: string
      chunkId: string
      lineStart: number
      lineEnd: number
    }>(origin, 'xagentCitation/resolve', {
      args: { sessionId: privateSessionId, citationId: '[资料1]' },
    }, auth)
    expect(authenticated.result).toEqual({
      ok: true,
      value: { artifactId, versionId, chunkId, lineStart: 7, lineEnd: 9 },
    })
    const resolved = observations.find(item => item.path === '/internal/xagent/retrieval/citations/resolve')
    expect(resolved).toMatchObject({ authorization: `Bearer ${userToken}`, serviceToken })
    expect(typeof resolved?.delegation).toBe('string')
  })

  it('只在 Business Browser 安装 citation Remote 与 keyed Tool view', { retry: 0 }, async () => {
    const browserHome = join(root, 'browser-home')
    const startupWarnings = vi.spyOn(console, 'warn')
    const startupErrors = vi.spyOn(console, 'error')
    for (const profileName of ['xagent-business', 'xagent-developer', 'web', 'headless']) {
      const host = profileName === 'xagent-business'
        ? { ctx: ctx!, origin }
        : await bootBrowserHostProfile(profileName, browserHome)
      const hostRoster = [...host.ctx.loader.entries()].map(entry => entry.options.name)
      if (profileName === 'headless') {
        try {
          expect(host.ctx.get('clientModules')).toBeUndefined()
          expect(host.origin).toBeUndefined()
          for (const packageName of RETRIEVAL_PACKAGE_NAMES) {
            expect(hostRoster, `headless Host package ${packageName}`).not.toContain(packageName)
          }
        } finally {
          await host.ctx.fiber.dispose()
        }
        continue
      }
      if (host.origin === undefined) throw new Error(`${profileName} Host 缺少 Web origin`)
      const network = await installBrowserNetwork(host.origin)
      if (profileName === 'xagent-business') expect((await network.login()).status).toBe(200)
      const loaded = await bootServedBrowser(host.origin, host.ctx)
      const browser = loaded.ctx
      try {
        const roster = [...browser.loader.entries()].map(entry => entry.options.name)
        expect(roster, `${profileName} production Browser roster`).toContain('@deepseek-ai/dsh-client-modules')
        expect(roster, `${profileName} production Browser runtime`).toContain('@deepseek-ai/dsh-client-runtime')
        expect([...roster].sort()).toEqual(loaded.graph.entries.map(entry => entry.id).sort())
        const slots = browser.get('slots') as BrowserSlots
        const entries = slots.entries('tool.call.toolview')
          .filter(entry => entry.options.key === 'submit_cited_answer')
        if (profileName === 'xagent-business') {
          expect(roster).toContain('@xagent/dsh-ui-citation')
          expect(roster).not.toContain('@xagent/dsh-ui-citation/client')
          const connection = browser.get('connection') as BrowserConnection | undefined
          expect(connection?.api.constructor.name).toBe('WebApiClient')
          if (connection === undefined) throw new Error('Business Browser 缺少 Connection')
          await vi.waitFor(() => { expect(connection.hostDescription.getSnapshot()).toBeDefined() })
          const inspect = browser.get('cordisInspect') as { publish(): void } | undefined
          if (inspect === undefined) throw new Error('Business Browser 缺少 Cordis inspect registry')
          inspect.publish()
          const project = browser.get('remote.xagentProject') as ProjectRemote | undefined
          if (project === undefined) throw new Error('Business Browser 缺少 project Remote')
          await expect(project['select-context']({ kind: 'workbench' })).resolves.toMatchObject({
            ok: true,
            value: { context: { kind: 'workbench' } },
          })
          const citation = browser.get('remote.xagentCitation') as CitationRemote | undefined
          expect(citation).toBeDefined()
          expect(entries).toHaveLength(1)
          expect(entries[0]?.registrant).toBe('xagent-cited-answer')
          if (citation === undefined) throw new Error('Business Browser 缺少 citation Remote')
          expect(await connection.api.sessions.create({ sessionId: browserSessionId })).toMatchObject({
            result: { ok: true, value: { sessionId: browserSessionId } },
          })
          const evidenceStart = observations.length
          expect(await connection.api.sessions.prompt({
            sessionId: browserSessionId,
            mode: 'queue',
            content: [{ type: 'text', text: '请通过真实 Browser 连接检索资料。' }],
          })).toMatchObject({ result: { ok: true, value: { accepted: true } } })
          await vi.waitFor(() => {
            expect(observations.slice(evidenceStart)
              .some(item => item.path === '/internal/xagent/retrieval/citations/authorize')).toBe(true)
          }, { timeout: 20_000 })
          const observationStart = observations.length
          await expect(citation.resolve(browserSessionId, '[资料1]')).resolves.toEqual({
            ok: true,
            value: { artifactId, versionId, chunkId, lineStart: 7, lineEnd: 9 },
          })
          const resolved = observations.slice(observationStart)
            .find(item => item.path === '/internal/xagent/retrieval/citations/resolve')
          expect(resolved).toMatchObject({ authorization: `Bearer ${userToken}`, serviceToken })
          expect(typeof resolved?.delegation).toBe('string')
          const privateKey = process.env.XAGENT_DELEGATION_PRIVATE_KEY
          if (privateKey === undefined) throw new Error('Business Host 测试私钥缺失')
          expectBrowserDataSafe({
            graph: loaded.graph,
            entries: [...browser.loader.entries()].map(entry => entry.options),
          }, [serviceToken, userToken, 'receipt_private_search_1', 'receipt_browser_search_2', privateKey])
        } else {
          for (const packageName of RETRIEVAL_PACKAGE_NAMES) {
            expect(hostRoster, `${profileName} Host package ${packageName}`).not.toContain(packageName)
            expect(roster, `${profileName} Browser package ${packageName}`).not.toContain(packageName)
          }
          expect(browser.get('remote.xagentCitation'), `${profileName} citation Remote`).toBeUndefined()
          expect(entries, `${profileName} citation Tool view`).toEqual([])
        }
      } finally {
        await disposeBrowser(browser, host.ctx)
        await network.restore()
        if (profileName !== 'xagent-business') await host.ctx.fiber.dispose()
      }
    }
    const retries = startupWarnings.mock.calls
      .filter(call => call[0] === '[web-runtime] connection lost, retry #1')
    const manifestDenials = startupErrors.mock.calls.filter(call =>
      call.some(item => String(item).includes('syncInspectManifest failed: transport failure')
        && String(item).includes('HTTP 401')))
    startupWarnings.mockRestore()
    startupErrors.mockRestore()
    // 并行 Browser graph 允许 UI account 注册 CSRF header 前的首轮请求；随后必须连接并完成 manifest 同步。
    expect(retries).toHaveLength(1)
    expect(manifestDenials).toHaveLength(1)
  })

  it('保持 Developer、Web 与 Headless 的运行时和完整 dump 无检索面', { retry: 0 }, async () => {
    const isolationHome = join(root, 'non-business-home')
    for (const profileName of ['xagent-developer', 'web', 'headless']) {
      const profile = await bootNonBusinessProfile(profileName, isolationHome)
      try {
        const liveTools = profile.ctx.tools.schemas().map(tool => tool.name)
        for (const name of RETRIEVAL_TOOL_NAMES) {
          expect(liveTools, `${profileName} runtime tools`).not.toContain(name)
          expect(profile.dump, `${profileName} dump tool ${name}`).not.toContain(name)
        }
        expect(profile.ctx.get('xagentCitation'), `${profileName} Host citation Remote`).toBeUndefined()
        expect(profile.dump, `${profileName} dump Remote`).not.toContain('xagentCitation')
        for (const packageName of RETRIEVAL_PACKAGE_NAMES) {
          expect(profile.dump, `${profileName} dump package ${packageName}`).not.toContain(packageName)
        }
      } finally {
        await profile.ctx.fiber.dispose()
      }
    }
  })
})
