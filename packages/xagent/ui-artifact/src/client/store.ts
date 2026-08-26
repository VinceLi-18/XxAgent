import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { XAgentArtifactDetail, XAgentArtifactSummary } from '@xagent/dsh-artifact/types'

/** Browser 内存中一次上传的可见阶段。 */
export interface XAgentArtifactUploadState {
  readonly filename: string
  readonly progress: number
  readonly phase: 'authorizing' | 'putting' | 'completing' | 'complete'
}

/** 只在当前详情层存活的短期安全预览。 */
export type XAgentArtifactPreviewState =
  | { readonly versionId: string; readonly filename: string; readonly kind: 'pdf' | 'image'; readonly url: string }
  | { readonly versionId: string; readonly filename: string; readonly kind: 'text'; readonly url: string; readonly text: string }

interface ArtifactScopeState {
  readonly accountId: string | undefined
  readonly contextKey: string | undefined
}

/** 资料右栏的服务器状态和短期交互状态。 */
export type XAgentArtifactState = ArtifactScopeState & (
  | { readonly phase: 'empty' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'unavailable'; readonly error: string }
  | {
    readonly phase: 'ready'
    readonly items: readonly XAgentArtifactSummary[]
    readonly selectedId: string | undefined
    readonly detail?: XAgentArtifactDetail | undefined
    readonly detailLoading?: boolean | undefined
    readonly preview?: XAgentArtifactPreviewState | undefined
    readonly upload?: XAgentArtifactUploadState | undefined
    readonly uploadError?: string | undefined
    readonly detailError?: string | undefined
  }
)

/** 包内可写、组件只读的资料快照。 */
export class XAgentArtifactStore implements HostObservable<XAgentArtifactState> {
  private state: XAgentArtifactState = { phase: 'empty', accountId: undefined, contextKey: undefined }
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): XAgentArtifactState => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 发布一次完整状态替换。
   * @param state 新的资料状态。
   */
  replace(state: XAgentArtifactState): void {
    this.state = state
    this.listeners.forEach((listener) => { listener() })
  }

  /**
   * 保留当前 ready 范围并替换指定交互字段。
   * @param patch 当前范围的局部资料状态。
   */
  replaceReady(patch: Partial<Omit<Extract<XAgentArtifactState, { phase: 'ready' }>, 'phase' | 'accountId' | 'contextKey'>>): void {
    if (this.state.phase !== 'ready') return
    this.replace({ ...this.state, ...patch })
  }
}
