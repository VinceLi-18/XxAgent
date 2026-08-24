import { timingSafeEqual } from 'node:crypto'
import type { XAgentBackend } from '@xagent/dsh-backend-client'
import type { ConnectionRequestContextResolver, ResolvedConnectionRequestContext } from '@deepseek-ai/dsh-client-connection'

const SESSION_COOKIE = 'xagent_session'
const CSRF_COOKIE = 'xagent_csrf'

export interface XAgentConnectionAuthOptions {
  allowedOrigins: readonly string[]
  secureCookie: boolean
  maxLoginBodyBytes?: number
  revalidateIntervalMs?: number
}

function cookieValue(header: string | null, name: string): string | undefined {
  if (header === null) return undefined
  const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`))
  if (matches.length !== 1) return undefined
  const match = matches[0]
  if (match === undefined) return undefined
  const value = match.slice(name.length + 1)
  return value.length === 0 ? undefined : value
}

function sameText(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function isLoopbackOrigin(origin: string): boolean {
  const hostname = new URL(origin).hostname
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

async function boundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new TypeError('invalid request')
  }
  const reader = request.body?.getReader()
  if (reader === undefined) throw new TypeError('invalid request')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new TypeError('invalid request')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function cookie(name: string, value: string, httpOnly: boolean, secure: boolean, clear = false): string {
  return [
    `${name}=${value}`,
    'Path=/',
    ...(httpOnly ? ['HttpOnly'] : []),
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
    ...(clear ? ['Max-Age=0'] : []),
  ].join('; ')
}

/** 将浏览器 Cookie 认证为一次固定的 XAgent 请求上下文。 */
export class XAgentConnectionAuthenticator implements ConnectionRequestContextResolver {
  private readonly origins: ReadonlySet<string>
  private readonly maxLoginBodyBytes: number
  private readonly revalidateIntervalMs: number
  private readonly lifetimes = new Map<string, Set<AbortController>>()

  constructor(
    private readonly backend: XAgentBackend,
    private readonly options: XAgentConnectionAuthOptions,
  ) {
    const origins = options.allowedOrigins.map(value => new URL(value).origin)
    if (origins.length === 0 || (!options.secureCookie && origins.some(origin => !isLoopbackOrigin(origin)))) {
      throw new TypeError('invalid connection authentication configuration')
    }
    this.origins = new Set(origins)
    this.maxLoginBodyBytes = options.maxLoginBodyBytes ?? 16 * 1024
    this.revalidateIntervalMs = options.revalidateIntervalMs ?? 5_000
  }

  async resolve(
    request: Request,
    connectionId: string,
    signal: AbortSignal = request.signal,
  ): Promise<ResolvedConnectionRequestContext> {
    this.assertOrigin(request)
    if (request.method !== 'GET') this.assertCsrf(request)
    const userToken = cookieValue(request.headers.get('cookie'), SESSION_COOKIE)
    if (userToken === undefined) throw new Error('unauthenticated')
    const resolved = await this.backend.introspect(userToken, signal)
    const principal = Object.freeze({ ...resolved, connectionId })
    const lifetime = request.headers.get('upgrade')?.toLowerCase() === 'websocket'
      ? this.watch(userToken, principal, signal)
      : undefined
    return Object.freeze({ principal, userToken, ...lifetime === undefined ? {} : { lifetime } })
  }

  async login(request: Request): Promise<Response> {
    if (request.method !== 'POST' || !this.hasAllowedOrigin(request)) {
      return new Response('forbidden', { status: 403 })
    }
    let value: unknown
    try {
      value = await boundedJson(request, this.maxLoginBodyBytes)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    if (typeof value !== 'object' || value === null) return new Response('bad request', { status: 400 })
    const { email, password } = value as Record<string, unknown>
    if (typeof email !== 'string' || email.length === 0 || typeof password !== 'string' || password.length === 0) {
      return new Response('bad request', { status: 400 })
    }
    const issued = await this.backend.login(email, password, request.signal)
    const headers = new Headers({ 'content-type': 'application/json' })
    headers.append('set-cookie', cookie(SESSION_COOKIE, issued.accessToken, true, this.options.secureCookie))
    headers.append('set-cookie', cookie(CSRF_COOKIE, issued.csrfToken, false, this.options.secureCookie))
    return Response.json({ csrf_token: issued.csrfToken, expires_at: issued.expiresAt }, { headers })
  }

  async status(request: Request): Promise<Response> {
    const headers = { 'x-xagent-auth': '1' }
    try {
      const userToken = cookieValue(request.headers.get('cookie'), SESSION_COOKIE)
      if (userToken === undefined) throw new Error('unauthenticated')
      await this.backend.introspect(userToken, request.signal)
      return new Response(null, { status: 204, headers })
    } catch {
      return new Response('unauthenticated', { status: 401, headers })
    }
  }

  async logout(request: Request): Promise<Response> {
    try {
      this.assertOrigin(request)
      this.assertCsrf(request)
      const userToken = cookieValue(request.headers.get('cookie'), SESSION_COOKIE)
      if (userToken === undefined) throw new Error('unauthenticated')
      await this.backend.revoke(userToken, request.signal)
      this.abortLifetimes(userToken)
    } catch {
      return new Response('unauthenticated', { status: 401 })
    }
    const headers = new Headers()
    headers.append('set-cookie', cookie(SESSION_COOKIE, '', true, this.options.secureCookie, true))
    headers.append('set-cookie', cookie(CSRF_COOKIE, '', false, this.options.secureCookie, true))
    return new Response(null, { status: 204, headers })
  }

  private hasAllowedOrigin(request: Request): boolean {
    const value = request.headers.get('origin')
    if (value === null) return false
    try {
      return this.origins.has(new URL(value).origin) && new URL(value).origin === value
    } catch {
      return false
    }
  }

  private assertOrigin(request: Request): void {
    if (!this.hasAllowedOrigin(request)) throw new Error('unauthenticated')
  }

  private assertCsrf(request: Request): void {
    const fromCookie = cookieValue(request.headers.get('cookie'), CSRF_COOKIE)
    const fromHeader = request.headers.get('x-xagent-csrf') ?? undefined
    if (!sameText(fromCookie, fromHeader)) throw new Error('unauthenticated')
  }

  private watch(
    userToken: string,
    expected: Readonly<{ actorId: string; role: string; permissionRevision: number; authSessionId: string }>,
    parent: AbortSignal,
  ): AbortSignal {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const watchers = this.lifetimes.get(userToken) ?? new Set<AbortController>()
    watchers.add(controller)
    this.lifetimes.set(userToken, watchers)
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      watchers.delete(controller)
      if (watchers.size === 0) this.lifetimes.delete(userToken)
    }
    controller.signal.addEventListener('abort', cleanup, { once: true })
    parent.addEventListener('abort', () => { controller.abort() }, { once: true })
    const revalidate = async (): Promise<void> => {
      if (controller.signal.aborted) return
      try {
        const current = await this.backend.introspect(userToken, controller.signal)
        if (
          current.actorId !== expected.actorId
          || current.role !== expected.role
          || current.permissionRevision !== expected.permissionRevision
          || current.authSessionId !== expected.authSessionId
        ) {
          controller.abort()
          return
        }
      } catch {
        controller.abort()
        return
      }
      timer = setTimeout(() => { void revalidate() }, this.revalidateIntervalMs)
      timer.unref()
    }
    timer = setTimeout(() => { void revalidate() }, this.revalidateIntervalMs)
    timer.unref()
    return controller.signal
  }

  private abortLifetimes(userToken: string): void {
    for (const controller of this.lifetimes.get(userToken) ?? []) controller.abort()
  }
}
