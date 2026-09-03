import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { XAgentCitationTarget } from '@xagent/dsh-retrieval/types'
import type { XAgentArtifactCitationOpener } from '@xagent/dsh-ui-artifact/client'

/** Browser 调用的 citation Remote 最小接口。 */
export interface XAgentCitationRemoteClient {
  resolve(sessionId: string, citationId: string, signal?: AbortSignal): Promise<RemoteResult<XAgentCitationTarget>>
}

interface ActiveResolution {
  readonly controller: AbortController
  readonly epoch: number
  readonly task: Promise<void>
}

/** 单账号、单 Session citation resolution 控制器。 */
export class XAgentCitationController {
  private accountId: string | undefined
  private sessionId: string | undefined
  private epoch = 0
  private active: ActiveResolution | undefined
  private artifactActive = false
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly remote: XAgentCitationRemoteClient,
    private readonly artifact: XAgentArtifactCitationOpener,
    private readonly cancelArtifactCitation: () => void,
  ) {}

  /**
   * 采用当前认证账号和 Session；变化会取消旧 resolution。
   * @param accountId 当前认证账号。
   * @param sessionId 当前顶层 Session。
   */
  setScope(accountId: string | undefined, sessionId: string | undefined): void {
    if (this.disposed || (this.accountId === accountId && this.sessionId === sessionId)) return
    this.cancelActive()
    ++this.epoch
    this.accountId = accountId
    this.sessionId = sessionId
  }

  /**
   * 解析当前 Session 的一个已持久化 citation 并交给 Artifact 面板。
   * @param sessionId ToolView 所属 Session。
   * @param citationId 已验证资料短 ID。
   */
  open(sessionId: string, citationId: string): Promise<void> {
    if (this.disposed || this.accountId === undefined || this.sessionId !== sessionId) return Promise.resolve()
    this.cancelActive()
    const controller = new AbortController()
    const epoch = this.epoch
    const task = (async () => {
      try {
        const result = await this.remote.resolve(sessionId, citationId, controller.signal)
        if (controller.signal.aborted || this.disposed || epoch !== this.epoch || this.sessionId !== sessionId || !result.ok) return
        this.artifactActive = true
        await this.artifact.openCitation(result.value)
      } catch {
        // Remote 失败与取消都保持关闭；服务端诊断不能进入对话 UI。
      }
    })()
    this.active = { controller, epoch, task }
    void task.finally(() => { if (this.active?.task === task) this.active = undefined })
    return task
  }

  /**
   * 取消正在卸载的 ToolView 所属 resolution。
   * @param sessionId 正在卸载的 ToolView Session。
   */
  cancel(sessionId: string): void {
    if (this.sessionId === sessionId) this.cancelActive()
  }

  /**
   * 永久封闭控制器并等待在途 resolution 收敛。
   * @returns 所有已取消 resolution 收敛后的 Promise。
   */
  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.disposed = true
      const task = this.active?.task
      this.cancelActive()
      ++this.epoch
      if (task !== undefined) await task
    })()
    return this.disposal
  }

  private cancelActive(): void {
    this.active?.controller.abort()
    this.active = undefined
    if (this.artifactActive) {
      this.artifactActive = false
      this.cancelArtifactCitation()
    }
  }
}
