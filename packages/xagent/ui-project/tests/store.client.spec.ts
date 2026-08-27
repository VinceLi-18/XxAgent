// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  XAgentProjectDetail,
  XAgentWorkbenchBootstrap,
  XAgentWorkbenchContext,
} from '@xagent/dsh-project/types'
import { XAgentWorkbenchController, type XAgentProjectRemoteClient } from '../src/client/service.ts'

const ACCOUNT_ID = '00000000-0000-0000-0000-000000000101'
const PROJECT_ID = '00000000-0000-0000-0000-000000000201'
const SESSION_ID = '00000000-0000-0000-0000-000000000301'

function bootstrap(overrides: Partial<XAgentWorkbenchBootstrap> = {}): XAgentWorkbenchBootstrap {
  return {
    account: { id: ACCOUNT_ID, email: 'manager@example.com', role: 'manager', permissionRevision: 1 },
    capabilities: ['project.create'],
    context: { kind: 'workbench' },
    projects: [{ id: PROJECT_ID, name: 'Alpha', createdAt: '2026-08-25T08:00:00Z' }],
    sessionScopes: [{ sessionId: SESSION_ID, visibility: 'private' }],
    sessionSummary: { privateCount: 1, projectCounts: { [PROJECT_ID]: 2 } },
    ...overrides,
  }
}

const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const failure = (code: string): RemoteResult<never> => ({ ok: false, error: { code, message: 'secret', details: {} } })

function remote(): XAgentProjectRemoteClient & {
  bootstrap: ReturnType<typeof vi.fn>
  'select-context': ReturnType<typeof vi.fn>
  'create-project': ReturnType<typeof vi.fn>
  project: ReturnType<typeof vi.fn>
} {
  return {
    bootstrap: vi.fn(async () => ok(bootstrap())),
    'select-context': vi.fn(async (context: XAgentWorkbenchContext) => ok(bootstrap({ context }))),
    'create-project': vi.fn(async () => ok(bootstrap({ context: { kind: 'project', projectId: PROJECT_ID } }))),
    project: vi.fn(async () => ok<XAgentProjectDetail>({
      accountId: ACCOUNT_ID,
      id: PROJECT_ID,
      name: 'Alpha',
      createdAt: '2026-08-25T08:00:00Z',
      canEdit: true,
      sessionCount: 2,
    })),
  }
}

function sessions() {
  return { clear: vi.fn(), open: vi.fn() }
}

describe('XAgent 项目工作台状态', () => {
  it('Bootstrap 是唯一初始化请求，且不读写任何浏览器缓存', async () => {
    const api = remote()
    const sessionActions = sessions()
    const localGet = vi.spyOn(Storage.prototype, 'getItem')
    const localSet = vi.spyOn(Storage.prototype, 'setItem')
    const workbench = new XAgentWorkbenchController(api, sessionActions)
    await Promise.all([workbench.bootstrap(), workbench.bootstrap()])
    expect(api.bootstrap).toHaveBeenCalledOnce()
    expect(api['select-context']).not.toHaveBeenCalled()
    expect(api.project).not.toHaveBeenCalled()
    expect(workbench.snapshot.getSnapshot()).toMatchObject({
      phase: 'ready',
      accountId: ACCOUNT_ID,
      account: { email: 'manager@example.com' },
      context: { kind: 'workbench' },
    })
    expect(localGet).not.toHaveBeenCalled()
    expect(localSet).not.toHaveBeenCalled()
  })

  it('reset 取消旧请求并丢弃迟到账号；显式账号不匹配时失败关闭', async () => {
    const first = Promise.withResolvers<RemoteResult<XAgentWorkbenchBootstrap>>()
    const api = remote()
    api.bootstrap.mockReturnValueOnce(first.promise)
    const workbench = new XAgentWorkbenchController(api, sessions())
    const pending = workbench.bootstrap()
    workbench.reset('00000000-0000-0000-0000-000000000999')
    first.resolve(ok(bootstrap()))
    await pending
    expect(workbench.snapshot.getSnapshot()).toEqual({
      phase: 'empty',
      accountId: '00000000-0000-0000-0000-000000000999',
      switching: false,
      creating: false,
    })
    await workbench.bootstrap()
    expect(workbench.snapshot.getSnapshot()).toMatchObject({ phase: 'unavailable', accountId: undefined })
  })

  it('Bootstrap 失败后允许显式重试，不复用已结算请求', async () => {
    const api = remote()
    api.bootstrap.mockResolvedValueOnce(failure('service-unavailable'))
    const workbench = new XAgentWorkbenchController(api, sessions())
    await workbench.bootstrap()
    expect(workbench.snapshot.getSnapshot().phase).toBe('unavailable')
    await workbench.bootstrap()
    expect(api.bootstrap).toHaveBeenCalledTimes(2)
    expect(workbench.snapshot.getSnapshot().phase).toBe('ready')
  })

  it('切换上下文提交后才替换状态并清空 Session；失败保留原上下文', async () => {
    const api = remote()
    const sessionActions = sessions()
    const workbench = new XAgentWorkbenchController(api, sessionActions)
    await workbench.bootstrap()
    api['select-context'].mockResolvedValueOnce(failure('service-unavailable'))
    await workbench.selectContext({ kind: 'project', projectId: PROJECT_ID })
    expect(workbench.snapshot.getSnapshot()).toMatchObject({ context: { kind: 'workbench' }, switching: false })
    expect(sessionActions.clear).not.toHaveBeenCalled()
    await workbench.selectContext({ kind: 'project', projectId: PROJECT_ID })
    expect(workbench.snapshot.getSnapshot()).toMatchObject({ context: { kind: 'project', projectId: PROJECT_ID } })
    expect(sessionActions.clear).toHaveBeenCalledOnce()
  })

  it('创建项目使用独立幂等键；403 不改项目状态，成功后自动进入项目', async () => {
    const api = remote()
    const sessionActions = sessions()
    const workbench = new XAgentWorkbenchController(api, sessionActions, () => 'create-key')
    await workbench.bootstrap()
    api['create-project'].mockResolvedValueOnce(failure('forbidden'))
    await workbench.createProject(' Alpha ')
    expect(api['create-project']).toHaveBeenLastCalledWith('Alpha', 'create-key', expect.any(AbortSignal))
    expect(workbench.snapshot.getSnapshot()).toMatchObject({
      context: { kind: 'workbench' },
      createError: '你没有创建项目的权限',
    })
    await workbench.createProject('Alpha')
    expect(workbench.snapshot.getSnapshot()).toMatchObject({ context: { kind: 'project', projectId: PROJECT_ID } })
    expect(sessionActions.clear).toHaveBeenCalledOnce()
  })

  it('拒绝非 ready 操作和非法项目名，ready Bootstrap 不重复请求', async () => {
    const api = remote()
    const workbench = new XAgentWorkbenchController(api, sessions())
    await expect(workbench.selectContext({ kind: 'workbench' })).rejects.toThrow('xagent workbench is not ready')
    await workbench.bootstrap()
    await workbench.bootstrap()
    expect(api.bootstrap).toHaveBeenCalledOnce()
    await workbench.createProject('   ')
    expect(workbench.snapshot.getSnapshot()).toMatchObject({ createError: '项目名称需为 1–255 个字符' })
    await workbench.createProject('x'.repeat(256))
    expect(api['create-project']).not.toHaveBeenCalled()
  })

  it('丢弃切换和创建的迟到响应，并拒绝响应账号漂移', async () => {
    const selectApi = remote()
    const selectWork = new XAgentWorkbenchController(selectApi, sessions())
    await selectWork.bootstrap()
    const lateSelect = Promise.withResolvers<RemoteResult<XAgentWorkbenchBootstrap>>()
    selectApi['select-context'].mockReturnValueOnce(lateSelect.promise)
    const selecting = selectWork.selectContext({ kind: 'project', projectId: PROJECT_ID })
    selectWork.reset()
    lateSelect.resolve(ok(bootstrap({ context: { kind: 'project', projectId: PROJECT_ID } })))
    await selecting
    expect(selectWork.snapshot.getSnapshot().phase).toBe('empty')

    const createApi = remote()
    const createWork = new XAgentWorkbenchController(createApi, sessions(), () => 'key')
    await createWork.bootstrap()
    const lateCreate = Promise.withResolvers<RemoteResult<XAgentWorkbenchBootstrap>>()
    createApi['create-project'].mockReturnValueOnce(lateCreate.promise)
    const creating = createWork.createProject('Alpha')
    createWork.reset()
    lateCreate.resolve(ok(bootstrap()))
    await creating
    expect(createWork.snapshot.getSnapshot().phase).toBe('empty')

    const driftApi = remote()
    const driftWork = new XAgentWorkbenchController(driftApi, sessions(), () => 'key')
    await driftWork.bootstrap()
    const other = bootstrap({ account: { ...bootstrap().account, id: 'other-account' } })
    driftApi['select-context'].mockResolvedValueOnce(ok(other))
    await driftWork.selectContext({ kind: 'workbench' })
    expect(driftWork.snapshot.getSnapshot()).toMatchObject({ phase: 'ready', error: '工作台服务暂时不可用' })
    driftApi['create-project'].mockResolvedValueOnce(ok(other))
    await driftWork.createProject('Alpha')
    expect(driftWork.snapshot.getSnapshot()).toMatchObject({ phase: 'ready', createError: '工作台服务暂时不可用' })
  })

  it('项目详情只发布当前账号和项目，并丢弃 reset 后的迟到详情', async () => {
    const api = remote()
    const workbench = new XAgentWorkbenchController(api, sessions())
    await workbench.bootstrap()
    await workbench.loadProject(PROJECT_ID)
    expect(workbench.snapshot.getSnapshot()).toMatchObject({ projectDetail: { id: PROJECT_ID, accountId: ACCOUNT_ID } })

    api.project.mockResolvedValueOnce(failure('service-unavailable'))
    await workbench.loadProject(PROJECT_ID)
    expect(workbench.snapshot.getSnapshot()).toMatchObject({ error: '工作台服务暂时不可用' })
    api.project.mockResolvedValueOnce(ok({
      accountId: 'other-account', id: PROJECT_ID, name: 'Alpha', createdAt: '2026-08-25T08:00:00Z',
      canEdit: false, sessionCount: 0,
    }))
    await workbench.loadProject(PROJECT_ID)
    expect(workbench.snapshot.getSnapshot()).toMatchObject({ error: '工作台服务暂时不可用' })
    api.project.mockResolvedValueOnce(ok({
      accountId: ACCOUNT_ID, id: 'other-project', name: 'Beta', createdAt: '2026-08-25T08:00:00Z',
      canEdit: false, sessionCount: 0,
    }))
    await workbench.loadProject(PROJECT_ID)
    expect(workbench.snapshot.getSnapshot()).toMatchObject({ error: '工作台服务暂时不可用' })

    const late = Promise.withResolvers<RemoteResult<XAgentProjectDetail>>()
    api.project.mockReturnValueOnce(late.promise)
    const pending = workbench.loadProject(PROJECT_ID)
    workbench.reset()
    late.resolve(ok({
      accountId: ACCOUNT_ID, id: PROJECT_ID, name: 'Alpha', createdAt: '2026-08-25T08:00:00Z',
      canEdit: true, sessionCount: 2,
    }))
    await pending
    expect(workbench.snapshot.getSnapshot().phase).toBe('empty')
  })

  it('外部取消信号参与操作，dispose 取消在途 Bootstrap，默认创建键来自 crypto', async () => {
    const api = remote()
    const pendingBootstrap = Promise.withResolvers<RemoteResult<XAgentWorkbenchBootstrap>>()
    api.bootstrap.mockReturnValueOnce(pendingBootstrap.promise)
    const workbench = new XAgentWorkbenchController(api, sessions())
    const external = new AbortController()
    const pending = workbench.bootstrap(external.signal)
    const bootstrapSignal = api.bootstrap.mock.calls[0]?.[0] as AbortSignal | undefined
    external.abort()
    expect(bootstrapSignal?.aborted).toBe(true)
    workbench.dispose()
    pendingBootstrap.resolve(ok(bootstrap()))
    await pending
    expect(workbench.snapshot.getSnapshot().phase).toBe('loading')

    const createApi = remote()
    const createWork = new XAgentWorkbenchController(createApi, sessions())
    await createWork.bootstrap()
    await createWork.createProject('Alpha')
    expect(createApi['create-project']).toHaveBeenCalledWith('Alpha', expect.any(String), expect.any(AbortSignal))
  })
})
