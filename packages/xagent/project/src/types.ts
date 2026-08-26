import type {
  XAgentProjectDetail as BackendProjectDetail,
  XAgentWorkbenchBootstrap as BackendWorkbenchBootstrap,
  XAgentWorkbenchContext as BackendWorkbenchContext,
} from '@xagent/dsh-backend-client'
import type { XAgentAuthenticatedRequestScope } from '@xagent/dsh-principal'

/** XAgent 项目 Remote 使用的工作台上下文。 */
export type XAgentWorkbenchContext = BackendWorkbenchContext

/** XAgent 项目 Remote 返回的完整账号工作台状态。 */
export type XAgentWorkbenchBootstrap = BackendWorkbenchBootstrap

/** XAgent 项目 Remote 返回的单项目详情。 */
export type XAgentProjectDetail = BackendProjectDetail

/** Authorizer 使用的非 Remote 请求作用域入口。 */
export interface XAgentProjectScopeRunner {
  withRequest<T>(scope: XAgentAuthenticatedRequestScope, operation: () => Promise<T>): Promise<T>
}

/** 浏览器可见的 XAgent 项目 Remote。 */
export interface XAgentProjectRemote {
  bootstrap(signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap>
  selectContext(context: XAgentWorkbenchContext, signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap>
  createProject(name: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap>
  project(projectId: string, signal?: AbortSignal): Promise<XAgentProjectDetail>
}
