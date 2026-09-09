// @vitest-environment jsdom
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  XAgentFactEvidence,
  XAgentFactPage,
  XAgentFactProposal,
  XAgentFactProposalDecision,
  XAgentFactRevision,
  XAgentFactRevisionDetail,
} from '@xagent/dsh-fact/types'
import { describe, expect, it, vi } from 'vitest'
import {
  XAgentFactController,
  type XAgentFactRemoteClient,
  type XAgentFactScope,
} from '../src/client/service.ts'
import { submitFactDecision } from '../src/client/decision.ts'

const ACCOUNT = '00000000-0000-0000-0000-000000000101'
const MANAGER = '00000000-0000-0000-0000-000000000102'
const SPECIALIST = '00000000-0000-0000-0000-000000000103'
const PROJECT = '00000000-0000-0000-0000-000000000201'
const SESSION = 'session-00000000-0000-0000-0000-000000000301'
const PROPOSAL = '00000000-0000-0000-0000-000000000401'
const REVISION = '00000000-0000-0000-0000-000000000501'

const evidence: XAgentFactEvidence = {
  citationId: '[资料1]', artifactId: '00000000-0000-0000-0000-000000000601',
  versionId: '00000000-0000-0000-0000-000000000602', indexId: '00000000-0000-0000-0000-000000000603',
  indexGeneration: 3, chunkId: '00000000-0000-0000-0000-000000000604', lineStart: 7, lineEnd: 9,
}

function revision(overrides: Partial<XAgentFactRevision> = {}): XAgentFactRevision {
  return {
    id: REVISION, projectId: PROJECT, fieldKey: 'customer.name', label: '客户名称',
    value: { type: 'text', value: '星河公司' }, contentRevision: 2, proposalId: PROPOSAL,
    proposerId: SPECIALIST, confirmedById: MANAGER, evidence: [evidence], createdAt: '2026-09-08T09:00:00+00:00',
    ...overrides,
  }
}

function proposal(overrides: Partial<XAgentFactProposal> = {}): XAgentFactProposal {
  return {
    id: PROPOSAL, projectId: PROJECT, fieldKey: 'renewal.date', label: '续约日期',
    value: { type: 'date', value: '2027-03-15' }, proposerId: SPECIALIST, baseRevision: 1,
    assertionReason: '客户在当面会议中确认', status: 'pending', evidence: [],
    createdAt: '2026-09-08T08:00:00+00:00', admittedAt: '2026-09-08T08:01:00+00:00',
    ...overrides,
  }
}

const ok = <T>(value: T): Promise<RemoteResult<T>> => Promise.resolve({ ok: true, value })
const fail = (code: string): Promise<RemoteResult<never>> => Promise.resolve({
  ok: false, error: { code, message: 'private backend detail', details: {} },
})

function scope(overrides: Partial<XAgentFactScope> = {}): XAgentFactScope {
  return { accountId: ACCOUNT, actorId: MANAGER, role: 'manager', projectId: PROJECT, sessionId: SESSION, ...overrides }
}

function remote(heads: readonly XAgentFactRevision[] = [revision()], proposals: readonly XAgentFactProposal[] = [proposal()]) {
  const client = {
    'list-heads': vi.fn((
      _sessionId: string, _input: { limit: number; cursor?: string }, _signal?: AbortSignal,
    ): Promise<RemoteResult<XAgentFactPage<XAgentFactRevision>>> => ok({ items: heads })),
    'list-proposals': vi.fn((
      _sessionId: string, _input: { limit: number; cursor?: string }, _signal?: AbortSignal,
    ): Promise<RemoteResult<XAgentFactPage<XAgentFactProposal>>> => ok({ items: proposals })),
    revision: vi.fn((
      _sessionId: string, _revisionId: string, _signal?: AbortSignal,
    ): Promise<RemoteResult<XAgentFactRevisionDetail>> => ok({ revision: heads[0]!, history: heads })),
    proposal: vi.fn((
      _sessionId: string, _proposalId: string, _signal?: AbortSignal,
    ): Promise<RemoteResult<XAgentFactProposal>> => ok(proposals[0]!)),
    approve: vi.fn((
      _sessionId: string, proposalId: string, _input: { idempotencyKey: string; decisionNote?: string },
      _signal?: AbortSignal,
    ): Promise<RemoteResult<XAgentFactProposalDecision>> => ok({
      proposalId, status: 'confirmed', factRevisionId: REVISION, contentRevision: 2,
    })),
    reject: vi.fn((
      _sessionId: string, proposalId: string, _input: { idempotencyKey: string; reason: string }, _signal?: AbortSignal,
    ): Promise<RemoteResult<XAgentFactProposalDecision>> => ok({ proposalId, status: 'rejected' })),
    withdraw: vi.fn((
      _sessionId: string, proposalId: string, _input: { idempotencyKey: string }, _signal?: AbortSignal,
    ): Promise<RemoteResult<XAgentFactProposalDecision>> => ok({ proposalId, status: 'withdrawn' })),
  }
  return client as typeof client & XAgentFactRemoteClient
}

describe('XAgent Fact memory controller', () => {
  it('loads bounded head and proposal pages for the exact Project Session and preserves typed values', async () => {
    const client = remote([
      revision(),
      revision({ id: '00000000-0000-0000-0000-000000000502', fieldKey: 'arr', label: 'ARR', value: { type: 'number', value: 81.5 } }),
      revision({ id: '00000000-0000-0000-0000-000000000503', fieldKey: 'active', label: '活跃', value: { type: 'boolean', value: true } }),
    ])
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) })

    await controller.setScope(scope())

    expect(client['list-heads']).toHaveBeenCalledWith(SESSION, { limit: 50 }, expect.any(AbortSignal))
    expect(client['list-proposals']).toHaveBeenCalledWith(SESSION, { limit: 50 }, expect.any(AbortSignal))
    expect(controller.snapshot.getSnapshot()).toMatchObject({
      phase: 'ready', sessionId: SESSION,
      heads: [
        { value: { type: 'text', value: '星河公司' } },
        { value: { type: 'number', value: 81.5 } },
        { value: { type: 'boolean', value: true } },
      ],
      proposals: [{ value: { type: 'date', value: '2027-03-15' } }],
    })
    await controller.setScope(scope())
    expect(client['list-heads']).toHaveBeenCalledOnce()
    expect(client['list-proposals']).toHaveBeenCalledOnce()
  })

  it('appends stable cursor pages once, rejects duplicate identities, and freezes concurrent cursor ownership', async () => {
    const second = Promise.withResolvers<RemoteResult<XAgentFactPage<XAgentFactRevision>>>()
    const firstHead = revision()
    const secondHead = revision({ id: '00000000-0000-0000-0000-000000000502', contentRevision: 1 })
    const client = remote([firstHead])
    client['list-heads']
      .mockResolvedValueOnce({ ok: true, value: { items: [firstHead], nextCursor: 'heads-2' } })
      .mockImplementationOnce(() => second.promise)
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) })
    await controller.setScope(scope())

    const loading = controller.loadMoreHeads()
    const duplicateLoad = controller.loadMoreHeads()
    expect(client['list-heads']).toHaveBeenCalledTimes(2)
    second.resolve({ ok: true, value: { items: [firstHead, secondHead] } })
    await Promise.all([loading, duplicateLoad])

    expect(controller.snapshot.getSnapshot()).toMatchObject({ heads: [firstHead, secondHead], headsCursor: undefined })
  })

  it('clears synchronously and rejects late list/detail results after account, project, Session, or tab scope changes', async () => {
    const oldHeads = Promise.withResolvers<RemoteResult<XAgentFactPage<XAgentFactRevision>>>()
    const oldProposals = Promise.withResolvers<RemoteResult<XAgentFactPage<XAgentFactProposal>>>()
    const client = remote()
    client['list-heads'].mockImplementationOnce(() => oldHeads.promise)
    client['list-proposals'].mockImplementationOnce(() => oldProposals.promise)
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) })

    const loading = controller.setScope(scope())
    const headSignal = client['list-heads'].mock.calls[0]![2]!
    controller.clear('00000000-0000-0000-0000-000000000999')
    expect(headSignal.aborted).toBe(true)
    expect(controller.snapshot.getSnapshot()).toEqual({ phase: 'empty', accountId: '00000000-0000-0000-0000-000000000999' })
    oldHeads.resolve({ ok: true, value: { items: [revision()] } })
    oldProposals.resolve({ ok: true, value: { items: [proposal()] } })
    await loading
    expect(controller.snapshot.getSnapshot()).toEqual({ phase: 'empty', accountId: '00000000-0000-0000-0000-000000000999' })

    await controller.setScope(scope())
    const detail = Promise.withResolvers<RemoteResult<XAgentFactProposal>>()
    client.proposal.mockImplementationOnce(() => detail.promise)
    const selecting = controller.selectProposal(PROPOSAL)
    const detailSignal = client.proposal.mock.calls.at(-1)![2]!
    await controller.setScope(scope({ sessionId: 'session-00000000-0000-0000-0000-000000000302' }))
    expect(detailSignal.aborted).toBe(true)
    detail.resolve({ ok: true, value: proposal({ label: 'STALE PRIVATE CONTENT' }) })
    await selecting
    expect(JSON.stringify(controller.snapshot.getSnapshot())).not.toContain('STALE PRIVATE CONTENT')
  })

  it('loads revision history and opens exact server evidence only for the current Session', async () => {
    const openCitation = vi.fn(async () => {})
    const client = remote()
    const controller = new XAgentFactController(client, { openCitation })
    await controller.setScope(scope())
    await controller.selectHead(REVISION)
    expect(client.revision).toHaveBeenCalledWith(SESSION, REVISION, expect.any(AbortSignal))
    expect(controller.snapshot.getSnapshot()).toMatchObject({
      selection: { kind: 'revision', id: REVISION },
      detail: { kind: 'revision', value: { revision: { id: REVISION }, history: [{ id: REVISION }] } },
    })

    await controller.openEvidence(SESSION, evidence)
    expect(openCitation).toHaveBeenCalledWith({
      artifactId: evidence.artifactId, versionId: evidence.versionId,
      lineStart: evidence.lineStart, lineEnd: evidence.lineEnd,
    })
    await controller.openEvidence('session-other', evidence)
    expect(openCitation).toHaveBeenCalledOnce()
  })

  it('opens evidence owned only by an older loaded revision', async () => {
    const historicalEvidence: XAgentFactEvidence = {
      ...evidence,
      citationId: '[历史资料]',
      chunkId: '00000000-0000-0000-0000-000000000605',
      lineStart: 21,
      lineEnd: 24,
    }
    const current = revision()
    const older = revision({
      id: '00000000-0000-0000-0000-000000000502',
      contentRevision: 1,
      evidence: [historicalEvidence],
    })
    const client = remote([current])
    client.revision.mockResolvedValueOnce({ ok: true, value: { revision: current, history: [current, older] } })
    const openCitation = vi.fn(async () => {})
    const controller = new XAgentFactController(client, { openCitation })
    await controller.setScope(scope())
    await controller.selectHead(REVISION)

    await controller.openEvidence(SESSION, historicalEvidence)

    expect(openCitation).toHaveBeenCalledWith({
      artifactId: historicalEvidence.artifactId,
      versionId: historicalEvidence.versionId,
      lineStart: historicalEvidence.lineStart,
      lineEnd: historicalEvidence.lineEnd,
    })
  })

  it('enforces manager/proposer actions and allows a manager to approve their own proposal', async () => {
    const specialistClient = remote([], [proposal()])
    const specialist = new XAgentFactController(specialistClient, { openCitation: vi.fn(async () => {}) })
    await specialist.setScope(scope({ actorId: SPECIALIST, role: 'specialist' }))
    await specialist.approve(PROPOSAL, '')
    await specialist.reject(PROPOSAL, '不采用')
    expect(specialistClient.approve).not.toHaveBeenCalled()
    expect(specialistClient.reject).not.toHaveBeenCalled()
    await specialist.withdraw(PROPOSAL)
    expect(specialistClient.withdraw).toHaveBeenCalledOnce()

    const approveClient = remote([], [proposal({ proposerId: MANAGER })])
    const approvingManager = new XAgentFactController(approveClient, { openCitation: vi.fn(async () => {}) })
    await approvingManager.setScope(scope())
    await approvingManager.approve(PROPOSAL, '复核通过')
    expect(approveClient.approve).toHaveBeenCalledOnce()

    const rejectClient = remote([], [proposal({ proposerId: MANAGER })])
    const rejectingManager = new XAgentFactController(rejectClient, { openCitation: vi.fn(async () => {}) })
    await rejectingManager.setScope(scope())
    await rejectingManager.reject(PROPOSAL, '信息不足')
    expect(rejectClient.reject).toHaveBeenCalledOnce()

    const withdrawClient = remote([], [proposal({ proposerId: MANAGER })])
    const withdrawingManager = new XAgentFactController(withdrawClient, { openCitation: vi.fn(async () => {}) })
    await withdrawingManager.setScope(scope())
    await withdrawingManager.withdraw(PROPOSAL)
    expect(withdrawClient.withdraw).toHaveBeenCalledOnce()
  })

  it('reuses one idempotency key only for explicit retry after an uncertain decision', async () => {
    const client = remote([], [proposal()])
    client.approve
      .mockRejectedValueOnce(new Error('connection lost after send'))
      .mockResolvedValueOnce({ ok: true, value: {
        proposalId: PROPOSAL, status: 'confirmed', factRevisionId: REVISION, contentRevision: 2,
      } })
    const keys = vi.fn().mockReturnValueOnce('decision-key-1').mockReturnValueOnce('decision-key-2')
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) }, keys)
    await controller.setScope(scope())

    await controller.approve(PROPOSAL, '同意')
    expect(controller.snapshot.getSnapshot()).toMatchObject({ action: { phase: 'uncertain', kind: 'approve', proposalId: PROPOSAL } })
    expect(JSON.stringify(controller.snapshot.getSnapshot())).not.toContain('decision-key-1')
    await controller.retryDecision()
    expect(client.approve.mock.calls.map(call => call[2].idempotencyKey)).toEqual(['decision-key-1', 'decision-key-1'])
    expect(keys).toHaveBeenCalledOnce()
  })

  it('refreshes authoritative state after conflict and blocks stale permissions without an automatic retry', async () => {
    const client = remote([], [proposal()])
    client.approve.mockImplementationOnce(() => fail('fact-revision-conflict'))
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) }, () => 'key')
    await controller.setScope(scope())
    await controller.selectProposal(PROPOSAL)
    client.proposal.mockResolvedValueOnce({ ok: true, value: proposal({ status: 'conflicted', decidedAt: '2026-09-08T10:00:00+00:00' }) })
    const otherProposal = proposal({ id: '00000000-0000-0000-0000-000000000402', label: '其他提案' })
    client['list-proposals'].mockResolvedValueOnce({ ok: true, value: { items: [otherProposal, proposal()] } })
    await controller.approve(PROPOSAL, '')
    expect(controller.snapshot.getSnapshot()).toMatchObject({ detail: { kind: 'proposal', value: { status: 'conflicted' } } })
    expect(controller.snapshot.getSnapshot()).toMatchObject({ proposals: [{ id: otherProposal.id }, { id: PROPOSAL, status: 'conflicted' }] })
    expect(controller.snapshot.getSnapshot()).toMatchObject({ action: undefined })

    const staleClient = remote([], [proposal()])
    staleClient.reject.mockImplementationOnce(() => fail('stale-permission'))
    const stale = new XAgentFactController(staleClient, { openCitation: vi.fn(async () => {}) }, () => 'key')
    await stale.setScope(scope())
    await stale.reject(PROPOSAL, '不采用')
    expect(stale.snapshot.getSnapshot()).toMatchObject({ permissionBlocked: true, decisionError: '权限已变更，请重新加载当前工作范围' })
    await stale.reject(PROPOSAL, '再试')
    expect(staleClient.reject).toHaveBeenCalledOnce()
  })

  it('keeps Fact values, reasons, evidence, keys, receipts, tokens, and URLs out of browser persistence', async () => {
    const localSet = vi.spyOn(Storage.prototype, 'setItem')
    const controller = new XAgentFactController(remote(), { openCitation: vi.fn(async () => {}) }, () => 'never-persist-key')
    await controller.setScope(scope())
    await controller.selectProposal(PROPOSAL)
    await controller.reject(PROPOSAL, '不采用私密理由')
    expect(localSet).not.toHaveBeenCalled()
    expect(Object.keys(controller.snapshot.getSnapshot())).not.toContain('receipt')
    expect(JSON.stringify(controller.snapshot.getSnapshot())).not.toContain('never-persist-key')
    localSet.mockRestore()
  })

  it('rejects new work before disposal, aborts every owner, and waits for late settlements', async () => {
    const heads = Promise.withResolvers<RemoteResult<XAgentFactPage<XAgentFactRevision>>>()
    const proposals = Promise.withResolvers<RemoteResult<XAgentFactPage<XAgentFactProposal>>>()
    const client = remote()
    client['list-heads'].mockImplementationOnce(() => heads.promise)
    client['list-proposals'].mockImplementationOnce(() => proposals.promise)
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) })
    const loading = controller.setScope(scope())
    const signals = [client['list-heads'].mock.calls[0]![2]!, client['list-proposals'].mock.calls[0]![2]!]
    let settled = false
    const disposal = controller.dispose().then(() => { settled = true })
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(controller.snapshot.getSnapshot()).toEqual({ phase: 'empty', accountId: undefined })
    expect(settled).toBe(false)
    await controller.setScope(scope())
    expect(client['list-heads']).toHaveBeenCalledOnce()
    heads.resolve({ ok: true, value: { items: [] } })
    proposals.resolve({ ok: true, value: { items: [] } })
    await Promise.all([loading, disposal])
    expect(settled).toBe(true)
  })

  it('surfaces initial, paging, and detail failures without publishing cross-project rows', async () => {
    const client = remote()
    client['list-heads'].mockRejectedValueOnce(new Error('offline'))
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) })
    await controller.setScope(scope())
    expect(controller.snapshot.getSnapshot()).toMatchObject({ phase: 'unavailable' })

    client['list-heads'].mockResolvedValueOnce({ ok: true, value: { items: [revision()], nextCursor: 'h' } })
    client['list-proposals'].mockResolvedValueOnce({ ok: true, value: { items: [proposal()], nextCursor: 'p' } })
    await controller.setScope(scope())
    client['list-heads'].mockResolvedValueOnce({ ok: false, error: { code: 'service-unavailable', message: 'x', details: {} } })
    await controller.loadMoreHeads()
    expect(controller.snapshot.getSnapshot()).toMatchObject({ listError: '无法加载更多事实' })
    client['list-proposals'].mockRejectedValueOnce(new Error('offline'))
    await controller.loadMoreProposals()
    expect(controller.snapshot.getSnapshot()).toMatchObject({ proposalsLoading: false, listError: '无法加载更多事实' })

    client.revision.mockResolvedValueOnce({ ok: true, value: { revision: revision({ projectId: 'other' }), history: [] } })
    await controller.selectHead(REVISION)
    expect(controller.snapshot.getSnapshot()).toMatchObject({ detailError: '事实详情暂时不可用' })
    client.proposal.mockRejectedValueOnce(new Error('offline'))
    await controller.selectProposal(PROPOSAL)
    expect(controller.snapshot.getSnapshot()).toMatchObject({ detailError: '事实详情暂时不可用' })
  })

  it('handles all terminal failure classes, empty reasons, and safe no-op commands', async () => {
    const client = remote([], [proposal()])
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) }, () => 'key')
    await controller.retryDecision()
    await controller.loadMoreHeads()
    await controller.selectHead(REVISION)
    await controller.setScope(scope())
    await controller.reject(PROPOSAL, '   ')
    expect(controller.snapshot.getSnapshot()).toMatchObject({ decisionError: '请输入拒绝理由' })
    client.approve.mockImplementationOnce(() => fail('service-unavailable'))
    await controller.approve(PROPOSAL, '')
    expect(controller.snapshot.getSnapshot()).toMatchObject({ action: { phase: 'uncertain' } })
    client.approve.mockImplementationOnce(() => fail('fact-already-decided'))
    client.proposal.mockResolvedValueOnce({ ok: true, value: proposal({
      status: 'confirmed', decisionActorId: MANAGER, decidedAt: '2026-09-08T10:00:00+00:00',
    }) })
    await controller.retryDecision()
    expect(controller.snapshot.getSnapshot()).toMatchObject({ decisionError: '该提案已被处理，状态已刷新' })
    expect(controller.relationshipIssue(client)).toBeUndefined()
    expect(controller.relationshipIssue(remote())).toContain('mounted Remote')
    await controller.dispose()
    controller.clear('ignored')
    await controller.dispose()
    expect(controller.snapshot.getSnapshot()).toEqual({ phase: 'empty', accountId: undefined })
  })

  it('requires every immutable evidence field and exercises every scope identity fence', async () => {
    const openCitation = vi.fn(async () => {})
    const client = remote()
    const controller = new XAgentFactController(client, { openCitation })
    await controller.setScope(scope())
    await controller.selectProposal(PROPOSAL)
    const changes: Partial<XAgentFactEvidence>[] = [
      { citationId: 'other' }, { artifactId: 'other' }, { versionId: 'other' }, { indexId: 'other' },
      { indexGeneration: 99 }, { chunkId: 'other' }, { lineStart: 99 }, { lineEnd: 99 },
    ]
    for (const change of changes) await controller.openEvidence(SESSION, { ...evidence, ...change })
    expect(openCitation).not.toHaveBeenCalled()
    for (const next of [
      scope({ accountId: 'account-other' }), scope({ actorId: 'actor-other' }),
      scope({ role: 'specialist' }), scope({ projectId: 'project-other' }),
    ]) await controller.setScope(next)
    expect(client['list-heads'].mock.calls.length).toBeGreaterThan(4)
  })

  it('suppresses a late cursor page and normalizes a missing typed reject reason defensively', async () => {
    const page = Promise.withResolvers<RemoteResult<XAgentFactPage<XAgentFactRevision>>>()
    const client = remote()
    client['list-heads'].mockResolvedValueOnce({ ok: true, value: { items: [revision()], nextCursor: 'h' } })
      .mockImplementationOnce(() => page.promise)
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) })
    await controller.setScope(scope())
    const loading = controller.loadMoreHeads()
    await Promise.resolve()
    controller.clear(ACCOUNT)
    page.resolve({ ok: true, value: { items: [revision({ label: 'late' })] } })
    await loading
    expect(JSON.stringify(controller.snapshot.getSnapshot())).not.toContain('late')
    await submitFactDecision(client, SESSION, { kind: 'reject', proposalId: PROPOSAL, idempotencyKey: 'k' }, new AbortController().signal)
    expect(client.reject).toHaveBeenLastCalledWith(SESSION, PROPOSAL, { idempotencyKey: 'k', reason: '' }, expect.any(AbortSignal))
  })

  it.each([
    ['head failure', () => fail('service-unavailable'), undefined],
    ['proposal failure', undefined, () => fail('service-unavailable')],
    ['foreign head', () => ok({ items: [revision({ projectId: 'other' })] }), undefined],
    ['foreign proposal', undefined, () => ok({ items: [proposal({ projectId: 'other' })] })],
  ])('keeps initial scope unavailable for %s', async (_label, heads, proposals) => {
    const client = remote()
    if (heads !== undefined) client['list-heads'].mockImplementationOnce(heads)
    if (proposals !== undefined) client['list-proposals'].mockImplementationOnce(proposals)
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) })
    await controller.setScope(scope())
    expect(controller.snapshot.getSnapshot()).toMatchObject({ phase: 'unavailable' })
  })

  it('rejects invalid detail identities and history fields', async () => {
    const client = remote()
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) })
    await controller.setScope(scope())
    client.revision.mockResolvedValueOnce({ ok: true, value: { revision: revision(), history: [revision({ fieldKey: 'other' })] } })
    await controller.selectHead(REVISION)
    client.proposal.mockResolvedValueOnce({ ok: true, value: proposal({ id: 'other' }) })
    await controller.selectProposal(PROPOSAL)
    client.proposal.mockResolvedValueOnce({ ok: true, value: proposal({ projectId: 'other' }) })
    await controller.selectProposal(PROPOSAL)
    expect(controller.snapshot.getSnapshot()).toMatchObject({ detailError: '事实详情暂时不可用' })
  })

  it('suppresses late rejected pages/details and late decision results', async () => {
    const client = remote()
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) })
    client['list-proposals'].mockResolvedValueOnce({ ok: true, value: { items: [proposal()], nextCursor: 'p' } })
    await controller.setScope(scope())
    const page = Promise.withResolvers<RemoteResult<XAgentFactPage<XAgentFactProposal>>>()
    client['list-proposals'].mockImplementationOnce(() => page.promise)
    const paging = controller.loadMoreProposals()
    controller.clear(ACCOUNT)
    page.reject(new Error('late'))
    await paging

    await controller.setScope(scope())
    const detail = Promise.withResolvers<RemoteResult<XAgentFactProposal>>()
    client.proposal.mockImplementationOnce(() => detail.promise)
    const selecting = controller.selectProposal(PROPOSAL)
    controller.clear(ACCOUNT)
    detail.reject(new Error('late'))
    await selecting

    await controller.setScope(scope())
    const decision = Promise.withResolvers<RemoteResult<XAgentFactProposalDecision>>()
    client.approve.mockImplementationOnce(() => decision.promise)
    const approving = controller.approve(PROPOSAL, '')
    controller.clear(ACCOUNT)
    decision.resolve({ ok: true, value: { proposalId: PROPOSAL, status: 'confirmed' } })
    await approving
    expect(controller.snapshot.getSnapshot()).toEqual({ phase: 'empty', accountId: ACCOUNT })
  })

  it('refreshes a selected revision after a decision', async () => {
    const client = remote([revision()], [proposal()])
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) })
    await controller.setScope(scope())
    await controller.selectHead(REVISION)
    await controller.approve(PROPOSAL, '')
    expect(client.revision.mock.calls.length).toBeGreaterThan(1)

  })

  it.each([
    ['heads after success', 'success', 'heads'],
    ['proposals after success', 'success', 'proposals'],
    ['detail after success', 'success', 'detail'],
    ['detail after a terminal conflict', 'terminal', 'detail'],
  ] as const)('fails closed when reloading %s fails', async (_label, decision, failedRoute) => {
    const stale = proposal({ label: '不得保留的待审提案' })
    const client = remote([revision()], [stale])
    if (decision === 'terminal') client.approve.mockImplementationOnce(() => fail('fact-revision-conflict'))
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) }, () => 'key')
    await controller.setScope(scope())
    await controller.selectProposal(PROPOSAL)
    const decided = proposal({
      status: decision === 'terminal' ? 'conflicted' : 'confirmed',
      decisionActorId: MANAGER,
      decidedAt: '2026-09-08T10:00:00+00:00',
    })
    if (failedRoute !== 'detail') client.proposal.mockResolvedValueOnce({ ok: true, value: decided })
    if (failedRoute === 'heads') client['list-heads'].mockRejectedValueOnce(new Error('refresh heads'))
    if (failedRoute === 'proposals') client['list-proposals'].mockImplementationOnce(() => fail('service-unavailable'))
    if (failedRoute === 'detail') client.proposal.mockRejectedValueOnce(new Error('refresh detail'))

    await controller.approve(PROPOSAL, '')

    expect(controller.snapshot.getSnapshot()).toMatchObject({
      heads: [], proposals: [], selection: undefined, detail: undefined, action: undefined,
      listError: '提案状态可能已变更，无法重新加载事实',
    })
    expect(JSON.stringify(controller.snapshot.getSnapshot())).not.toContain('不得保留的待审提案')
    await controller.approve(PROPOSAL, '')
    expect(client.approve).toHaveBeenCalledOnce()
  })

  it('fails closed when a selected revision refresh returns a mismatched detail', async () => {
    const client = remote([revision()], [proposal()])
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) }, () => 'key')
    await controller.setScope(scope())
    await controller.selectHead(REVISION)
    client.revision.mockResolvedValueOnce({ ok: true, value: {
      revision: revision({ projectId: 'other-project' }),
      history: [],
    } })

    await controller.approve(PROPOSAL, '')

    expect(controller.snapshot.getSnapshot()).toMatchObject({
      heads: [], proposals: [], selection: undefined, detail: undefined,
      listError: '提案状态可能已变更，无法重新加载事实',
    })
  })

  it('suppresses a refresh that settles after the scope is cleared', async () => {
    const client = remote([], [proposal()])
    const refreshHeads = Promise.withResolvers<RemoteResult<XAgentFactPage<XAgentFactRevision>>>()
    client['list-heads'].mockResolvedValueOnce({ ok: true, value: { items: [] } }).mockImplementationOnce(() => refreshHeads.promise)
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) })
    await controller.setScope(scope())
    const approving = controller.approve(PROPOSAL, '')
    await Promise.resolve()
    await Promise.resolve()
    controller.clear(ACCOUNT)
    refreshHeads.resolve({ ok: true, value: { items: [] } })
    await approving
    expect(controller.snapshot.getSnapshot()).toEqual({ phase: 'empty', accountId: ACCOUNT })
  })

  it('freezes concurrent proposal cursor ownership and suppresses late decision rejection', async () => {
    const client = remote([], [proposal()])
    const page = Promise.withResolvers<RemoteResult<XAgentFactPage<XAgentFactProposal>>>()
    client['list-proposals'].mockResolvedValueOnce({ ok: true, value: { items: [proposal()], nextCursor: 'p' } }).mockImplementationOnce(() => page.promise)
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) })
    await controller.setScope(scope())
    const first = controller.loadMoreProposals()
    const second = controller.loadMoreProposals()
    page.resolve({ ok: true, value: { items: [] } })
    await Promise.all([first, second])
    expect(client['list-proposals']).toHaveBeenCalledTimes(2)

    const rejected = Promise.withResolvers<RemoteResult<XAgentFactProposalDecision>>()
    client.approve.mockImplementationOnce(() => rejected.promise)
    const approving = controller.approve(PROPOSAL, '')
    controller.clear(ACCOUNT)
    rejected.reject(new Error('late'))
    await approving
    expect(controller.snapshot.getSnapshot()).toEqual({ phase: 'empty', accountId: ACCOUNT })
  })

  it('suppresses conflict refresh publication after scope loss', async () => {
    const client = remote([], [proposal()])
    const refreshHeads = Promise.withResolvers<RemoteResult<XAgentFactPage<XAgentFactRevision>>>()
    client.approve.mockImplementationOnce(() => fail('fact-revision-conflict'))
    client['list-heads'].mockResolvedValueOnce({ ok: true, value: { items: [] } }).mockImplementationOnce(() => refreshHeads.promise)
    const controller = new XAgentFactController(client, { openCitation: vi.fn(async () => {}) })
    await controller.setScope(scope())
    const approving = controller.approve(PROPOSAL, '')
    await Promise.resolve(); await Promise.resolve()
    controller.clear(ACCOUNT)
    refreshHeads.resolve({ ok: true, value: { items: [] } })
    await approving
    expect(controller.snapshot.getSnapshot()).toEqual({ phase: 'empty', accountId: ACCOUNT })
  })
})
