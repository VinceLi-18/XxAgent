import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { XAgentFactProposal, XAgentFactRevision, XAgentFactRevisionDetail } from '@xagent/dsh-fact/types'

/** Current in-memory Fact workbench state. */
export type XAgentFactState =
  | { readonly phase: 'empty'; readonly accountId: string | undefined }
  | { readonly phase: 'loading'; readonly accountId: string; readonly projectId: string; readonly sessionId: string }
  | { readonly phase: 'unavailable'; readonly accountId: string; readonly error: string }
  | {
    readonly phase: 'ready'
    readonly accountId: string
    readonly projectId: string
    readonly sessionId: string
    readonly actorId: string
    readonly role: 'manager' | 'specialist'
    readonly heads: readonly XAgentFactRevision[]
    readonly proposals: readonly XAgentFactProposal[]
    readonly headsCursor?: string | undefined
    readonly proposalsCursor?: string | undefined
    readonly headsLoading?: boolean | undefined
    readonly proposalsLoading?: boolean | undefined
    readonly listError?: string | undefined
    readonly selection?: { readonly kind: 'revision' | 'proposal'; readonly id: string } | undefined
    readonly detail?: { readonly kind: 'revision'; readonly value: XAgentFactRevisionDetail } | { readonly kind: 'proposal'; readonly value: XAgentFactProposal } | undefined
    readonly detailLoading?: boolean | undefined
    readonly detailError?: string | undefined
    readonly permissionBlocked?: boolean | undefined
    readonly decisionError?: string | undefined
    readonly action?: { readonly phase: 'submitting' | 'uncertain'; readonly kind: 'approve' | 'reject' | 'withdraw'; readonly proposalId: string } | undefined
  }

/** Observable, memory-only snapshot owned by one Fact controller. */
export class XAgentFactStore implements HostObservable<XAgentFactState> {
  private state: XAgentFactState = { phase: 'empty', accountId: undefined }
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): XAgentFactState => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Replace the complete published snapshot and isolate subscriber failures.
   * @param state Complete memory state to publish.
   */
  replace(state: XAgentFactState): void {
    this.state = state
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[xagent-ui-fact] subscriber threw:', error)
      }
    }
  }

  /** Apply a partial update only while a Project Session remains ready.
   * @param patch Ready-state fields to publish atomically.
   */
  replaceReady(patch: Partial<Omit<Extract<XAgentFactState, { phase: 'ready' }>, 'phase' | 'accountId' | 'projectId' | 'sessionId' | 'actorId' | 'role'>>): void {
    if (this.state.phase !== 'ready') return
    this.replace({ ...this.state, ...patch })
  }
}
