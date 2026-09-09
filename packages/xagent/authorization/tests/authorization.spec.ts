import type { ConnectionRequestContext } from '@deepseek-ai/dsh-client-connection'
import { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { XAgentBackend, XAgentSessionBackend } from '@xagent/dsh-backend-client'
import { XAgentBackendError } from '@xagent/dsh-backend-client'
import type { XAgentArtifactScopeRunner } from '../../artifact/src/index.ts'
import {
  currentXAgentAuthenticatedRequestScope,
  type XAgentAuthenticatedRequestScope,
  type XAgentAuthenticatedSessionRequestScope,
} from '../../principal/src/index.ts'
import type { XAgentProjectScopeRunner } from '../../project/src/index.ts'
import type { XAgentCitationScopeRunner } from '../../retrieval/src/index.ts'
import type { XAgentFactScopeRunner } from '../../fact/src/types.ts'
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
      list: vi.fn(async () => ({ schema_version: 1, sessions: [{
        id: '00000000-0000-0000-0000-000000000701',
        visibility: 'private',
        project_id: null,
        runtime_header: { id: 'session-00000000-0000-0000-0000-000000000701' },
      }] })),
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

function projectScope(onScope?: (scope: XAgentAuthenticatedRequestScope) => void): XAgentProjectScopeRunner & {
  readonly active: () => XAgentAuthenticatedRequestScope | undefined
} {
  let active: XAgentAuthenticatedRequestScope | undefined
  return {
    active: () => active,
    async withRequest<T>(scope: XAgentAuthenticatedRequestScope, operation: () => Promise<T>): Promise<T> {
      if (active !== undefined) throw new Error('nested project request scope')
      active = scope
      onScope?.(scope)
      try {
        return await operation()
      } finally {
        active = undefined
      }
    },
  }
}

function artifactScope(onScope?: (scope: XAgentAuthenticatedRequestScope) => void): XAgentArtifactScopeRunner & {
  readonly active: () => XAgentAuthenticatedRequestScope | undefined
} {
  let active: XAgentAuthenticatedRequestScope | undefined
  return {
    active: () => active,
    async withRequest<T>(scope: XAgentAuthenticatedRequestScope, operation: () => Promise<T>): Promise<T> {
      if (active !== undefined) throw new Error('nested artifact request scope')
      active = scope
      onScope?.(scope)
      try {
        return await operation()
      } finally {
        active = undefined
      }
    },
  }
}

function citationScope(onScope?: (scope: XAgentAuthenticatedRequestScope) => void): XAgentCitationScopeRunner & {
  readonly active: () => XAgentAuthenticatedRequestScope | undefined
} {
  let active: XAgentAuthenticatedRequestScope | undefined
  return {
    active: () => active,
    async withRequest<T>(scope: XAgentAuthenticatedRequestScope, operation: () => Promise<T>): Promise<T> {
      if (active !== undefined) throw new Error('nested citation request scope')
      active = scope
      onScope?.(scope)
      try {
        return await operation()
      } finally {
        active = undefined
      }
    },
  }
}

function factScope(onScope?: (scope: XAgentAuthenticatedRequestScope) => void): XAgentFactScopeRunner & {
  readonly active: () => XAgentAuthenticatedRequestScope | undefined
} {
  let active: XAgentAuthenticatedRequestScope | undefined
  return {
    active: () => active,
    async withRequest<T>(scope: XAgentAuthenticatedSessionRequestScope, operation: () => Promise<T>): Promise<T> {
      if (active !== undefined) throw new Error('nested Fact request scope')
      active = scope
      onScope?.(scope)
      try {
        return await operation()
      } finally {
        active = undefined
      }
    },
  }
}

describe('XAgent Session 授权', () => {
  test('prompt admission propagates one immutable physical and Session scope into detached agent work', async () => {
    const value = backend()
    value.sessions.list = vi.fn(async () => ({
      schema_version: 1,
      sessions: [{
        id: '00000000-0000-0000-0000-000000000701',
        visibility: 'project',
        project_id: '00000000-0000-0000-0000-000000000401',
        runtime_header: { id: 'session-00000000-0000-0000-0000-000000000701' },
      }],
    }))
    const auth = new XAgentAuthorization(value, persistence())
    const request = new AbortController()
    const connection = new AbortController()
    let resolveDetached!: (scope: unknown) => void
    const detached = new Promise<unknown>((resolve) => { resolveDetached = resolve })

    await auth.run(
      'session/prompt',
      { args: { sessionId: 'session-00000000-0000-0000-0000-000000000701' } },
      { ...context, requestId: 'rpc-1', lifetime: connection.signal },
      request.signal,
      async () => {
        void new Promise<void>(resolve => setImmediate(resolve))
          .then(() => { resolveDetached(currentXAgentAuthenticatedRequestScope()) })
        return { ok: true, value: 'ok' }
      },
    )

    await expect(detached).resolves.toMatchObject({
      principal: context.principal,
      userToken: 'alice-token',
      connectionId: 'connection-1',
      sessionId: '00000000-0000-0000-0000-000000000701',
      visibility: 'project',
      projectId: '00000000-0000-0000-0000-000000000401',
      requestSignal: request.signal,
      connectionSignal: connection.signal,
    })
  })
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

  test.each([
    ['session/history', 'read'],
    ['session/create', 'read'],
    ['session/fork', 'read'],
    ['session/prompt', 'edit'],
  ] as const)('%s 在项目或引用失权后统一返回 session-not-found', async (endpoint, permission) => {
    const authorize = vi.fn(async () => { throw new XAgentBackendError('not-found') })
    const operation = vi.fn(success)
    const auth = new XAgentAuthorization(backend(authorize), persistence())
    const sessionId = 'session-00000000-0000-0000-0000-000000000701'

    await expect(auth.run(
      endpoint,
      { args: { sessionId } },
      context,
      new AbortController().signal,
      operation,
    )).resolves.toEqual({
      ok: false,
      error: {
        code: 'session-not-found',
        message: 'session not found',
        details: { sessionId },
      },
    })
    expect(authorize).toHaveBeenCalledWith(
      'alice-token',
      '00000000-0000-0000-0000-000000000701',
      permission,
      expect.any(AbortSignal),
    )
    expect(operation).not.toHaveBeenCalled()
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
    'xagentProject/bootstrap',
    'xagentProject/select-context',
    'xagentProject/create-project',
    'xagentProject/project',
  ])('%s 在认证账号请求 scope 内执行完整 Remote operation', async (endpoint) => {
    const scopes: XAgentAuthenticatedRequestScope[] = []
    const scope = projectScope(value => scopes.push(value))
    const operation = vi.fn(async (): Promise<RpcResult<string>> => {
      expect(scope.active()).toEqual({
        principal: context.principal,
        userToken: 'alice-token',
        connectionId: 'connection-1',
      })
      return { ok: true, value: 'ok' }
    })
    const auth = new XAgentAuthorization(backend(), persistence(), scope)

    await expect(auth.run(endpoint, { args: {} }, context, new AbortController().signal, operation))
      .resolves.toEqual({ ok: true, value: 'ok' })
    expect(operation).toHaveBeenCalledOnce()
    expect(scope.active()).toBeUndefined()
    expect(scopes).toHaveLength(1)
  })

  test('项目 endpoint 在异常后清空 scope，缺服务或缺认证时失败关闭', async () => {
    const scope = projectScope()
    const failure = new Error('operation failed')
    const auth = new XAgentAuthorization(backend(), persistence(), scope)
    await expect(auth.run(
      'xagentProject/bootstrap',
      { args: {} },
      context,
      new AbortController().signal,
      async () => { throw failure },
    )).resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(scope.active()).toBeUndefined()

    const operation = vi.fn(success)
    const missing = new XAgentAuthorization(backend(), persistence())
    await expect(missing.run('xagentProject/bootstrap', {}, context, new AbortController().signal, operation))
      .resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
    await expect(auth.run(
      'xagentProject/bootstrap',
      {},
      { connectionId: 'anonymous' },
      new AbortController().signal,
      operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    expect(operation).not.toHaveBeenCalled()
  })

  test('未知项目方法拒绝，点式 endpoint 与普通 Profile endpoint 保持明确边界', async () => {
    const scope = projectScope()
    const operation = vi.fn(success)
    const auth = new XAgentAuthorization(backend(), persistence(), scope)
    await expect(auth.run(
      'xagentProject.unknown', {}, context, new AbortController().signal, operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    await expect(auth.run(
      'xagentProject.bootstrap', {}, context, new AbortController().signal, operation,
    )).resolves.toEqual({ ok: true, value: 'ok' })
    await expect(auth.run(
      'host/describe', {}, context, new AbortController().signal, operation,
    )).resolves.toEqual({ ok: true, value: 'ok' })
    expect(operation).toHaveBeenCalledTimes(2)
  })

  test('项目授权也接受生命周期已由调用方持有的直接 scope runner', async () => {
    const scope = projectScope()
    const auth = new XAgentAuthorization(backend(), persistence(), scope)
    await expect(auth.run(
      'xagentProject/bootstrap', {}, context, new AbortController().signal, success,
    )).resolves.toEqual({ ok: true, value: 'ok' })
  })

  test.each([
    'xagentArtifact/list',
    'xagentArtifact/detail',
    'xagentArtifact/create-upload',
    'xagentArtifact/create-version-upload',
    'xagentArtifact/complete-upload',
    'xagentArtifact/retry',
    'xagentArtifact/preview',
    'xagentArtifact/download',
  ])('%s 用物理连接 Principal 包围完整 operation', async (endpoint) => {
    const scope = artifactScope()
    const remote = backend()
    const operation = vi.fn(async (): Promise<RpcResult<string>> => {
      expect(scope.active()).toEqual({
        principal: context.principal,
        userToken: 'alice-token',
        connectionId: 'connection-1',
      })
      await Promise.resolve()
      expect(scope.active()).toBeDefined()
      return { ok: true, value: 'ok' }
    })
    const auth = new XAgentAuthorization(remote, persistence(), undefined, scope)

    await expect(auth.run(endpoint, { args: {} }, context, new AbortController().signal, operation))
      .resolves.toEqual({ ok: true, value: 'ok' })
    expect(operation).toHaveBeenCalledOnce()
    expect(scope.active()).toBeUndefined()
  })

  test('Artifact 未装配、未知方法、未认证连接和 FastAPI 账号串号都失败关闭', async () => {
    const operation = vi.fn(success)
    const missing = new XAgentAuthorization(backend(), persistence())
    await expect(missing.run('xagentArtifact/list', {}, context, new AbortController().signal, operation))
      .resolves.toEqual({
        ok: false,
        error: { code: 'internal', message: 'artifact service unavailable', details: {} },
      })

    const scope = artifactScope()
    const auth = new XAgentAuthorization(backend(), persistence(), undefined, scope)
    await expect(auth.run('xagentArtifact/unknown', {}, context, new AbortController().signal, operation))
      .resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    await expect(auth.run(
      'xagentArtifact/list', {}, { connectionId: 'anonymous' }, new AbortController().signal, operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })

    await expect(auth.run(
      'xagentArtifact/list', {}, {
        ...context,
        principal: { ...(context.principal as Record<string, unknown>), connectionId: 'other-connection' },
      }, new AbortController().signal, operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    expect(operation).not.toHaveBeenCalled()
  })

  test('Artifact operation 抛错或取消后释放 scope，resolver 不保留已 dispose 的 service', async () => {
    const first = artifactScope()
    let current: XAgentArtifactScopeRunner | undefined = first
    const remote = backend()
    const auth = new XAgentAuthorization(remote, persistence(), undefined, () => current)
    for (const failure of [new Error('failed'), new DOMException('cancelled', 'AbortError')]) {
      await expect(auth.run(
        'xagentArtifact/list', {}, context, new AbortController().signal, async () => { throw failure },
      )).resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
      expect(first.active()).toBeUndefined()
    }

    current = undefined
    await expect(auth.run('xagentArtifact/list', {}, context, new AbortController().signal, success))
      .resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
    const replacement = artifactScope()
    current = replacement
    await expect(auth.run('xagentArtifact/list', {}, context, new AbortController().signal, success))
      .resolves.toEqual({ ok: true, value: 'ok' })
    expect(first.active()).toBeUndefined()
  })

  test('唯一 citation resolve endpoint 在当前物理连接与 Session scope 内运行', async () => {
    const remote = backend()
    remote.sessions.list = vi.fn(async () => ({
      schema_version: 1,
      sessions: [{
        id: '00000000-0000-0000-0000-000000000701',
        visibility: 'project',
        project_id: '00000000-0000-0000-0000-000000000401',
        runtime_header: { id: 'session-00000000-0000-0000-0000-000000000701' },
      }],
    }))
    const scopes: XAgentAuthenticatedRequestScope[] = []
    const runner = citationScope(value => scopes.push(value))
    const operation = vi.fn(async (): Promise<RpcResult<string>> => {
      const active = runner.active()
      expect(active).toMatchObject({
        principal: context.principal,
        userToken: 'alice-token',
        connectionId: 'connection-1',
        sessionId: '00000000-0000-0000-0000-000000000701',
        visibility: 'project',
        projectId: '00000000-0000-0000-0000-000000000401',
      })
      expect(active?.requestSignal).toBeInstanceOf(AbortSignal)
      expect(active?.connectionSignal).toBeInstanceOf(AbortSignal)
      return { ok: true, value: 'ok' }
    })
    const auth = new XAgentAuthorization(remote, persistence(), undefined, undefined, runner)

    await expect(auth.run(
      'xagentCitation/resolve',
      { args: { sessionId: 'session-00000000-0000-0000-0000-000000000701', citationId: '[资料1]' } },
      context,
      new AbortController().signal,
      operation,
    )).resolves.toEqual({ ok: true, value: 'ok' })
    expect(operation).toHaveBeenCalledOnce()
    expect(scopes).toHaveLength(1)
    expect(runner.active()).toBeUndefined()
  })

  test('citation namespace 对未知方法、匿名、串号 Session 与缺失 service 失败关闭', async () => {
    const operation = vi.fn(success)
    const runner = citationScope()
    const auth = new XAgentAuthorization(backend(), persistence(), undefined, undefined, runner)
    await expect(auth.run('xagentCitation.unknown', {}, context, new AbortController().signal, operation))
      .resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    await expect(auth.run('xagentCitation.resolve', {}, context, new AbortController().signal, operation))
      .resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    await expect(auth.run(
      'xagentCitation/resolve',
      { args: { sessionId: 'session-00000000-0000-0000-0000-000000000701' } },
      context,
      new AbortController().signal,
      operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    await expect(auth.run(
      'xagentCitation/resolve',
      { args: { citationId: '[资料1]' } },
      context,
      new AbortController().signal,
      operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    await expect(auth.run(
      'xagentCitation/resolve',
      { args: { sessionId: 'session-00000000-0000-0000-0000-000000000999', citationId: '[资料1]' } },
      context,
      new AbortController().signal,
      operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    await expect(auth.run(
      'xagentCitation/resolve',
      { args: { sessionId: 'session-00000000-0000-0000-0000-000000000701', citationId: '[资料1]' } },
      { connectionId: 'anonymous' },
      new AbortController().signal,
      operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    const missing = new XAgentAuthorization(backend(), persistence())
    await expect(missing.run(
      'xagentCitation/resolve',
      { args: { sessionId: 'session-00000000-0000-0000-0000-000000000701', citationId: '[资料1]' } },
      context,
      new AbortController().signal,
      operation,
    )).resolves.toEqual({
      ok: false,
      error: { code: 'internal', message: 'citation service unavailable', details: {} },
    })
    expect(operation).not.toHaveBeenCalled()
  })

  test.each([
    ['bad', backend(), 'internal'],
    ['session-00000000-0000-0000-0000-000000000701', null, 'internal'],
    ['session-00000000-0000-0000-0000-000000000701', {}, 'internal'],
    ['session-00000000-0000-0000-0000-000000000701', { sessions: null }, 'internal'],
    ['session-00000000-0000-0000-0000-000000000701', { sessions: [null] }, 'session-not-found'],
    ['session-00000000-0000-0000-0000-000000000701', { sessions: [{
      id: 1,
      visibility: 'private',
      project_id: null,
      runtime_header: { id: 'session-00000000-0000-0000-0000-000000000701' },
    }] }, 'internal'],
    ['session-00000000-0000-0000-0000-000000000701', { sessions: [{
      id: '00000000-0000-0000-0000-000000000702',
      visibility: 'private',
      project_id: null,
      runtime_header: { id: 'session-00000000-0000-0000-0000-000000000701' },
    }] }, 'internal'],
    ['session-00000000-0000-0000-0000-000000000701', { sessions: [{
      id: '00000000-0000-0000-0000-000000000701',
      visibility: 'private',
      project_id: '00000000-0000-0000-0000-000000000401',
      runtime_header: { id: 'session-00000000-0000-0000-0000-000000000701' },
    }] }, 'internal'],
  ])('citation 拒绝畸形 Session scope 响应 %#', async (sessionId, response, code) => {
    const remote = backend()
    if ('sessions' in remote) remote.sessions.list = vi.fn(async () => response as never)
    const auth = new XAgentAuthorization(remote, persistence(), undefined, undefined, citationScope())
    await expect(auth.run(
      'xagentCitation/resolve',
      { args: { sessionId, citationId: '[资料1]' } },
      context,
      new AbortController().signal,
      success,
    )).resolves.toMatchObject({ ok: false, error: { code } })
  })

  test('citation 将后端认证失效映射为统一未认证错误', async () => {
    const remote = backend()
    remote.sessions.list = vi.fn(async () => { throw new XAgentBackendError('unauthenticated') })
    const auth = new XAgentAuthorization(remote, persistence(), undefined, undefined, citationScope())
    await expect(auth.run(
      'xagentCitation/resolve',
      { args: {
        sessionId: 'session-00000000-0000-0000-0000-000000000701',
        citationId: '[资料1]',
      } },
      context,
      new AbortController().signal,
      success,
    )).resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
  })

  test('citation resolver replacement、取消与异常不会保留旧请求 scope', async () => {
    const first = citationScope()
    let current: XAgentCitationScopeRunner | undefined = first
    const remote = backend()
    const auth = new XAgentAuthorization(remote, persistence(), undefined, undefined, () => current)
    const payload = { args: { sessionId: 'session-00000000-0000-0000-0000-000000000701', citationId: '[资料1]' } }
    await expect(auth.run(
      'xagentCitation/resolve', payload, context, new AbortController().signal,
      async () => { throw new DOMException('cancelled', 'AbortError') },
    )).resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(first.active()).toBeUndefined()

    current = undefined
    await expect(auth.run('xagentCitation/resolve', payload, context, new AbortController().signal, success))
      .resolves.toMatchObject({ ok: false, error: { message: 'citation service unavailable' } })
    const replacement = citationScope()
    current = replacement
    await expect(auth.run('xagentCitation/resolve', payload, context, new AbortController().signal, success))
      .resolves.toEqual({ ok: true, value: 'ok' })
    expect(first.active()).toBeUndefined()
  })

  test.each([
    'xagentFact/list-heads',
    'xagentFact/list-proposals',
    'xagentFact/revision',
    'xagentFact/proposal',
    'xagentFact/approve',
    'xagentFact/reject',
    'xagentFact/withdraw',
  ])('%s 在当前物理连接的唯一 Project Session scope 内运行', async (endpoint) => {
    const remote = backend()
    remote.sessions.list = vi.fn(async () => ({
      schema_version: 1,
      sessions: [{
        id: '00000000-0000-0000-0000-000000000701',
        visibility: 'project',
        project_id: '00000000-0000-0000-0000-000000000401',
        runtime_header: { id: 'session-00000000-0000-0000-0000-000000000701' },
      }],
    }))
    const runner = factScope()
    const operation = vi.fn(async (): Promise<RpcResult<string>> => {
      expect(runner.active()).toMatchObject({
        principal: context.principal,
        userToken: 'alice-token',
        connectionId: 'connection-1',
        sessionId: '00000000-0000-0000-0000-000000000701',
        visibility: 'project',
        projectId: '00000000-0000-0000-0000-000000000401',
      })
      return { ok: true, value: 'ok' }
    })
    const auth = new XAgentAuthorization(
      remote, persistence(), undefined, undefined, undefined, runner,
    )

    await expect(auth.run(
      endpoint,
      { args: { sessionId: 'session-00000000-0000-0000-0000-000000000701' } },
      context,
      new AbortController().signal,
      operation,
    )).resolves.toEqual({ ok: true, value: 'ok' })
    expect(operation).toHaveBeenCalledOnce()
    expect(runner.active()).toBeUndefined()
  })

  test('Fact namespace 拒绝未知方法、匿名连接、Private Session、Session 串号和缺失服务', async () => {
    const operation = vi.fn(success)
    const remote = backend()
    const runner = factScope()
    const auth = new XAgentAuthorization(
      remote, persistence(), undefined, undefined, undefined, runner,
    )
    const payload = { args: { sessionId: 'session-00000000-0000-0000-0000-000000000701' } }

    await expect(auth.run(
      'xagentFact/unknown', payload, context, new AbortController().signal, operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    await expect(auth.run(
      'xagentFact/list-heads', { args: {} }, context, new AbortController().signal, operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    await expect(auth.run(
      'xagentFact/list-heads', payload, { connectionId: 'anonymous' }, new AbortController().signal, operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    await expect(auth.run(
      'xagentFact/list-heads', payload, context, new AbortController().signal, operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'session-not-found' } })

    remote.sessions.list = vi.fn(async () => { throw new XAgentBackendError('unauthenticated') })
    await expect(auth.run(
      'xagentFact/list-heads', payload, context, new AbortController().signal, operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })

    remote.sessions.list = vi.fn(async () => { throw new Error('backend unavailable') })
    await expect(auth.run(
      'xagentFact/list-heads', payload, context, new AbortController().signal, operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'internal' } })

    remote.sessions.list = vi.fn(async () => ({ schema_version: 1, sessions: [] }))
    await expect(auth.run(
      'xagentFact/list-heads', payload, context, new AbortController().signal, operation,
    )).resolves.toMatchObject({ ok: false, error: { code: 'session-not-found' } })

    const missing = new XAgentAuthorization(remote, persistence())
    await expect(missing.run(
      'xagentFact/list-heads', payload, context, new AbortController().signal, operation,
    )).resolves.toEqual({
      ok: false,
      error: { code: 'internal', message: 'Fact service unavailable', details: {} },
    })
    expect(operation).not.toHaveBeenCalled()
  })

  test('显式 Session 恢复在同一物理连接派生的 Session scope 内发布 session/created', async () => {
    const remote = backend()
    remote.sessions.list = vi.fn(async () => ({
      schema_version: 1,
      sessions: [{
        id: '00000000-0000-0000-0000-000000000701',
        visibility: 'project',
        project_id: '00000000-0000-0000-0000-000000000401',
        runtime_header: { id: 'session-00000000-0000-0000-0000-000000000701' },
      }],
    }))
    const auth = new XAgentAuthorization(remote, persistence())
    let observed: XAgentAuthenticatedRequestScope | undefined

    await expect(auth.run(
      'session/create',
      { args: { sessionId: 'session-00000000-0000-0000-0000-000000000701' } },
      context,
      new AbortController().signal,
      async () => {
        observed = currentXAgentAuthenticatedRequestScope()
        return { ok: true, value: 'ok' }
      },
    )).resolves.toEqual({ ok: true, value: 'ok' })

    expect(observed).toMatchObject({
      sessionId: '00000000-0000-0000-0000-000000000701',
      visibility: 'project',
      projectId: '00000000-0000-0000-0000-000000000401',
      userToken: 'alice-token',
      connectionId: 'connection-1',
    })
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

  test('prompt 在进入令牌作用域前拒绝缺失的 Session 标识', async () => {
    const operation = vi.fn(success)
    const auth = new XAgentAuthorization(backend(), persistence())
    await expect(auth.run('session.prompt', { args: {} }, context, new AbortController().signal, operation))
      .resolves.toMatchObject({ ok: false, error: { code: 'unauthenticated' } })
    expect(operation).not.toHaveBeenCalled()
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
    const mountedAuthorizer = mounted.get('connectionRequestAuthorizer')
    expect(mountedAuthorizer).toBeDefined()
    await expect(mountedAuthorizer?.run(
      'xagentProject/bootstrap', {}, context, new AbortController().signal, success,
    )).resolves.toMatchObject({ ok: false, error: { message: 'project service unavailable' } })
    await expect(mountedAuthorizer?.run(
      'xagentArtifact/list', {}, context, new AbortController().signal, success,
    )).resolves.toMatchObject({ ok: false, error: { message: 'artifact service unavailable' } })
    await expect(mountedAuthorizer?.run(
      'xagentCitation/resolve', {
        args: { sessionId: 'session-00000000-0000-0000-0000-000000000701', citationId: '[资料1]' },
      }, context, new AbortController().signal, success,
    )).resolves.toMatchObject({ ok: false, error: { message: 'citation service unavailable' } })
    await mounted.fiber.dispose()
  })
})
