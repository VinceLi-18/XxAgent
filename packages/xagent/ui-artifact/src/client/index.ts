import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@xagent/dsh-ui-project/client'
import artifactRemote from '@xagent/dsh-artifact/remote'
import { ArtifactPanel, type ArtifactPanelInjected } from './ArtifactPanel.tsx'
import { XAgentArtifactController, type XAgentArtifactRemoteClient } from './service.ts'

export type { XAgentArtifactState } from './store.ts'
export type { XAgentArtifactCitationOpener, XAgentArtifactRemoteClient } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Citation UI 可调用的不可变 Artifact 导航入口。 */
    xagentArtifactCitationOpener: import('./service.ts').XAgentArtifactCitationOpener
  }
}

interface WorkbenchSnapshot {
  readonly phase: 'empty' | 'loading' | 'ready' | 'unavailable'
  readonly accountId?: string | undefined
  readonly switching: boolean
  readonly context?: { readonly kind: 'workbench' } | { readonly kind: 'project'; readonly projectId: string }
}

interface WorkbenchBridge {
  readonly snapshot: {
    getSnapshot(): WorkbenchSnapshot
    subscribe(listener: () => void): () => void
  }
}

/** 资料 UI 依赖项目工作台、Slot 与生成式 Remote 装配服务。 */
export const inject = ['slots', 'remote', 'sessions', 'xagentWorkbench']

/** 挂载 Artifact Remote，并把资料面板贡献到项目工作台子 Slot。 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(artifactRemote)
  const feature = ctx.inject(['remote.xagentArtifact'], (scope: ClientContext) => {
    const remote = scope.get('remote.xagentArtifact') as XAgentArtifactRemoteClient
    const workbench = (scope as ClientContext & { xagentWorkbench: WorkbenchBridge }).xagentWorkbench
    const controller = new XAgentArtifactController(remote)
    scope.provide('xagentArtifactCitationOpener', controller)
    const sessions = scope.get('sessions') as ISessions
    let sessionId = sessions.list.getSnapshot().current
    scope.effect(() => sessions.list.subscribe(() => {
      const next = sessions.list.getSnapshot().current
      if (next === sessionId) return
      sessionId = next
      controller.cancelCitation()
    }), 'xagent artifacts: cancel citation navigation on Session change')

    const sync = () => {
      const state = workbench.snapshot.getSnapshot()
      if (state.phase !== 'ready' || state.switching) {
        controller.clear(state.accountId)
        return
      }
      void controller.setScope(state.accountId, state.context)
    }
    scope.effect(() => workbench.snapshot.subscribe(sync), 'xagent artifacts: follow account and project scope')
    sync()

    scope.slots.inject('xagent.workbench.artifacts', () => scope.slots.register({
      name: 'xagent.workbench.artifacts',
      registrant: 'xagent-artifact-panel',
      inject: (): ArtifactPanelInjected => ({
        hooks: { artifacts: controller.snapshot },
        selectArtifact: artifactId => controller.selectArtifact(artifactId),
        backToList: () => { controller.backToList() },
        upload: file => controller.upload(file),
        uploadNewVersion: file => controller.uploadNewVersion(file),
        retry: versionId => controller.retry(versionId),
        openPreview: versionId => controller.openPreview(versionId),
        closePreview: () => { controller.closePreview() },
        download: versionId => controller.download(versionId),
      }),
    }, ArtifactPanel))
    return () => controller.dispose()
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
