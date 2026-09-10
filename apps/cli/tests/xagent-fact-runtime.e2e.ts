import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TOOL_RUNTIME_CODE_SCHEMAS } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {} from '../src/profile-boot.ts'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const basePatch = join(repoRoot, 'packages/bundle/base/cordis.patch.yml')
const webPatch = join(repoRoot, 'packages/bundle/web-app/cordis.patch.yml')
const businessPatch = join(repoRoot, 'packages/bundle/xagent-business/cordis.patch.yml')
const installAnchor = join(repoRoot, 'apps/cli/package.json')
const scopeFixture = join(repoRoot, 'apps/cli/tests/fixtures/xagent-fact-scope.ts')
const projectId = '00000000-0000-0000-0000-000000000301'
const sessionUuid = '00000000-0000-0000-0000-000000000701'
const sessionId = SessionId(`session-${sessionUuid}`)

interface BackendRequest {
  readonly path: string
  readonly authorization: string | undefined
  readonly serviceToken: string | undefined
  readonly body: unknown
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

function factBackend(requests: BackendRequest[]): Server {
  return createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
      const encoded = Buffer.concat(chunks).toString('utf8')
      requests.push({
        path: new URL(request.url ?? '/', 'http://xagent.test').pathname,
        authorization: request.headers.authorization,
        serviceToken: request.headers['x-xagent-service-token'] as string | undefined,
        body: encoded.length === 0 ? undefined : JSON.parse(encoded) as unknown,
      })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ schema_version: 1, items: [], next_cursor: null }))
    })()
  })
}

class StopAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function codeToolNames(ctx: Context, scope: Parameters<Context['tools']['schemas']>[0]): string[] {
  const key = Object.getOwnPropertySymbols(ctx.tools)
    .find(symbol => symbol.description === TOOL_RUNTIME_CODE_SCHEMAS.description)
  if (key === undefined) throw new Error('Business Loader lacks the Code Mode schema seam')
  const schemas = (ctx.tools as unknown as Record<symbol, (value: unknown) => Array<{ name: string }>>)[key]
  if (typeof schemas !== 'function') throw new Error('Business Loader Code Mode schema seam is not callable')
  return schemas(scope).map(tool => tool.name).sort()
}

async function bootBusiness(home: string): Promise<Context> {
  const profileDir = join(home, 'profiles', 'xagent-business')
  mkdirSync(profileDir, { recursive: true })
  const rootConfig = join(profileDir, 'cordis.yml')
  writeFileSync(rootConfig, '[]\n')
  healProfilesModuleFallback(installAnchor, home)
  const patches: PatchOptions[] = [
    ...loadOverlayPatches('dsh-test', basePatch),
    ...loadOverlayPatches('dsh-test', webPatch),
    ...loadOverlayPatches('dsh-test', businessPatch),
    { id: 'webserver', disabled: true },
    { id: 'web-runtime', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'modules', disabled: true },
    { id: 'connection', disabled: true },
    { id: 'client-hmr', disabled: true },
    { id: 'directory-picker', disabled: true },
    { id: 'xagent-session-persistence-api', disabled: true },
    { id: 'session-persistence-jsonl', disabled: false, config: { root: join(profileDir, 'data', 'sessions') } },
    { id: 'xagent-connection-auth', disabled: true },
    { id: 'xagent-authorization', disabled: true },
    { id: 'xagent-retrieval', disabled: true },
    { id: 'xagent-project', disabled: true },
    { id: 'xagent-artifact', disabled: true },
    { insert: [{ id: 'xagent-fact-scope-fixture', name: scopeFixture }] },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] },
  ]
  return await boot('dsh-test', rootConfig, patches, (ctx) => {
    ctx.provide('dshProfileDataPath', (...segments: string[]) => join(profileDir, 'data', ...segments))
    provideCmdline(ctx, { args: [], exit: () => {} })
  })
}

describe('XAgent Business governed Fact runtime composition', () => {
  const previous = {
    DSH_HOME: process.env.DSH_HOME,
    XAGENT_API_ORIGIN: process.env.XAGENT_API_ORIGIN,
    XAGENT_SERVICE_TOKEN: process.env.XAGENT_SERVICE_TOKEN,
    XAGENT_DELEGATION_PRIVATE_KEY: process.env.XAGENT_DELEGATION_PRIVATE_KEY,
    XAGENT_DELEGATION_ISSUER: process.env.XAGENT_DELEGATION_ISSUER,
    XAGENT_DELEGATION_AUDIENCE: process.env.XAGENT_DELEGATION_AUDIENCE,
  }
  let home: string
  let ctx: Context | undefined
  let backendServer: Server | undefined
  const backendRequests: BackendRequest[] = []

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'xagent-fact-loader-'))
    backendServer = factBackend(backendRequests)
    const backendOrigin = await listen(backendServer)
    const { privateKey } = generateKeyPairSync('ed25519')
    process.env.DSH_HOME = home
    process.env.XAGENT_API_ORIGIN = backendOrigin
    process.env.XAGENT_SERVICE_TOKEN = 'snapshot-service-token'
    process.env.XAGENT_DELEGATION_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    process.env.XAGENT_DELEGATION_ISSUER = 'xagent-host'
    process.env.XAGENT_DELEGATION_AUDIENCE = 'xagent-api'
    ctx = await bootBusiness(home)
  }, 120_000)

  afterAll(async () => {
    try {
      await ctx?.fiber.dispose()
    } finally {
      try {
        await close(backendServer)
      } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) Reflect.deleteProperty(process.env, name)
          else process.env[name] = value
        }
        rmSync(home, { recursive: true, force: true })
      }
    }
  })

  it('mounts the provider and one exact Project-only Native schema outside Code Mode', { retry: 0 }, async () => {
    if (ctx === undefined) throw new Error('Business composition did not boot')
    const adapter = new StopAdapter()
    ctx.llm.registerAdapter(['fact-loader'], adapter)
    const agent = (await ctx.agents.create({
      sessionId,
      meta: { cwd: home },
      agentOptions: { provider: 'fact-loader', model: 'snapshot' },
    })).agent
    expect(ctx.get('xagentFact')).toBeDefined()
    expect(agent.ctx.get('xagentFact')).toBeDefined()
    const toolEntry = [...ctx.loader.entries()].find(entry => entry.options.name === '@xagent/dsh-tool-fact')
    expect(toolEntry?.fiber).toBeDefined()
    expect(ctx.tools.get('propose_fact')).toBeUndefined()
    expect(ctx.tools.get('propose_fact', agent)).toBeUndefined()

    const message = createUserMessage({ content: [{ type: 'text', text: 'propose a Fact' }], source: { kind: 'user' } })
    const request = new AbortController()
    const connection = new AbortController()
    const requestScope = Object.freeze({
      principal: Object.freeze({
        actorId: '00000000-0000-0000-0000-000000000101',
        role: 'specialist' as const,
        permissionRevision: 3,
        authSessionId: '00000000-0000-0000-0000-000000000102',
        connectionId: 'fact-loader',
      }),
      userToken: 'user-token',
      connectionId: 'fact-loader',
      sessionId: sessionUuid,
      requestSignal: request.signal,
      connectionSignal: connection.signal,
      visibility: 'project' as const,
      projectId,
    })
    let codeNames: string[] = []
    let insertedScope: unknown
    ctx.on('agent/inbox/inserted', ({ agent: subject }) => {
      if (subject === agent) {
        insertedScope = ctx!.xagentFactScopeFixture.current()
      }
    })
    ctx.on('agent/request', ({ agent: subject }, next) => {
      if (subject === agent) codeNames = codeToolNames(ctx!, agent)
      return next()
    })
    ctx.xagentFactScopeFixture.run(requestScope, () => { agent.followup(message) })
    await agent.whenIdle()

    expect(insertedScope).toEqual(requestScope)
    const factRequests = adapter.requests.filter(request =>
      request.tools?.some(tool => tool.name === 'propose_fact') === true)
    expect(factRequests).toHaveLength(1)
    const definition = factRequests[0]?.tools?.find(tool => tool.name === 'propose_fact')
    expect(definition).toBeDefined()
    expect(definition?.parameters).toEqual({
      type: 'object',
      properties: {
        field_key: { type: 'string', description: 'Stable lowercase field key using letters, digits, dots, underscores, or hyphens; at most 128 UTF-8 bytes.' },
        label: { type: 'string', description: 'Non-empty human-readable Fact label, at most 255 UTF-8 bytes.' },
        value: {
          oneOf: [
            {
              type: 'object', additionalProperties: false,
              properties: {
                type: { type: 'string', const: 'text', description: 'Use text for a text value.' },
                value: { type: 'string', description: 'Text value, at most 16 KiB in UTF-8.' },
              },
              required: ['type', 'value'], description: 'A text Fact value.',
            },
            {
              type: 'object', additionalProperties: false,
              properties: {
                type: { type: 'string', const: 'number', description: 'Use number for a numeric value.' },
                value: { type: 'number', description: 'Finite number; integral values must be safe integers.' },
              },
              required: ['type', 'value'], description: 'A finite numeric Fact value.',
            },
            {
              type: 'object', additionalProperties: false,
              properties: {
                type: { type: 'string', const: 'boolean', description: 'Use boolean for a true or false value.' },
                value: { type: 'boolean', description: 'Boolean value.' },
              },
              required: ['type', 'value'], description: 'A boolean Fact value.',
            },
            {
              type: 'object', additionalProperties: false,
              properties: {
                type: { type: 'string', const: 'date', description: 'Use date for a calendar date.' },
                value: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Valid Gregorian calendar date in YYYY-MM-DD form.' },
              },
              required: ['type', 'value'], description: 'A calendar-date Fact value.',
            },
          ],
          description: 'Typed value proposed for the project Fact.',
        },
        evidence_ids: {
          type: 'array', maxItems: 64, uniqueItems: true,
          items: { type: 'string', description: 'Admitted citation ID in [资料N] form.' },
          description: 'Up to 64 distinct citation IDs already admitted to this Session.',
        },
        assertion_reason: { type: 'string', description: 'Non-blank assertion basis, at most 4 KiB in UTF-8; required when evidence_ids is empty or omitted.' },
      },
      required: ['field_key', 'label', 'value'],
      additionalProperties: false,
    })
    expect(codeNames).not.toContain('propose_fact')
    expect(backendRequests).toEqual([{
      path: `/internal/xagent/facts/sessions/${sessionUuid}/outbox/pull`,
      authorization: 'Bearer user-token',
      serviceToken: 'snapshot-service-token',
      body: { schema_version: 1, limit: 32 },
    }])
  })

  it('keeps the Fact packages confined to the Business overlay', () => {
    if (ctx === undefined) throw new Error('Business composition did not boot')
    const roster = [...ctx.loader.entries()].map(entry => entry.options.name)
    expect(roster).toEqual(expect.arrayContaining([
      '@xagent/dsh-fact',
      '@xagent/dsh-tool-fact',
      '@xagent/dsh-ui-fact',
    ]))
  })
})
