// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { XAgentWorkbenchBootstrap } from '@xagent/dsh-project/types'
import { ContextMarker } from '../src/client/ContextMarker.tsx'
import { WorkbenchDetails } from '../src/client/WorkbenchDetails.tsx'
import { WorkbenchOperationShield } from '../src/client/WorkbenchOperationShield.tsx'
import { XAgentWorkbenchStore, type XAgentWorkbenchState } from '../src/client/store.ts'

const PROJECT_ID = '00000000-0000-0000-0000-000000000201'

type ReadyWorkbenchState = Extract<XAgentWorkbenchState, { phase: 'ready' }>

function ready(context: XAgentWorkbenchBootstrap['context']): ReadyWorkbenchState {
  return {
    phase: 'ready', accountId: 'account-1', switching: false, creating: false,
    account: { id: 'account-1', email: 'manager@example.com', role: 'manager', permissionRevision: 1 },
    capabilities: ['project.create'], context,
    projects: [{ id: PROJECT_ID, name: 'Alpha', createdAt: '2026-08-25T08:00:00Z' }],
    sessionScopes: [], sessionSummary: { privateCount: 3, projectCounts: { [PROJECT_ID]: 4 } },
  }
}

function hook(store: XAgentWorkbenchStore) {
  return function useWorkbench<S>(selector: (value: XAgentWorkbenchState) => S): S {
    return selector(useSyncExternalStore(store.subscribe, store.getSnapshot))
  }
}

function renderArtifacts() {
  return <p>资料插件内容</p>
}

const standard = {
  useSessions: vi.fn() as never,
  useWorkspaces: vi.fn() as never,
  renderSlot: vi.fn((name: string) => name === 'xagent.workbench.artifacts' ? renderArtifacts() : null) as never,
}

afterEach(cleanup)

describe('XAgent 工作台上下文与详情', () => {
  it('未就绪时详情显示加载状态，上下文标识不发布猜测值', () => {
    const store = new XAgentWorkbenchStore()
    render(<>
      <ContextMarker {...standard} useWorkbench={hook(store)} />
      <WorkbenchDetails {...standard} useWorkbench={hook(store)} loadProject={vi.fn(async () => {})} />
    </>)
    expect(screen.getByText('正在加载详情…')).toBeTruthy()
    expect(screen.queryByText(/跨项目|Alpha/)).toBeNull()
  })

  it('工作台显示跨项目标识、可访问项目数、私有 Session 和空协作收件箱', () => {
    const store = new XAgentWorkbenchStore()
    store.replace(ready({ kind: 'workbench' }))
    const useWorkbench = hook(store)
    render(<>
      <ContextMarker {...standard} useWorkbench={useWorkbench} />
      <WorkbenchDetails {...standard} useWorkbench={useWorkbench} loadProject={vi.fn(async () => {})} />
    </>)
    expect(screen.getByText('我的工作台 · 跨项目')).toBeTruthy()
    expect(screen.getByText('可访问项目')).toBeTruthy()
    expect(screen.getByText('私有会话')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByText('协作收件箱')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '协作收件箱' }))
    expect(screen.getByText('暂无待处理协作')).toBeTruthy()
    expect(screen.queryByText(/未读|\d+ 条待办/)).toBeNull()
  })

  it('默认显示概览，并只在资料页签渲染资料子 Slot', () => {
    const store = new XAgentWorkbenchStore()
    store.replace(ready({ kind: 'workbench' }))
    render(<WorkbenchDetails {...standard} useWorkbench={hook(store)} loadProject={vi.fn(async () => {})} />)

    expect(screen.getByRole('tab', { name: '概览' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByText('资料插件内容')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '资料' }))
    expect(screen.getByRole('tab', { name: '资料' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('资料插件内容')).toBeTruthy()
    expect(standard.renderSlot).toHaveBeenCalledWith('xagent.workbench.artifacts', {})
  })

  it('页签支持方向键、Home 和 End 切换并跟随焦点', () => {
    const store = new XAgentWorkbenchStore()
    store.replace(ready({ kind: 'workbench' }))
    render(<WorkbenchDetails {...standard} useWorkbench={hook(store)} loadProject={vi.fn(async () => {})} />)
    const overview = screen.getByRole('tab', { name: '概览' })
    const artifacts = screen.getByRole('tab', { name: '资料' })
    const inbox = screen.getByRole('tab', { name: '协作收件箱' })

    overview.focus()
    fireEvent.keyDown(overview, { key: 'ArrowRight' })
    expect(artifacts).toBe(document.activeElement)
    expect(artifacts.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(artifacts, { key: 'End' })
    expect(inbox).toBe(document.activeElement)
    fireEvent.keyDown(inbox, { key: 'ArrowRight' })
    expect(overview).toBe(document.activeElement)
    fireEvent.keyDown(overview, { key: 'End' })
    fireEvent.keyDown(inbox, { key: 'Home' })
    expect(overview).toBe(document.activeElement)
    fireEvent.keyDown(overview, { key: 'ArrowLeft' })
    expect(inbox).toBe(document.activeElement)
  })

  it('没有资料 occupant 时显示稳定中文空态，协作收件箱保持独立页签', () => {
    const store = new XAgentWorkbenchStore()
    store.replace(ready({ kind: 'workbench' }))
    const renderSlot = vi.fn(() => null)
    render(<WorkbenchDetails
      {...standard}
      renderSlot={renderSlot as never}
      useWorkbench={hook(store)}
      loadProject={vi.fn(async () => {})}
    />)

    fireEvent.click(screen.getByRole('tab', { name: '资料' }))
    expect(screen.getByText('当前范围暂无资料功能')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '协作收件箱' }))
    expect(screen.getByText('暂无待处理协作')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledTimes(1)
  })

  it('项目上下文显示名称、创建时间、权限和 Session 数，并按账号加载详情', async () => {
    const store = new XAgentWorkbenchStore()
    store.replace({
      ...ready({ kind: 'project', projectId: PROJECT_ID }),
      projectDetail: {
        accountId: 'account-1', id: PROJECT_ID, name: 'Alpha', createdAt: '2026-08-25T08:00:00Z', canEdit: true, sessionCount: 4,
      },
    })
    const useWorkbench = hook(store)
    const loadProject = vi.fn(async () => {})
    render(<>
      <ContextMarker {...standard} useWorkbench={useWorkbench} />
      <WorkbenchDetails {...standard} useWorkbench={useWorkbench} loadProject={loadProject} />
    </>)
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0)
    expect(screen.getByText('可编辑')).toBeTruthy()
    expect(screen.getByText('项目会话')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByText(/2026-08-25/)).toBeTruthy()
    expect(loadProject).not.toHaveBeenCalled()
  })

  it('项目详情缺失时按当前项目 ID 从服务器加载', async () => {
    const store = new XAgentWorkbenchStore()
    store.replace(ready({ kind: 'project', projectId: PROJECT_ID }))
    const loadProject = vi.fn(async () => {})
    render(<WorkbenchDetails {...standard} useWorkbench={hook(store)} loadProject={loadProject} />)
    await waitFor(() => { expect(loadProject).toHaveBeenCalledWith(PROJECT_ID) })
  })

  it('缺失项目摘要与详情时显示保守占位，并使用 Bootstrap 会话计数', () => {
    const store = new XAgentWorkbenchStore()
    store.replace({
      ...ready({ kind: 'project', projectId: 'missing-project' }),
      projects: [],
      sessionSummary: { privateCount: 0, projectCounts: {} },
    })
    render(<>
      <ContextMarker {...standard} useWorkbench={hook(store)} />
      <WorkbenchDetails {...standard} useWorkbench={hook(store)} loadProject={vi.fn(async () => {})} />
    </>)
    expect(screen.getAllByText('项目').length).toBeGreaterThan(0)
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.getByText('加载中')).toBeTruthy()
    expect(screen.getByText('0')).toBeTruthy()
  })

  it('项目详情显示只读权限和详情计数', () => {
    const store = new XAgentWorkbenchStore()
    store.replace({
      ...ready({ kind: 'project', projectId: PROJECT_ID }),
      projectDetail: {
        accountId: 'account-1', id: PROJECT_ID, name: 'Alpha', createdAt: '2026-08-25T08:00:00Z',
        canEdit: false, sessionCount: 7,
      },
    })
    render(<WorkbenchDetails {...standard} useWorkbench={hook(store)} loadProject={vi.fn(async () => {})} />)
    expect(screen.getByText('只读')).toBeTruthy()
    expect(screen.getByText('7')).toBeTruthy()
  })

  it('上下文提交期间阻止从旧范围启动产品壳操作', async () => {
    const store = new XAgentWorkbenchStore()
    const initial = ready({ kind: 'workbench' })
    store.replace(initial)
    render(<WorkbenchOperationShield {...standard} useWorkbench={hook(store)} />)
    expect(screen.queryByRole('status')).toBeNull()
    store.replace({ ...initial, switching: true })
    expect((await screen.findByRole('status')).textContent).toBe('正在切换工作范围…')
    store.replace({ ...initial, creating: true })
    expect((await screen.findByRole('status')).textContent).toBe('正在创建项目…')
  })
})
