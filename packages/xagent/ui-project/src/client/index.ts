import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@xagent/dsh-project/remote'
import { ContextMarker } from './ContextMarker.tsx'
import { ProjectBrowser, type ProjectBrowserInjected } from './ProjectBrowser.tsx'
import { XAgentWorkbenchController, type IXAgentWorkbench, type XAgentProjectRemoteClient } from './service.ts'
import { WorkbenchDetails, type WorkbenchDetailsInjected } from './WorkbenchDetails.tsx'
import { WorkbenchOperationShield } from './WorkbenchOperationShield.tsx'

export type {
  IXAgentWorkbench, XAgentProjectRemoteClient, XAgentSessionActions,
} from './service.ts'
export type { XAgentWorkbenchState } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 当前认证账号的服务器授权项目工作台。 */
    xagentWorkbench: IXAgentWorkbench
  }
}

/** Project UI 依赖正式 Slot、Session 导航和生成式 Project Remote。 */
export const inject = ['slots', 'sessions', 'remote', 'remote.xagentProject']

/** 注册工作台服务以及左栏、中央上下文和第三栏详情。 */
export function apply(ctx: ClientContext): void {
  const remote = (ctx.remote as typeof ctx.remote & { xagentProject: XAgentProjectRemoteClient }).xagentProject
  const workbench = new XAgentWorkbenchController(remote, {
    clear: () => { ctx.sessions.clear() },
  })
  ctx.provide('xagentWorkbench', workbench)
  ctx.effect(() => () => { workbench.dispose() }, 'dispose xagent workbench')

  const browserInjected = (): ProjectBrowserInjected => ({
    hooks: { workbench: workbench.snapshot },
    selectContext: context => workbench.selectContext(context),
    createProject: name => workbench.createProject(name),
    openSession: (sessionId) => { ctx.sessions.open(sessionId as never) },
  })
  const detailsInjected = (): WorkbenchDetailsInjected => ({
    hooks: { workbench: workbench.snapshot },
    loadProject: projectId => workbench.loadProject(projectId),
  })
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces', registrant: 'xagent-project-browser', inject: browserInjected,
  }, ProjectBrowser))
  ctx.slots.inject('conversation.context', () => ctx.slots.register({
    name: 'conversation.context', registrant: 'xagent-project-context',
    inject: () => ({ hooks: { workbench: workbench.snapshot } }),
  }, ContextMarker))
  ctx.slots.inject('shell.details', () => ctx.slots.register({
    name: 'shell.details', registrant: 'xagent-workbench-details', inject: detailsInjected,
  }, WorkbenchDetails))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'xagent-workbench-operation-shield', order: -90,
    inject: () => ({ hooks: { workbench: workbench.snapshot } }),
  }, WorkbenchOperationShield))
}
