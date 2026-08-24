/** XAgent 浏览器 Cookie 到 Connection Principal 的认证桥。 @module @xagent/dsh-connection-auth */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConnectionRequestContextResolver, ResolvedConnectionRequestContext } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { XAgentBackendClient, XAgentBackendError } from '@xagent/dsh-backend-client'
import { XAgentConnectionAuthenticator } from './authenticator.ts'

export {
  XAgentConnectionAuthenticator,
  type XAgentConnectionAuthOptions,
} from './authenticator.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    connectionRequestContextResolver: XAgentConnectionAuthService
  }
}

/** XAgent browser connection authentication plugin configuration. */
export interface Config {
  /** FastAPI 服务的绝对 HTTP origin。 */
  backendOrigin: string
  /** Host 调用内部认证接口时使用的服务身份。 */
  serviceToken: string
  /** 可以提交浏览器登录请求的精确 origin 清单。 */
  allowedOrigins: string[]
  /** 是否只通过 HTTPS 发送登录 Cookie。 */
  secureCookie: boolean
  /** 已认证连接再次 introspection 前的最长缓存时间。 */
  revalidateIntervalMs: number
}

export const Config: z<Config> = z.object({
  backendOrigin: z.string().required(),
  serviceToken: z.string().required(),
  allowedOrigins: z.array(String).required(),
  secureCookie: z.boolean().default(true),
  revalidateIntervalMs: z.natural().min(100).default(5_000),
})

export const name = 'xagent-connection-auth'
export const inject = ['webServer']

/** Connection 可选解析服务；通用传输只依赖其结构，不导入 XAgent。 */
export class XAgentConnectionAuthService extends Service implements ConnectionRequestContextResolver {
  constructor(ctx: Context, private readonly authenticator: XAgentConnectionAuthenticator) {
    super(ctx, 'connectionRequestContextResolver')
  }

  /**
   * Resolve one HTTP request into a context bound to its physical connection.
   * @param request - browser request carrying only Host-managed credentials.
   * @param connectionId - Host-generated physical connection identifier.
   * @param signal - request cancellation signal.
   * @returns the authenticated context used by RPC authorization.
   */
  resolve(request: Request, connectionId: string, signal: AbortSignal): Promise<ResolvedConnectionRequestContext> {
    return this.authenticator.resolve(request, connectionId, signal)
  }
}

async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
    size += chunk.byteLength
    if (size > limit) throw new TypeError('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

async function fetchRequest(request: IncomingMessage, maxBodyBytes: number): Promise<Request> {
  const headers = new Headers()
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]
    const value = request.rawHeaders[index + 1]
    if (name === undefined || value === undefined) throw new TypeError('invalid request headers')
    headers.append(name, value)
  }
  const method = request.method ?? 'GET'
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request, maxBodyBytes)
  const init: RequestInit = { method, headers }
  /* v8 ignore next -- GET, HEAD, and body-bearing branches are exercised through registered routes;
   * V8 attributes only the assignment arm. */
  if (body !== undefined) init.body = Buffer.from(body).toString('utf8')
  return new Request(new URL(request.url ?? '/', 'http://xagent.internal'), init)
}

async function send(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status
  for (const [header, value] of response.headers) {
    if (header !== 'set-cookie') target.setHeader(header, value)
  }
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) target.setHeader('set-cookie', cookies)
  target.end(Buffer.from(await response.arrayBuffer()))
}

function backendFailure(error: unknown): Response {
  return new Response(
    error instanceof XAgentBackendError && error.code === 'unauthenticated'
      ? 'unauthenticated'
      : 'service unavailable',
    { status: error instanceof XAgentBackendError && error.code === 'unauthenticated' ? 401 : 503 },
  )
}

/** 安装登录路由和 Connection 请求上下文 resolver。 */
export function apply(ctx: Context, config: Config): void {
  const backend = new XAgentBackendClient({
    origin: config.backendOrigin,
    serviceToken: config.serviceToken,
  })
  const authenticator = new XAgentConnectionAuthenticator(backend, {
    allowedOrigins: config.allowedOrigins,
    secureCookie: config.secureCookie,
    revalidateIntervalMs: config.revalidateIntervalMs,
  })
  new XAgentConnectionAuthService(ctx, authenticator)

  const login: WebRoute = {
    kind: 'exact',
    path: '/auth/login',
    handler: async (request, response) => {
      try {
        await send(await authenticator.login(await fetchRequest(request, 16 * 1024)), response)
      } catch (error) {
        await send(backendFailure(error), response)
      }
    },
  }
  const logout: WebRoute = {
    kind: 'exact',
    path: '/auth/logout',
    handler: async (request, response) => {
      try {
        await send(await authenticator.logout(await fetchRequest(request, 1)), response)
      } catch (error) {
        await send(backendFailure(error), response)
      }
    },
  }
  const status: WebRoute = {
    kind: 'exact',
    path: '/auth/session',
    handler: async (request, response) => {
      await send(await authenticator.status(await fetchRequest(request, 0)), response)
    },
  }
  ctx.effect(() => ctx.webServer.register(login), 'xagent-auth: login route')
  ctx.effect(() => ctx.webServer.register(logout), 'xagent-auth: logout route')
  ctx.effect(() => ctx.webServer.register(status), 'xagent-auth: session route')
}
