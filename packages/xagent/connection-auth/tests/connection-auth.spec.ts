import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, test, vi } from 'vitest'
import type { XAgentBackend } from '@xagent/dsh-backend-client'
import { apply, XAgentConnectionAuthenticator } from '../src/index.ts'

const ACTOR_ID = '00000000-0000-0000-0000-000000000001'
const AUTH_SESSION_ID = '00000000-0000-0000-0000-000000000101'

function backend(overrides: Partial<XAgentBackend> = {}): XAgentBackend {
  return {
    login: vi.fn(async () => ({
      accessToken: 'user-token',
      expiresAt: '2026-08-25T08:00:00Z',
      csrfToken: 'csrf-token',
    })),
    introspect: vi.fn<XAgentBackend['introspect']>(async (_token, _signal) => ({
      actorId: ACTOR_ID,
      role: 'specialist' as const,
      permissionRevision: 3,
      authSessionId: AUTH_SESSION_ID,
      connectionId: 'backend-value-is-ignored',
    })),
    revoke: vi.fn(async () => {}),
    sessions: {} as XAgentBackend['sessions'],
    ...overrides,
  }
}

function authenticator(value = backend()): XAgentConnectionAuthenticator {
  return new XAgentConnectionAuthenticator(value, {
    allowedOrigins: ['https://app.example.test'],
    secureCookie: true,
  })
}

function authenticatedRequest(method: 'GET' | 'POST' = 'POST'): Request {
  return new Request('https://app.example.test/api/session.list', {
    method,
    headers: {
      cookie: 'xagent_session=user-token; xagent_csrf=csrf-token',
      origin: 'https://app.example.test',
      'x-xagent-csrf': 'csrf-token',
    },
  })
}

function nodeRequest(options: {
  method?: string
  url?: string
  headers?: Record<string, string>
  chunks?: Array<string | Uint8Array>
}): IncomingMessage {
  const request = Readable.from(options.chunks ?? []) as IncomingMessage
  request.method = options.method
  request.url = options.url
  request.rawHeaders = Object.entries(options.headers ?? {}).flatMap(([name, value]) => [name, value])
  return request
}

async function invoke(route: WebRoute, request: IncomingMessage): Promise<{ status: number; headers: Headers; body: string }> {
  const headers = new Headers()
  let body = ''
  let finished!: () => void
  const done = new Promise<void>((resolve) => { finished = resolve })
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string | readonly string[]) {
      headers.delete(name)
      for (const item of typeof value === 'string' ? [value] : value) headers.append(name, item)
    },
    end(value?: Uint8Array) {
      body = value === undefined ? '' : Buffer.from(value).toString('utf8')
      finished()
    },
  } as unknown as ServerResponse
  await route.handler(request, response)
  await done
  return { status: response.statusCode, headers, body }
}

describe('XAgent Connection 认证桥', () => {
  test('在 RPC handler 前固定 Principal 与用户令牌', async () => {
    const introspect = vi.fn<XAgentBackend['introspect']>(async (_token, _signal) => ({
      actorId: ACTOR_ID,
      role: 'specialist',
      permissionRevision: 3,
      authSessionId: AUTH_SESSION_ID,
      connectionId: 'backend-value-is-ignored',
    }))
    const value = backend({ introspect })
    const result = await authenticator(value).resolve(authenticatedRequest(), 'connection-1')

    expect(result).toEqual({
      principal: {
        actorId: ACTOR_ID,
        role: 'specialist',
        permissionRevision: 3,
        authSessionId: AUTH_SESSION_ID,
        connectionId: 'connection-1',
      },
      userToken: 'user-token',
    })
    expect(introspect).toHaveBeenCalledWith('user-token', expect.any(AbortSignal))
  })

  test('POST 缺少同源 Origin 或双提交 CSRF 时失败关闭', async () => {
    const missingCsrf = new Request('https://app.example.test/api/session.list', {
      method: 'POST',
      headers: {
        cookie: 'xagent_session=user-token; xagent_csrf=csrf-token',
        origin: 'https://app.example.test',
      },
    })
    const foreignOrigin = new Request('https://app.example.test/api/session.list', {
      method: 'POST',
      headers: {
        cookie: 'xagent_session=user-token; xagent_csrf=csrf-token',
        origin: 'https://evil.example.test',
        'x-xagent-csrf': 'csrf-token',
      },
    })

    await expect(authenticator().resolve(missingCsrf, 'connection-1')).rejects.toThrow('unauthenticated')
    await expect(authenticator().resolve(foreignOrigin, 'connection-1')).rejects.toThrow('unauthenticated')
  })

  test('WebSocket 握手要求同源 Origin 和会话 Cookie，但不要求 CSRF 头', async () => {
    const request = new Request('https://app.example.test/api/events', {
      headers: {
        cookie: 'xagent_session=user-token',
        origin: 'https://app.example.test',
        upgrade: 'websocket',
      },
    })

    await expect(authenticator().resolve(request, 'connection-2')).resolves.toMatchObject({
      principal: { connectionId: 'connection-2' },
      userToken: 'user-token',
    })
  })

  test('登录只返回 CSRF 和过期时间，并设置严格 Cookie', async () => {
    const login = vi.fn<XAgentBackend['login']>(async () => ({
      accessToken: 'user-token', expiresAt: '2026-08-25T08:00:00Z', csrfToken: 'csrf-token',
    }))
    const value = backend({ login })
    const response = await authenticator(value).login(new Request('https://app.example.test/auth/login', {
      method: 'POST',
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.test', password: 'password' }),
    }))

    const body = await response.text()
    expect(JSON.parse(body)).toEqual({
      csrf_token: 'csrf-token',
      expires_at: '2026-08-25T08:00:00Z',
    })
    const cookies = response.headers.get('set-cookie') ?? ''
    expect(cookies).toContain('xagent_session=user-token')
    expect(cookies).toContain('HttpOnly')
    expect(cookies).toContain('SameSite=Strict')
    expect(cookies).toContain('Secure')
    expect(cookies).toContain('xagent_csrf=csrf-token')
    expect(body).not.toContain('user-token')
    expect(login).toHaveBeenCalledWith('alice@example.test', 'password', expect.any(AbortSignal))
  })

  test('退出先撤销服务端会话，再清除两个 Cookie', async () => {
    const calls: string[] = []
    const value = backend({
      revoke: vi.fn(async () => { calls.push('revoke') }),
    })
    const response = await authenticator(value).logout(authenticatedRequest())
    calls.push('response')

    expect(calls).toEqual(['revoke', 'response'])
    expect(response.status).toBe(204)
    const cookies = response.headers.get('set-cookie') ?? ''
    expect(cookies).toContain('xagent_session=;')
    expect(cookies).toContain('xagent_csrf=;')
    expect(cookies.match(/Max-Age=0/g)).toHaveLength(2)
  })

  test('退出在撤销完成后终止同一登录态的 WebSocket 生命周期', async () => {
    const value = backend()
    const auth = authenticator(value)
    const websocket = new Request('https://app.example.test/api/events', {
      headers: {
        cookie: 'xagent_session=user-token',
        origin: 'https://app.example.test',
        upgrade: 'websocket',
      },
    })
    const resolved = await auth.resolve(websocket, 'connection-3')
    expect(resolved.lifetime?.aborted).toBe(false)

    await auth.logout(authenticatedRequest())

    expect(resolved.lifetime?.aborted).toBe(true)
  })

  test('外部撤销在定期 introspection 失败后终止长连接', async () => {
    vi.useFakeTimers()
    try {
      const introspect = vi.fn()
        .mockResolvedValueOnce({
          actorId: ACTOR_ID,
          role: 'specialist',
          permissionRevision: 3,
          authSessionId: AUTH_SESSION_ID,
          connectionId: 'first',
        })
        .mockRejectedValueOnce(new Error('revoked'))
      const auth = new XAgentConnectionAuthenticator(backend({ introspect }), {
        allowedOrigins: ['https://app.example.test'],
        secureCookie: true,
        revalidateIntervalMs: 100,
      })
      const request = new Request('https://app.example.test/api/events', {
        headers: {
          cookie: 'xagent_session=user-token',
          origin: 'https://app.example.test',
          upgrade: 'websocket',
        },
      })
      const resolved = await auth.resolve(request, 'connection-4')

      await vi.advanceTimersByTimeAsync(100)

      expect(resolved.lifetime?.aborted).toBe(true)
      expect(introspect).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('非回环来源禁止关闭 Secure Cookie', () => {
    expect(() => new XAgentConnectionAuthenticator(backend(), {
      allowedOrigins: ['https://app.example.test'],
      secureCookie: false,
    })).toThrow('invalid connection authentication configuration')
  })

  test('登录态探针只返回状态，不暴露 Principal 或用户令牌', async () => {
    const auth = new XAgentConnectionAuthenticator(backend(), {
      allowedOrigins: ['https://app.example.test'],
      secureCookie: true,
    })

    const active = await auth.status(new Request('https://app.example.test/auth/session', {
      headers: { cookie: 'xagent_session=user-token' },
    }))
    const missing = await auth.status(new Request('https://app.example.test/auth/session'))

    expect(active.status).toBe(204)
    expect(await active.text()).toBe('')
    expect(missing.status).toBe(401)
  })

  test('Cookie 解析、登录载荷与来源校验的所有拒绝路径均失败关闭', async () => {
    const auth = authenticator()
    const baseHeaders = { origin: 'https://app.example.test', 'content-type': 'application/json' }
    for (const request of [
      new Request('https://app.example.test/auth/login', { method: 'GET', headers: baseHeaders }),
      new Request('https://app.example.test/auth/login', { method: 'POST', headers: { ...baseHeaders, origin: 'bad url' }, body: '{}' }),
      new Request('https://app.example.test/auth/login', { method: 'POST', headers: baseHeaders }),
      new Request('https://app.example.test/auth/login', { method: 'POST', headers: { ...baseHeaders, 'content-length': 'invalid' }, body: '{}' }),
      new Request('https://app.example.test/auth/login', { method: 'POST', headers: baseHeaders, body: 'not-json' }),
      new Request('https://app.example.test/auth/login', { method: 'POST', headers: baseHeaders, body: 'null' }),
      new Request('https://app.example.test/auth/login', { method: 'POST', headers: baseHeaders, body: JSON.stringify({ email: 1, password: 'p' }) }),
      new Request('https://app.example.test/auth/login', { method: 'POST', headers: baseHeaders, body: JSON.stringify({ email: '', password: 'p' }) }),
      new Request('https://app.example.test/auth/login', { method: 'POST', headers: baseHeaders, body: JSON.stringify({ email: 'a', password: 1 }) }),
      new Request('https://app.example.test/auth/login', { method: 'POST', headers: baseHeaders, body: JSON.stringify({ email: 'a', password: '' }) }),
    ]) expect((await auth.login(request)).status).toBe(request.method === 'GET' || request.headers.get('origin') === 'bad url' ? 403 : 400)

    const limited = new XAgentConnectionAuthenticator(backend(), {
      allowedOrigins: ['http://127.0.0.1:3000'], secureCookie: false, maxLoginBodyBytes: 3,
    })
    expect((await limited.login(new Request('http://127.0.0.1:3000/auth/login', {
      method: 'POST', headers: { origin: 'http://127.0.0.1:3000', 'content-length': '4' }, body: '{}  ',
    }))).status).toBe(400)
    expect((await limited.login(new Request('http://127.0.0.1:3000/auth/login', {
      method: 'POST', headers: { origin: 'http://127.0.0.1:3000' }, body: '{}  ',
    }))).status).toBe(400)

    await expect(auth.resolve(new Request('https://app.example.test/api', {
      method: 'POST',
      headers: { origin: 'https://app.example.test', cookie: 'xagent_session=a; xagent_session=b; xagent_csrf=x', 'x-xagent-csrf': 'x' },
    }), 'connection')).rejects.toThrow('unauthenticated')
    await expect(auth.resolve(new Request('https://app.example.test/api', {
      method: 'POST',
      headers: { origin: 'https://app.example.test', cookie: 'xagent_session=; xagent_csrf=long', 'x-xagent-csrf': 'x' },
    }), 'connection')).rejects.toThrow('unauthenticated')
  })

  test('父信号、身份变化和注销失败都终止或拒绝登录态', async () => {
    vi.useFakeTimers()
    try {
      const auth = new XAgentConnectionAuthenticator(backend({
        introspect: vi.fn()
          .mockResolvedValueOnce({ actorId: ACTOR_ID, role: 'specialist', permissionRevision: 3, authSessionId: AUTH_SESSION_ID, connectionId: 'x' })
          .mockResolvedValueOnce({ actorId: ACTOR_ID, role: 'manager', permissionRevision: 3, authSessionId: AUTH_SESSION_ID, connectionId: 'x' }),
      }), { allowedOrigins: ['https://app.example.test'], secureCookie: true, revalidateIntervalMs: 100 })
      const parent = new AbortController()
      const websocket = new Request('https://app.example.test/api/events', {
        headers: { cookie: 'xagent_session=user-token', origin: 'https://app.example.test', upgrade: 'websocket' },
        signal: parent.signal,
      })
      const first = await auth.resolve(websocket, 'connection')
      await vi.advanceTimersByTimeAsync(100)
      expect(first.lifetime?.aborted).toBe(true)

      const second = await authenticator().resolve(new Request('https://app.example.test/api/events', {
        headers: { cookie: 'xagent_session=user-token', origin: 'https://app.example.test', upgrade: 'websocket' },
        signal: parent.signal,
      }), 'connection')
      parent.abort()
      expect(second.lifetime?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }

    const failed = authenticator(backend({ revoke: vi.fn(async () => { throw new Error('revoked') }) }))
    expect((await failed.logout(authenticatedRequest())).status).toBe(401)
    expect((await failed.logout(new Request('https://app.example.test/auth/logout', { method: 'POST' }))).status).toBe(401)
    expect((await failed.logout(new Request('https://app.example.test/auth/logout', {
      method: 'POST', headers: {
        origin: 'https://app.example.test', cookie: 'xagent_csrf=csrf-token', 'x-xagent-csrf': 'csrf-token',
      },
    }))).status).toBe(401)
  })

  test('回环 HTTP 可使用非 Secure Cookie，且来源必须是规范化精确值', async () => {
    const local = new XAgentConnectionAuthenticator(backend(), {
      allowedOrigins: ['http://localhost:3000'], secureCookie: false,
    })
    const response = await local.login(new Request('http://localhost:3000/auth/login', {
      method: 'POST', headers: { origin: 'http://localhost:3000' },
      body: JSON.stringify({ email: 'alice@example.test', password: 'password' }),
    }))
    expect(response.headers.get('set-cookie')).not.toContain('Secure')
    for (const origin of ['not a url', 'http://localhost:3000/']) {
      await expect(local.resolve(new Request('http://localhost:3000/api', {
        headers: { origin, cookie: 'xagent_session=user-token' },
      }), 'connection')).rejects.toThrow('unauthenticated')
    }
    await expect(local.resolve(new Request('http://localhost:3000/api', {
      headers: { origin: 'http://localhost:3000', cookie: 'xagent_session=' },
    }), 'connection')).rejects.toThrow('unauthenticated')
  })

  test('多个长连接独立清理，成功复核会继续调度', async () => {
    vi.useFakeTimers()
    try {
      const introspect = vi.fn<XAgentBackend['introspect']>(async () => ({
        actorId: ACTOR_ID, role: 'specialist', permissionRevision: 3,
        authSessionId: AUTH_SESSION_ID, connectionId: 'ignored',
      }))
      const auth = new XAgentConnectionAuthenticator(backend({ introspect }), {
        allowedOrigins: ['https://app.example.test'], secureCookie: true, revalidateIntervalMs: 100,
      })
      const firstParent = new AbortController()
      const secondParent = new AbortController()
      const make = (signal: AbortSignal) => new Request('https://app.example.test/api/events', {
        headers: { cookie: 'xagent_session=user-token', origin: 'https://app.example.test', upgrade: 'websocket' }, signal,
      })
      const first = await auth.resolve(make(firstParent.signal), 'first')
      const second = await auth.resolve(make(secondParent.signal), 'second')
      firstParent.abort()
      expect(first.lifetime?.aborted).toBe(true)
      expect(second.lifetime?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(100)
      expect(second.lifetime?.aborted).toBe(false)
      expect(introspect).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(100)
      expect(introspect).toHaveBeenCalledTimes(4)
      secondParent.abort()
    } finally {
      vi.useRealTimers()
    }
  })

  test.each([
    [{ role: 'manager' }],
    [{ permissionRevision: 4 }],
    [{ authSessionId: crypto.randomUUID() }],
  ])('任一复核身份字段变化都会终止连接 %#', async (change) => {
    vi.useFakeTimers()
    try {
      const introspect = vi.fn()
        .mockResolvedValueOnce({ actorId: ACTOR_ID, role: 'specialist', permissionRevision: 3, authSessionId: AUTH_SESSION_ID, connectionId: 'x' })
        .mockResolvedValueOnce({ actorId: ACTOR_ID, role: 'specialist', permissionRevision: 3, authSessionId: AUTH_SESSION_ID, connectionId: 'x', ...change })
      const auth = new XAgentConnectionAuthenticator(backend({ introspect }), {
        allowedOrigins: ['https://app.example.test'], secureCookie: true, revalidateIntervalMs: 100,
      })
      const resolved = await auth.resolve(new Request('https://app.example.test/api/events', {
        headers: { cookie: 'xagent_session=user-token', origin: 'https://app.example.test', upgrade: 'websocket' },
      }), 'connection')
      await vi.advanceTimersByTimeAsync(100)
      expect(resolved.lifetime?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('Cordis 插件注册三条真实 HTTP 路由并转发 Cookie', async () => {
    const routes = new Map<string, WebRoute>()
    const ctx = new Context()
    ctx.provide('webServer', {
      register(route: WebRoute) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    } as WebServer)
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      if (path.endsWith('/login')) return Response.json({
        access_token: 'user-token', token_type: 'bearer', expires_at: '2026-08-25T08:00:00Z', csrf_token: 'csrf-token',
      })
      if (path.endsWith('/introspect')) return Response.json({
        actor_id: ACTOR_ID, role: 'specialist', permission_revision: 3, auth_session_id: AUTH_SESSION_ID,
      })
      return new Response(null, { status: 204 })
    })
    apply(ctx, {
      backendOrigin: 'https://api.example.test', serviceToken: 'service-secret',
      allowedOrigins: ['https://app.example.test'], secureCookie: true, revalidateIntervalMs: 100,
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect([...routes.keys()].sort()).toEqual(['/auth/login', '/auth/logout', '/auth/session'])

    const login = await invoke(routes.get('/auth/login')!, nodeRequest({
      method: 'POST', url: '/auth/login', headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      chunks: [Buffer.from('{"email":"alice@example.test",'), '"password":"password"}'],
    }))
    expect(login.status).toBe(200)
    expect(login.headers.get('set-cookie')).toContain('xagent_session=user-token')

    const status = await invoke(routes.get('/auth/session')!, nodeRequest({
      method: 'GET', url: '/auth/session', headers: { cookie: 'xagent_session=user-token' },
    }))
    expect(status.status).toBe(204)

    const logout = await invoke(routes.get('/auth/logout')!, nodeRequest({
      method: 'POST', url: '/auth/logout', headers: {
        origin: 'https://app.example.test', cookie: 'xagent_session=user-token; xagent_csrf=csrf-token', 'x-xagent-csrf': 'csrf-token',
      },
    }))
    expect(logout.status).toBe(204)
    const resolver = ctx.get('connectionRequestContextResolver')!
    await expect(resolver.resolve(authenticatedRequest(), 'service-connection', new AbortController().signal))
      .resolves.toMatchObject({ principal: { connectionId: 'service-connection' } })
    await ctx.fiber.dispose()
    fetcher.mockRestore()
  })

  test('插件 HTTP 适配器拒绝超限正文、畸形头并稳定映射后端错误', async () => {
    const routes = new Map<string, WebRoute>()
    const ctx = new Context()
    ctx.provide('webServer', { register(route: WebRoute) { routes.set(route.path, route); return () => {} } } as WebServer)
    const fetcher = vi.spyOn(globalThis, 'fetch')
    apply(ctx, {
      backendOrigin: 'https://api.example.test', serviceToken: 'service-secret',
      allowedOrigins: ['https://app.example.test'], secureCookie: true, revalidateIntervalMs: 100,
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    fetcher.mockResolvedValueOnce(Response.json({ detail: { code: 'unauthenticated' } }, { status: 401 }))
    const unauthorized = await invoke(routes.get('/auth/login')!, nodeRequest({
      method: 'POST', url: '/auth/login', headers: { origin: 'https://app.example.test' },
      chunks: ['{"email":"alice@example.test","password":"password"}'],
    }))
    expect(unauthorized).toMatchObject({ status: 401, body: 'unauthenticated' })

    fetcher.mockRejectedValueOnce(new Error('offline'))
    const unavailable = await invoke(routes.get('/auth/login')!, nodeRequest({
      method: 'POST', url: '/auth/login', headers: { origin: 'https://app.example.test' },
      chunks: ['{"email":"alice@example.test","password":"password"}'],
    }))
    expect(unavailable).toMatchObject({ status: 503, body: 'service unavailable' })

    const oversized = await invoke(routes.get('/auth/login')!, nodeRequest({
      method: 'POST', url: '/auth/login', headers: { origin: 'https://app.example.test' },
      chunks: ['x'.repeat(16 * 1024 + 1)],
    }))
    expect(oversized.status).toBe(503)

    const defaults = await invoke(routes.get('/auth/session')!, nodeRequest({}))
    expect(defaults.status).toBe(401)
    const head = await invoke(routes.get('/auth/session')!, nodeRequest({ method: 'HEAD', url: '/auth/session' }))
    expect(head.status).toBe(401)
    const logoutBodyFailure = await invoke(routes.get('/auth/logout')!, nodeRequest({
      method: 'POST', url: '/auth/logout', chunks: ['xx'], headers: {
        origin: 'https://app.example.test', cookie: 'xagent_session=user-token; xagent_csrf=csrf-token', 'x-xagent-csrf': 'csrf-token',
      },
    }))
    expect(logoutBodyFailure.status).toBe(503)
    const oddHeaders = nodeRequest({ method: 'GET' })
    oddHeaders.rawHeaders = ['orphan']
    await expect(invoke(routes.get('/auth/session')!, oddHeaders)).rejects.toThrow('invalid request headers')
    await ctx.fiber.dispose()
    fetcher.mockRestore()
  })
})
