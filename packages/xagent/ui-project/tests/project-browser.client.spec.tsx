// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { ProjectBrowser } from '../src/client/ProjectBrowser.tsx'
import { XAgentWorkbenchStore, type XAgentWorkbenchState } from '../src/client/store.ts'

const PROJECT_ID = '00000000-0000-0000-0000-000000000201'
const PRIVATE_SESSION = '00000000-0000-0000-0000-000000000301'
const PROJECT_SESSION = '00000000-0000-0000-0000-000000000302'

type ReadyWorkbenchState = Extract<XAgentWorkbenchState, { phase: 'ready' }>

function state(overrides: Partial<ReadyWorkbenchState> = {}): ReadyWorkbenchState {
  return {
    phase: 'ready', accountId: 'account-1', switching: false, creating: false,
    account: { id: 'account-1', email: 'manager@example.com', role: 'manager', permissionRevision: 1 },
    capabilities: ['project.create'],
    context: { kind: 'workbench' },
    projects: [
      { id: PROJECT_ID, name: 'Alpha', createdAt: '2026-08-25T08:00:00Z' },
      { id: 'project-2', name: 'Beta', createdAt: '2026-08-25T09:00:00Z' },
    ],
    sessionScopes: [
      { sessionId: PRIVATE_SESSION, visibility: 'private' },
      { sessionId: PROJECT_SESSION, visibility: 'project', projectId: PROJECT_ID },
    ],
    sessionSummary: { privateCount: 1, projectCounts: { [PROJECT_ID]: 1 } },
    ...overrides,
  }
}

function sessionState(): SessionListState {
  return {
    ids: [PRIVATE_SESSION, PROJECT_SESSION] as never,
    byId: {
      [PRIVATE_SESSION]: { id: PRIVATE_SESSION, displayTitle: '私有进度', running: false, blank: false, updatedAt: 2 },
      [PROJECT_SESSION]: { id: PROJECT_SESSION, displayTitle: 'Alpha 进度', running: false, blank: false, updatedAt: 1 },
    } as never,
    current: undefined,
    phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
}

function mountWorkbench(workbenchState: XAgentWorkbenchState, wide = true, sessionList = sessionState()) {
  const store = new XAgentWorkbenchStore()
  store.replace(workbenchState)
  const selectContext = vi.fn(async () => {})
  const createProject = vi.fn(async () => {})
  const openSession = vi.fn()
  const expandSidebar = vi.fn()
  const useWorkbench = <S,>(selector: (value: XAgentWorkbenchState) => S): S =>
    selector(useSyncExternalStore(store.subscribe, store.getSnapshot))
  const view = render(<ProjectBrowser
    wide={wide}
    expandSidebar={expandSidebar}
    useSessions={((selector: (value: SessionListState) => unknown) => selector(sessionList)) as never}
    useWorkspaces={vi.fn() as never}
    useWorkbench={useWorkbench}
    selectContext={selectContext}
    createProject={createProject}
    openSession={openSession}
  />)
  return { ...view, store, selectContext, createProject, openSession, expandSidebar }
}

afterEach(cleanup)

describe('XAgent Project Browser', () => {
  it('明确显示 loading 与 unavailable 状态', async () => {
    const view = mountWorkbench({ phase: 'loading', accountId: undefined, switching: false, creating: false })
    expect(screen.getByText('正在加载工作台…')).toBeTruthy()
    view.store.replace({ phase: 'unavailable', accountId: undefined, switching: false, creating: false })
    expect((await screen.findByRole('alert')).textContent).toBe('工作台服务暂时不可用')
  })

  it('显示工作台、真实项目和当前范围 Session，Manager 可创建项目', () => {
    const view = mountWorkbench(state())
    expect(screen.getByRole('button', { name: '我的工作台' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Beta' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建项目' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '私有进度' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Alpha 进度' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }))
    expect(view.selectContext).toHaveBeenCalledWith({ kind: 'project', projectId: PROJECT_ID })
  })

  it('无 project.create 的专员不显示创建入口，折叠栏不塞入完整项目列表', () => {
    const specialist = state({
      account: { id: 'account-1', email: 'specialist@example.com', role: 'specialist', permissionRevision: 1 },
      capabilities: [],
      context: { kind: 'project', projectId: PROJECT_ID },
    })
    const view = mountWorkbench(specialist, false)
    expect(screen.queryByRole('button', { name: '新建项目' })).toBeNull()
    expect(screen.getByRole('button', { name: '打开我的工作台' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开当前项目 Alpha' })).toBeTruthy()
    expect(screen.queryByText('Beta')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开当前项目 Alpha' }))
    expect(view.expandSidebar).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '打开我的工作台' }))
    expect(view.selectContext).toHaveBeenCalledWith({ kind: 'workbench' })
  })

  it('项目上下文只显示服务器映射的项目 Session，并支持打开与切回工作台', () => {
    const projectState = state({ context: { kind: 'project', projectId: PROJECT_ID } })
    const sessions = sessionState()
    Reflect.deleteProperty(sessions.byId, PROJECT_SESSION)
    const view = mountWorkbench(projectState, true, sessions)
    expect(screen.queryByRole('button', { name: '私有进度' })).toBeNull()
    expect(screen.getByRole('button', { name: '未命名会话' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '未命名会话' }))
    expect(view.openSession).toHaveBeenCalledWith(PROJECT_SESSION)
    fireEvent.click(screen.getByRole('button', { name: '我的工作台' }))
    expect(view.selectContext).toHaveBeenCalledWith({ kind: 'workbench' })
  })

  it('空范围显示真实空状态；工作台折叠入口只展开而不重复提交', () => {
    const empty = state({ sessionScopes: [] })
    const view = mountWorkbench(empty)
    expect(screen.getByText('当前范围暂无会话')).toBeTruthy()
    view.unmount()
    const rail = mountWorkbench(empty, false)
    fireEvent.click(screen.getByRole('button', { name: '打开我的工作台' }))
    expect(rail.expandSidebar).toHaveBeenCalledOnce()
    expect(rail.selectContext).not.toHaveBeenCalled()
  })

  it('创建表单校验 1–255 字符，并支持取消与 Escape 恢复入口焦点', () => {
    const view = mountWorkbench(state())
    const trigger = screen.getByRole('button', { name: '新建项目' })
    trigger.focus()
    fireEvent.click(trigger)
    const input = screen.getByLabelText('项目名称') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect(screen.getByRole('alert').textContent).toBe('项目名称需为 1–255 个字符')
    expect(view.createProject).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('dialog', { name: '新建项目' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '新建项目' })).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('dialog', { name: '新建项目' }), { key: 'Tab' })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '新建项目' })).toBeNull()
  })

  it('创建失败保留表单和输入焦点，成功才关闭并恢复入口焦点', async () => {
    const workbench = state()
    const view = mountWorkbench(workbench)
    view.createProject.mockImplementationOnce(async () => {
      view.store.replace({ ...workbench, createError: '你没有创建项目的权限' })
    })
    const trigger = screen.getByRole('button', { name: '新建项目' })
    fireEvent.click(trigger)
    const input = screen.getByLabelText('项目名称') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Gamma' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    expect((await screen.findByRole('alert')).textContent).toBe('你没有创建项目的权限')
    expect(screen.getByRole('dialog', { name: '新建项目' })).toBeTruthy()
    expect(document.activeElement).toBe(input)

    view.createProject.mockImplementationOnce(async () => {
      view.store.replace({
        ...workbench,
        context: { kind: 'project', projectId: PROJECT_ID },
        createError: undefined,
      })
    })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))
    await screen.findByRole('button', { name: '新建项目' })
    expect(screen.queryByRole('dialog', { name: '新建项目' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('提交期间显示进度并禁用提交；权限变化后关闭仍安全', async () => {
    const workbench = state()
    const view = mountWorkbench(workbench)
    fireEvent.click(screen.getByRole('button', { name: '新建项目' }))
    view.store.replace({ ...workbench, creating: true })
    expect((await screen.findByRole<HTMLButtonElement>('button', { name: '创建中…' })).disabled).toBe(true)
    view.store.replace({ ...workbench, capabilities: [] })
    await screen.findByRole('dialog', { name: '新建项目' })
    fireEvent.keyDown(screen.getByRole('dialog', { name: '新建项目' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '新建项目' })).toBeNull()
  })
})
