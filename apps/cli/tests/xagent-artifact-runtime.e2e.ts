import type { AddressInfo } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  healProfilesModuleFallback,
  loadProfile,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
const actorId = '00000000-0000-0000-0000-000000000001'
const authSessionId = '00000000-0000-0000-0000-000000000101'
const serviceToken = 'xagent-artifact-loader-service-token'
const userToken = 'xagent-artifact-loader-user-token'
const csrfToken = 'xagent-artifact-loader-csrf-token'

interface BackendObservation {
  readonly path: string
  readonly authorization: string | undefined
  readonly serviceToken: string | undefined
}

interface RpcResponse<T> {
  readonly result?: { readonly ok: true; readonly value: T } | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string }
  }
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

async function body(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function backend(observations: BackendObservation[]): Server {
  return createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://xagent.test').pathname
      observations.push({
        path,
        authorization: request.headers.authorization,
        serviceToken: request.headers['x-xagent-service-token'] as string | undefined,
      })
      response.setHeader('content-type', 'application/json')
      if (path === '/api/v1/auth/login') {
        expect(await body(request)).toEqual({ email: 'alice@example.test', password: 'loader-password' })
        response.end(JSON.stringify({
          token_type: 'bearer',
          access_token: userToken,
          expires_at: '2026-08-27T00:00:00Z',
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
      if (path === '/internal/xagent/artifacts/list') {
        expect(await body(request)).toEqual({})
        response.end('[]')
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

function cookies(response: Response): { readonly cookie: string; readonly csrf: string } {
  const values = response.headers.getSetCookie()
  const session = values.find(value => value.startsWith('xagent_session='))?.split(';', 1)[0]
  const csrfCookie = values.find(value => value.startsWith('xagent_csrf='))?.split(';', 1)[0]
  if (session === undefined || csrfCookie === undefined) throw new Error('登录响应缺少认证 Cookie')
  return { cookie: `${session}; ${csrfCookie}`, csrf: csrfCookie.slice('xagent_csrf='.length) }
}

describe('XAgent Business 资料真实 Loader 闭包', () => {
  const root = mkdtempSync(join(tmpdir(), 'xagent-artifact-loader-'))
  const home = join(root, 'home')
  const observations: BackendObservation[] = []
  const previousEnvironment = {
    DSH_HOME: process.env.DSH_HOME,
    XAGENT_API_ORIGIN: process.env.XAGENT_API_ORIGIN,
    XAGENT_SERVICE_TOKEN: process.env.XAGENT_SERVICE_TOKEN,
    XAGENT_ALLOWED_ORIGINS: process.env.XAGENT_ALLOWED_ORIGINS,
    XAGENT_ALLOW_INSECURE_COOKIE: process.env.XAGENT_ALLOW_INSECURE_COOKIE,
    XAGENT_DELEGATION_PRIVATE_KEY: process.env.XAGENT_DELEGATION_PRIVATE_KEY,
    XAGENT_DELEGATION_ISSUER: process.env.XAGENT_DELEGATION_ISSUER,
    XAGENT_DELEGATION_AUDIENCE: process.env.XAGENT_DELEGATION_AUDIENCE,
  }
  let backendServer: Server | undefined
  let ctx: Context | undefined
  let origin = ''

  beforeAll(async () => {
    backendServer = backend(observations)
    const backendOrigin = await listen(backendServer)
    const port = await freePort()
    origin = `http://127.0.0.1:${String(port)}`
    process.env.DSH_HOME = home
    process.env.XAGENT_API_ORIGIN = backendOrigin
    process.env.XAGENT_SERVICE_TOKEN = serviceToken
    process.env.XAGENT_ALLOWED_ORIGINS = origin
    process.env.XAGENT_ALLOW_INSECURE_COOKIE = '1'
    const { privateKey } = generateKeyPairSync('ed25519')
    process.env.XAGENT_DELEGATION_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    process.env.XAGENT_DELEGATION_ISSUER = 'xagent-artifact-loader-test'
    process.env.XAGENT_DELEGATION_AUDIENCE = 'xagent-fastapi-artifact-loader-test'

    const profile = loadProfile('dsh-test', 'xagent-business', installAnchor, home)
    mkdirSync(profile.dir, { recursive: true })
    const rootConfig = join(profile.dir, 'cordis.yml')
    writeFileSync(rootConfig, '[]\n')
    healProfilesModuleFallback(installAnchor, home)
    const patches: PatchOptions[] = [
      ...profile.layers.flatMap(layer => layer.patches),
      ...profile.patches,
      { id: 'web-runtime', disabled: true },
      {
        id: 'connection',
        name: '@deepseek-ai/dsh-client-connection',
        inject: [],
        config: { trustedHosts: [] },
      },
      { id: 'client-hmr', disabled: true },
      { id: 'modules', disabled: true },
      { id: 'session-telemetry-otel', disabled: true },
    ]
    ctx = await boot('dsh-test', rootConfig, patches, (bootCtx) => {
      bootCtx.provide('dshProfileDataPath', (...segments: string[]) => join(profile.dir, 'data', ...segments))
      provideCmdline(bootCtx, { args: ['--host', '127.0.0.1', '--port', String(port)], exit: () => {} })
    })
  }, 120_000)

  afterAll(async () => {
    try {
      await ctx?.fiber.dispose()
      await close(backendServer)
    } finally {
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('从真实 HTTP 登录经 API gateway 建立认证 scope 并列出资料', async () => {
    const login = await fetch(`${origin}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email: 'alice@example.test', password: 'loader-password' }),
    })
    expect(login.status).toBe(200)
    const auth = cookies(login)
    const response = await fetch(`${origin}/api/xagentArtifact/list`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        cookie: auth.cookie,
        'x-xagent-csrf': auth.csrf,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'xagent-artifact-loader-list',
        method: 'xagentArtifact/list',
        payload: { args: {} },
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json() as RpcResponse<readonly unknown[]>).toMatchObject({
      result: { ok: true, value: [] },
    })
    expect(observations.filter(item => item.path.startsWith('/internal/xagent/'))).toEqual([
      {
        path: '/internal/xagent/auth/introspect',
        authorization: `Bearer ${userToken}`,
        serviceToken,
      },
      {
        path: '/internal/xagent/artifacts/list',
        authorization: `Bearer ${userToken}`,
        serviceToken,
      },
    ])
  })

  it('保持 Business 的运行时工具闭包只含结构化检索入口', () => {
    if (ctx === undefined) throw new Error('Business Loader 未启动')
    expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual([
      'list_accessible_projects',
      'search_artifacts',
    ])
  })
})
