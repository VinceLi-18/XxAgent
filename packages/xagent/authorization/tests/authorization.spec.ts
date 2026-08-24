import type { ConnectionRequestContext } from '@deepseek-ai/dsh-client-connection'
import { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { XAgentBackend, XAgentSessionBackend } from '@xagent/dsh-backend-client'
import { XAgentBackendError } from '@xagent/dsh-backend-client'
import { describe, expect, test, vi } from 'vitest'
import * as authorizationModule from '../src/index.ts'
import {
  XAgentAuthorization,
  XAgentAuthorizationService,
  type TokenScopedPersistence,
} from '../src/index.ts'

const context: ConnectionRequestContext = {
  principal: {
    actorId: '00000000-0000-0000-0000-000000000001',
    role: 'specialist',
    permissionRevision: 3,
    authSessionId: '00000000-0000-0000-0000-000000000101',
    connectionId: 'connection-1',
  },
  userToken: 'alice-token',
  connectionId: 'connection-1',
}

function backend(authorize: XAgentSessionBackend['authorize'] = vi.fn(async () => {})): XAgentBackend {
  return {
    login: vi.fn(), introspect: vi.fn(), revoke: vi.fn(),
    sessions: {
      list: vi.fn(async () => ({ schema_version: 1, sessions: [] })),
      create: vi.fn(), open: vi.fn(), events: vi.fn(), append: vi.fn(), fork: vi.fn(), archive: vi.fn(),
      authorize,
    },
  }
}

function persistence(onToken?: (token: string) => void): TokenScopedPersistence {
  return {
    async withUserToken<T>(token: string, operation: () => Promise<T>): Promise<T> {
      onToken?.(token)
      return operation()
    },
  }
}

const success = async (): Promise<RpcResult<string>> => ({ ok: true, value: 'ok' })

describe('XAgent Session 授权', () => {
  test('模块插件入口只暴露带配置的安装函数', () => {
    expect('default' in authorizationModule).toBe(false)
    expect(typeof authorizationModule.apply).toBe('function')
  })

  test('Cordis 服务代理保留授权器依赖与方法 this', async () => {
    const scopedTokens: string[] = []
    const ctx = new Context()
    new XAgentAuthorizationService(ctx, backend(), persistence(token => scopedTokens.push(token)))

    const result = new Promise<RpcResult<string>>((resolve) => {
      void ctx.plugin({
        inject: ['connectionRequestAuthorizer'],
        apply(consumer) {
          void consumer.connectionRequestAuthorizer.run(
            'session/list',
            { args: {} },
            context,
            new AbortController().signal,
            success,
          ).then(resolve)
        },
      })
    })

    await expect(result).resolves.toEqual({ ok: true, value: 'ok' })
    expect(scopedTokens).toEqual(['alice-token'])
  })

  test('缺少可信 Principal 或用户令牌时不调用业务方法', async () => {
    const operation = vi.fn(success)
    const auth = new XAgentAuthorization(backend(), persistence())

    const result = await auth.run('session/list', { args: {} }, { connectionId: 'anonymous' }, new AbortController().signal, operation)

    expect(result).toEqual({ ok: false, error: { code: 'unauthenticated', message: 'authentication required', details: {} } })
    expect(operation).not.toHaveBeenCalled()
  })

  test.each([
    ['session/history', 'read'],
    ['session/prompt', 'edit'],
    ['session/fork', 'read'],
    ['session/cancel', 'edit'],
  ] as const)('%s 映射为 %s 权限并在令牌作用域内执行', async (endpoint, permission) => {
    const authorize = vi.fn(async () => {})
    const scopedTokens: string[] = []
    const scope = persistence(token => scopedTokens.push(token))
    const auth = new XAgentAuthorization(backend(authorize), scope)

    await expect(auth.run(
      endpoint,
      { args: { sessionId: 'session-00000000-0000-0000-0000-000000000701' } },
      context,
      new AbortController().signal,
      success,
    )).resolves.toEqual({ ok: true, value: 'ok' })

    expect(authorize).toHaveBeenCalledWith(
      'alice-token',
      '00000000-0000-0000-0000-000000000701',
      permission,
      expect.any(AbortSignal),
    )
    expect(scopedTokens).toEqual(['alice-token'])
  })

  test('prompt 将 Host rpcId 与用户令牌显式绑定给后续事件追加', async () => {
    const authorizeRequest = vi.fn()
    const scope: TokenScopedPersistence = { ...persistence(), authorizeRequest }
    const auth = new XAgentAuthorization(backend(), scope)

    await auth.run(
      'session/prompt',
      { args: { sessionId: 'session-00000000-0000-0000-0000-000000000701' } },
      { ...context, requestId: 'rpc-alice-prompt' },
      new AbortController().signal,
      success,
    )

    expect(authorizeRequest).toHaveBeenCalledWith(
      'session-00000000-0000-0000-0000-000000000701',
      'rpc-alice-prompt',
      'alice-token',
    )
    await auth.run(
      'session/history',
      { args: { sessionId: 'session-00000000-0000-0000-0000-000000000701' } },
      context,
      new AbortController().signal,
      success,
    )
    expect(authorizeRequest).toHaveBeenLastCalledWith(
      'session-00000000-0000-0000-0000-000000000701',
      undefined,
      'alice-token',
    )
  })

  test('不可见 Session 统一映射为 session-not-found', async () => {
    const authorize = vi.fn(async () => { throw new XAgentBackendError('not-found') })
    const auth = new XAgentAuthorization(backend(authorize), persistence())

    const result = await auth.run(
      'session/history',
      { args: { sessionId: 'session-00000000-0000-0000-0000-000000000701' } },
      context,
      new AbortController().signal,
      success,
    )

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'session-not-found',
        message: 'session not found',
        details: { sessionId: 'session-00000000-0000-0000-0000-000000000701' },
      },
    })
  })

  test('列表结果按 FastAPI 当前可见集合过滤内存中的其他用户 Session', async () => {
    const value = backend()
    value.sessions.list = vi.fn(async () => ({
      schema_version: 1,
      sessions: [{ runtime_header: { id: 'session-alice' } }],
    }))
    const auth = new XAgentAuthorization(value, persistence())

    const result = await auth.run(
      'session/list',
      { args: {} },
      context,
      new AbortController().signal,
      async () => ({
        ok: true,
        value: { items: [{ sessionId: 'session-alice' }, { sessionId: 'session-bob' }] },
      }),
    )

    expect(result).toEqual({ ok: true, value: { items: [{ sessionId: 'session-alice' }] } })
  })

  test('显式恢复 Session、归档和导出都先验证当前 read/edit 权限', async () => {
    const authorize = vi.fn(async () => {})
    const auth = new XAgentAuthorization(backend(authorize), persistence())
    const signal = new AbortController().signal

    await auth.run('session/create', { args: { sessionId: 'session-00000000-0000-0000-0000-000000000701' } }, context, signal, success)
    await auth.run('workspace/archiveSession', { sessionId: 'session-00000000-0000-0000-0000-000000000702' }, context, signal, success)
    await auth.run('session.export', { sessionId: 'session-00000000-0000-0000-0000-000000000703' }, context, signal, success)

    expect(authorize.mock.calls.map(call => call.slice(1, 3))).toEqual([
      ['00000000-0000-0000-0000-000000000701', 'read'],
      ['00000000-0000-0000-0000-000000000702', 'edit'],
      ['00000000-0000-0000-0000-000000000703', 'read'],
    ])
  })

  test('实时事件逐 Session 复核，工作区事件不进入 Phase 2 Business 客户端', async () => {
    const authorize = vi.fn(async (_token: string, id: string) => {
      if (id.endsWith('702')) throw new XAgentBackendError('not-found')
    })
    const auth = new XAgentAuthorization(backend(authorize), persistence())
    const signal = new AbortController().signal

    await expect(auth.filterEvent('events.mux', {
      type: 'session/event',
      sessionId: 'session-00000000-0000-0000-0000-000000000701',
      event: {},
    }, context, signal)).resolves.toMatchObject({ type: 'session/event' })
    await expect(auth.filterEvent('events.mux', {
      type: 'session/event',
      sessionId: 'session-00000000-0000-0000-0000-000000000702',
      event: {},
    }, context, signal)).resolves.toBeUndefined()
    await expect(auth.filterEvent('events.host', {
      type: 'host/workspace-changed',
      workspace: { workspaceId: 'local' },
    }, context, signal)).resolves.toBeUndefined()
    await expect(auth.filterEvent('events.host', {
      type: 'host/archived-sessions-changed',
      archivedSessionIds: [
        'session-00000000-0000-0000-0000-000000000701',
        'session-00000000-0000-0000-0000-000000000702',
      ],
    }, context, signal)).resolves.toEqual({
      type: 'host/archived-sessions-changed',
      archivedSessionIds: ['session-00000000-0000-0000-0000-000000000701'],
    })
  })

  test('项目 UI 延后时拒绝访问内部 Workspace registry', async () => {
    const operation = vi.fn(success)
    const auth = new XAgentAuthorization(backend(), persistence())

    const result = await auth.run(
      'workspace/list',
      { args: {} },
      context,
      new AbortController().signal,
      operation,
    )

    expect(result).toEqual({
      ok: false,
      error: { code: 'unauthenticated', message: 'authentication required', details: {} },
    })
    expect(operation).not.toHaveBeenCalled()
  })

  test('匿名连接收不到实时事件', async () => {
    const auth = new XAgentAuthorization(backend(), persistence())
    await expect(auth.filterEvent(
      'events.host',
      { type: 'host/remote-event', event: 'commands/change', args: [] },
      { connectionId: 'anonymous' },
      new AbortController().signal,
    )).resolves.toBeUndefined()
  })

  test('非 Session endpoint 保持上游行为', async () => {
    const operation = vi.fn(success)
    const auth = new XAgentAuthorization(backend(), persistence())

    await expect(auth.run('host/describe', { args: {} }, context, new AbortController().signal, operation))
      .resolves.toEqual({ ok: true, value: 'ok' })
    expect(operation).toHaveBeenCalledOnce()
  })

  test.each([
    [{ userToken: undefined }],
    [{ userToken: '' }],
    [{ principal: null }],
    [{ principal: { ...(context.principal as Record<string, unknown>), actorId: 1 } }],
    [{ principal: { ...(context.principal as Record<string, unknown>), actorId: 'bad' } }],
    [{ principal: { ...(context.principal as Record<string, unknown>), role: 'admin' } }],
    [{ principal: { ...(context.principal as Record<string, unknown>), permissionRevision: 1.5 } }],
    [{ principal: { ...(context.principal as Record<string, unknown>), permissionRevision: 0 } }],
    [{ principal: { ...(context.principal as Record<string, unknown>), authSessionId: 1 } }],
    [{ principal: { ...(context.principal as Record<string, unknown>), authSessionId: 'bad' } }],
    [{ principal: { ...(context.principal as Record<string, unknown>), connectionId: 'other' } }],
  ])('拒绝伪造或不完整 Principal %#', async (override) => {
    const operation = vi.fn(success)
    const auth = new XAgentAuthorization(backend(), persistence())
    const result = await auth.run('session.list', {}, { ...context, ...override } as never, new AbortController().signal, operation)
    expect(result.ok).toBe(false)
    expect(operation).not.toHaveBeenCalled()
  })

  test.each([
    [null],
    [[]],
    [{ args: null }],
    [{ args: [] }],
    [{ args: 'bad' }],
  ])('无效参数对象不能提供 Session 标识 %#', async (payload) => {
    const auth = new XAgentAuthorization(backend(), persistence())
    await expect(auth.run('session.history', payload, context, new AbortController().signal, success))
      .resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
  })

  test('点式 Session 方法、创建与未登记方法遵守封闭权限表', async () => {
    const authorize = vi.fn(async () => {})
    const operation = vi.fn(success)
    const auth = new XAgentAuthorization(backend(authorize), persistence())
    const signal = new AbortController().signal
    await expect(auth.run('session.create', { args: {} }, context, signal, operation)).resolves.toEqual({ ok: true, value: 'ok' })
    await expect(auth.run('session.unknown', { args: {} }, context, signal, operation))
      .resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    await expect(auth.run('workspace.archiveSession', { args: { sessionId: 'bad' } }, context, signal, operation))
      .resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    expect(authorize).not.toHaveBeenCalled()
  })

  test.each([
    [null],
    [{}],
    [{ sessions: null }],
    [{ sessions: [null] }],
    [{ sessions: [{ runtime_header: 'bad' }] }],
    [{ sessions: [{ runtime_header: {} }] }],
  ])('拒绝畸形可见 Session 响应 %#', async (value) => {
    const remote = backend()
    remote.sessions.list = vi.fn(async () => value as never)
    const auth = new XAgentAuthorization(remote, persistence())
    await expect(auth.run('session.search', {}, context, new AbortController().signal, success))
      .resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  test('列表过滤保留失败或非 items 响应，并丢弃畸形内存项', async () => {
    const remote = backend()
    remote.sessions.list = vi.fn(async () => ({
      schema_version: 1, sessions: [{ runtime_header: null }, { runtime_header: { id: 'visible' } }],
    }))
    const auth = new XAgentAuthorization(remote, persistence())
    const signal = new AbortController().signal
    const failed: RpcResult<unknown> = { ok: false, error: { code: 'internal', message: 'failed', details: {} } }
    await expect(auth.run('session.list', {}, context, signal, async () => failed)).resolves.toBe(failed)
    await expect(auth.run('session.list', {}, context, signal, async () => ({ ok: true, value: null })))
      .resolves.toEqual({ ok: true, value: null })
    await expect(auth.run('session.list', {}, context, signal, async () => ({ ok: true, value: {} })))
      .resolves.toEqual({ ok: true, value: {} })
    await expect(auth.run('session.list', {}, context, signal, async () => ({
      ok: true, value: { items: [null, {}, { sessionId: 1 }, { sessionId: 'visible' }] },
    }))).resolves.toEqual({ ok: true, value: { items: [{ sessionId: 'visible' }] } })
  })

  test.each([
    [new XAgentBackendError('unauthenticated'), 'unauthenticated'],
    [new XAgentBackendError('not-found'), 'internal'],
    [new Error('offline'), 'internal'],
  ])('授权后端错误稳定映射 %#', async (failure, code) => {
    const remote = backend()
    remote.sessions.list = vi.fn(async () => { throw failure })
    const auth = new XAgentAuthorization(remote, persistence())
    const result = await auth.run('session.list', {}, context, new AbortController().signal, success)
    expect(result).toMatchObject({ ok: false, error: { code } })
  })

  test('事件过滤覆盖控制帧、畸形帧、归档校验和后端故障', async () => {
    const flushSession = vi.fn(async () => {})
    const authorize = vi.fn(async (_token: string, id: string) => {
      if (id.endsWith('999')) throw new Error('offline')
    })
    const auth = new XAgentAuthorization(backend(authorize), { ...persistence(), flushSession })
    const signal = new AbortController().signal
    for (const frame of [null, [], 'bad']) {
      await expect(auth.filterEvent('events.host', frame, context, signal)).resolves.toBeUndefined()
    }
    for (const type of ['stream/error', 'host/remote-event']) {
      const frame = { type }
      await expect(auth.filterEvent('events.host', frame, context, signal)).resolves.toBe(frame)
    }
    await expect(auth.filterEvent('events.host', { type: 'host/archived-sessions-changed', archivedSessionIds: null }, context, signal))
      .resolves.toBeUndefined()
    await expect(auth.filterEvent('events.host', {
      type: 'host/archived-sessions-changed', archivedSessionIds: [1, 'bad'],
    }, context, signal)).resolves.toEqual({ type: 'host/archived-sessions-changed', archivedSessionIds: [] })
    await expect(auth.filterEvent('events.host', { type: 1 }, context, signal)).resolves.toBeUndefined()
    await expect(auth.filterEvent('events.host', { type: 'session/event', sessionId: 1 }, context, signal)).resolves.toBeUndefined()
    await expect(auth.filterEvent('events.host', {
      type: 'session/event', sessionId: 'session-00000000-0000-0000-0000-000000000999',
    }, context, signal)).rejects.toThrow('offline')
    expect(flushSession).toHaveBeenCalled()
  })

  test('服务代理转发事件过滤，插件入口校验 token scope 并注册服务', async () => {
    const ctx = new Context()
    const service = new XAgentAuthorizationService(ctx, backend(), persistence())
    await expect(service.filterEvent('events.host', { type: 'stream/error' }, context, new AbortController().signal))
      .resolves.toEqual({ type: 'stream/error' })
    await ctx.fiber.dispose()

    const missing = new Context()
    missing.provide('sessionPersistence', {} as never)
    expect(() => {
      authorizationModule.apply(missing, { backendOrigin: 'https://api.example.test', serviceToken: 'service' })
    })
      .toThrow('requires token-scoped session persistence')
    await missing.fiber.dispose()

    const mounted = new Context()
    mounted.provide('sessionPersistence', persistence() as never)
    authorizationModule.apply(mounted, { backendOrigin: 'https://api.example.test', serviceToken: 'service' })
    expect(mounted.get('connectionRequestAuthorizer')).toBeDefined()
    await mounted.fiber.dispose()
  })
})
