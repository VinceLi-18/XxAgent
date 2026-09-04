import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import projectRemote from '@xagent/dsh-project/remote'
import { ContextMarker } from './ContextMarker.tsx'
import { ProjectBrowser, type ProjectBrowserInjected } from './ProjectBrowser.tsx'
import { XAgentWorkbenchController, type IXAgentWorkbench, type XAgentProjectRemoteClient } from './service.ts'
import { WorkbenchDetails, type WorkbenchDetailsInjected } from './WorkbenchDetails.tsx'
import { WorkbenchOperationShield } from './WorkbenchOperationShield.tsx'

export type {
  IXAgentWorkbench, XAgentProjectRemoteClient, XAgentSessionActions,
} from './service.ts'
export type { XAgentWorkbenchState } from './store.ts'
export type { XAgentWorkbenchDetailsTab } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 当前 XAgent 工作范围的资料管理入口。 */
    'xagent.workbench.artifacts': { kind: 'single'; scope: 'root' }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 当前认证账号的服务器授权项目工作台。 */
    xagentWorkbench: IXAgentWorkbench
  }
}

/** Project UI 依赖本地 Slot、Session 与生成式 Remote 装配服务。 */
export const inject = ['slots', 'sessions', 'remote', 'layout']

/** 注册工作台服务以及左栏、中央上下文和第三栏详情。 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(projectRemote)
  const feature = ctx.inject(['remote.xagentProject'], (scope: ClientContext) => {
    const remote = scope.get('remote.xagentProject') as XAgentProjectRemoteClient
    const workbench = new XAgentWorkbenchController(remote, {
      clear: () => { scope.sessions.clear() },
    }, undefined, () => { scope.layout.openDetails() })
    scope.provide('xagentWorkbench', workbench)

    const browserInjected = (): ProjectBrowserInjected => ({
      hooks: { workbench: workbench.snapshot },
      selectContext: (context) => {
        scope.layout.openDetails()
        return workbench.selectContext(context)
      },
      createProject: (name) => {
        scope.layout.openDetails()
        return workbench.createProject(name)
      },
      openSession: (sessionId) => { scope.sessions.open(sessionId as never) },
    })
    const detailsInjected = (): WorkbenchDetailsInjected => ({
      hooks: { workbench: workbench.snapshot, detailsTab: workbench.details },
      loadProject: projectId => workbench.loadProject(projectId),
      selectDetailsTab: (tab) => { workbench.selectDetailsTab(tab) },
    })
    scope.slots.inject('sidebar.workspaces', () => scope.slots.register({
      name: 'sidebar.workspaces', registrant: 'xagent-project-browser', inject: browserInjected,
    }, ProjectBrowser))
    scope.slots.inject('conversation.context', () => scope.slots.register({
      name: 'conversation.context', registrant: 'xagent-project-context',
      inject: () => ({ hooks: { workbench: workbench.snapshot } }),
    }, ContextMarker))
    scope.slots.inject('shell.details', () => scope.slots.register({
      name: 'shell.details', registrant: 'xagent-workbench-details', inject: detailsInjected,
      children: { 'xagent.workbench.artifacts': { kind: 'single', scope: 'root' } },
    }, WorkbenchDetails))
    scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay', id: 'xagent-workbench-operation-shield', order: -90,
      inject: () => ({ hooks: { workbench: workbench.snapshot } }),
    }, WorkbenchOperationShield))
    return () => { workbench.dispose() }
  })
  try {
    await feature.await()
  } catch (error) {
    await feature.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await feature.dispose()
    await disposeRemote()
  }
}
