import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import {
  XAgentBackendError,
  type XAgentWorkbenchBackend,
  type XAgentWorkbenchBootstrap,
} from '@xagent/dsh-backend-client'
import { describe, expect, test, vi } from 'vitest'
import {
  XAgentProjectService,
  type XAgentProjectRequestScope,
} from '../src/index.ts'

const alice: XAgentProjectRequestScope = {
  principal: {
    actorId: '00000000-0000-0000-0000-000000000001',
    role: 'specialist',
    permissionRevision: 3,
  },
  userToken: 'alice-token',
  connectionId: 'connection-alice',
}

const bob: XAgentProjectRequestScope = {
  principal: {
    actorId: '00000000-0000-0000-0000-000000000002',
    role: 'manager',
    permissionRevision: 4,
  },
  userToken: 'bob-token',
  connectionId: 'connection-bob',
}

function bootstrap(accountId: string): XAgentWorkbenchBootstrap {
  return {
    account: {
      id: accountId,
      email: `${accountId}@example.test`,
      role: 'specialist',
      permissionRevision: 3,
    },
    capabilities: [],
    context: { kind: 'workbench' },
    projects: [],
    sessionSummary: { privateCount: 0, projectCounts: {} },
  }
}

interface WorkbenchMock extends XAgentWorkbenchBackend {
  readonly calls: {
    bootstrap: unknown[][]
    selectContext: unknown[][]
    createProject: unknown[][]
    project: unknown[][]
  }
}

function backend(): WorkbenchMock {
  const calls: WorkbenchMock['calls'] = {
    bootstrap: [], selectContext: [], createProject: [], project: [],
  }
  return {
    calls,
    bootstrap: async (...args) => {
      calls.bootstrap.push(args)
      return bootstrap(args[0] === 'alice-token' ? alice.principal.actorId : bob.principal.actorId)
    },
    selectContext: async (...args) => {
      calls.selectContext.push(args)
      return bootstrap(args[0] === 'alice-token' ? alice.principal.actorId : bob.principal.actorId)
    },
    createProject: async (...args) => {
      calls.createProject.push(args)
      return bootstrap(args[0] === 'alice-token' ? alice.principal.actorId : bob.principal.actorId)
    },
    project: async (...args) => {
      calls.project.push(args)
      return {
        accountId: args[0] === 'alice-token' ? alice.principal.actorId : bob.principal.actorId,
        id: args[1],
        name: 'Alpha',
        createdAt: '2026-08-25T08:00:00+00:00',
        canEdit: true,
        sessionCount: 0,
      }
    },
    addSessionProjectRefs: vi.fn(async () => {}),
  }
}

describe('XAgent Project Remote', () => {
  test('只发布四个固定 Remote，withRequest 不进入协议', () => {
    const ctx = new Context()
    const service = new XAgentProjectService(ctx, backend())
    expect(service.typertRemote).toMatchObject({ serviceKey: 'xagentProject', namespace: 'xagentProject' })
    expect(remoteMethods(service)).toEqual([
      { method: 'bootstrap', invocation: { kind: 'direct' } },
      { method: 'selectContext', exportName: 'select-context', invocation: { kind: 'direct' } },
      { method: 'createProject', exportName: 'create-project', invocation: { kind: 'direct' } },
      { method: 'project', invocation: { kind: 'direct' } },
    ])
  })

  test('四个 Remote 都只从请求 scope 读取令牌并传递取消信号', async () => {
    const remote = backend()
    const service = new XAgentProjectService(new Context(), remote)
    const signal = new AbortController().signal

    await service.withRequest(alice, async () => {
      await service.bootstrap(signal)
      await service.selectContext({ kind: 'project', projectId: '00000000-0000-0000-0000-000000000201' }, signal)
      await service.createProject('Alpha', 'create-1', signal)
      await service.project('00000000-0000-0000-0000-000000000201', signal)
    })

    expect(remote.calls.bootstrap).toEqual([['alice-token', signal]])
    expect(remote.calls.selectContext).toEqual([[
      'alice-token', { kind: 'project', projectId: '00000000-0000-0000-0000-000000000201' }, signal,
    ]])
    expect(remote.calls.createProject).toEqual([[
      'alice-token', { name: 'Alpha', idempotencyKey: 'create-1' }, signal,
    ]])
    expect(remote.calls.project).toEqual([[
      'alice-token', '00000000-0000-0000-0000-000000000201', signal,
    ]])
  })

  test('scope 缺失、嵌套调用和 dispose 后调用全部失败关闭', async () => {
    const ctx = new Context()
    const service = new XAgentProjectService(ctx, backend())
    await expect(service.bootstrap()).rejects.toThrow('request scope')
    await expect(service.withRequest(alice, () => service.withRequest(bob, async () => undefined)))
      .rejects.toThrow('nested')
    await ctx.fiber.dispose()
    await expect(service.withRequest(alice, () => service.bootstrap())).rejects.toThrow('disposed')
  })

  test.each([
    { principal: { ...alice.principal, actorId: 'bad' } },
    { principal: { ...alice.principal, role: 'admin' as 'specialist' } },
    { principal: { ...alice.principal, permissionRevision: 0 } },
    { userToken: '' },
    { connectionId: '' },
  ])('拒绝畸形 Host 请求 scope %#', async (override) => {
    const service = new XAgentProjectService(new Context(), backend())
    await expect(service.withRequest({ ...alice, ...override }, async () => undefined))
      .rejects.toThrow('invalid xagent project request scope')
  })

  test('请求完成或异常后，派生但未等待的迟到任务不能继续读取令牌', async () => {
    const service = new XAgentProjectService(new Context(), backend())
    const normalRelease = Promise.withResolvers<undefined>()
    const normal = Promise.withResolvers<Awaited<ReturnType<typeof service.bootstrap>>>()
    await service.withRequest(alice, async () => {
      void normalRelease.promise.then(() => service.bootstrap()).then(normal.resolve, normal.reject)
    })
    normalRelease.resolve(undefined)
    await expect(normal.promise).rejects.toThrow('request scope')

    const failedRelease = Promise.withResolvers<undefined>()
    const failed = Promise.withResolvers<Awaited<ReturnType<typeof service.bootstrap>>>()
    await expect(service.withRequest(alice, async () => {
      void failedRelease.promise.then(() => service.bootstrap()).then(failed.resolve, failed.reject)
      throw new Error('operation failed')
    })).rejects.toThrow('operation failed')
    failedRelease.resolve(undefined)
    await expect(failed.promise).rejects.toThrow('request scope')
  })

  test('并发账号 scope 隔离且响应账号必须匹配请求 Principal', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const remote = backend()
    remote.bootstrap = vi.fn(async (token) => {
      if (token === 'alice-token') {
        entered.resolve(undefined)
        await release.promise
      }
      return bootstrap(token === 'alice-token' ? alice.principal.actorId : bob.principal.actorId)
    })
    const service = new XAgentProjectService(new Context(), remote)
    const pendingAlice = service.withRequest(alice, () => service.bootstrap())
    await entered.promise
    const pendingBob = service.withRequest(bob, () => service.bootstrap())
    release.resolve(undefined)
    await expect(Promise.all([pendingAlice, pendingBob])).resolves.toEqual([
      bootstrap(alice.principal.actorId),
      bootstrap(bob.principal.actorId),
    ])

    remote.bootstrap = vi.fn(async () => bootstrap(bob.principal.actorId))
    await expect(service.withRequest(alice, () => service.bootstrap()))
      .rejects.toMatchObject({ code: 'service-unavailable' })

    remote.project = vi.fn(async (_token: string, projectId: string) => ({
      accountId: bob.principal.actorId,
      id: projectId,
      name: 'Alpha',
      createdAt: '2026-08-25T08:00:00+00:00',
      canEdit: true,
      sessionCount: 0,
    }))
    await expect(service.withRequest(alice, () => service.project('00000000-0000-0000-0000-000000000201')))
      .rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('后端稳定错误保持稳定且不会改写 detail', async () => {
    const remote = backend()
    remote.createProject = vi.fn(async () => { throw new XAgentBackendError('forbidden') })
    const service = new XAgentProjectService(new Context(), remote)
    await expect(service.withRequest(alice, () => service.createProject('Alpha', 'create-1')))
      .rejects.toEqual(new XAgentBackendError('forbidden'))
  })
})
