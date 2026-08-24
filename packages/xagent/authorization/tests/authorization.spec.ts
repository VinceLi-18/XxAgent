import type { ConnectionRequestContext } from '@deepseek-ai/dsh-client-connection'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { XAgentBackend, XAgentSessionBackend } from '@xagent/dsh-backend-client'
import { XAgentBackendError } from '@xagent/dsh-backend-client'
import { describe, expect, test, vi } from 'vitest'
import { XAgentAuthorization, type TokenScopedPersistence } from '../src/index.ts'

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

function persistence(): TokenScopedPersistence {
  return {
    withUserToken: vi.fn(async (_token: string, operation: () => Promise<unknown>) => operation()) as unknown as
      TokenScopedPersistence['withUserToken'],
  }
}

const success = async (): Promise<RpcResult<string>> => ({ ok: true, value: 'ok' })

describe('XAgent Session 授权', () => {
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
    const scope = persistence()
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
    expect(scope.withUserToken).toHaveBeenCalledWith('alice-token', expect.any(Function))
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
})
