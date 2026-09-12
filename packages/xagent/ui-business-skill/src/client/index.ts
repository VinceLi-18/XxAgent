/** Generated Remote and single project Skills Slot assembly. */
import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type { IXAgentWorkbench } from '@xagent/dsh-ui-project/client'
import businessSkillRemote from '@xagent/dsh-business-skill/remote'
import type { BusinessSkillUiRelationships } from '../relationships.ts'
import { BusinessSkillController, type BusinessSkillRemote } from './service.ts'
import { BusinessSkillPanel, type BusinessSkillPanelInjected } from './BusinessSkillPanel.tsx'

/** Account/project, connection and Session changes invalidate governance content. */
export const inject = ['slots', 'remote', 'sessions', 'connection', 'xagentWorkbench']

/** Own the generated namespace, controller and Slot until plugin disposal.
 * @param ctx Browser plugin context with the current project services.
 * @returns Cleanup that drains cancelled requests and unmounts the Remote.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(businessSkillRemote)
  const feature = ctx.inject(['remote.xagentBusinessSkill'], (scope: ClientContext) => {
    const remote = scope.get('remote.xagentBusinessSkill') as BusinessSkillRemote
    const workbench = scope.get('xagentWorkbench') as IXAgentWorkbench
    const sessions = scope.get('sessions') as unknown as ISessions
    const connection = scope.get('connection') as unknown as { hostDescription: { getSnapshot(): unknown; subscribe(listener: () => void): () => void } }
    const controller = new BusinessSkillController(remote)
    const sync = (): void => {
      const state = workbench.snapshot.getSnapshot()
      const current = sessions.list.getSnapshot().current
      const generation = connection.hostDescription.getSnapshot()
      if (scope.slots.spec('xagent.workbench.skills') === undefined) { controller.clear(); return }
      if (state.phase !== 'ready' || state.switching || state.context.kind !== 'project' || current === undefined
        || generation === undefined || workbench.details.getSnapshot() !== 'skills') { controller.clear(); return }
      const projectId = state.context.projectId
      if (!state.sessionScopes.some(session => session.sessionId === current && session.visibility === 'project' && session.projectId === projectId)) {
        controller.clear(); return
      }
      void controller.setScope({ accountId: state.accountId, projectId, sessionId: current, role: state.account.role, generation })
    }
    scope.effect(() => workbench.snapshot.subscribe(sync), 'business skills: current account and project')
    scope.effect(() => workbench.details.subscribe(sync), 'business skills: selected tab')
    scope.effect(() => sessions.list.subscribe(sync), 'business skills: current project Session')
    scope.effect(() => connection.hostDescription.subscribe(sync), 'business skills: physical connection generation')
    scope.slots.inject('xagent.workbench.skills', () => {
      sync()
      const disposePanel = scope.slots.register({
        name: 'xagent.workbench.skills', registrant: 'xagent-business-skill-panel',
        inject: (): BusinessSkillPanelInjected => ({ hooks: { skills: controller.snapshot },
          select: slug => controller.select(slug), refresh: () => controller.refresh(), loadMore: () => controller.loadMore(),
          loadHistory: kind => controller.loadHistory(kind), openTranscript: (run, more) => controller.openTranscript(run, more),
          mutate: request => controller.mutate(request), retryMutation: () => controller.retryMutation(),
        }),
      }, BusinessSkillPanel)
      return () => { controller.clear(); disposePanel() }
    })
    const relationships: BusinessSkillUiRelationships = { issue: () => {
      if (scope.get('remote.xagentBusinessSkill') !== remote) return 'Business Skill controller Remote identity changed'
      const entries = scope.slots.entries('xagent.workbench.skills')
      if (scope.slots.spec('xagent.workbench.skills') === undefined) return undefined
      const panel = entries[0]
      if (entries.length !== 1 || panel?.component !== BusinessSkillPanel) return 'Business Skill Slot must have its single live panel'
      const injected = panel.inject?.() as BusinessSkillPanelInjected | undefined
      if (injected?.hooks.skills !== controller.snapshot) return 'Business Skill Slot snapshot does not belong to its controller'
      return undefined
    } }
    scope.provide('xagentBusinessSkillUiRelationships', relationships)
    sync()
    return () => controller.dispose()
  })
  const dispose = async (): Promise<void> => { await feature.dispose(); await disposeRemote() }
  try { await feature.await() } catch (error) { await dispose(); throw error }
  return dispose
}

export { BusinessSkillPanel, BusinessSkillController }
export type { BusinessSkillRemote, BusinessSkillMutation, BusinessSkillMutationOutcome } from './service.ts'
export type { BusinessSkillScope, BusinessSkillState } from './store.ts'
