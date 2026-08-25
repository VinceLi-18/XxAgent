/** 请求绑定的 XAgent 项目工作台 Remote。 @module @xagent/dsh-project */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  XAgentBackendClient,
  XAgentBackendError,
  type XAgentWorkbenchBackend,
} from '@xagent/dsh-backend-client'
import type {
  XAgentProjectDetail,
  XAgentProjectRemote,
  XAgentProjectRequestScope,
  XAgentProjectScopeRunner,
  XAgentWorkbenchBootstrap,
  XAgentWorkbenchContext,
} from './types.ts'

export type * from './types.ts'

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const PROJECT_FAILURE_CODES = new Set([
  'unauthenticated', 'forbidden', 'not-found', 'idempotency-conflict', 'unsupported-version', 'service-unavailable',
])

interface RequestScopeState {
  readonly scope: XAgentProjectRequestScope
  active: boolean
}

/** XAgent Project Host plugin configuration. */
export interface Config {
  /** FastAPI 服务的绝对 HTTP origin。 */
  backendOrigin: string
  /** Host 调用内部项目接口时使用的服务身份。 */
  serviceToken: string
}

export const Config: z<Config> = z.object({
  backendOrigin: z.string().required(),
  serviceToken: z.string().required(),
})

export const name = 'xagent-project'

declare module '@deepseek-ai/cordis' {
  interface Context {
    xagentProject: XAgentProjectService
  }
}

function validScope(scope: XAgentProjectRequestScope): boolean {
  const role: unknown = scope.principal.role
  return UUID_PATTERN.test(scope.principal.actorId)
    && (role === 'manager' || role === 'specialist')
    && Number.isSafeInteger(scope.principal.permissionRevision)
    && scope.principal.permissionRevision >= 1
    && scope.userToken.length > 0
    && scope.connectionId.length > 0
}

/** 将账号绑定请求转发给 FastAPI 的项目工作台服务。 */
export class XAgentProjectService extends TypertRemoteService implements XAgentProjectRemote, XAgentProjectScopeRunner {
  private readonly requestScope = new AsyncLocalStorage<RequestScopeState>()
  private disposed = false

  constructor(ctx: Context, private readonly backend: XAgentWorkbenchBackend) {
    super(ctx, 'xagentProject')
    ctx.effect(() => () => { this.disposed = true }, 'dispose xagent project request scope')
  }

  /**
   * 在 Host 认证所得的单请求身份内执行完整 Remote 调用。
   * @param scope - 物理连接绑定的可信 Principal 与用户令牌。
   * @param operation - 下游完整 Remote 操作。
   * @returns 下游结果；退出时自动清除请求身份。
   */
  async withRequest<T>(scope: XAgentProjectRequestScope, operation: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('xagent project service is disposed')
    if (!validScope(scope)) throw new Error('invalid xagent project request scope')
    const current = this.requestScope.getStore()
    if (current?.active === true) throw new Error('nested xagent project request scope')
    const state: RequestScopeState = { scope, active: true }
    try {
      return await this.requestScope.run(state, operation)
    } finally {
      state.active = false
    }
  }

  /**
   * 读取当前账号的完整工作台状态。
   * @param signal - 物理请求的取消信号。
   * @returns FastAPI 当前可见的账号、能力、上下文、项目和会话摘要。
   */
  @Remote('bootstrap')
  async bootstrap(signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap> {
    const scope = this.requireScope()
    return this.callBackend(async () =>
      this.assertBootstrapAccount(await this.backend.bootstrap(scope.userToken, signal), scope))
  }

  /**
   * 为当前账号选择跨项目工作台或单项目上下文。
   * @param context - 目标工作台或项目上下文。
   * @param signal - 物理请求的取消信号。
   * @returns FastAPI 提交选择后重新读取的完整工作台状态。
   */
  @Remote('select-context')
  async selectContext(context: XAgentWorkbenchContext, signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap> {
    const scope = this.requireScope()
    return this.callBackend(async () =>
      this.assertBootstrapAccount(await this.backend.selectContext(scope.userToken, context, signal), scope))
  }

  /**
   * 使用服务端能力检查为当前账号创建项目。
   * @param name - 用户提交的项目名称。
   * @param idempotencyKey - 当前创建意图的幂等键。
   * @param signal - 物理请求的取消信号。
   * @returns FastAPI 创建项目后重新读取的完整工作台状态。
   */
  @Remote('create-project')
  async createProject(name: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap> {
    const scope = this.requireScope()
    return this.callBackend(async () => this.assertBootstrapAccount(
      await this.backend.createProject(scope.userToken, { name, idempotencyKey }, signal), scope,
    ))
  }

  /**
   * 读取当前账号可见的一个项目详情。
   * @param projectId - 当前账号请求查看的项目 UUID。
   * @param signal - 物理请求的取消信号。
   * @returns 与请求 Principal 账号一致的项目详情。
   */
  @Remote('project')
  async project(projectId: string, signal?: AbortSignal): Promise<XAgentProjectDetail> {
    const scope = this.requireScope()
    return this.callBackend(async () => {
      const result = await this.backend.project(scope.userToken, projectId, signal)
      if (result.accountId !== scope.principal.actorId) throw new XAgentBackendError('service-unavailable')
      return result
    })
  }

  private async callBackend<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (!(error instanceof XAgentBackendError)) throw error
      const code = PROJECT_FAILURE_CODES.has(error.code) ? error.code : 'service-unavailable'
      throw new TypertRemoteFailure({ code, message: 'XAgent project request failed', details: {} })
    }
  }

  private requireScope(): XAgentProjectRequestScope {
    if (this.disposed) throw new Error('xagent project service is disposed')
    const state = this.requestScope.getStore()
    if (state?.active !== true) throw new Error('xagent project request scope is required')
    return state.scope
  }

  private assertBootstrapAccount(
    result: XAgentWorkbenchBootstrap,
    scope: XAgentProjectRequestScope,
  ): XAgentWorkbenchBootstrap {
    if (result.account.id !== scope.principal.actorId) throw new XAgentBackendError('service-unavailable')
    return result
  }
}

/** 安装 XAgent 项目工作台 Host 服务。 */
export function apply(ctx: Context, config: Config): void {
  new XAgentProjectService(
    ctx,
    new XAgentBackendClient({ origin: config.backendOrigin, serviceToken: config.serviceToken }).workbench,
  )
}
