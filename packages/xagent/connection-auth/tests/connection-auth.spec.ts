import { describe, expect, test, vi } from 'vitest'
import type { XAgentBackend } from '@xagent/dsh-backend-client'
import { XAgentConnectionAuthenticator } from '../src/index.ts'

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
})
