import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  XAgentProjectDetail,
  XAgentWorkbenchBootstrap,
  XAgentWorkbenchContext,
} from '@xagent/dsh-project/types'
import { XAgentWorkbenchStore, type XAgentWorkbenchState } from './store.ts'

/** 浏览器调用的生成式 XAgent Project Remote 子集。 */
export interface XAgentProjectRemoteClient {
  bootstrap(signal?: AbortSignal): Promise<RemoteResult<XAgentWorkbenchBootstrap>>
  'select-context'(context: XAgentWorkbenchContext, signal?: AbortSignal): Promise<RemoteResult<XAgentWorkbenchBootstrap>>
  'create-project'(name: string, idempotencyKey: string, signal?: AbortSignal): Promise<RemoteResult<XAgentWorkbenchBootstrap>>
  project(projectId: string, signal?: AbortSignal): Promise<RemoteResult<XAgentProjectDetail>>
}

/** 上下文切换成功后同步导航选择所需的 Session 操作。 */
export interface XAgentSessionActions {
  clear(): void
}

/** 账号界面和项目组件使用的工作台服务。 */
export interface IXAgentWorkbench {
  readonly snapshot: XAgentWorkbenchStore
  bootstrap(signal?: AbortSignal): Promise<void>
  selectContext(context: XAgentWorkbenchContext, signal?: AbortSignal): Promise<void>
  createProject(name: string, signal?: AbortSignal): Promise<void>
  loadProject(projectId: string, signal?: AbortSignal): Promise<void>
  reset(nextAccountId?: string): void
  dispose(): void
}

function stableError(code: string): string {
  return code === 'forbidden' ? '你没有创建项目的权限' : '工作台服务暂时不可用'
}

function readyState(value: XAgentWorkbenchBootstrap): Extract<XAgentWorkbenchState, { phase: 'ready' }> {
  return {
    phase: 'ready',
    accountId: value.account.id,
    account: value.account,
    capabilities: value.capabilities,
    context: value.context,
    projects: value.projects,
    sessionScopes: value.sessionScopes,
    sessionSummary: value.sessionSummary,
    switching: false,
    creating: false,
  }
}

/** 以服务器 Bootstrap 为唯一账号工作台事实源的客户端控制器。 */
export class XAgentWorkbenchController implements IXAgentWorkbench {
  readonly snapshot = new XAgentWorkbenchStore()
  private epoch = 0
  private operation: AbortController | undefined
  private bootstrapTask: Promise<void> | undefined

  constructor(
    private readonly remote: XAgentProjectRemoteClient,
    private readonly sessions: XAgentSessionActions,
    private readonly createIdempotencyKey: () => string = () => crypto.randomUUID(),
  ) {}

  /**
   * 装载当前账号的完整服务器工作台；同一 epoch 共享一个请求。
   * @param signal 调用方取消信号。
   */
  bootstrap(signal?: AbortSignal): Promise<void> {
    if (this.bootstrapTask !== undefined) return this.bootstrapTask
    if (this.snapshot.getSnapshot().phase === 'ready') return Promise.resolve()
    const [epoch, operationSignal] = this.begin(signal)
    const accountId = this.snapshot.getSnapshot().accountId
    this.snapshot.replace({ phase: 'loading', accountId, switching: false, creating: false })
    const pending = this.loadBootstrap(epoch, accountId, operationSignal).finally(() => {
      if (this.bootstrapTask === pending) this.bootstrapTask = undefined
    })
    this.bootstrapTask = pending
    return pending
  }

  /**
   * 提交新的工作台或项目上下文。
   * @param context 服务端要选择的上下文。
   * @param signal 调用方取消信号。
   */
  async selectContext(context: XAgentWorkbenchContext, signal?: AbortSignal): Promise<void> {
    const current = this.requireReady()
    const [epoch, operationSignal] = this.begin(signal)
    this.snapshot.replace({ ...current, switching: true, error: undefined })
    const result = await this.remote['select-context'](context, operationSignal)
    if (epoch !== this.epoch) return
    if (!result.ok || !this.accountMatches(current.accountId, result.value)) {
      this.snapshot.replace({ ...current, switching: false, error: stableError(result.ok ? 'service-unavailable' : result.error.code) })
      return
    }
    this.snapshot.replace(readyState(result.value))
    this.sessions.clear()
  }

  /**
   * 创建项目并采用服务器返回的项目上下文。
   * @param name 用户输入的项目名称。
   * @param signal 调用方取消信号。
   */
  async createProject(name: string, signal?: AbortSignal): Promise<void> {
    const current = this.requireReady()
    const normalized = name.trim()
    if (normalized.length < 1 || normalized.length > 255) {
      this.snapshot.replace({ ...current, createError: '项目名称需为 1–255 个字符' })
      return
    }
    const [epoch, operationSignal] = this.begin(signal)
    this.snapshot.replace({ ...current, creating: true, createError: undefined })
    const result = await this.remote['create-project'](normalized, this.createIdempotencyKey(), operationSignal)
    if (epoch !== this.epoch) return
    if (!result.ok || !this.accountMatches(current.accountId, result.value)) {
      this.snapshot.replace({
        ...current,
        creating: false,
        createError: stableError(result.ok ? 'service-unavailable' : result.error.code),
      })
      return
    }
    this.snapshot.replace(readyState(result.value))
    this.sessions.clear()
  }

  /**
   * 读取当前账号可见的项目详情。
   * @param projectId 项目 UUID。
   * @param signal 调用方取消信号。
   */
  async loadProject(projectId: string, signal?: AbortSignal): Promise<void> {
    const current = this.requireReady()
    const [epoch, operationSignal] = this.begin(signal)
    const result = await this.remote.project(projectId, operationSignal)
    if (epoch !== this.epoch) return
    if (!result.ok || result.value.accountId !== current.accountId || result.value.id !== projectId) {
      this.snapshot.replace({ ...current, error: stableError(result.ok ? 'service-unavailable' : result.error.code) })
      return
    }
    this.snapshot.replace({ ...current, projectDetail: result.value })
  }

  /**
   * 切换账号时取消请求并清除所有项目状态。
   * @param nextAccountId 已知的新账号 ID；登录前可省略。
   */
  reset(nextAccountId?: string): void {
    this.operation?.abort()
    this.operation = undefined
    this.bootstrapTask = undefined
    ++this.epoch
    this.snapshot.replace({
      phase: 'empty', accountId: nextAccountId, switching: false, creating: false,
    })
    this.sessions.clear()
  }

  /** 取消请求并停止发布旧 epoch 的状态。 */
  dispose(): void {
    this.operation?.abort()
    this.operation = undefined
    this.bootstrapTask = undefined
    ++this.epoch
  }

  private async loadBootstrap(epoch: number, accountId: string | undefined, signal: AbortSignal): Promise<void> {
    const result = await this.remote.bootstrap(signal)
    if (epoch !== this.epoch) return
    if (!result.ok || !this.accountMatches(accountId, result.value)) {
      this.snapshot.replace({
        phase: 'unavailable', accountId: undefined, switching: false, creating: false,
        error: stableError(result.ok ? 'service-unavailable' : result.error.code),
      })
      return
    }
    this.snapshot.replace(readyState(result.value))
  }

  private requireReady(): Extract<XAgentWorkbenchState, { phase: 'ready' }> {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready') throw new Error('xagent workbench is not ready')
    return state
  }

  private accountMatches(expected: string | undefined, result: XAgentWorkbenchBootstrap): boolean {
    return expected === undefined || expected === result.account.id
  }

  private begin(signal?: AbortSignal): readonly [number, AbortSignal] {
    this.operation?.abort()
    const operation = new AbortController()
    this.operation = operation
    return [++this.epoch, signal === undefined ? operation.signal : AbortSignal.any([operation.signal, signal])]
  }
}
