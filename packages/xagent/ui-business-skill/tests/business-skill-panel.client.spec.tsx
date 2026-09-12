// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BusinessSkillPanel } from '../src/client/BusinessSkillPanel.tsx'
import { BusinessSkillStore, type BusinessSkillState } from '../src/client/store.ts'
import { detail } from './fixtures.client.ts'

afterEach(cleanup)
function mount(role: 'manager' | 'specialist' = 'manager', override?: Parameters<BusinessSkillStore['replace']>[0]) {
  const store = new BusinessSkillStore()
  store.replace(override ?? { phase: 'ready', scope: { accountId: 'a', projectId: 'p', sessionId: 's', role, generation: {} }, items: [detail], selected: detail.slug, detail })
  const actions = {
    mutate: vi.fn(async () => 'succeeded' as const), select: vi.fn(async () => {}), refresh: vi.fn(async () => {}), loadMore: vi.fn(async () => {}),
    loadHistory: vi.fn(async () => {}), openTranscript: vi.fn(async () => {}), retryMutation: vi.fn(async () => 'succeeded' as const),
  }
  render(<BusinessSkillPanel {...actions} useSkills={selector => selector(useSyncExternalStore(store.subscribe, store.getSnapshot))}
    useSessions={vi.fn() as never} useWorkspaces={vi.fn() as never} />)
  return { store, actions }
}
describe('Business Skill release dossier', () => {
  it('creates a new draft through the closed tool selector and returns to the dossier', async () => {
    const { actions } = mount()
    fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }))
    expect(screen.getByRole('button', { name: '创建草稿' }).matches(':disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'new-review' } })
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '新流程' } })
    fireEvent.change(screen.getByLabelText('目录说明'), { target: { value: '审核项目' } })
    fireEvent.change(screen.getByLabelText('Markdown 指令'), { target: { value: '# 审核项目' } })
    const checkbox = screen.getByRole('checkbox', { name: /查看可访问项目/ })
    fireEvent.click(checkbox); fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('checkbox', { name: /检索项目资料/ }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '创建草稿' })) })
    expect(actions.mutate).toHaveBeenCalledWith({ kind: 'create', input: { slug: 'new-review', displayName: '新流程', description: '审核项目', instructions: '# 审核项目', primaryTools: ['search_artifacts'] } }, 0)
    expect(screen.getByRole('article', { name: 'Skill 详情' })).toBeTruthy()
  })

  it('exposes only refresh on an unavailable draft instead of sending a guessed revision', () => {
    const { store, actions } = mount()
    const state = store.getSnapshot() as Extract<BusinessSkillState, { phase: 'ready' }>
    const { draft: _draft, ...withoutDraft } = detail
    act(() => { store.replace({ ...state, detail: withoutDraft }) })
    expect(screen.queryByRole('button', { name: '保存草稿' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(actions.refresh).toHaveBeenCalledOnce()
  })

  it('shows immutable versions, transcript events and audit, with explicit authorize and version confirmation', () => {
    const { store, actions } = mount()
    const state = store.getSnapshot() as Extract<BusinessSkillState, { phase: 'ready' }>
    const version = { versionNumber: 1, description: '第一版', instructions: '# 固定版本', primaryTools: ['search_artifacts'], completeTools: ['skill', 'search_artifacts', 'submit_cited_answer'], contentDigest: 'content', toolPolicyDigest: 'policy', sourceDraftRevision: 1, publishedAt: '2026-09-11' }
    act(() => { store.replace({ ...state, cursor: 'next', detail: { ...detail, currentVersion: 2, versions: [version, { ...version, versionNumber: 2 }], nextVersionCursor: 1, nextRunCursor: 3, auditSummary: [{ action: 'publish', result: 'published', versionNumber: 2, createdAt: '2026-09-12' }, { action: 'create', result: 'created', createdAt: '2026-09-11' }] }, transcript: { test: detail.tests[0]!, events: [{ sequence: 1, eventType: 'assistant/message', payload: { content: '审查完成' }, createdAt: '2026-09-12' }], nextSequence: 2 } }) })
    expect(screen.getByText(/审查完成/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续读取测试记录' }))
    expect(actions.openTranscript).toHaveBeenCalledWith(3, true)
    fireEvent.click(screen.getByRole('button', { name: '更多版本' })); fireEvent.click(screen.getByRole('button', { name: '更多测试' })); fireEvent.click(screen.getByRole('button', { name: '更多 Skill' }))
    expect(actions.loadHistory.mock.calls).toEqual([['versions'], ['tests']]); expect(actions.loadMore).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '授权使用' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认授权' }))
    expect(actions.mutate).toHaveBeenCalledWith({ kind: 'authorization', slug: 'review-facts', authorized: true }, 0)
    fireEvent.click(screen.getByRole('button', { name: '切换至 v1' }))
    expect(screen.getByRole('dialog').textContent).toMatch(/v1/)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认切换' }))
    expect(actions.mutate).toHaveBeenCalledWith({ kind: 'version', slug: 'review-facts', version: 1 }, 0)
    const updated = store.getSnapshot() as typeof state
    act(() => { store.replace({ ...updated, detail: { ...updated.detail!, authorized: true } }) })
    fireEvent.click(screen.getByRole('button', { name: '取消授权' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认取消授权' }))
    expect(actions.mutate).toHaveBeenCalledWith({ kind: 'authorization', slug: 'review-facts', authorized: false }, 0)
  })

  it('requires a new qualifying run for changed digests and exposes failed, running and rejected history', () => {
    const { store, actions } = mount()
    const state = store.getSnapshot() as Extract<BusinessSkillState, { phase: 'ready' }>
    const { terminationReason: _reason, verdict: _verdict, ...running } = detail.tests[0]!
    act(() => { store.replace({ ...state, items: [{ ...detail, status: 'retired', currentVersion: 1, latestTest: detail.tests[0]! }], detail: { ...detail, draft: { ...detail.draft!, contentDigest: 'changed' }, tests: [{ ...detail.tests[0]!, status: 'failed', verdict: 'reject', unexecutedWriteTools: [] }, { ...running, runNumber: 4, status: 'running' }, { ...running, runNumber: 5, status: 'cancelled' }] } }) })
    expect(screen.getByRole('button', { name: '发布版本' }).matches(':disabled')).toBe(true)
    expect(screen.getByText('需要当前草稿的完成测试与人工通过')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '人工拒绝 run 3' }))
    expect(actions.mutate).toHaveBeenCalledWith({ kind: 'verdict', slug: 'review-facts', run: 3, verdict: 'reject' }, 0)
    fireEvent.click(screen.getByRole('button', { name: /审核项目事实.*review-facts/ }))
    expect(actions.select).toHaveBeenCalledWith('review-facts')
  })

  it('localizes test and audit protocol values before rendering them', () => {
    const { store } = mount()
    const state = store.getSnapshot() as Extract<BusinessSkillState, { phase: 'ready' }>
    const base = detail.tests[0]!
    const { verdict: _verdict, verdictAt: _verdictAt, ...unreviewed } = base
    act(() => { store.replace({
      ...state,
      items: [{ ...detail, latestTest: { ...base, status: 'failed', terminationReason: 'tool-denied', verdict: 'reject' } }],
      detail: {
        ...detail,
        tests: [
          { ...base, status: 'failed', terminationReason: 'tool-denied', verdict: 'reject' },
          { ...unreviewed, runNumber: 4, status: 'failed', terminationReason: 'authorization-denied' },
          { ...unreviewed, runNumber: 5, status: 'failed', terminationReason: 'skill-not-loaded' },
          { ...unreviewed, runNumber: 6, status: 'failed', terminationReason: 'service-unavailable' },
        ],
        auditSummary: [
          { action: 'business_skill.test_start', result: 'running', createdAt: '2026-09-12' },
          { action: 'business_skill.test_settle', result: 'completed', createdAt: '2026-09-12' },
          { action: 'business_skill.test_settle', result: 'failed', createdAt: '2026-09-12' },
          { action: 'business_skill.test_settle', result: 'cancelled', createdAt: '2026-09-12' },
          { action: 'business_skill.publish', result: 'published', versionNumber: 2, createdAt: '2026-09-12' },
          { action: 'business_skill.tool_authorization_denied', result: 'business-skill-tool-denied', createdAt: '2026-09-12' },
          { action: 'business_skill.future_action', result: 'future-result', createdAt: '2026-09-12' },
        ],
      },
    }) })

    expect(screen.getByText(/最近测试 失败/)).toBeTruthy()
    for (const label of ['工具被拒绝', '授权被拒绝', 'Skill 未加载', '服务不可用', '开始测试 · 运行中', '结束测试 · 已完成',
      '结束测试 · 失败', '结束测试 · 已取消', '发布版本 · 已发布', '工具授权被拒绝 · 工具不在允许范围', '未知操作 · 未知结果']) {
      expect(screen.getAllByText(new RegExp(label)).length).toBeGreaterThan(0)
    }
    expect(screen.queryByText(
      /tool-denied|authorization-denied|skill-not-loaded|service-unavailable|business_skill\.|running|completed|failed|cancelled/,
    )).toBeNull()
  })

  it('renders empty, loading, blocked, submitting, uncertain and retired ready states', () => {
    const { store, actions } = mount()
    const state = store.getSnapshot() as Extract<BusinessSkillState, { phase: 'ready' }>
    act(() => { store.replace({ ...state, items: [], detail: undefined }) })
    expect(screen.getByText(/暂无业务 Skill/)).toBeTruthy()
    act(() => { store.replace({ ...state, detailLoading: true }) })
    expect(screen.getByRole('status').textContent).toMatch(/详情/)
    act(() => { store.replace({ ...state, error: '权限改变', blocked: true, action: 'submitting' }) })
    expect(screen.getByRole('alert').textContent).toBe('权限改变')
    expect(screen.getByRole('button', { name: '保存草稿' }).matches(':disabled')).toBe(true)
    act(() => { store.replace({ ...state, action: 'uncertain' }) })
    fireEvent.click(screen.getByRole('button', { name: '使用原请求重试' }))
    expect(actions.retryMutation).toHaveBeenCalledOnce()
    act(() => { store.replace({ ...state, detail: { ...detail, status: 'retired', tests: [], authorized: false } }) })
    expect(screen.getByText('已退役 · 不可恢复')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存草稿' })).toBeNull()
    expect(screen.getByText(/暂无测试/)).toBeTruthy()
  })

  it('dismisses a confirmation with no mutation, including Escape', () => {
    const { actions } = mount()
    fireEvent.click(screen.getByRole('button', { name: '退役 Skill' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '退役 Skill' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(actions.mutate).not.toHaveBeenCalled()
  })
  it.each([
    [{ phase: 'empty' }, '请选择项目会话以管理业务 Skill'],
    [{ phase: 'loading' }, '正在加载业务 Skill…'],
    [{ phase: 'error', error: '加载失败' }, '加载失败'],
  ] as const)('shows %s with an actionable status', (state, expected) => {
    mount('manager', state)
    expect(screen.getByText(expected)).toBeTruthy()
  })
  it('refreshes an unavailable panel and publishes a read-only draft without write permissions', () => {
    const { store, actions } = mount('manager', { phase: 'error', error: '加载失败' })
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
    expect(actions.refresh).toHaveBeenCalledOnce()
    const { draftRevision: _revision, ...summary } = detail
    act(() => { store.replace({ phase: 'ready', scope: { accountId: 'a', projectId: 'p', sessionId: 's', role: 'manager', generation: {} }, items: [{ ...summary, authorized: true }], selected: detail.slug, detail: { ...detail, draft: { ...detail.draft!, primaryTools: [] } } }) })
    expect(screen.getByText(/草稿 —/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '发布版本' }))
    expect(screen.getByRole('dialog').textContent).toMatch(/生产写权限：无/)
  })
  it('saves Markdown against the displayed revision and starts one exact scenario', () => {
    const { actions } = mount('specialist')
    fireEvent.change(screen.getByLabelText('Markdown 指令'), { target: { value: '# 新审核' } })
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    expect(actions.mutate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'draft', slug: 'review-facts' }), 0)
    expect(actions.mutate.mock.calls[0]).toMatchObject([{ input: { expectedDraftRevision: 2, instructions: '# 新审核' } }, 0])
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
    fireEvent.change(screen.getByLabelText('测试场景'), { target: { value: '审核项目的事实证据' } })
    fireEvent.click(screen.getByRole('button', { name: '运行只读测试' }))
    expect(actions.mutate).toHaveBeenCalledWith({ kind: 'test', slug: 'review-facts', revision: 2, policy: 'policy', scenario: '审核项目的事实证据' }, 0)
  })
  it('shows exact test provenance and keeps manager actions absent for Specialists', () => {
    const { actions } = mount('specialist')
    expect(screen.getByRole('list', { name: '发布流程' }).textContent).toMatch(/Draft.*Test.*Publish.*Authorize/)
    for (const name of ['发布版本', '授权使用', '取消授权', '切换版本', '退役 Skill']) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.getByText(/测试未执行的生产写权限：propose_fact/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看测试 run 3' }))
    expect(actions.openTranscript).toHaveBeenCalledWith(3)
    fireEvent.click(screen.getByRole('button', { name: '人工通过 run 3' }))
    expect(actions.mutate).toHaveBeenCalledWith({ kind: 'verdict', slug: 'review-facts', run: 3, verdict: 'pass' }, 0)
  })
  it('publication confirmation binds the exact revision, qualifying run and write permissions', () => {
    const { actions } = mount()
    fireEvent.click(screen.getByRole('button', { name: '发布版本' }))
    const dialog = screen.getByRole('dialog', { name: '确认发布版本' })
    expect(dialog.textContent).toMatch(/revision 2/)
    expect(dialog.textContent).toMatch(/run 3/)
    expect(dialog.textContent).toMatch(/propose_fact/)
    fireEvent.click(within(dialog).getByRole('button', { name: '确认发布' }))
    expect(actions.mutate).toHaveBeenCalledWith({ kind: 'publish', slug: 'review-facts', revision: 2 }, 0)
  })
  it('retirement explains terminal state and immediate unauthorization before sending', () => {
    const { actions } = mount()
    fireEvent.click(screen.getByRole('button', { name: '退役 Skill' }))
    const dialog = screen.getByRole('dialog', { name: '确认退役 Skill' })
    expect(dialog.textContent).toMatch(/不可恢复/)
    expect(dialog.textContent).toMatch(/立即取消授权/)
    expect(actions.mutate).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认退役' }))
    expect(actions.mutate).toHaveBeenCalledWith({ kind: 'retire', slug: 'review-facts' }, 0)
  })
})
