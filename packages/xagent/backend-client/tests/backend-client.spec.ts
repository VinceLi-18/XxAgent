import { describe, expect, test, vi } from 'vitest'
import { XAgentBackendClient, XAgentBackendError } from '../src/index.ts'

const principal = {
  actor_id: '00000000-0000-0000-0000-000000000001',
  role: 'specialist',
  permission_revision: 3,
  auth_session_id: '00000000-0000-0000-0000-000000000101',
}

const bootstrapResponse = {
  schema_version: 1,
  account: {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'alice@example.test',
    role: 'specialist',
    permission_revision: 3,
  },
  capabilities: ['project.create'],
  context: { kind: 'workbench', project_id: null },
  projects: [{
    id: '00000000-0000-0000-0000-000000000201',
    name: 'Alpha',
    created_at: '2026-08-25T08:00:00+00:00',
  }],
  session_scopes: [
    {
      session_id: '00000000-0000-0000-0000-000000000301',
      visibility: 'private',
      project_id: null,
    },
    {
      session_id: '00000000-0000-0000-0000-000000000302',
      visibility: 'project',
      project_id: '00000000-0000-0000-0000-000000000201',
    },
  ],
  session_summary: {
    private_count: 2,
    project_counts: { '00000000-0000-0000-0000-000000000201': 4 },
  },
}

const projectResponse = {
  schema_version: 1,
  account_id: '00000000-0000-0000-0000-000000000001',
  project: {
    id: '00000000-0000-0000-0000-000000000201',
    name: 'Alpha',
    created_at: '2026-08-25T08:00:00+00:00',
  },
  access: { can_edit: true },
  session_summary: { session_count: 4 },
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('XAgent 后端客户端', () => {
  test('缺少 FastAPI origin 或 Host 服务身份时构造立即失败', () => {
    expect(() => new XAgentBackendClient({ origin: '', serviceToken: 'service-secret' }))
      .toThrow('invalid XAgent backend configuration')
    expect(() => new XAgentBackendClient({ origin: 'https://api.example.test', serviceToken: '' }))
      .toThrow('invalid XAgent backend configuration')
    expect(() => new XAgentBackendClient({ origin: 'file:///tmp/api', serviceToken: 'service-secret' }))
      .toThrow('invalid XAgent backend configuration')
  })

  test('公开登录不发送 Host 服务身份并严格解析令牌响应', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
      access_token: 'user-token',
      token_type: 'bearer',
      expires_at: '2026-08-25T08:00:00Z',
      csrf_token: 'csrf-token',
    }))
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: fetcher,
    })

    await expect(client.login('alice@example.test', 'password')).resolves.toEqual({
      accessToken: 'user-token',
      expiresAt: '2026-08-25T08:00:00Z',
      csrfToken: 'csrf-token',
    })
    const [url, init] = fetcher.mock.calls[0]!
    expect(requestUrl(url)).toBe('https://api.example.test/api/v1/auth/login')
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    expect(new Headers(init?.headers).has('x-xagent-service-token')).toBe(false)
  })

  test('固定 origin、内部路径、服务身份和用户 JWT', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(principal), { status: 200 }))
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test/base/path',
      serviceToken: 'service-secret',
      fetch: fetcher,
      connectionId: () => 'connection-1',
    })

    const result = await client.introspect('user-secret')

    expect(result.connectionId).toBe('connection-1')
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(requestUrl(url)).toBe('https://api.example.test/internal/xagent/auth/introspect')
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' })
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer user-secret')
    expect(new Headers(init?.headers).get('x-xagent-service-token')).toBe('service-secret')
  })

  test('非成功响应只暴露稳定错误码，不回显凭据或正文', async () => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => new Response(
        JSON.stringify({ detail: { code: 'not-found' }, leaked: 'user-secret' }),
        { status: 404 },
      ),
    })

    const rejected = await client.sessions.open('user-secret', crypto.randomUUID()).catch((error: unknown) => error)

    expect(rejected).toBeInstanceOf(XAgentBackendError)
    expect(rejected).toMatchObject({ code: 'not-found' })
    expect(String(rejected)).not.toContain('user-secret')
  })

  test('限制完整响应正文大小', async () => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      maxResponseBytes: 32,
      fetch: async () => new Response(JSON.stringify({ value: 'x'.repeat(64) })),
    })

    await expect(client.sessions.list('user-secret')).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('调用方取消会传到 fetch 且统一映射服务不可用', async () => {
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('request aborted', { cause: init.signal?.reason }))
      }, { once: true })
    }))
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: fetcher,
    })
    const controller = new AbortController()
    const pending = client.sessions.list('user-secret', controller.signal)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'service-unavailable' })
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true)
  })

  test('会话授权使用固定路径且接受空成功响应', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 204 }))
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: fetcher,
    })

    await expect(client.sessions.authorize('user-secret', 'session/unsafe', 'edit')).resolves.toBeUndefined()
    expect(requestUrl(fetcher.mock.calls[0]![0])).toBe(
      'https://api.example.test/internal/xagent/sessions/session%2Funsafe/authorize',
    )
  })

  test.each([
    [null],
    ['invalid'],
    [{ token_type: 'basic', access_token: 'token', expires_at: 'time', csrf_token: 'csrf' }],
    [{ token_type: 'bearer', access_token: 1, expires_at: 'time', csrf_token: 'csrf' }],
    [{ token_type: 'bearer', access_token: '', expires_at: 'time', csrf_token: 'csrf' }],
    [{ token_type: 'bearer', access_token: 'token', expires_at: 1, csrf_token: 'csrf' }],
    [{ token_type: 'bearer', access_token: 'token', expires_at: '', csrf_token: 'csrf' }],
    [{ token_type: 'bearer', access_token: 'token', expires_at: 'time', csrf_token: 1 }],
    [{ token_type: 'bearer', access_token: 'token', expires_at: 'time', csrf_token: '' }],
  ])('拒绝畸形登录响应 %#', async (value) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json(value),
    })
    await expect(client.login('alice@example.test', 'password')).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('拒绝畸形 Principal，并把底层网络异常统一为服务不可用', async () => {
    const invalid = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: async () => Response.json({}),
    })
    await expect(invalid.introspect('token')).rejects.toMatchObject({ code: 'service-unavailable' })

    const failed = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: async () => { throw new Error('secret') },
    })
    await expect(failed.sessions.list('token')).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('全部 Session 方法固定编码路径和请求正文', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const client = new XAgentBackendClient({
      origin: 'http://127.0.0.1:3000',
      serviceToken: 'service-secret',
      fetch: async (input, init) => {
        calls.push({
          url: requestUrl(input),
          body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
        })
        return Response.json({ ok: true })
      },
    })
    const id = 'id/unsafe'
    await client.sessions.list('token')
    await client.sessions.create('token', { schema_version: 1, runtime_header: {} })
    await client.sessions.open('token', id)
    await client.sessions.events('token', id, { schema_version: 1, after_seq: 2 })
    await client.sessions.append('token', id, { schema_version: 1, events: [] })
    await client.sessions.fork('token', id, { schema_version: 1, target_session_id: 'target' })
    await client.sessions.archive('token', id, { schema_version: 1 })
    await client.revoke('token')

    expect(calls.map(call => new URL(call.url).pathname)).toEqual([
      '/internal/xagent/sessions/list',
      '/internal/xagent/sessions',
      '/internal/xagent/sessions/id%2Funsafe/open',
      '/internal/xagent/sessions/id%2Funsafe/events',
      '/internal/xagent/sessions/id%2Funsafe/append',
      '/internal/xagent/sessions/id%2Funsafe/fork',
      '/internal/xagent/sessions/id%2Funsafe/archive',
      '/internal/xagent/auth/revoke',
    ])
    expect(calls[0]?.body).toEqual({ schema_version: 1 })
  })

  test('内部调用缺少用户令牌时失败关闭', async () => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: vi.fn(),
    })
    await expect(client.sessions.list(undefined as never)).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  test.each([
    [401, {}, 'unauthenticated'],
    [403, { detail: { code: 'forbidden' } }, 'forbidden'],
    [404, { detail: { code: 'session-not-found' } }, 'session-not-found'],
    [500, {}, 'service-unavailable'],
    [503, { detail: { code: 'service-unavailable' } }, 'service-unavailable'],
    [500, 'failure', 'service-unavailable'],
    [409, { detail: null }, 'service-unavailable'],
    [409, { detail: { code: 1 } }, 'service-unavailable'],
    [409, { detail: { code: 'sequence-conflict' } }, 'sequence-conflict'],
    [409, { detail: { code: 'idempotency-conflict' } }, 'idempotency-conflict'],
    [409, { detail: { code: 'unsupported-version' } }, 'unsupported-version'],
  ])('规范化后端错误 %#', async (status, body, code) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => new Response(JSON.stringify(body), { status }),
    })
    await expect(client.sessions.list('token')).rejects.toMatchObject({ code })
  })

  test('拒绝空白或非 JSON 成功响应，并能拼接多段响应流', async () => {
    const invalid = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: async () => new Response('not-json'),
    })
    await expect(invalid.sessions.list('token')).rejects.toMatchObject({ code: 'service-unavailable' })

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"sessions":'))
        controller.enqueue(new TextEncoder().encode('[]}'))
        controller.close()
      },
    })
    const streamed = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: async () => new Response(stream),
    })
    await expect(streamed.sessions.list('token')).resolves.toEqual({ sessions: [] })
  })

  test('默认使用平台 fetch 和随机物理连接标识', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(principal))
    try {
      const client = new XAgentBackendClient({ origin: 'https://api.example.test', serviceToken: 'service-secret' })
      const result = await client.introspect('token')
      expect(result.connectionId).toMatch(/^[0-9a-f-]{36}$/)
      expect(fetcher).toHaveBeenCalledOnce()
    } finally {
      fetcher.mockRestore()
    }
  })

  test('工作台方法只调用固定 POST 路径并严格转换协议字段', async () => {
    const calls: Array<{ path: string; body: unknown; headers: Headers; redirect: RequestRedirect | undefined }> = []
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(requestUrl(input)).pathname
      calls.push({
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
        headers: new Headers(init?.headers),
        redirect: init?.redirect,
      })
      if (path === '/internal/xagent/workbench/bootstrap') return Response.json(bootstrapResponse)
      if (path === '/internal/xagent/workbench/context') {
        return Response.json({
          schema_version: 1,
          account_id: bootstrapResponse.account.id,
          context: { kind: 'workbench', project_id: null },
        })
      }
      if (path === '/internal/xagent/projects') {
        return Response.json({
          schema_version: 1,
          account_id: bootstrapResponse.account.id,
          project: projectResponse.project,
          context: { kind: 'project', project_id: projectResponse.project.id },
        }, { status: 201 })
      }
      if (path.startsWith('/internal/xagent/projects/')) return Response.json(projectResponse)
      if (path === '/internal/xagent/session-project-refs') return new Response(null, { status: 204 })
      return new Response(null, { status: 500 })
    })
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test/base',
      serviceToken: 'service-secret',
      fetch: fetcher,
    })

    const bootstrapped = await client.workbench.bootstrap('user-secret')
    const selected = await client.workbench.selectContext(
      'user-secret',
      { kind: 'workbench' },
    )
    const created = await client.workbench.createProject(
      'user-secret',
      { name: 'Alpha', idempotencyKey: 'create-1' },
    )
    const detail = await client.workbench.project(
      'user-secret',
      'project/unsafe',
    )
    await client.workbench.addSessionProjectRefs('user-secret', {
      sessionId: '00000000-0000-0000-0000-000000000301',
      projectIds: ['00000000-0000-0000-0000-000000000201'],
      idempotencyKey: 'refs-1',
    })

    expect(bootstrapped).toEqual({
      account: {
        id: bootstrapResponse.account.id,
        email: 'alice@example.test',
        role: 'specialist',
        permissionRevision: 3,
      },
      capabilities: ['project.create'],
      context: { kind: 'workbench' },
      projects: [{
        id: projectResponse.project.id,
        name: 'Alpha',
        createdAt: '2026-08-25T08:00:00+00:00',
      }],
      sessionScopes: [
        {
          sessionId: '00000000-0000-0000-0000-000000000301',
          visibility: 'private',
        },
        {
          sessionId: '00000000-0000-0000-0000-000000000302',
          visibility: 'project',
          projectId: '00000000-0000-0000-0000-000000000201',
        },
      ],
      sessionSummary: {
        privateCount: 2,
        projectCounts: { [projectResponse.project.id]: 4 },
      },
    })
    expect(selected).toEqual(bootstrapped)
    expect(created).toEqual(bootstrapped)
    expect(detail).toEqual({
      accountId: bootstrapResponse.account.id,
      id: projectResponse.project.id,
      name: 'Alpha',
      createdAt: '2026-08-25T08:00:00+00:00',
      canEdit: true,
      sessionCount: 4,
    })
    expect(calls.map(call => call.path)).toEqual([
      '/internal/xagent/workbench/bootstrap',
      '/internal/xagent/workbench/context',
      '/internal/xagent/workbench/bootstrap',
      '/internal/xagent/projects',
      '/internal/xagent/workbench/bootstrap',
      '/internal/xagent/projects/project%2Funsafe',
      '/internal/xagent/session-project-refs',
    ])
    expect(calls.map(call => call.body)).toEqual([
      { schema_version: 1 },
      { schema_version: 1, kind: 'workbench', project_id: null },
      { schema_version: 1 },
      { schema_version: 1, name: 'Alpha', idempotency_key: 'create-1' },
      { schema_version: 1 },
      { schema_version: 1 },
      {
        schema_version: 1,
        session_id: '00000000-0000-0000-0000-000000000301',
        project_ids: ['00000000-0000-0000-0000-000000000201'],
        idempotency_key: 'refs-1',
      },
    ])
    expect(calls.every(call => call.headers.get('authorization') === 'Bearer user-secret')).toBe(true)
    expect(calls.every(call => call.headers.get('x-xagent-service-token') === 'service-secret')).toBe(true)
    expect(calls.every(call => call.redirect === 'manual')).toBe(true)
  })

  test.each([
    [null],
    [{ ...bootstrapResponse, schema_version: 2 }],
    [{ ...bootstrapResponse, extra: true }],
    [{ ...bootstrapResponse, account: { ...bootstrapResponse.account, permission_revision: 0 } }],
    [{ ...bootstrapResponse, capabilities: ['project.delete'] }],
    [{ ...bootstrapResponse, context: { kind: 'project', project_id: null } }],
    [{ ...bootstrapResponse, projects: [{ ...bootstrapResponse.projects[0], created_at: '' }] }],
    [{ ...bootstrapResponse, session_scopes: null }],
    [{ ...bootstrapResponse, session_scopes: [{ session_id: 'bad', visibility: 'private', project_id: null }] }],
    [{ ...bootstrapResponse, session_scopes: [{ session_id: '00000000-0000-0000-0000-000000000301', visibility: 'project', project_id: null }] }],
    [{ ...bootstrapResponse, session_scopes: [...bootstrapResponse.session_scopes, { session_id: '00000000-0000-0000-0000-000000000301', visibility: 'private', project_id: null }] }],
    [{ ...bootstrapResponse, session_scopes: [{ session_id: '00000000-0000-0000-0000-000000000301', visibility: 'project', project_id: '00000000-0000-0000-0000-000000000999' }] }],
    [{ ...bootstrapResponse, session_summary: { private_count: -1, project_counts: {} } }],
    [{ ...bootstrapResponse, session_summary: { private_count: 0, project_counts: {} } }],
    [{ ...bootstrapResponse, projects: [...bootstrapResponse.projects, bootstrapResponse.projects[0]] }],
  ])('拒绝畸形工作台 Bootstrap %#', async (value) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json(value),
    })

    await expect(client.workbench.bootstrap('token')).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [null],
    [{ ...projectResponse, schema_version: 2 }],
    [{ ...projectResponse, account_id: '' }],
    [{ ...projectResponse, project: { ...projectResponse.project, name: '' } }],
    [{ ...projectResponse, access: { can_edit: 'yes' } }],
    [{ ...projectResponse, session_summary: { session_count: -1 } }],
  ])('拒绝畸形项目详情 %#', async (value) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json(value),
    })

    await expect(client.workbench.project('token', 'project-id')).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('拒绝畸形操作响应和跨账号 Bootstrap', async () => {
    const malformedCreate = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json({
        schema_version: 1,
        account_id: bootstrapResponse.account.id,
        project: projectResponse.project,
        context: { kind: 'project', project_id: projectResponse.project.id },
        owner_id: bootstrapResponse.account.id,
      }),
    })
    await expect(malformedCreate.workbench.createProject('token', {
      name: 'Alpha',
      idempotencyKey: 'create-1',
    })).rejects.toMatchObject({ code: 'service-unavailable' })

    const responses = [
      Response.json({
        schema_version: 1,
        account_id: bootstrapResponse.account.id,
        context: { kind: 'workbench', project_id: null },
      }),
      Response.json({
        ...bootstrapResponse,
        account: {
          ...bootstrapResponse.account,
          id: '00000000-0000-0000-0000-000000000002',
        },
      }),
    ]
    const crossed = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => responses.shift()!,
    })
    await expect(crossed.workbench.selectContext('token', { kind: 'workbench' }))
      .rejects.toMatchObject({ code: 'service-unavailable' })

    const nonemptyRefs = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json({ ok: true }),
    })
    await expect(nonemptyRefs.workbench.addSessionProjectRefs('token', {
      sessionId: '00000000-0000-0000-0000-000000000301',
      projectIds: ['00000000-0000-0000-0000-000000000201'],
      idempotencyKey: 'refs-1',
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('工作台请求体超限、超时和重定向全部失败关闭', async () => {
    const notCalled = vi.fn()
    const oversized = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      maxRequestBytes: 32,
      fetch: notCalled,
    })
    await expect(oversized.workbench.createProject('token', {
      name: 'x'.repeat(64),
      idempotencyKey: 'key',
    })).rejects.toMatchObject({ code: 'service-unavailable' })
    expect(notCalled).not.toHaveBeenCalled()

    const timedOut = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      timeoutMs: 1,
      fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('request timed out'))
        }, { once: true })
      }),
    })
    await expect(timedOut.workbench.bootstrap('token')).rejects.toMatchObject({ code: 'service-unavailable' })

    const redirected = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
    })
    await expect(redirected.workbench.bootstrap('token')).rejects.toMatchObject({ code: 'service-unavailable' })
  })
})
