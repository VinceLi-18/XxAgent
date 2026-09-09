import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  XAgentProjectDetail,
  XAgentWorkbenchBootstrap,
} from '@xagent/dsh-project/types'

/** 工作台第三栏可选择的页签。 */
export type XAgentWorkbenchDetailsTab = 'overview' | 'artifacts' | 'facts' | 'inbox'

/** 工作台第三栏当前页签的包内可写快照。 */
export class XAgentWorkbenchDetailsStore implements HostObservable<XAgentWorkbenchDetailsTab> {
  private state: XAgentWorkbenchDetailsTab = 'overview'
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): XAgentWorkbenchDetailsTab => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 选择第三栏页签。
   * @param tab 要显示的页签。
   */
  replace(tab: XAgentWorkbenchDetailsTab): void {
    if (tab === this.state) return
    this.state = tab
    this.listeners.forEach((listener) => { listener() })
  }
}

interface XAgentWorkbenchInteractionState {
  readonly switching: boolean
  readonly creating: boolean
  readonly error?: string | undefined
  readonly createError?: string | undefined
}

/** 项目工作台组件共享的服务器状态和短期交互状态。 */
export type XAgentWorkbenchState = XAgentWorkbenchInteractionState & (
  | { readonly phase: 'empty'; readonly accountId: string | undefined }
  | { readonly phase: 'loading'; readonly accountId: string | undefined }
  | { readonly phase: 'unavailable'; readonly accountId: string | undefined }
  | {
    readonly phase: 'ready'
    readonly accountId: string
    readonly account: XAgentWorkbenchBootstrap['account']
    readonly capabilities: XAgentWorkbenchBootstrap['capabilities']
    readonly context: XAgentWorkbenchBootstrap['context']
    readonly projects: XAgentWorkbenchBootstrap['projects']
    readonly sessionScopes: XAgentWorkbenchBootstrap['sessionScopes']
    readonly sessionSummary: XAgentWorkbenchBootstrap['sessionSummary']
    readonly projectDetail?: XAgentProjectDetail
  }
)

/** 包内可写、包外只读的项目工作台快照。 */
export class XAgentWorkbenchStore implements HostObservable<XAgentWorkbenchState> {
  private state: XAgentWorkbenchState = {
    phase: 'empty', accountId: undefined, switching: false, creating: false,
  }
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): XAgentWorkbenchState => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 发布一次完整状态替换。
   * @param state 新的工作台状态。
   */
  replace(state: XAgentWorkbenchState): void {
    this.state = state
    this.listeners.forEach((listener) => { listener() })
  }
}
