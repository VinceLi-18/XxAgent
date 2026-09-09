// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { XAgentFactProposal, XAgentFactRevision } from '@xagent/dsh-fact/types'
import { FactPanel } from '../src/client/FactPanel.tsx'
import { XAgentFactStore } from '../src/client/store.ts'
import { factStatusText } from '../src/client/locales.ts'

const PROJECT = '00000000-0000-0000-0000-000000000201'
const SESSION = 'session-00000000-0000-0000-0000-000000000301'
const ACTOR = '00000000-0000-0000-0000-000000000102'
const PROPOSAL = '00000000-0000-0000-0000-000000000401'
const REVISION = '00000000-0000-0000-0000-000000000501'
const evidence = { citationId: '[资料1]', artifactId: 'a', versionId: 'v', indexId: 'i', indexGeneration: 1, chunkId: 'c', lineStart: 2, lineEnd: 4 }

const head: XAgentFactRevision = { id: REVISION, projectId: PROJECT, fieldKey: 'customer.arr', label: '年度金额', value: { type: 'number', value: 810000 }, contentRevision: 2, proposalId: PROPOSAL, proposerId: 'p', confirmedById: ACTOR, evidence: [evidence], createdAt: '2026-09-08T09:00:00Z' }
const pending: XAgentFactProposal = { id: PROPOSAL, projectId: PROJECT, fieldKey: 'renewal.date', label: '续约日期', value: { type: 'date', value: '2027-03-15' }, proposerId: ACTOR, baseRevision: 1, assertionReason: '客户当面确认', status: 'pending', evidence: [evidence], createdAt: '2026-09-08T08:00:00Z', admittedAt: '2026-09-08T08:01:00Z' }

function props(store: XAgentFactStore) {
  return {
    useSessions: vi.fn() as never,
    useWorkspaces: vi.fn() as never,
    useFacts: <S,>(selector: (value: ReturnType<XAgentFactStore['getSnapshot']>) => S) => selector(
      useSyncExternalStore(store.subscribe, store.getSnapshot),
    ),
    selectHead: vi.fn(async () => {}),
    selectProposal: vi.fn(async () => {}),
    loadMoreHeads: vi.fn(async () => {}),
    loadMoreProposals: vi.fn(async () => {}),
    approve: vi.fn(async () => {}),
    reject: vi.fn(async () => {}),
    withdraw: vi.fn(async () => {}),
    retryDecision: vi.fn(async () => {}),
    openEvidence: vi.fn(async () => {}),
  }
}

afterEach(cleanup)

describe('Fact review workbench', () => {
  it('renders compact current and pending lists and keeps typed values legible', () => {
    const store = new XAgentFactStore()
    store.replace({ phase: 'ready', accountId: 'a', actorId: ACTOR, role: 'manager', projectId: PROJECT, sessionId: SESSION, heads: [head], proposals: [pending] })
    render(<FactPanel {...props(store)} />)
    expect(screen.getByRole('region', { name: '事实审阅工作台' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /打开当前事实“年度金额”/ }).textContent).toContain('810,000')
    expect(screen.getByRole('button', { name: /审阅提案“续约日期”/ }).textContent).toContain('2027-03-15')
  })

  it('shows a newest-first revision ledger and opens exact evidence', () => {
    const store = new XAgentFactStore()
    const older = { ...head, id: 'older', contentRevision: 1, value: { type: 'number' as const, value: 700000 } }
    store.replace({ phase: 'ready', accountId: 'a', actorId: ACTOR, role: 'manager', projectId: PROJECT, sessionId: SESSION, heads: [head], proposals: [], selection: { kind: 'revision', id: REVISION }, detail: { kind: 'revision', value: { revision: head, history: [head, older] } } })
    const injected = props(store)
    render(<FactPanel {...injected} />)
    const ledger = screen.getByRole('list', { name: '修订记录' })
    expect(within(ledger).getAllByRole('listitem').map(item => item.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('v2'), expect.stringContaining('v1')]))
    expect(within(ledger).getAllByText(`确认人：${ACTOR}`)).toHaveLength(2)
    expect(within(ledger).getAllByRole('button', { name: '打开证据 [资料1]，第 2 至 4 行' })).toHaveLength(2)
    fireEvent.click(within(ledger).getAllByRole('button', { name: '打开证据 [资料1]，第 2 至 4 行' })[0]!)
    expect(injected.openEvidence).toHaveBeenCalledWith(SESSION, evidence)
  })

  it('offers role-aware confirm dialogs and exact uncertain retry', async () => {
    const store = new XAgentFactStore()
    store.replace({ phase: 'ready', accountId: 'a', actorId: ACTOR, role: 'manager', projectId: PROJECT, sessionId: SESSION, heads: [], proposals: [pending], selection: { kind: 'proposal', id: PROPOSAL }, detail: { kind: 'proposal', value: pending } })
    const injected = props(store)
    render(<FactPanel {...injected} />)
    expect(screen.getByText(`提案人：${ACTOR}`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '拒绝提案' }))
    let dialog = screen.getByRole('dialog', { name: '拒绝事实提案' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '拒绝提案' }))
    dialog = screen.getByRole('dialog', { name: '拒绝事实提案' })
    fireEvent.change(within(dialog).getByLabelText('拒绝理由'), { target: { value: '资料不足' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认拒绝' }))
    expect(injected.reject).toHaveBeenCalledWith(PROPOSAL, '资料不足')

    store.replaceReady({ action: { phase: 'uncertain', kind: 'reject', proposalId: PROPOSAL }, decisionError: '服务响应中断' })
    fireEvent.click(await screen.findByRole('button', { name: '使用原请求重试' }))
    expect(injected.retryDecision).toHaveBeenCalledOnce()
  })

  it('covers status, empty, loading, error, pagination, and all typed value states', async () => {
    const store = new XAgentFactStore()
    const injected = props(store)
    const view = render(<FactPanel {...injected} />)
    expect(screen.getByRole('status')).toBeTruthy()
    store.replace({ phase: 'unavailable', accountId: 'a', error: '暂不可用' })
    expect((await screen.findByRole('alert')).textContent).toContain('暂不可用')
    store.replace({ phase: 'ready', accountId: 'a', actorId: 'other', role: 'specialist', projectId: PROJECT, sessionId: SESSION,
      heads: [{ ...head, value: { type: 'boolean', value: false } }, { ...head, id: 'true', value: { type: 'boolean', value: true } }, { ...head, id: 'text', value: { type: 'text', value: '星河' } }],
      proposals: [{ ...pending, proposerId: 'other', status: 'confirmed', decisionReason: '已核对' }], headsCursor: 'h', proposalsCursor: 'p', listError: '列表中断' })
    expect(await screen.findByText('否')).toBeTruthy()
    expect(screen.getByText('是')).toBeTruthy()
    expect(screen.getByText('星河')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('列表中断')
    fireEvent.click(screen.getAllByRole('button', { name: '加载更多' })[0]!)
    fireEvent.click(screen.getAllByRole('button', { name: '加载更多' })[1]!)
    fireEvent.click(screen.getAllByRole('button', { name: /打开当前事实“年度金额”/ })[0]!)
    fireEvent.click(screen.getByRole('button', { name: /审阅提案/ }))
    expect(injected.loadMoreHeads).toHaveBeenCalledOnce()
    expect(injected.loadMoreProposals).toHaveBeenCalledOnce()
    expect(injected.selectHead).toHaveBeenCalledOnce()
    expect(injected.selectProposal).toHaveBeenCalledOnce()
    store.replaceReady({ heads: [], proposals: [], headsCursor: undefined, proposalsCursor: undefined, listError: undefined })
    expect(await screen.findByText('当前项目会话还没有事实')).toBeTruthy()
    view.unmount()
  })

  it('renders detail loading/failure/evidence-free decided proposal and approve/withdraw dialogs', async () => {
    const store = new XAgentFactStore()
    const injected = props(store)
    store.replace({ phase: 'ready', accountId: 'a', actorId: ACTOR, role: 'manager', projectId: PROJECT, sessionId: SESSION, heads: [], proposals: [pending], detailLoading: true })
    render(<FactPanel {...injected} />)
    expect(screen.getByRole('status').textContent).toContain('正在加载详情')
    store.replaceReady({ detailLoading: false, detailError: '详情中断' })
    expect((await screen.findByRole('alert')).textContent).toContain('详情中断')
    store.replaceReady({ detailError: undefined, detail: { kind: 'proposal', value: { ...pending, evidence: [], status: 'confirmed', decisionReason: '经理确认' } } })
    expect(await screen.findByText('已确认')).toBeTruthy()
    expect(screen.getByText('未提供证据')).toBeTruthy()
    expect(screen.getByText(/经理确认/)).toBeTruthy()
    store.replaceReady({ detail: { kind: 'proposal', value: pending } })
    fireEvent.click(await screen.findByRole('button', { name: '批准提案' }))
    fireEvent.change(screen.getByLabelText('决定备注'), { target: { value: '  同意  ' } })
    fireEvent.click(screen.getByRole('button', { name: '确认批准' }))
    expect(injected.approve).toHaveBeenCalledWith(PROPOSAL, '  同意  ')
    fireEvent.click(screen.getByRole('button', { name: '撤回提案' }))
    fireEvent.click(screen.getByRole('button', { name: '确认撤回' }))
    expect(injected.withdraw).toHaveBeenCalledWith(PROPOSAL)
    fireEvent.click(screen.getByRole('button', { name: '批准提案' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    store.replaceReady({ detail: undefined })
    expect(await screen.findByText('选择一项查看服务器详情')).toBeTruthy()
    expect(factStatusText('future')).toBe('future')
  })

  it('contains subscriber failures and ignores ready patches outside a ready scope', () => {
    const store = new XAgentFactStore()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = store.subscribe(() => { throw new Error('listener') })
    store.replace({ phase: 'loading', accountId: 'a', projectId: PROJECT, sessionId: SESSION })
    store.replaceReady({ detailError: 'ignored' })
    expect(store.getSnapshot()).not.toHaveProperty('detailError')
    expect(error).toHaveBeenCalledOnce()
    stop(); error.mockRestore()
  })
})
