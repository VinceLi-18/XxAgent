// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BusinessSkillPanel } from '../src/client/BusinessSkillPanel.tsx'
import { BusinessSkillController } from '../src/client/service.ts'
import { detail, scope, ok, remoteFixture } from './fixtures.client.ts'

afterEach(cleanup)
async function mount() {
  const remote = remoteFixture()
  const controller = new BusinessSkillController(remote)
  await controller.setScope(scope)
  render(<BusinessSkillPanel
    useSkills={selector => selector(useSyncExternalStore(controller.snapshot.subscribe, controller.snapshot.getSnapshot))}
    select={slug => controller.select(slug)} refresh={() => controller.refresh()} loadMore={() => controller.loadMore()}
    loadHistory={kind => controller.loadHistory(kind)} openTranscript={(run, more) => controller.openTranscript(run, more)}
    mutate={request => controller.mutate(request)} retryMutation={() => controller.retryMutation()}
    useSessions={vi.fn() as never} useWorkspaces={vi.fn() as never} />)
  return { remote, controller }
}
function fill() {
  fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }))
  for (const [label, value] of [['Slug', 'new-review'], ['显示名称', '新流程'], ['目录说明', '审核项目'], ['Markdown 指令', '# 未保存的审核']]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } })
  }
  fireEvent.click(screen.getByRole('checkbox', { name: /生产写权限/ }))
}
function retained() {
  expect(screen.getByLabelText<HTMLInputElement>('Slug').value).toBe('new-review')
  expect(screen.getByLabelText<HTMLInputElement>('显示名称').value).toBe('新流程')
  expect(screen.getByLabelText<HTMLInputElement>('目录说明').value).toBe('审核项目')
  expect(screen.getByLabelText<HTMLTextAreaElement>('Markdown 指令').value).toBe('# 未保存的审核')
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /生产写权限/ }).checked).toBe(true)
}

it.each(['input-invalid', 'business-skill-conflict', 'business-skill-revision-conflict', 'forbidden', 'service-unavailable', 'transport'])(
  'retains create inputs after %s and closes only after an authoritative success', async (code) => {
    const { remote, controller } = await mount()
    if (code === 'transport') remote.create.mockRejectedValueOnce(new Error('connection lost'))
    else remote.create.mockResolvedValueOnce({ ok: false, error: { code, message: 'rejected', details: {} } })
    fill()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '创建草稿' })) })
    retained()
    expect(screen.getByRole('alert')).toBeTruthy()
    remote.create.mockResolvedValueOnce(ok({ ...detail, slug: 'new-review' }))
    if (code === 'forbidden') {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新加载' })) })
      retained()
    }
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: ['service-unavailable', 'transport'].includes(code) ? '使用原请求重试' : '创建草稿' })) })
    expect(screen.queryByLabelText('Slug')).toBeNull()
    expect(screen.getByRole('article', { name: 'Skill 详情' }).textContent).toContain('/new-review')
    fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }))
    expect(screen.getByLabelText<HTMLInputElement>('Slug').value).toBe('')
    await act(() => controller.dispose())
  },
)

it.each(['accountId', 'projectId', 'sessionId', 'generation', 'role'] as const)('forgets retained input when its %s owner changes', async (field) => {
  const { controller } = await mount()
  fill()
  await act(() => controller.setScope({ ...scope, [field]: field === 'generation' ? {} : field === 'role' ? 'specialist' : 'other' }))
  fireEvent.click(screen.getByRole('button', { name: '新建 Skill' }))
  expect(screen.getByLabelText<HTMLInputElement>('Slug').value).toBe('')
  act(() => { controller.clear() })
  expect(screen.queryByLabelText('Slug')).toBeNull()
  await controller.dispose()
})

it('retains create inputs through an aborted same-scope reload and ignores its late success', async () => {
  const { remote, controller } = await mount()
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.create>>>()
  remote.create.mockReturnValueOnce(pending.promise)
  fill()
  fireEvent.click(screen.getByRole('button', { name: '创建草稿' }))
  await act(() => controller.refresh())
  await act(async () => { pending.resolve(ok({ ...detail, slug: 'old-success' })); await pending.promise })
  retained()
  await act(() => controller.dispose())
})

it('retains a test scenario through an authoritative stale-draft refresh', async () => {
  const { remote, controller } = await mount()
  remote.test.mockResolvedValueOnce({ ok: false, error: { code: 'business-skill-policy-changed', message: 'changed', details: {} } })
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof remote.detail>>>()
  remote.detail.mockReturnValueOnce(pending.promise)
  fireEvent.change(screen.getByLabelText('测试场景'), { target: { value: '保留测试场景' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '运行只读测试' })) })
  await act(async () => { pending.resolve(ok(detail)); await pending.promise })
  expect(screen.getByLabelText<HTMLTextAreaElement>('测试场景').value).toBe('保留测试场景')
  await act(() => controller.dispose())
})

it('clears the retained scenario when the actor explicitly selects a Skill', async () => {
  const { controller } = await mount()
  fireEvent.change(screen.getByLabelText('测试场景'), { target: { value: '上一选择的场景' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(`/${detail.slug}`) })) })
  expect(screen.getByLabelText<HTMLTextAreaElement>('测试场景').value).toBe('')
  await act(() => controller.dispose())
})
