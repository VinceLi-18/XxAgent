// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { BusinessSkillController, type BusinessSkillRemote } from '../src/client/service.ts'
import { detail, scope, ok, remoteFixture } from './fixtures.client.ts'
import { BusinessSkillStore } from '../src/client/store.ts'

describe('Business Skill governance scope', () => {
  it.each([false, true])('gives successful creation independent page ownership with an existing selection: %s', async (existing) => {
    const remote = remoteFixture()
    remote.list.mockResolvedValueOnce(ok({ items: existing ? [detail] : [] }))
    remote.detail.mockResolvedValueOnce(ok({ ...detail, nextVersionCursor: 2 }))
    remote.create.mockResolvedValueOnce(ok({ ...detail, slug: 'created', nextVersionCursor: 2 }))
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    if (existing) await controller.openTranscript(3)
    const pending = Promise.withResolvers<never>()
    if (existing) remote.detail.mockReturnValueOnce(pending.promise)
    const old = existing ? controller.loadHistory('versions') : Promise.resolve()
    const oldSignal = remote.detail.mock.calls.at(-1)?.[4]
    await controller.mutate({ kind: 'create', input: {
      slug: 'created', displayName: 'Created', description: 'Created', instructions: '# Created', primaryTools: [],
    } })
    if (existing) expect(oldSignal?.aborted).toBe(true)
    expect(controller.snapshot.getSnapshot()).toMatchObject({ transcript: undefined })
    await controller.loadHistory('versions')
    expect(remote.detail.mock.calls.at(-1)?.[2]).toBe('created')
    pending.resolve(ok(detail) as never); await old
    await controller.dispose()
  })

  it.each(['versions', 'tests', 'transcript'] as const)('releases %s work on selection changes and rejects A → B → A late content', async (kind) => {
    const remote = remoteFixture()
    remote.detail.mockImplementation(async (...[_project, _session, slug]: Parameters<BusinessSkillRemote['detail']>) =>
      ok({ ...detail, slug, nextVersionCursor: 2, nextRunCursor: 3 }))
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    const pending = Promise.withResolvers<never>()
    if (kind === 'transcript') remote.transcript.mockReturnValueOnce(pending.promise)
    else remote.detail.mockReturnValueOnce(pending.promise)
    const load = () => kind === 'transcript' ? controller.openTranscript(3) : controller.loadHistory(kind)
    const old = load()
    const oldSignal = kind === 'transcript' ? remote.transcript.mock.calls[0]?.[5] : remote.detail.mock.calls[1]?.[4]
    await controller.select('other')
    expect(oldSignal?.aborted).toBe(true)
    await load()
    if (kind === 'transcript') expect(remote.transcript.mock.calls.at(-1)?.[2]).toBe('other')
    else expect(remote.detail.mock.calls.at(-1)?.[3]).toEqual({ limit: 50, [kind === 'versions' ? 'versionCursor' : 'runCursor']: kind === 'versions' ? 2 : 3 })
    await controller.select(detail.slug)
    pending.resolve(ok(kind === 'transcript'
      ? { test: detail.tests[0], events: [{ sequence: 0, eventType: 'old', payload: {}, createdAt: 'old' }], nextSequence: 0 }
      : { ...detail, tests: [{ ...detail.tests[0], runNumber: 99 }], versions: [{ versionNumber: 99 }] }) as never)
    await old
    expect(controller.snapshot.getSnapshot()).toMatchObject({ detail: { tests: [{ runNumber: 3 }], versions: [] }, transcript: undefined })
    await controller.dispose()
  })

  it('suppresses a rejected history page from an abandoned selection', async () => {
    const remote = remoteFixture()
    remote.detail.mockResolvedValueOnce(ok({ ...detail, nextVersionCursor: 2 }))
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    const pending = Promise.withResolvers<never>()
    remote.detail.mockReturnValueOnce(pending.promise)
    const old = controller.loadHistory('versions')
    await controller.select('other')
    pending.reject(new Error('old history failed')); await old
    expect(controller.snapshot.getSnapshot()).toMatchObject({ error: undefined })
    await controller.dispose()
  })

  it('includes sequence-zero startup and advances the backend last-sequence cursor without gaps', async () => {
    const remote = remoteFixture()
    const events = [0, 1, 2].map(sequence => ({ sequence, eventType: 'message', payload: { text: String(sequence) }, createdAt: 'now' }))
    remote.transcript.mockImplementation(async (...[_project, _session, _slug, _run, input]: Parameters<BusinessSkillRemote['transcript']>) => {
      const page = events.filter(event => event.sequence > (input.afterSequence ?? -1)).slice(0, 2)
      return ok({ test: detail.tests[0]!, events: page, nextSequence: page.at(-1)?.sequence ?? input.afterSequence ?? -1 })
    })
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    await controller.openTranscript(3)
    await controller.openTranscript(3, true)
    await controller.openTranscript(3, true)
    expect(controller.snapshot.getSnapshot()).toMatchObject({ transcript: {
      events: [{ sequence: 0 }, { sequence: 1 }, { sequence: 2 }], nextSequence: 2,
    } })
    await controller.dispose()
  })

  it.each(['input-invalid', 'business-skill-input-invalid', 'business-skill-conflict'] as const)('permits correcting a create rejected with %s', async (code) => {
    const remote = remoteFixture()
    remote.create.mockResolvedValueOnce({ ok: false, error: { code, message: 'rejected', details: {} } })
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    const input = { slug: 'new', displayName: 'New', description: 'New', instructions: '# New', primaryTools: [] }
    expect(await controller.mutate({ kind: 'create', input })).toBe('failed')
    expect(controller.snapshot.getSnapshot()).toMatchObject({ action: undefined })
    expect(await controller.mutate({ kind: 'create', input: { ...input, slug: 'corrected' } })).toBe('succeeded')
    expect(remote.create.mock.calls[1]?.[2].idempotencyKey).not.toBe(remote.create.mock.calls[0]?.[2].idempotencyKey)
    await controller.dispose()
  })
  it('keeps a new generation page locked when the preceding page settles', async () => {
    const remote = remoteFixture()
    remote.list.mockResolvedValue(ok({ items: [detail], nextCursor: 'next' }))
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    const old = Promise.withResolvers<Awaited<ReturnType<typeof remote.list>>>()
    remote.list.mockReturnValueOnce(old.promise)
    const oldLoad = controller.loadMore()
    await controller.setScope({ ...scope, generation: {} })
    const current = Promise.withResolvers<Awaited<ReturnType<typeof remote.list>>>()
    remote.list.mockReturnValueOnce(current.promise)
    const currentLoad = controller.loadMore()
    old.resolve(ok({ items: [] })); await oldLoad
    await controller.loadMore()
    expect(remote.list).toHaveBeenCalledTimes(4)
    current.resolve(ok({ items: [] })); await currentLoad
    await controller.dispose()
  })

  it('cancels a preceding transcript selection and retains only the latest run', async () => {
    const remote = remoteFixture()
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.transcript>>>()
    remote.transcript.mockReturnValueOnce(pending.promise)
    const old = controller.openTranscript(3)
    remote.transcript.mockResolvedValueOnce(ok({ test: { ...detail.tests[0]!, runNumber: 4 }, events: [], nextSequence: 0 }))
    await controller.openTranscript(4)
    expect(remote.transcript.mock.calls[0]?.[5]?.aborted).toBe(true)
    pending.resolve(ok({ test: detail.tests[0]!, events: [], nextSequence: 0 })); await old
    expect(controller.snapshot.getSnapshot()).toMatchObject({ transcript: { test: { runNumber: 4 } } })
    await controller.dispose()
  })

  it('inserts a created Skill into the public slug ordering', async () => {
    const remote = remoteFixture()
    remote.create.mockResolvedValueOnce(ok({ ...detail, slug: 'aaa' }))
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    await controller.mutate({ kind: 'create', input: {
      slug: 'aaa', displayName: 'A', description: 'A', instructions: '# A', primaryTools: [],
    } })
    expect(controller.snapshot.getSnapshot()).toMatchObject({ items: [{ slug: 'aaa' }, { slug: detail.slug }] })
    await controller.dispose()
  })
  it('orders the initial list and represents a project with no Skills', async () => {
    const remote = remoteFixture()
    remote.list.mockResolvedValueOnce(ok({ items: [{ ...detail, slug: 'z-last' }, detail] }))
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    expect(controller.snapshot.getSnapshot()).toMatchObject({ items: [{ slug: 'review-facts' }, { slug: 'z-last' }] })
    remote.list.mockResolvedValueOnce(ok({ items: [] }))
    await controller.refresh()
    expect(controller.snapshot.getSnapshot()).toMatchObject({ items: [] })
    await controller.dispose()
  })

  it.each(['versions', 'tests'] as const)('exhausts %s history without retaining the absent sibling cursor', async (kind) => {
    const remote = remoteFixture()
    remote.detail.mockResolvedValueOnce(ok({ ...detail, [kind === 'versions' ? 'nextVersionCursor' : 'nextRunCursor']: 3 }))
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    await controller.loadHistory(kind)
    await controller.loadHistory(kind)
    expect(remote.detail).toHaveBeenCalledTimes(2)
    await controller.dispose()
  })
  it('does not admit old mutation content after a subscriber switches scope', async () => {
    const remote = remoteFixture()
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    const states: string[] = []
    let switched = false
    controller.snapshot.subscribe(() => {
      const state = controller.snapshot.getSnapshot()
      if (state.phase !== 'ready') return
      states.push(`${state.scope.accountId}:${state.detail?.displayName}`)
      if (state.action === undefined && !switched) { switched = true; void controller.setScope({ ...scope, accountId: 'other' }) }
    })
    remote.publish.mockResolvedValueOnce(ok({ ...detail, displayName: 'publication from first account' }))
    await controller.mutate({ kind: 'publish', slug: detail.slug, revision: 2 })
    await Promise.resolve(); await Promise.resolve()
    expect(states).not.toContain('other:publication from first account')
    await controller.dispose()
  })
  it('suppresses rejected old reads and conflict refreshes after a scope change', async () => {
    const remote = remoteFixture()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.detail>>>()
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    remote.detail.mockReturnValueOnce(pending.promise)
    remote.publish.mockResolvedValueOnce({ ok: false, error: { code: 'business-skill-revision-conflict', message: 'changed',
      details: {} } })
    const mutation = controller.mutate({ kind: 'publish', slug: detail.slug, revision: 2 })
    await Promise.resolve(); await Promise.resolve()
    await controller.setScope({ ...scope, accountId: 'new' })
    pending.reject(new Error('old read failed')); await mutation
    expect(controller.snapshot.getSnapshot()).toMatchObject({ scope: { accountId: 'new' }, error: undefined })
    await controller.dispose()
  })
  it('advances independent history cursors and deduplicates transcript sequences', async () => {
    const remote = remoteFixture()
    const version = { versionNumber: 2, description: 'two', instructions: 'two', primaryTools: [], completeTools: ['skill'],
      contentDigest: 'c', toolPolicyDigest: 'p', sourceDraftRevision: 2, publishedAt: '2026-09-12' }
    remote.detail.mockResolvedValueOnce(ok({ ...detail, versions: [version], nextVersionCursor: 2, nextRunCursor: 3 }))
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    remote.detail.mockResolvedValueOnce(ok({ ...detail, versions: [{ ...version, versionNumber: 1 }, version], nextVersionCursor: 1 }))
    await controller.loadHistory('versions')
    remote.detail.mockResolvedValueOnce(ok({ ...detail, tests: [{ ...detail.tests[0]!, runNumber: 1 }, detail.tests[0]!],
      nextRunCursor: 1 }))
    await controller.loadHistory('tests')
    expect(controller.snapshot.getSnapshot()).toMatchObject({ detail: { versions: [{ versionNumber: 2 },
      { versionNumber: 1 }], tests: [{ runNumber: 3 }, { runNumber: 1 }], nextVersionCursor: 1, nextRunCursor: 1 } })
    const event = { sequence: 1, eventType: 'assistant/message', payload: { content: 'Read' }, createdAt: '2026-09-12' }
    remote.transcript.mockResolvedValueOnce(ok({ test: detail.tests[0]!, events: [event], nextSequence: 2 }))
    await controller.openTranscript(3)
    remote.transcript.mockResolvedValueOnce(ok({ test: detail.tests[0]!, events: [{ ...event, sequence: 2 }, event], nextSequence: 3 }))
    await controller.openTranscript(3, true)
    expect(controller.snapshot.getSnapshot()).toMatchObject({ transcript: { events: [{ sequence: 1 }, { sequence: 2 }], nextSequence: 3 } })
    expect(remote.transcript.mock.calls[1]?.[4]).toEqual({ limit: 50, afterSequence: 2 })
    await controller.openTranscript(7, true)
    expect(remote.transcript.mock.calls[2]?.[4]).toEqual({ limit: 50, afterSequence: -1 })
    await controller.loadHistory('tests'); await controller.loadHistory('tests')
    expect(remote.detail).toHaveBeenCalledTimes(4)
    await controller.dispose()
  })

  it.each(['list', 'versions', 'tests', 'transcript'] as const)('offers an explicit retry for a failed %s page', async (kind) => {
    const remote = remoteFixture()
    remote.list.mockResolvedValueOnce(ok({ items: [detail], nextCursor: 'page' }))
    remote.detail.mockResolvedValueOnce(ok({ ...detail, nextVersionCursor: 2, nextRunCursor: 3 }))
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    const failed = { ok: false as const, error: { code: 'service-unavailable', message: 'unavailable', details: {} } }
    remote.list.mockResolvedValueOnce(failed); remote.detail.mockResolvedValueOnce(failed); remote.transcript.mockResolvedValueOnce(failed)
    if (kind === 'list') await controller.loadMore()
    else if (kind === 'transcript') await controller.openTranscript(3)
    else await controller.loadHistory(kind)
    expect(controller.snapshot.getSnapshot()).toHaveProperty('error', expect.stringContaining('无法加载'))
    await controller.dispose()
  })

  it.each(['list', 'versions',
    'transcript'] as const)('drops an old %s page after scope changes and prevents duplicate in-flight pages', async (kind) => {
    const remote = remoteFixture()
    remote.list.mockResolvedValueOnce(ok({ items: [detail], nextCursor: 'page' }))
    remote.detail.mockResolvedValueOnce(ok({ ...detail, nextVersionCursor: 2 }))
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    const pending = Promise.withResolvers<never>()
    if (kind === 'list') remote.list.mockReturnValueOnce(pending.promise)
    else if (kind === 'versions') remote.detail.mockReturnValueOnce(pending.promise)
    else remote.transcript.mockReturnValueOnce(pending.promise)
    const load = () => kind === 'list' ? controller.loadMore() : kind === 'versions' ? controller.loadHistory('versions') : controller.openTranscript(3)
    const old = load(); await load()
    await controller.setScope({ ...scope, projectId: 'other' })
    pending.resolve(ok(kind === 'list' ? { items: [] } : kind === 'versions' ? detail : { test: detail.tests[0], events: [],
      nextSequence: 0 }) as never)
    await old
    expect(controller.snapshot.getSnapshot()).toMatchObject({ scope: { projectId: 'other' }, selected: 'review-facts' })
    await controller.dispose()
  })
  it('contains subscriber exceptions and does not revive cleared snapshots through a patch', () => {
    const store = new BusinessSkillStore()
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    const second = vi.fn()
    const stop = store.subscribe(() => { throw new Error('observer') })
    store.subscribe(second)
    store.replace({ phase: 'loading' })
    expect(second).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledOnce()
    stop(); store.patch({ items: [] })
    expect(store.getSnapshot()).toEqual({ phase: 'loading' })
    report.mockRestore()
  })

  it('forwards every mutation with fresh identity and exact current scope', async () => {
    const remote = remoteFixture()
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    await controller.setScope(scope)
    expect(remote.list).toHaveBeenCalledOnce()
    await controller.mutate({ kind: 'create', input: { slug: 'new', displayName: 'New', description: 'New',
      instructions: '# New', primaryTools: [] } })
    await controller.mutate({ kind: 'test', slug: detail.slug, revision: 2, policy: 'policy', scenario: 'Read' })
    await controller.mutate({ kind: 'verdict', slug: detail.slug, run: 3, verdict: 'reject' })
    await controller.mutate({ kind: 'authorization', slug: detail.slug, authorized: true })
    await controller.mutate({ kind: 'version', slug: detail.slug, version: 1 })
    await controller.mutate({ kind: 'retire', slug: detail.slug })
    expect(remote.create.mock.calls[0]?.slice(0, 2)).toEqual(['project', 'session'])
    expect(remote.test.mock.calls[0]?.slice(0, 4)).toEqual(['project', 'session', 'review-facts', {
      expectedDraftRevision: 2, toolPolicyDigest: 'policy', scenario: 'Read', idempotencyKey: remote.test.mock.calls[0]?.[3].idempotencyKey,
    }])
    expect(remote.verdict.mock.calls[0]?.slice(0, 5)).toEqual(['project', 'session', 'review-facts', 3, 'reject'])
    expect(remote.authorization.mock.calls[0]?.slice(0, 4)).toEqual(['project', 'session', 'review-facts', true])
    expect(remote.version.mock.calls[0]?.slice(0, 4)).toEqual(['project', 'session', 'review-facts', 1])
    expect(remote.retire.mock.calls[0]?.slice(0, 3)).toEqual(['project', 'session', 'review-facts'])
    await controller.dispose()
    await controller.setScope(scope); await controller.refresh(); await controller.select(detail.slug)
    await controller.mutate({ kind: 'retire', slug: detail.slug }); await controller.retryMutation()
    await controller.loadMore(); await controller.loadHistory('versions'); await controller.openTranscript(3)
    expect(remote.retire).toHaveBeenCalledOnce()
  })

  it.each(['reject', 'denied'] as const)('shows recoverable read errors for %s responses', async (mode) => {
    const remote = remoteFixture()
    if (mode === 'reject') remote.list.mockRejectedValueOnce(new Error('network'))
    else remote.list.mockResolvedValueOnce({ ok: false, error: { code: 'forbidden', message: 'denied', details: {} } })
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    expect(controller.snapshot.getSnapshot()).toMatchObject({ phase: 'error' })
    remote.detail.mockRejectedValueOnce(new Error('detail unavailable'))
    await controller.refresh()
    expect(controller.snapshot.getSnapshot()).toMatchObject({ detailLoading: false })
    expect(controller.snapshot.getSnapshot()).toHaveProperty('error', expect.stringContaining('重新加载'))
    remote.detail.mockResolvedValueOnce({ ok: false, error: { code: 'not-found', message: 'absent', details: {} } })
    await controller.select(detail.slug)
    expect(controller.snapshot.getSnapshot()).toMatchObject({ detailLoading: false })
    expect(controller.snapshot.getSnapshot()).toHaveProperty('error', expect.stringContaining('详情'))
    await controller.dispose()
  })

  it.each(['service-unavailable', 'forbidden',
    'business-skill-policy-changed'] as const)('handles definitive or uncertain %s mutations without silent retry', async (code) => {
    const remote = remoteFixture()
    remote.publish.mockResolvedValueOnce({ ok: false, error: { code, message: 'failed', details: {} } })
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    await controller.mutate({ kind: 'publish', slug: detail.slug, revision: 2 })
    expect(remote.publish).toHaveBeenCalledOnce()
    await controller.mutate({ kind: 'retire', slug: detail.slug })
    if (code === 'service-unavailable') {
      expect(remote.retire).not.toHaveBeenCalled()
      await controller.retryMutation()
      expect(remote.publish.mock.calls[1]?.[4]).toBe(remote.publish.mock.calls[0]?.[4])
    } else if (code === 'forbidden') {
      expect(remote.retire).not.toHaveBeenCalled()
      expect(controller.snapshot.getSnapshot()).toMatchObject({ blocked: true })
      await controller.retryMutation()
      expect(remote.publish).toHaveBeenCalledOnce()
    }
    await controller.dispose()
  })

  it.each(['resolve', 'reject'] as const)('suppresses %s mutation settlement after account switch', async (mode) => {
    const remote = remoteFixture()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.publish>>>()
    remote.publish.mockReturnValueOnce(pending.promise)
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    const action = controller.mutate({ kind: 'publish', slug: detail.slug, revision: 2 })
    await controller.setScope({ ...scope, accountId: 'other' })
    if (mode === 'resolve') pending.resolve(ok({ ...detail, displayName: 'old result' }))
    else pending.reject(new Error('old failure'))
    await action
    expect(controller.snapshot.getSnapshot()).toMatchObject({ scope: { accountId: 'other' }, detail: { displayName: '审核项目事实' } })
    await controller.dispose()
  })
  it('cancels a superseded detail even when the same slug is selected again', async () => {
    const remote = remoteFixture()
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.detail>>>()
    remote.detail.mockReturnValueOnce(pending.promise)
    const earlier = controller.select(detail.slug)
    const signal = remote.detail.mock.calls[1]![4]!
    await controller.select(detail.slug)
    expect(signal.aborted).toBe(true)
    pending.resolve(ok({ ...detail, displayName: 'stale' })); await earlier
    expect(controller.snapshot.getSnapshot()).toMatchObject({ detail: { displayName: '审核项目事实' } })
    await controller.dispose()
  })

  it('keeps disposal pending until cancelled transport settles without notifying subscribers', async () => {
    const remote = remoteFixture()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.list>>>()
    remote.list.mockReturnValueOnce(pending.promise)
    const controller = new BusinessSkillController(remote)
    const loading = controller.setScope(scope)
    const listener = vi.fn()
    controller.snapshot.subscribe(listener)
    let settled = false
    const disposed = controller.dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(remote.list.mock.calls[0]![3]!.aborted).toBe(true)
    pending.resolve(ok({ items: [detail] })); await loading; await disposed
    expect(listener).not.toHaveBeenCalled()
    expect(controller.snapshot.getSnapshot()).toEqual({ phase: 'empty' })
  })

  it('invalidates overlapping refreshes within one physical scope', async () => {
    const remote = remoteFixture()
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.list>>>()
    remote.list.mockReturnValueOnce(pending.promise)
    const first = controller.refresh()
    await controller.refresh()
    pending.resolve(ok({ items: [{ ...detail, slug: 'obsolete' }] })); await first
    expect(controller.snapshot.getSnapshot()).toMatchObject({ selected: 'review-facts' })
    await controller.dispose()
  })
  it('merges overlapping pages deterministically while keeping selection', async () => {
    const remote = remoteFixture()
    remote.list.mockResolvedValueOnce(ok({ items: [detail], nextCursor: 'next' }))
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    remote.list.mockResolvedValueOnce(ok({ items: [{ ...detail, slug: 'aaa' }, detail] }))
    await controller.loadMore()
    expect(controller.snapshot.getSnapshot()).toMatchObject({ selected: 'review-facts', items: [{ slug: 'aaa' },
      { slug: 'review-facts' }] })
    await controller.loadMore()
    expect(remote.list).toHaveBeenCalledTimes(2)
    await controller.dispose()
  })

  it('reads separate version, test and transcript pages by their public cursors', async () => {
    const remote = remoteFixture()
    remote.detail.mockResolvedValueOnce(ok({ ...detail, nextVersionCursor: 2, nextRunCursor: 3 }))
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    await controller.loadHistory('versions')
    expect(remote.detail).toHaveBeenLastCalledWith('project', 'session', 'review-facts', { limit: 50, versionCursor: 2 },
      expect.any(AbortSignal))
    await controller.openTranscript(3)
    expect(remote.transcript).toHaveBeenCalledWith('project', 'session', 'review-facts', 3, { limit: 50, afterSequence: -1 },
      expect.any(AbortSignal))
    expect(controller.snapshot.getSnapshot()).toMatchObject({ transcript: { test: { runNumber: 3 } } })
    await controller.dispose()
  })
  it('loads the selected slug and exact revision from the current project', async () => {
    const remote = remoteFixture()
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    expect(controller.snapshot.getSnapshot()).toMatchObject({ phase: 'ready', selected: 'review-facts', detail })
    await controller.mutate({ kind: 'draft', slug: detail.slug, input: { expectedDraftRevision: 2, instructions: '# 新说明' } })
    expect(remote.draft).toHaveBeenCalledWith('project', 'session', 'review-facts',
      expect.objectContaining({ expectedDraftRevision: 2, instructions: '# 新说明' }),
      expect.any(AbortSignal))
    await controller.dispose()
    expect(controller.snapshot.getSnapshot()).toEqual({ phase: 'empty' })
  })

  it.each(['accountId', 'projectId', 'sessionId', 'generation'] as const)('cancels and suppresses old %s responses', async (field) => {
    const remote = remoteFixture()
    let settle!: (value: ReturnType<typeof ok<{ items: typeof detail[] }>>) => void
    remote.list.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
    const controller = new BusinessSkillController(remote)
    const old = controller.setScope(scope)
    const signal = remote.list.mock.calls[0]![3] as AbortSignal
    await controller.setScope({ ...scope, [field]: field === 'generation' ? {} : 'other' })
    expect(signal.aborted).toBe(true)
    settle(ok({ items: [{ ...detail, slug: 'stale' }] })); await old
    expect(controller.snapshot.getSnapshot()).toMatchObject({ selected: 'review-facts' })
    await controller.dispose()
  })

  it('reuses a mutation key only after uncertain transport settlement', async () => {
    const remote = remoteFixture()
    remote.publish.mockRejectedValueOnce(new Error('connection lost'))
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    await controller.mutate({ kind: 'publish', slug: detail.slug, revision: 2 })
    expect(controller.snapshot.getSnapshot()).toMatchObject({ action: 'uncertain' })
    await controller.retryMutation()
    expect(remote.publish.mock.calls[0]![4]).toBe(remote.publish.mock.calls[1]![4])
    await controller.mutate({ kind: 'publish', slug: detail.slug, revision: 2 })
    expect(remote.publish.mock.calls[2]![4]).not.toBe(remote.publish.mock.calls[1]![4])
    await controller.dispose()
  })

  it('refreshes stale drafts and never retries the old overwrite', async () => {
    const remote = remoteFixture()
    remote.draft.mockResolvedValueOnce({ ok: false, error: { code: 'business-skill-revision-conflict', message: 'conflict' } } as never)
    const controller = new BusinessSkillController(remote)
    await controller.setScope(scope)
    remote.detail.mockResolvedValueOnce(ok({ ...detail, draft: { ...detail.draft!, revision: 3 } }))
    await controller.mutate({ kind: 'draft', slug: detail.slug, input: { expectedDraftRevision: 2, instructions: 'edit' } })
    expect(controller.snapshot.getSnapshot()).toMatchObject({ detail: { draft: { revision: 3 } } })
    expect(controller.snapshot.getSnapshot()).toHaveProperty('error', expect.stringMatching(/已更新/))
    await controller.retryMutation()
    expect(remote.draft).toHaveBeenCalledOnce()
    await controller.dispose()
  })

  it('denies manager mutations in the Specialist controller', async () => {
    const remote = remoteFixture()
    const controller = new BusinessSkillController(remote)
    await controller.setScope({ ...scope, role: 'specialist' })
    await controller.mutate({ kind: 'publish', slug: detail.slug, revision: 2 })
    expect(remote.publish).not.toHaveBeenCalled()
    await controller.dispose()
  })
})
