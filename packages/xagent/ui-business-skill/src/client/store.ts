/** Project-scoped Business Skill snapshots; no browser persistence. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { XAgentBusinessSkillDetail, XAgentBusinessSkillSummary } from '@xagent/dsh-backend-client/types'
import type { BusinessSkillRemoteTranscript } from '@xagent/dsh-business-skill/types'

/** Live account, project and physical connection that own all retained content. */
export interface BusinessSkillScope {
  readonly accountId: string
  readonly projectId: string
  readonly sessionId: string
  readonly role: 'manager' | 'specialist'
  readonly generation: unknown
}

/** Observable server records and pending UI operations for one scope. */
export type BusinessSkillState =
  | { readonly phase: 'empty' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly error: string }
  | {
    readonly phase: 'ready'
    readonly scope: BusinessSkillScope
    readonly items: readonly XAgentBusinessSkillSummary[]
    readonly cursor?: string | undefined
    readonly selected?: string | undefined
    readonly detail?: XAgentBusinessSkillDetail | undefined
    readonly detailLoading?: boolean | undefined
    readonly action?: 'submitting' | 'uncertain' | undefined
    readonly error?: string | undefined
    readonly blocked?: boolean | undefined
    readonly transcript?: BusinessSkillRemoteTranscript | undefined
  }

/** Memory-only observable; disposal closes listeners before cancellation settles. */
export class BusinessSkillStore implements HostObservable<BusinessSkillState> {
  private state: BusinessSkillState = { phase: 'empty' }
  private readonly listeners = new Set<() => void>()
  readonly getSnapshot = (): BusinessSkillState => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Publish a complete replacement while containing observer failures.
   * @param state Current in-memory records.
   */
  replace(state: BusinessSkillState): void {
    this.state = state
    for (const listener of this.listeners) {
      try { listener() } catch (error) { console.error('[xagent-ui-business-skill] subscriber threw:', error) }
    }
  }

  /** Update a ready snapshot without reviving a cleared scope.
   * @param patch Records and operation state to replace.
   */
  patch(patch: Partial<Extract<BusinessSkillState, { phase: 'ready' }>>): void {
    if (this.state.phase === 'ready') this.replace({ ...this.state, ...patch })
  }

  /** Forget all content and subscriptions at plugin disposal. */
  dispose(): void { this.listeners.clear(); this.state = { phase: 'empty' } }
}
