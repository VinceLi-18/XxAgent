import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@xagent/dsh-ui-project/client'
import factRemote from '@xagent/dsh-fact/remote'
import type { XAgentFactEvidence } from '@xagent/dsh-fact/types'
import type { XAgentArtifactCitationOpener } from '@xagent/dsh-ui-artifact/client'
import type { XAgentFactUiRelationships } from '../relationships.ts'
import { FactPanel, type FactPanelInjected } from './FactPanel.tsx'
import { FactToolCard } from './FactToolCard.tsx'
import { XAgentFactController, type XAgentFactRemoteClient, type XAgentFactScope } from './service.ts'

interface Observable<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
interface WorkbenchState {
  readonly phase: string
  readonly switching: boolean
  readonly accountId?: string
  readonly account?: { readonly id: string; readonly role: 'manager' | 'specialist' }
  readonly context?: { readonly kind: 'workbench' } | { readonly kind: 'project'; readonly projectId: string }
  readonly sessionScopes?: readonly ({ readonly sessionId: string; readonly visibility: 'private' } | { readonly sessionId: string; readonly visibility: 'project'; readonly projectId: string })[]
}
interface WorkbenchBridge {
  readonly snapshot: Observable<WorkbenchState>
  readonly details: Observable<string>
}
interface ConnectionBridge { readonly hostDescription: Observable<unknown> }

/** Fact UI dependencies: live scope sources, generated Remote, Slot registry, and Artifact opener. */
export const inject = ['slots', 'remote', 'sessions', 'connection', 'xagentWorkbench', 'xagentArtifactCitationOpener']

/** Mount the generated Remote and own the Fact panel and `propose_fact` ToolView effects. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(factRemote)
  const feature = ctx.inject(['remote.xagentFact'], (scope: ClientContext) => {
    const remote = scope.get('remote.xagentFact') as XAgentFactRemoteClient
    const workbench = scope.get('xagentWorkbench') as unknown as WorkbenchBridge
    const sessions = scope.get('sessions') as ISessions
    const connection = (scope as ClientContext & { connection: ConnectionBridge }).connection
    const artifact = scope.get('xagentArtifactCitationOpener') as XAgentArtifactCitationOpener
    const controller = new XAgentFactController(remote, artifact)
    const sync = (): void => {
      const account = workbench.snapshot.getSnapshot()
      const sessionId = sessions.list.getSnapshot().current
      const projectId = account.context?.kind === 'project' ? account.context.projectId : undefined
      if (connection.hostDescription.getSnapshot() === undefined || workbench.details.getSnapshot() !== 'facts'
        || account.phase !== 'ready' || account.switching || account.accountId === undefined || account.account === undefined
        || projectId === undefined || sessionId === undefined) {
        controller.clear(account.accountId)
        return
      }
      const sessionScope = account.sessionScopes?.find(item => item.sessionId === sessionId)
      if (sessionScope?.visibility !== 'project' || sessionScope.projectId !== projectId) {
        controller.clear(account.accountId)
        return
      }
      const next: XAgentFactScope = {
        accountId: account.accountId, actorId: account.account.id, role: account.account.role, projectId, sessionId,
      }
      void controller.setScope(next)
    }
    scope.effect(() => workbench.snapshot.subscribe(sync), 'xagent facts: follow account and Project scope')
    scope.effect(() => workbench.details.subscribe(sync), 'xagent facts: follow details tab')
    scope.effect(() => sessions.list.subscribe(sync), 'xagent facts: follow current Session')
    scope.effect(() => connection.hostDescription.subscribe(sync), 'xagent facts: follow connected generation')
    const panelEntry = scope.slots.register({
      name: 'xagent.workbench.facts', registrant: 'xagent-fact-panel',
      inject: (): FactPanelInjected => ({
        hooks: { facts: controller.snapshot },
        selectHead: id => controller.selectHead(id), selectProposal: id => controller.selectProposal(id),
        loadMoreHeads: () => controller.loadMoreHeads(), loadMoreProposals: () => controller.loadMoreProposals(),
        approve: (id, note) => controller.approve(id, note), reject: (id, reason) => controller.reject(id, reason),
        withdraw: id => controller.withdraw(id), retryDecision: () => controller.retryDecision(),
        openEvidence: (sessionId: string, evidence: XAgentFactEvidence) => controller.openEvidence(sessionId, evidence),
      }),
    }, FactPanel)
    scope.effect(() => panelEntry, 'xagent facts: contribute Project details panel')
    const toolEntry = scope.slots.register({ name: 'tool.call.toolview', key: 'propose_fact', registrant: 'xagent-fact-proposal' }, FactToolCard)
    scope.effect(() => toolEntry, 'xagent facts: contribute propose_fact ToolView')
    const relationships: XAgentFactUiRelationships = { issue: () => {
      const panel = scope.slots.entries('xagent.workbench.facts').find(entry => entry.registrant === 'xagent-fact-panel')
      if (panel?.component !== FactPanel) return 'Fact workbench Slot occupant is not live'
      const tool = scope.slots.entries('tool.call.toolview').find(entry => entry.registrant === 'xagent-fact-proposal')
      if (tool?.component !== FactToolCard) return 'propose_fact ToolView renderer is not live'
      const injected = panel.inject?.() as FactPanelInjected | undefined
      if (injected?.hooks.facts !== controller.snapshot) return 'Fact Slot does not expose its controller snapshot'
      return controller.relationshipIssue(remote)
    } }
    scope.provide('xagentFactUiRelationships', relationships)
    sync()
    return () => controller.dispose()
  })
  const dispose = async (): Promise<void> => {
    await feature.dispose()
    await disposeRemote()
  }
  try { await feature.await() } catch (error) { await dispose(); throw error }
  return dispose
}

export { FactPanel, FactToolCard, XAgentFactController }
export type { XAgentFactRemoteClient, XAgentFactScope } from './service.ts'
export type { XAgentFactState } from './store.ts'
