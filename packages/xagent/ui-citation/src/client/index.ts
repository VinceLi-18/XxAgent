import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import citationRemote from '@xagent/dsh-retrieval/remote'
import type { XAgentArtifactCitationOpener } from '@xagent/dsh-ui-artifact/client'
import { CitedAnswerView, type CitedAnswerInjected } from './CitedAnswerView.tsx'
import { XAgentCitationController, type XAgentCitationRemoteClient } from './service.ts'

interface WorkbenchBridge {
  readonly snapshot: {
    getSnapshot(): { readonly phase: string; readonly switching: boolean; readonly accountId?: string }
    subscribe(listener: () => void): () => void
  }
}

/** Citation UI 依赖当前 Session、认证工作台、Artifact opener 和 ToolView Slot。 */
export const inject = ['slots', 'sessions', 'remote', 'xagentWorkbench', 'xagentArtifactCitationOpener']

/** 挂载 citation Remote 并接管 `submit_cited_answer` 的结构化 ToolView。 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(citationRemote)
  const feature = ctx.inject(['remote.xagentCitation'], (scope: ClientContext) => {
    const workbench = (scope as ClientContext & { xagentWorkbench: WorkbenchBridge }).xagentWorkbench
    const sessions = scope.get('sessions') as ISessions
    const artifact = scope.get('xagentArtifactCitationOpener') as XAgentArtifactCitationOpener & { cancelCitation(): void }
    const controller = new XAgentCitationController(
      scope.get('remote.xagentCitation') as XAgentCitationRemoteClient,
      artifact,
      () => { artifact.cancelCitation() },
    )
    const sync = (): void => {
      const account = workbench.snapshot.getSnapshot()
      const sessionId = sessions.list.getSnapshot().current
      controller.setScope(account.phase === 'ready' && !account.switching ? account.accountId : undefined,
        sessionId === undefined ? undefined : String(sessionId))
    }
    scope.effect(() => workbench.snapshot.subscribe(sync), 'xagent citations: follow account scope')
    scope.effect(() => sessions.list.subscribe(sync), 'xagent citations: follow Session scope')
    sync()
    scope.slots.inject('tool.call.toolview', () => scope.slots.register({
      name: 'tool.call.toolview', key: 'submit_cited_answer', registrant: 'xagent-cited-answer',
      inject: (): CitedAnswerInjected => ({
        sessionId: String(sessions.list.getSnapshot().current ?? ''),
        openCitation: (sessionId, citationId) => controller.open(sessionId, citationId),
        cancelCitation: (sessionId) => { controller.cancel(sessionId) },
      }),
    }, CitedAnswerView))
    return () => controller.dispose()
  })
  try {
    await feature.await()
  } catch (error) {
    await feature.dispose(); await disposeRemote(); throw error
  }
  return async () => { await feature.dispose(); await disposeRemote() }
}

export { CitedAnswerView, XAgentCitationController }
export type { XAgentCitationRemoteClient }
