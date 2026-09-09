import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  XAgentFactEvidence,
  XAgentFactPage,
  XAgentFactProposal,
  XAgentFactProposalDecision,
  XAgentFactRevision,
  XAgentFactRevisionDetail,
} from '@xagent/dsh-fact/types'
import { mergeFactRows, rowsMatchProject } from './collections.ts'
import {
  canSubmitFactDecision,
  submitFactDecision,
  type XAgentFactDecisionKind,
  type XAgentFactDecisionRequest,
} from './decision.ts'
import { XAgentFactStore, type XAgentFactState } from './store.ts'

const PAGE_LIMIT = 50

type ReadyState = Extract<XAgentFactState, { phase: 'ready' }>

interface Operation {
  readonly controller: AbortController
  readonly epoch: number
  readonly scope: XAgentFactScope
}

/** Browser-visible server scope required for governed Fact reads. */
export interface XAgentFactScope {
  readonly accountId: string
  readonly actorId: string
  readonly role: 'manager' | 'specialist'
  readonly projectId: string
  readonly sessionId: string
}

/** Generated Fact Remote namespace consumed by the browser controller. */
export interface XAgentFactRemoteClient {
  'list-heads'(
    sessionId: string, input: { readonly limit: number; readonly cursor?: string }, signal?: AbortSignal,
  ): Promise<RemoteResult<XAgentFactPage<XAgentFactRevision>>>
  'list-proposals'(
    sessionId: string, input: { readonly limit: number; readonly cursor?: string }, signal?: AbortSignal,
  ): Promise<RemoteResult<XAgentFactPage<XAgentFactProposal>>>
  revision(sessionId: string, revisionId: string, signal?: AbortSignal): Promise<RemoteResult<XAgentFactRevisionDetail>>
  proposal(sessionId: string, proposalId: string, signal?: AbortSignal): Promise<RemoteResult<XAgentFactProposal>>
  approve(
    sessionId: string, proposalId: string, input: { readonly idempotencyKey: string; readonly decisionNote?: string },
    signal?: AbortSignal,
  ): Promise<RemoteResult<XAgentFactProposalDecision>>
  reject(
    sessionId: string, proposalId: string, input: { readonly idempotencyKey: string; readonly reason: string }, signal?: AbortSignal,
  ): Promise<RemoteResult<XAgentFactProposalDecision>>
  withdraw(
    sessionId: string, proposalId: string, input: { readonly idempotencyKey: string }, signal?: AbortSignal,
  ): Promise<RemoteResult<XAgentFactProposalDecision>>
}

/** Existing Artifact panel navigation action. */
export interface XAgentFactEvidenceOpener {
  openCitation(target: {
    readonly artifactId: string
    readonly versionId: string
    readonly lineStart: number
    readonly lineEnd: number
  }): Promise<void>
}

/** Cancellable in-memory owner for one Project Session Fact view. */
export class XAgentFactController {
  /** Observable memory state injected into the Fact Slot occupant. */
  readonly snapshot = new XAgentFactStore()
  private scope: XAgentFactScope | undefined
  private epoch = 0
  private disposed = false
  private disposal: Promise<void> | undefined
  private readonly controllers = new Set<AbortController>()
  private readonly tasks = new Set<Promise<void>>()
  private headsTask: Promise<void> | undefined
  private proposalsTask: Promise<void> | undefined
  private detailController: AbortController | undefined
  private decisionController: AbortController | undefined
  private retry: XAgentFactDecisionRequest | undefined

  constructor(
    private readonly remote: XAgentFactRemoteClient,
    private readonly evidence: XAgentFactEvidenceOpener,
    private readonly idempotencyKey: () => string = () => crypto.randomUUID(),
  ) {}

  /** Report whether this controller still owns the mounted Remote identity.
   * @param remote Currently mounted Fact Remote identity.
   * @returns A relationship failure, or undefined while ownership matches.
   */
  relationshipIssue(remote: XAgentFactRemoteClient): string | undefined {
    return this.remote === remote ? undefined : 'Fact controller does not own the mounted Remote client'
  }

  /** Adopt one exact Project Session scope and load both first pages.
   * @param scope Authorized account, actor, Project, and Session identities.
   */
  setScope(scope: XAgentFactScope): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.sameScope(scope) && this.snapshot.getSnapshot().phase !== 'unavailable') return Promise.resolve()
    return this.track(this.loadScope(scope))
  }

  /** Clear prior scope state synchronously and abort every owned request.
   * @param accountId Account identity retained for diagnostics, when known.
   */
  clear(accountId?: string): void {
    if (this.disposed) return
    this.invalidate()
    this.snapshot.replace({ phase: 'empty', accountId })
  }

  /** Append the next server-ordered current-head page once. */
  loadMoreHeads(): Promise<void> {
    if (this.headsTask !== undefined) return this.headsTask
    const task = this.track(this.loadPage('heads')).finally(() => {
      if (this.headsTask === task) this.headsTask = undefined
    })
    this.headsTask = task
    return task
  }

  /** Append the next server-ordered proposal page once. */
  loadMoreProposals(): Promise<void> {
    if (this.proposalsTask !== undefined) return this.proposalsTask
    const task = this.track(this.loadPage('proposals')).finally(() => {
      if (this.proposalsTask === task) this.proposalsTask = undefined
    })
    this.proposalsTask = task
    return task
  }

  /** Read one immutable revision and its newest-first history.
   * @param revisionId Selected immutable revision identity.
   */
  selectHead(revisionId: string): Promise<void> {
    return this.track(this.loadDetail('revision', revisionId))
  }

  /** Reauthorize and read one proposal.
   * @param proposalId Selected proposal identity.
   */
  selectProposal(proposalId: string): Promise<void> {
    return this.track(this.loadDetail('proposal', proposalId))
  }

  /** Start one manager approval intent with a fresh idempotency key.
   * @param proposalId Pending proposal identity.
   * @param decisionNote Optional manager note; surrounding whitespace is removed.
   */
  approve(proposalId: string, decisionNote: string): Promise<void> {
    if (!this.canDecide(proposalId, 'approve')) return Promise.resolve()
    const normalized = decisionNote.trim()
    return this.startDecision({
      kind: 'approve', proposalId, idempotencyKey: this.idempotencyKey(),
      ...(normalized.length === 0 ? {} : { decisionNote: normalized }),
    })
  }

  /** Start one manager rejection intent with a fresh idempotency key.
   * @param proposalId Pending proposal identity.
   * @param reason Required manager rejection reason.
   */
  reject(proposalId: string, reason: string): Promise<void> {
    if (!this.canDecide(proposalId, 'reject')) return Promise.resolve()
    const normalized = reason.trim()
    if (normalized.length === 0) {
      this.snapshot.replaceReady({ decisionError: '请输入拒绝理由' })
      return Promise.resolve()
    }
    return this.startDecision({ kind: 'reject', proposalId, idempotencyKey: this.idempotencyKey(), reason: normalized })
  }

  /** Start one proposer withdrawal intent with a fresh idempotency key.
   * @param proposalId Pending proposal identity.
   */
  withdraw(proposalId: string): Promise<void> {
    if (!this.canDecide(proposalId, 'withdraw')) return Promise.resolve()
    return this.startDecision({ kind: 'withdraw', proposalId, idempotencyKey: this.idempotencyKey() })
  }

  /** Retry only the uncertain request, retaining its exact key and fields. */
  retryDecision(): Promise<void> {
    return this.retry === undefined ? Promise.resolve() : this.startDecision(this.retry, true)
  }

  /** Gate exact evidence navigation to the current Session and loaded detail.
   * @param sessionId Session identity captured by the rendered evidence action.
   * @param candidate Complete evidence identity captured by the rendered action.
   */
  openEvidence(sessionId: string, candidate: XAgentFactEvidence): Promise<void> {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready' || state.sessionId !== sessionId || !this.detailEvidence(state).some(item => this.sameEvidence(item, candidate))) {
      return Promise.resolve()
    }
    return this.track(this.evidence.openCitation({
      artifactId: candidate.artifactId,
      versionId: candidate.versionId,
      lineStart: candidate.lineStart,
      lineEnd: candidate.lineEnd,
    }))
  }

  /** Reject new work, clear published state, abort owners, and await quiescence. */
  dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true
      this.invalidate()
      this.snapshot.replace({ phase: 'empty', accountId: undefined })
    }
    return this.disposal ??= this.waitForQuiescence()
  }

  private async loadScope(scope: XAgentFactScope): Promise<void> {
    this.invalidate()
    this.scope = scope
    const epoch = this.epoch
    this.snapshot.replace({ phase: 'loading', accountId: scope.accountId, projectId: scope.projectId, sessionId: scope.sessionId })
    const heads = this.operation(epoch, scope)
    const proposals = this.operation(epoch, scope)
    const results = await Promise.allSettled([
      this.remote['list-heads'](scope.sessionId, { limit: PAGE_LIMIT }, heads.controller.signal),
      this.remote['list-proposals'](scope.sessionId, { limit: PAGE_LIMIT }, proposals.controller.signal),
    ])
    this.finish(heads.controller)
    this.finish(proposals.controller)
    if (this.stale(epoch, scope)) return
    const [headResult, proposalResult] = results
    if (headResult.status !== 'fulfilled' || proposalResult.status !== 'fulfilled'
      || !headResult.value.ok || !proposalResult.value.ok
      || !this.sameProject(headResult.value.value.items, scope.projectId)
      || !this.sameProject(proposalResult.value.value.items, scope.projectId)) {
      this.snapshot.replace({ phase: 'unavailable', accountId: scope.accountId, error: '事实服务暂时不可用' })
      return
    }
    this.snapshot.replace({
      phase: 'ready', ...scope,
      heads: mergeFactRows(headResult.value.value.items),
      proposals: mergeFactRows(proposalResult.value.value.items),
      headsCursor: headResult.value.value.nextCursor,
      proposalsCursor: proposalResult.value.value.nextCursor,
    })
  }

  private async loadPage(kind: 'heads' | 'proposals'): Promise<void> {
    const state = this.snapshot.getSnapshot()
    const cursor = state.phase === 'ready' ? state[`${kind}Cursor`] : undefined
    if (state.phase !== 'ready' || cursor === undefined || this.disposed) return
    const scope = this.scope as XAgentFactScope
    const operation = this.operation(this.epoch, scope)
    this.snapshot.replaceReady({ [`${kind}Loading`]: true, listError: undefined })
    try {
      const result = kind === 'heads'
        ? await this.remote['list-heads'](scope.sessionId, { limit: PAGE_LIMIT, cursor }, operation.controller.signal)
        : await this.remote['list-proposals'](scope.sessionId, { limit: PAGE_LIMIT, cursor }, operation.controller.signal)
      /* v8 ignore else -- V8 reports a synthetic empty else after tested stale and fresh paths. */
      if (this.staleOperation(operation)) return
      if (!result.ok || !this.sameProject(result.value.items, scope.projectId)) {
        this.snapshot.replaceReady({ [`${kind}Loading`]: false, listError: '无法加载更多事实' })
        return
      }
      const current = this.snapshot.getSnapshot() as ReadyState
      this.snapshot.replaceReady({
        [kind]: mergeFactRows([...current[kind], ...result.value.items]),
        [`${kind}Cursor`]: result.value.nextCursor,
        [`${kind}Loading`]: false,
      })
    } catch {
      if (!this.staleOperation(operation)) this.snapshot.replaceReady({ [`${kind}Loading`]: false, listError: '无法加载更多事实' })
    } finally {
      this.finish(operation.controller)
    }
  }

  private async loadDetail(kind: 'revision' | 'proposal', id: string): Promise<void> {
    const state = this.snapshot.getSnapshot()
    const scope = this.scope
    if (state.phase !== 'ready' || scope === undefined || this.disposed) return
    this.detailController?.abort()
    const operation = this.operation(this.epoch, scope)
    this.detailController = operation.controller
    this.snapshot.replaceReady({ selection: { kind, id }, detail: undefined, detailLoading: true, detailError: undefined })
    try {
      const detail = kind === 'revision'
        ? await this.loadRevisionValue(scope, id, operation.controller.signal)
        : await this.loadProposalValue(scope, id, operation.controller.signal)
      if (this.staleOperation(operation) || this.detailController !== operation.controller) return
      if (detail === undefined) {
        this.snapshot.replaceReady({ detailLoading: false, detailError: '事实详情暂时不可用' })
        return
      }
      this.snapshot.replaceReady({ detail, detailLoading: false, detailError: undefined })
    } catch {
      if (!this.staleOperation(operation) && this.detailController === operation.controller) {
        this.snapshot.replaceReady({ detailLoading: false, detailError: '事实详情暂时不可用' })
      }
    } finally {
      if (this.detailController === operation.controller) this.detailController = undefined
      this.finish(operation.controller)
    }
  }

  private async loadRevisionValue(scope: XAgentFactScope, id: string, signal: AbortSignal): Promise<ReadyState['detail']> {
    const result = await this.remote.revision(scope.sessionId, id, signal)
    if (!result.ok || result.value.revision.id !== id || result.value.revision.projectId !== scope.projectId
      || !result.value.history.every(item => item.projectId === scope.projectId
        && item.fieldKey === result.value.revision.fieldKey)) return undefined
    return { kind: 'revision', value: result.value }
  }

  private async loadProposalValue(scope: XAgentFactScope, id: string, signal: AbortSignal): Promise<ReadyState['detail']> {
    const result = await this.remote.proposal(scope.sessionId, id, signal)
    return result.ok && result.value.id === id && result.value.projectId === scope.projectId
      ? { kind: 'proposal', value: result.value }
      : undefined
  }

  private startDecision(request: XAgentFactDecisionRequest, retry = false): Promise<void> {
    if (!retry) this.retry = undefined
    return this.track(this.performDecision(request))
  }

  private async performDecision(request: XAgentFactDecisionRequest): Promise<void> {
    const scope = this.scope as XAgentFactScope
    this.decisionController?.abort()
    const operation = this.operation(this.epoch, scope)
    this.decisionController = operation.controller
    this.snapshot.replaceReady({
      action: { phase: 'submitting', kind: request.kind, proposalId: request.proposalId },
      decisionError: undefined,
    })
    let result: RemoteResult<XAgentFactProposalDecision>
    try {
      result = await submitFactDecision(this.remote, scope.sessionId, request, operation.controller.signal)
    } catch {
      if (!this.staleOperation(operation)) this.publishUncertain(request)
      this.finishDecision(operation.controller)
      return
    }
    if (this.staleOperation(operation)) { this.finishDecision(operation.controller); return }
    if (!result.ok) {
      if (result.error.code === 'service-unavailable') {
        this.publishUncertain(request)
      } else if (result.error.code === 'stale-permission' || result.error.code === 'unauthenticated'
        || result.error.code === 'not-found') {
        this.retry = undefined
        this.snapshot.replaceReady({ action: undefined, permissionBlocked: true, decisionError: '权限已变更，请重新加载当前工作范围' })
      } else {
        this.retry = undefined
        await this.refreshAfterDecision(request.proposalId, operation)
        if (!this.staleOperation(operation)) this.snapshot.replaceReady({
          action: undefined,
          decisionError: result.error.code === 'fact-revision-conflict'
            ? '当前事实已更新，该提案已标记冲突'
            : '该提案已被处理，状态已刷新',
        })
      }
      this.finishDecision(operation.controller)
      return
    }
    this.retry = undefined
    await this.refreshAfterDecision(request.proposalId, operation)
    if (!this.staleOperation(operation)) this.snapshot.replaceReady({ action: undefined })
    this.finishDecision(operation.controller)
  }

  private async refreshAfterDecision(proposalId: string, operation: Operation): Promise<void> {
    const state = this.snapshot.getSnapshot() as ReadyState
    const detailRequest = state.selection?.kind === 'revision'
      ? this.remote.revision(operation.scope.sessionId, state.selection.id, operation.controller.signal)
      : this.remote.proposal(operation.scope.sessionId, proposalId, operation.controller.signal)
    const [heads, proposals, detail] = await Promise.allSettled([
      this.remote['list-heads'](operation.scope.sessionId, { limit: PAGE_LIMIT }, operation.controller.signal),
      this.remote['list-proposals'](operation.scope.sessionId, { limit: PAGE_LIMIT }, operation.controller.signal),
      detailRequest,
    ])
    if (this.staleOperation(operation)) return
    const detailValue = detail.status === 'fulfilled' && detail.value.ok ? detail.value.value : undefined
    const detailKind = state.selection?.kind === 'revision' ? 'revision' : 'proposal'
    this.snapshot.replaceReady({
      ...(heads.status === 'fulfilled' && heads.value.ok && this.sameProject(heads.value.value.items, operation.scope.projectId)
        ? { heads: mergeFactRows(heads.value.value.items), headsCursor: heads.value.value.nextCursor } : {}),
      ...(proposals.status === 'fulfilled' && proposals.value.ok && this.sameProject(proposals.value.value.items, operation.scope.projectId)
        ? { proposals: mergeFactRows(proposals.value.value.items), proposalsCursor: proposals.value.value.nextCursor } : {}),
      ...(detailValue === undefined ? {} : { detail: { kind: detailKind, value: detailValue } as ReadyState['detail'] }),
    })
  }

  private publishUncertain(request: XAgentFactDecisionRequest): void {
    this.retry = request
    this.snapshot.replaceReady({
      action: { phase: 'uncertain', kind: request.kind, proposalId: request.proposalId },
      decisionError: '服务响应中断，请使用原请求重试以确认结果',
    })
  }

  private canDecide(proposalId: string, kind: XAgentFactDecisionKind): boolean {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready' || state.permissionBlocked || state.action !== undefined) return false
    const candidate = state.detail?.kind === 'proposal' && state.detail.value.id === proposalId
      ? state.detail.value
      : state.proposals.find(item => item.id === proposalId)
    return canSubmitFactDecision(candidate, kind, state.actorId, state.role)
  }

  private detailEvidence(state: ReadyState): readonly XAgentFactEvidence[] {
    if (state.detail?.kind === 'proposal') return state.detail.value.evidence
    return state.detail?.value.revision.evidence ?? []
  }

  private sameEvidence(left: XAgentFactEvidence, right: XAgentFactEvidence): boolean {
    return left.citationId === right.citationId && left.artifactId === right.artifactId && left.versionId === right.versionId
      && left.indexId === right.indexId && left.indexGeneration === right.indexGeneration && left.chunkId === right.chunkId
      && left.lineStart === right.lineStart && left.lineEnd === right.lineEnd
  }

  private sameProject(items: readonly { readonly projectId: string }[], projectId: string): boolean {
    return rowsMatchProject(items, projectId)
  }

  private sameScope(scope: XAgentFactScope): boolean {
    const current = this.scope
    return current !== undefined && current.accountId === scope.accountId && current.actorId === scope.actorId
      && current.role === scope.role && current.projectId === scope.projectId && current.sessionId === scope.sessionId
  }

  private operation(epoch: number, scope: XAgentFactScope): Operation {
    const controller = new AbortController()
    this.controllers.add(controller)
    return { controller, epoch, scope }
  }

  private finish(controller: AbortController): void {
    this.controllers.delete(controller)
  }

  private finishDecision(controller: AbortController): void {
    this.decisionController = undefined
    this.finish(controller)
  }

  private stale(epoch: number, scope: XAgentFactScope): boolean {
    return this.disposed || epoch !== this.epoch || !this.sameScope(scope)
  }

  private staleOperation(operation: Operation): boolean {
    return operation.controller.signal.aborted || this.stale(operation.epoch, operation.scope)
  }

  private invalidate(): void {
    ++this.epoch
    this.scope = undefined
    this.retry = undefined
    this.headsTask = undefined
    this.proposalsTask = undefined
    this.detailController = undefined
    this.decisionController = undefined
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
  }

  private track(task: Promise<void>): Promise<void> {
    this.tasks.add(task)
    void task.finally(() => { this.tasks.delete(task) })
    return task
  }

  private async waitForQuiescence(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks])
  }
}
