// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppFrame } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import type { XAgentWorkbenchBootstrap } from '@xagent/dsh-project/types'
import { ContextMarker } from '../src/client/ContextMarker.tsx'
import { WorkbenchDetails } from '../src/client/WorkbenchDetails.tsx'
import { WorkbenchOperationShield } from '../src/client/WorkbenchOperationShield.tsx'
import {
  XAgentWorkbenchDetailsStore,
  XAgentWorkbenchStore,
  type XAgentWorkbenchDetailsTab,
  type XAgentWorkbenchState,
} from '../src/client/store.ts'

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

function detailsHook(store: XAgentWorkbenchDetailsStore) {
  return function useDetailsTab<S>(selector: (value: XAgentWorkbenchDetailsTab) => S): S {
    return selector(useSyncExternalStore(store.subscribe, store.getSnapshot))
  }
}

function layoutHook(store: ReturnType<ReturnType<typeof createLayoutStore>['create']>) {
  return function useLayout<S>(selector: (value: ReturnType<typeof store.getSnapshot>) => S): S {
    return selector(useSyncExternalStore(
      listener => store.subscribe(listener),
      () => store.getSnapshot(),
    ))
  }
}

function renderArtifacts() {
  return <p>资料插件内容</p>
}

const standard = {
  useSessions: vi.fn() as never,
  useWorkspaces: vi.fn() as never,
  useDetailsTab: ((selector: (value: 'overview') => unknown) => selector('overview')) as never,
  selectDetailsTab: vi.fn(),
  useFactsAvailable: ((selector: (value: false) => unknown) => selector(false)) as never,
  renderSlot: vi.fn((name: string) => name === 'xagent.workbench.artifacts' ? renderArtifacts() : null) as never,
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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

  it('citation 的外部页签选择会显示资料子 Slot', () => {
    const store = new XAgentWorkbenchStore()
    const details = new XAgentWorkbenchDetailsStore()
    store.replace(ready({ kind: 'workbench' }))
    render(<WorkbenchDetails
      {...standard}
      useWorkbench={hook(store)}
      useDetailsTab={detailsHook(details)}
      loadProject={vi.fn(async () => {})}
    />)

    act(() => { details.replace('artifacts') })

    expect(screen.getByRole('tab', { name: '资料' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('资料插件内容')).toBeTruthy()
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

  it('仅在 Fact occupant 存在时增加等宽事实页签并加入键盘顺序', () => {
    const store = new XAgentWorkbenchStore()
    store.replace(ready({ kind: 'project', projectId: PROJECT_ID }))
    const renderSlot = vi.fn((name: string) => name === 'xagent.workbench.facts' ? <p>Fact occupant</p> : null)
    render(<WorkbenchDetails
      {...standard}
      renderSlot={renderSlot as never}
      useFactsAvailable={((selector: (value: true) => unknown) => selector(true)) as never}
      useWorkbench={hook(store)}
      loadProject={vi.fn(async () => {})}
    />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['概览', '资料', '事实', '协作收件箱'])
    expect(screen.queryByText('Fact occupant')).toBeNull()
    const artifacts = screen.getByRole('tab', { name: '资料' })
    artifacts.focus()
    fireEvent.keyDown(artifacts, { key: 'ArrowRight' })
    const facts = screen.getByRole('tab', { name: '事实' })
    expect(facts).toBe(document.activeElement)
    expect(facts.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Fact occupant')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('xagent.workbench.facts', {})
    fireEvent.keyDown(facts, { key: 'End' })
    expect(screen.getByRole('tab', { name: '协作收件箱' })).toBe(document.activeElement)
  })

  it('没有 Fact occupant 时保留原有三页签、默认选择和键盘顺序', () => {
    const store = new XAgentWorkbenchStore()
    store.replace(ready({ kind: 'workbench' }))
    const renderSlot = vi.fn((name: string) => name === 'xagent.workbench.artifacts' ? renderArtifacts() : null)
    render(<WorkbenchDetails
      {...standard}
      renderSlot={renderSlot as never}
      useWorkbench={hook(store)}
      loadProject={vi.fn(async () => {})}
    />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['概览', '资料', '协作收件箱'])
    expect(screen.getByRole('tab', { name: '概览' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: '资料' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: '协作收件箱' })).toBe(document.activeElement)
    expect(renderSlot).not.toHaveBeenCalledWith('xagent.workbench.facts', {})
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
    expect(renderSlot).toHaveBeenCalledWith('xagent.workbench.artifacts', {})
  })

  it('窄屏保留 Agent 对话中栏，并以抽屉承载真实资料详情', () => {
    window.innerWidth = 980
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    const layout = createLayoutStore().create()
    layout.actions.openDetails()
    const workbench = new XAgentWorkbenchStore()
    workbench.replace(ready({ kind: 'workbench' }))
    const renderSlot = vi.fn((name: string) => {
      if (name === 'conversation') return <main>Agent 对话</main>
      if (name === 'shell.details') return <WorkbenchDetails
        {...standard}
        useWorkbench={hook(workbench)}
        loadProject={vi.fn(async () => {})}
      />
      return null
    })

    render(<AppFrame
      useStore={layoutHook(layout)}
      actions={layout.actions}
      renderSlot={renderSlot as never}
      useSessions={((selector: (state: object) => unknown) => selector({ current: undefined, byId: {} })) as never}
      useWorkspaces={vi.fn() as never}
      SessionProvider={vi.fn() as never}
      useShellDetails={selector => selector(true)}
    />)

    expect(screen.getByText('Agent 对话')).toBeTruthy()
    expect(screen.queryByText('资料插件内容')).toBeNull()
    const trigger = screen.getByRole('button', { name: '打开上下文栏' })
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: '上下文栏' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '资料' }))
    expect(screen.getByText('资料插件内容')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭上下文栏' }))
    expect(screen.queryByRole('dialog', { name: '上下文栏' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(screen.getByText('Agent 对话')).toBeTruthy()
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
