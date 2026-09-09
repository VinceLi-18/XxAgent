import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import type { ConnectionRequestContext } from '@deepseek-ai/dsh-client-connection'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as authorizationPlugin from '@xagent/dsh-authorization'
import * as factPlugin from '@xagent/dsh-fact'
import { afterEach, describe, expect, test, vi } from 'vitest'

const ACTOR = '00000000-0000-0000-0000-000000000101'
const AUTH_SESSION = '00000000-0000-0000-0000-000000000102'
const SESSION = '00000000-0000-0000-0000-000000000201'
const RUNTIME_SESSION = `session-${SESSION}`
const PROJECT = '00000000-0000-0000-0000-000000000301'
const PROPOSAL = '00000000-0000-0000-0000-000000000401'
const OUTBOX = '00000000-0000-0000-0000-000000000501'

type RpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

type RpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  request?: ConnectionRequestContext,
) => Promise<RpcResult>

class FixtureConnection extends Service {
  matches: ((endpoint: string) => boolean) | undefined
  handler: RpcHandler | undefined

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get rpc() {
    const owner = this.ctx
    return {
      intercept: (
        _channel: string,
        matches: (endpoint: string) => boolean,
        handler: RpcHandler,
      ) => owner.effect(() => {
        this.matches = matches
        this.handler = handler
        return () => {
          this.matches = undefined
          this.handler = undefined
        }
      }),
    }
  }
}

class FixturePersistence extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  async withUserToken<T>(_token: string, operation: () => Promise<T>): Promise<T> {
    return operation()
  }
}

let root: string | undefined
let context: Context | undefined
let connection: FixtureConnection | undefined
let sessionVisibility: 'project' | 'private' = 'project'
let outboxPending = true
let requests: Request[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  connection = undefined
  requests = []
  sessionVisibility = 'project'
  outboxPending = true
  vi.unstubAllGlobals()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : 1)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

function sessionList(): unknown {
  return {
    schema_version: 1,
    sessions: [{
      id: SESSION,
      visibility: sessionVisibility,
      project_id: sessionVisibility === 'project' ? PROJECT : null,
      runtime_header: { id: RUNTIME_SESSION },
    }],
  }
}

function outboxPage(): unknown {
  if (!outboxPending) return { schema_version: 1, items: [], next_cursor: null }
  outboxPending = false
  const event = {
    type: 'fact/proposal-decided',
    data: {
      proposal_id: PROPOSAL,
      project_id: PROJECT,
      field_key: 'customer.name',
      label: 'Customer',
      status: 'rejected',
      decision_reason: 'duplicate',
    },
  }
  return {
    schema_version: 1,
    items: [{
      outbox_id: OUTBOX,
      payload_sha256: createHash('sha256').update(canonicalJson(event)).digest('hex'),
      event,
    }],
    next_cursor: null,
  }
}

async function loadComposition(): Promise<Context> {
  const { privateKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  root = await mkdtemp(join(tmpdir(), 'xagent-fact-auth-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-typert-registry'",
    "- name: '@xagent/dsh-fact'",
    '  config:',
    "    backendOrigin: 'https://backend.example'",
    "    serviceToken: 'service-token'",
    `    delegationPrivateKey: ${JSON.stringify(pem)}`,
    "    delegationIssuer: 'xagent-host'",
    "    delegationAudience: 'xagent-api'",
    "- name: '@xagent/dsh-authorization'",
    '  config:',
    "    backendOrigin: 'https://backend.example'",
    "    serviceToken: 'service-token'",
    "- name: '@deepseek-ai/dsh-api-gateway'",
    '',
  ].join('\n'))

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push(request)
    const path = new URL(request.url).pathname
    if (path === '/internal/xagent/sessions/list') return json(sessionList())
    if (path === `/internal/xagent/sessions/${SESSION}/authorize`) return new Response(null, { status: 200 })
    if (path === `/internal/xagent/facts/projects/${PROJECT}/heads/list`) {
      return json({ schema_version: 1, items: [], next_cursor: null })
    }
    if (path === `/internal/xagent/facts/sessions/${SESSION}/outbox/pull`) return json(outboxPage())
    throw new Error(`unexpected backend request: ${path}`)
  }))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  connection = new FixtureConnection(context)
  new FixturePersistence(context)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-typert-registry', TypertRegistry],
    ['@deepseek-ai/dsh-api-gateway', TypertGatewayService],
    ['@xagent/dsh-fact', factPlugin],
    ['@xagent/dsh-authorization', authorizationPlugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  const unloaded = [...context.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  expect(context.get('xagentFact')).toBeDefined()
  expect(context.get('connectionRequestAuthorizer')).toBeDefined()
  return context
}

function authenticatedRequest(): ConnectionRequestContext {
  return {
    connectionId: 'connection-1',
    userToken: 'alice-token',
    principal: {
      actorId: ACTOR,
      role: 'specialist',
      permissionRevision: 7,
      authSessionId: AUTH_SESSION,
      connectionId: 'connection-1',
    },
  }
}

describe('XAgent Fact authorization Loader composition', () => {
  test('dispatches authenticated Fact Remote calls through the physical Project Session scope', async () => {
    await loadComposition()
    const handler = connection?.handler
    if (handler === undefined) throw new Error('Gateway did not register its Connection interceptor')
    expect(connection?.matches?.('xagentFact/list-heads')).toBe(true)

    await expect(handler(
      'xagentFact/list-heads',
      { args: { sessionId: RUNTIME_SESSION, input: { limit: 10 } } },
      new AbortController().signal,
      authenticatedRequest(),
    )).resolves.toEqual({ ok: true, value: { items: [] } })

    expect(requests.map(request => new URL(request.url).pathname)).toContain(
      `/internal/xagent/facts/projects/${PROJECT}/heads/list`,
    )
  })

  test('cold-opens a Project Session under the same scope and delivers its Outbox without a Turn', async () => {
    const ctx = await loadComposition()
    const signal = new AbortController().signal
    let opened = false
    const result = await ctx.connectionRequestAuthorizer.run(
      'session/create',
      { args: { sessionId: RUNTIME_SESSION } },
      authenticatedRequest(),
      signal,
      async () => {
        ctx.sessions.create(SessionId(RUNTIME_SESSION))
        opened = true
        return { ok: true, value: undefined }
      },
    )
    expect(result).toEqual({ ok: true, value: undefined })
    expect(opened).toBe(true)
    await vi.waitFor(() => {
      expect(ctx.sessions.get(SessionId(RUNTIME_SESSION))?.events).toHaveLength(1)
    })
    expect(ctx.sessions.get(SessionId(RUNTIME_SESSION))?.events).toMatchObject([{
      type: 'fact/proposal-decided',
      data: { proposalId: PROPOSAL, projectId: PROJECT, status: 'rejected' },
    }])
    expect(ctx.sessions.get(SessionId(RUNTIME_SESSION))?.events.some(event => event.type === 'turn/start')).toBe(false)
  })

  test('denies anonymous and private-session Fact calls before the Remote executes', async () => {
    await loadComposition()
    const handler = connection?.handler
    if (handler === undefined) throw new Error('Gateway did not register its Connection interceptor')
    const payload = { args: { sessionId: RUNTIME_SESSION, input: { limit: 10 } } }

    await expect(handler('xagentFact/list-heads', payload, new AbortController().signal, {
      connectionId: 'anonymous',
    })).resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })

    sessionVisibility = 'private'
    await expect(handler(
      'xagentFact/list-heads', payload, new AbortController().signal, authenticatedRequest(),
    )).resolves.toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    expect(requests.some(request => new URL(request.url).pathname.includes('/facts/projects/'))).toBe(false)
  })
})
