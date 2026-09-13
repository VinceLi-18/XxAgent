/** Cancelled-generation suppression and exact mutation intents for Skill governance. */
import type { TypertRemoteNamespaceMap, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@xagent/dsh-business-skill/remote'
import type { XAgentBusinessSkillCreateInput, XAgentBusinessSkillDraftInput, XAgentBusinessSkillDetail, XAgentBusinessSkillTest } from '@xagent/dsh-backend-client/types'
import { BusinessSkillStore, type BusinessSkillScope, type BusinessSkillState } from './store.ts'

/** Generated browser face; server authorization owns every decision. */
export type BusinessSkillRemote = TypertRemoteNamespaceMap['xagentBusinessSkill']

interface ReadOwner {
  readonly scope: BusinessSkillScope
  readonly slug: string | undefined
  readonly controller: AbortController
  readonly pages: Map<string, AbortController>
}

/** Authoritative mutation settlement; a resolved request alone does not establish success. */
export type BusinessSkillMutationOutcome = 'succeeded' | 'failed' | 'uncertain' | 'cancelled' | 'not-started'

/** Immutable user intent. Retry adds no changed content to an uncertain request. */
export type BusinessSkillMutation =
  | { readonly kind: 'create'; readonly input: Omit<XAgentBusinessSkillCreateInput, 'idempotencyKey'> }
  | { readonly kind: 'draft'; readonly slug: string; readonly input: Omit<XAgentBusinessSkillDraftInput, 'idempotencyKey'> }
  | { readonly kind: 'test'; readonly slug: string; readonly revision: number; readonly policy: string; readonly scenario: string }
  | { readonly kind: 'verdict'; readonly slug: string; readonly run: number; readonly verdict: 'pass' | 'reject' }
  | { readonly kind: 'publish'; readonly slug: string; readonly revision: number }
  | { readonly kind: 'authorization'; readonly slug: string; readonly authorized: boolean }
  | { readonly kind: 'version'; readonly slug: string; readonly version: number }
  | { readonly kind: 'retire'; readonly slug: string }

/** Owns all requests and retained content for one connected project. */
export class BusinessSkillController {
  /** Only current-generation public records, cleared on scope loss and disposal. */
  readonly snapshot = new BusinessSkillStore()
  private scope: BusinessSkillScope | undefined
  private disposed = false
  private readonly requests = new Map<AbortController, Promise<void>>()
  private retry: { request: BusinessSkillMutation; key: string } | undefined
  private catalogOwner: ReadOwner | undefined
  private selectionOwner: ReadOwner | undefined
  private selected: string | undefined

  constructor(private readonly remote: BusinessSkillRemote) {}

  /** Replace scope, cancelling every request from its preceding generation.
   * @param scope Authenticated workbench selection and physical connection identity.
   * @returns Initial list and selected detail settlement.
   */
  setScope(scope: BusinessSkillScope): Promise<void> {
    const old = this.scope
    if (this.disposed || (old !== undefined && old.accountId === scope.accountId && old.projectId === scope.projectId
      && old.sessionId === scope.sessionId && old.role === scope.role && old.generation === scope.generation)) return Promise.resolve()
    this.clear()
    this.scope = scope
    return this.refresh()
  }

  /** Cancel requests and remove project content when the selection becomes unavailable. */
  clear(): void {
    this.scope = undefined
    this.selected = undefined
    this.retry = undefined
    this.catalogOwner = undefined
    this.selectionOwner?.controller.abort()
    this.selectionOwner = undefined
    for (const controller of this.requests.keys()) controller.abort()
    this.snapshot.invalidate()
  }

  /** Reload the catalog within the same epoch, retaining the selected slug when still available.
   * @returns Settlement without retaining inaccessible content.
   */
  refresh(): Promise<void> {
    const scope = this.scope
    if (scope === undefined || this.disposed) return Promise.resolve()
    const selected = this.selected
    for (const controller of this.requests.keys()) controller.abort()
    this.scope = { ...scope }
    this.catalogOwner = this.readOwner(undefined)
    this.selectionOwner?.controller.abort()
    this.selectionOwner = undefined
    this.snapshot.replace({ phase: 'loading' })
    return this.perform(async (signal, live, scope) => {
      const result = await this.remote.list(scope.projectId, scope.sessionId, { limit: 50 }, signal)
      if (!live()) return
      if (!result.ok) { this.snapshot.replace({ phase: 'error', error: '无法加载业务 Skill，请重新加载' }); return }
      const items = [...new Map(result.value.items.map(item => [item.slug, item])).values()].sort((a, b) => a.slug.localeCompare(b.slug))
      this.snapshot.replace({ phase: 'ready', scope, items, cursor: result.value.nextCursor })
      const next = items.find(item => item.slug === selected) ?? items[0]
      if (next !== undefined) await this.select(next.slug)
    })
  }

  /** Read one slug, cancelling the preceding selection's detail, history and transcript requests.
   * @param slug Public project-local Skill name.
   * @returns Selected detail settlement.
   */
  select(slug: string): Promise<void> {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready' || state.action !== undefined || this.disposed) return Promise.resolve()
    this.selectionOwner?.controller.abort()
    const owner = this.readOwner(slug)
    this.selectionOwner = owner
    this.selected = slug
    this.snapshot.patch({ selected: slug, detail: undefined, transcript: undefined, detailLoading: true, error: undefined })
    return this.perform(async (signal, live, scope) => {
      const result = await this.remote.detail(scope.projectId, scope.sessionId, slug, { limit: 50 }, signal)
      const current = this.snapshot.getSnapshot()
      if (!live() || current.phase !== 'ready' || current.selected !== slug) return
      this.snapshot.patch(result.ok
        ? { detail: result.value, detailLoading: false }
        : { detailLoading: false, error: '无法加载 Skill 详情，请重新加载' })
    }, owner, owner.controller)
  }

  /** Append the next catalog page, retaining the current selection.
   * @returns Deduplicated public rows in slug order.
   */
  loadMore(): Promise<void> {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready' || state.cursor === undefined) return Promise.resolve()
    const cursor = state.cursor
    return this.page(this.catalogOwner as ReadOwner, 'list', async (signal, live, scope) => {
      const result = await this.remote.list(scope.projectId, scope.sessionId, { limit: 50, cursor }, signal)
      const current = this.snapshot.getSnapshot()
      if (!live() || current.phase !== 'ready') return
      if (!result.ok) { this.snapshot.patch({ error: '无法加载更多 Skill' }); return }
      this.snapshot.patch({ items: [...new Map([...current.items, ...result.value.items].map(item => [item.slug,
        item])).values()].sort((a, b) => a.slug.localeCompare(b.slug)), cursor: result.value.nextCursor })
    })
  }

  /** Append an independent immutable history page.
   * @param kind Version or test-run history to advance.
   * @returns History settlement without replacing the selected draft.
   */
  loadHistory(kind: 'versions' | 'tests'): Promise<void> {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready' || state.detail === undefined) return Promise.resolve()
    const detail = state.detail
    const cursor = kind === 'versions' ? detail.nextVersionCursor : detail.nextRunCursor
    if (cursor === undefined) return Promise.resolve()
    return this.page(this.selectionOwner as ReadOwner, kind, async (signal, live, scope) => {
      const result = await this.remote.detail(scope.projectId, scope.sessionId, detail.slug, { limit: 50,
        [kind === 'versions' ? 'versionCursor' : 'runCursor']: cursor }, signal)
      const current = this.snapshot.getSnapshot()
      if (!live() || current.phase !== 'ready' || current.detail?.slug !== detail.slug) return
      if (!result.ok) { this.snapshot.patch({ error: '无法加载 Skill 历史' }); return }
      const { nextVersionCursor: _versions, nextRunCursor: _runs, ...history } = current.detail
      this.snapshot.patch({ detail: kind === 'versions'
        ? { ...history, ...(_runs === undefined ? {} : { nextRunCursor: _runs }),
          versions: [...new Map([...current.detail.versions, ...result.value.versions].map(item => [item.versionNumber,
            item])).values()].sort((a, b) => b.versionNumber - a.versionNumber),
          ...(result.value.nextVersionCursor === undefined ? {} : { nextVersionCursor: result.value.nextVersionCursor }) }
        : { ...history, ...(_versions === undefined ? {} : { nextVersionCursor: _versions }),
          tests: [...new Map([...current.detail.tests, ...result.value.tests].map(item => [item.runNumber, item])).values()].sort((a,
            b) => b.runNumber - a.runNumber),
          ...(result.value.nextRunCursor === undefined ? {} : { nextRunCursor: result.value.nextRunCursor }) },
      })
    })
  }

  /** Open the public test transcript before sequence zero, or advance from its returned last-sequence cursor.
   * @param run Public run number belonging to the selected Skill.
   * @param more Append the next event page when true.
   * @returns Transcript events, never an ordinary Session lookup.
   */
  openTranscript(run: number, more = false): Promise<void> {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready' || state.selected === undefined) return Promise.resolve()
    const slug = state.selected
    const previous = more && state.transcript?.test.runNumber === run ? state.transcript : undefined
    if (!more) this.snapshot.patch({ transcript: undefined })
    return this.page(this.selectionOwner as ReadOwner, 'transcript', async (signal, live, scope) => {
      const result = await this.remote.transcript(scope.projectId, scope.sessionId, slug, run, { limit: 50,
        afterSequence: previous?.nextSequence ?? -1 }, signal)
      const current = this.snapshot.getSnapshot()
      if (!live() || current.phase !== 'ready' || current.selected !== slug) return
      if (!result.ok) { this.snapshot.patch({ error: '无法加载测试记录' }); return }
      this.snapshot.patch({ transcript: { ...result.value, events: [...new Map([...(previous?.events ?? []),
        ...result.value.events].map(item => [item.sequence, item])).values()].sort((a, b) => a.sequence - b.sequence) } })
    }, !more)
  }

  private page(
    owner: ReadOwner,
    key: string,
    operation: (signal: AbortSignal, live: () => boolean, scope: BusinessSkillScope) => Promise<void>,
    replace = false,
  ): Promise<void> {
    if (replace) {
      owner.pages.get(key)?.abort()
      owner.pages.delete(key)
    }
    if (owner.pages.has(key) || this.disposed) return Promise.resolve()
    const controller = new AbortController()
    owner.pages.set(key, controller)
    return this.perform(operation, owner, controller).finally(() => {
      if (owner.pages.get(key) === controller) owner.pages.delete(key)
    })
  }

  private readOwner(slug: string | undefined): ReadOwner {
    return { scope: this.scope as BusinessSkillScope, slug, controller: new AbortController(), pages: new Map() }
  }

  /** Submit one user intent, creating a fresh idempotency key.
   * @param request Exact content and revision confirmed by the actor.
   * @param scopeEpoch Captured form owner; immediate callers may use the current epoch.
   * @returns Explicit success, rejection, uncertainty, cancellation or refusal to start.
   */
  mutate(request: BusinessSkillMutation, scopeEpoch = this.snapshot.getSnapshot().scopeEpoch): Promise<BusinessSkillMutationOutcome> {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready' || scopeEpoch !== state.scopeEpoch || state.action !== undefined || state.blocked || this.disposed) return Promise.resolve('not-started')
    if (state.scope.role !== 'manager' && ['publish', 'authorization', 'version', 'retire'].includes(request.kind)) return Promise.resolve('not-started')
    this.retry = undefined
    return this.submit(structuredClone(request), crypto.randomUUID())
  }

  /** Retry only the identical mutation whose transport outcome remains unknown.
   * @returns Original-key outcome, or not-started if no uncertain intent exists.
   */
  retryMutation(): Promise<BusinessSkillMutationOutcome> {
    const retry = this.retry
    if (retry === undefined || this.disposed) return Promise.resolve('not-started')
    this.retry = undefined
    return this.submit(retry.request, retry.key)
  }

  /** Abort requests, publish input invalidation, stop notifications and await all pending work. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.clear()
    this.snapshot.dispose()
    await Promise.allSettled([...this.requests.values()])
  }

  private submit(request: BusinessSkillMutation, key: string): Promise<BusinessSkillMutationOutcome> {
    let outcome: BusinessSkillMutationOutcome = 'cancelled'
    this.snapshot.patch({ action: 'submitting', error: undefined })
    return this.perform(async (signal, live, scope) => {
      let result: RemoteResult<XAgentBusinessSkillDetail | XAgentBusinessSkillTest>
      try { result = await this.dispatch(request, key, signal, scope) }
      catch {
        if (live()) { this.uncertain(request, key); outcome = 'uncertain' }
        return
      }
      if (!live()) return
      if (!result.ok && result.error.code === 'service-unavailable') {
        this.uncertain(request, key); outcome = 'uncertain'; return
      }
      this.retry = undefined
      this.snapshot.patch({ action: undefined })
      if (!live()) return
      const slug = request.kind === 'create' ? request.input.slug : request.slug
      if (!result.ok) {
        outcome = 'failed'
        if (result.error.code === 'input-invalid' || result.error.code === 'business-skill-input-invalid'
          || (request.kind === 'create' && result.error.code === 'business-skill-conflict')) {
          this.snapshot.patch({ error: '草稿未保存，请检查名称和内容后重试' })
        } else if (result.error.code === 'business-skill-revision-conflict' || result.error.code === 'business-skill-policy-changed') {
          await this.select(slug)
          if (live()) this.snapshot.patch({ error: '草稿或工具策略已更新，已重新加载；请检查新内容后再保存' })
        } else this.snapshot.patch({ blocked: true, error: '操作未完成，请重新加载当前权限和 Skill 状态' })
        return
      }
      outcome = 'succeeded'
      if (request.kind === 'test') await this.select(slug)
      else {
        const detail = result.value as XAgentBusinessSkillDetail
        const state = this.snapshot.getSnapshot() as Extract<BusinessSkillState, { phase: 'ready' }>
        if (request.kind === 'create') {
          this.selectionOwner?.controller.abort()
          this.selectionOwner = this.readOwner(slug)
          this.selected = slug
        }
        this.snapshot.patch({ detail, selected: slug, detailLoading: false,
          transcript: request.kind === 'create' ? undefined : state.transcript,
          items: [...new Map([...state.items, detail].map(item => [item.slug, item])).values()].sort((a,
            b) => a.slug.localeCompare(b.slug)),
        })
      }
    }).then(() => outcome)
  }

  private dispatch(request: BusinessSkillMutation, key: string, signal: AbortSignal,
    scope: BusinessSkillScope): Promise<RemoteResult<XAgentBusinessSkillDetail | XAgentBusinessSkillTest>> {
    switch (request.kind) {
      case 'create': return this.remote.create(scope.projectId, scope.sessionId, { ...request.input, idempotencyKey: key }, signal)
      case 'draft': return this.remote.draft(scope.projectId, scope.sessionId, request.slug, { ...request.input,
        idempotencyKey: key }, signal)
      case 'test': return this.remote.test(scope.projectId, scope.sessionId, request.slug,
        { expectedDraftRevision: request.revision, toolPolicyDigest: request.policy, scenario: request.scenario,
          idempotencyKey: key }, signal)
      case 'verdict': return this.remote.verdict(scope.projectId, scope.sessionId, request.slug, request.run, request.verdict, key, signal)
      case 'publish': return this.remote.publish(scope.projectId, scope.sessionId, request.slug, request.revision, key, signal)
      case 'authorization': return this.remote.authorization(scope.projectId, scope.sessionId, request.slug,
        request.authorized, key, signal)
      case 'version': return this.remote.version(scope.projectId, scope.sessionId, request.slug, request.version, key, signal)
      case 'retire': return this.remote.retire(scope.projectId, scope.sessionId, request.slug, key, signal)
    }
  }

  private uncertain(request: BusinessSkillMutation, key: string): void {
    this.retry = { request, key }
    this.snapshot.patch({ action: 'uncertain', error: '服务响应中断，结果尚未确认；请使用原请求重试' })
  }

  private perform(
    operation: (signal: AbortSignal, live: () => boolean, scope: BusinessSkillScope) => Promise<void>,
    owner?: ReadOwner,
    controller = new AbortController(),
  ): Promise<void> {
    const scope = (owner?.scope ?? this.scope) as BusinessSkillScope
    const signal = owner === undefined ? controller.signal : AbortSignal.any([owner.controller.signal, controller.signal])
    const live = (): boolean => !this.disposed && !signal.aborted && this.scope === scope
    const task = operation(signal, live, scope).catch(() => {
      if (!live()) return
      const state = this.snapshot.getSnapshot()
      if (state.phase === 'loading') this.snapshot.replace({ phase: 'error', error: '无法加载业务 Skill，请重新加载' })
      else this.snapshot.patch({ detailLoading: false, error: '无法加载 Skill，请重新加载' })
    }).finally(() => { this.requests.delete(controller) })
    this.requests.set(controller, task)
    return task
  }
}
