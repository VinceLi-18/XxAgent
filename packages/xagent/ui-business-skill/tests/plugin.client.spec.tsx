// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { InvariantRegistry } from '@deepseek-ai/dsh-invariants'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { BusinessSkillPanel, type BusinessSkillPanelInjected } from '../src/client/BusinessSkillPanel.tsx'
import { validateBusinessSkillUi } from '../src/invariant.ts'
import * as invariant from '../src/invariant.ts'
import { remoteFixture } from './fixtures.client.ts'
import { apply as applyHost } from '../src/index.ts'

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    replace: (next: T) => { value = next; listeners.forEach((listener) => { listener() }) }, listeners }
}
describe('Business Skill browser ownership', () => {
  it('keeps Host-only assembly inert and accepts an absent browser owner', async () => {
    applyHost()
    expect(() => { validateBusinessSkillUi(new Context(), (message) => { throw new Error(message) }) }).not.toThrow()
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry).await()
    await ctx.plugin(invariant).await()
    await ctx.fiber.dispose()
  })

  it('unmounts the generated namespace when feature assembly fails', async () => {
    const failed = new Error('feature startup')
    const disposed: string[] = []
    const context = {
      remote: { $mount: async () => async () => { disposed.push('remote') } },
      inject: () => ({ await: async () => { throw failed }, dispose: async () => { disposed.push('feature') } }),
    }
    await expect(apply(context as never)).rejects.toBe(failed)
    expect(disposed).toEqual(['feature', 'remote'])
  })
  it('mounts the generated Remote and one live Slot, follows scope, and removes every subscription', async () => {
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    const openDatabase = vi.fn()
    vi.stubGlobal('indexedDB', { open: openDatabase })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    const root = slots.register({ name: 'root', children: { 'xagent.workbench.skills': { kind: 'single',
      scope: 'root' } } } as never, () => null)
    const remote = remoteFixture()
    const mount = vi.fn(async () => {
      const dispose = ctx.reflect.provide('remote.xagentBusinessSkill', remote)
      return async () => { await dispose() }
    })
    ctx.provide('remote', { $mount: mount } as never)
    const workbench = observable({ phase: 'ready', accountId: 'a', account: { id: 'a', role: 'manager' }, switching: false,
      context: { kind: 'project', projectId: 'p' }, sessionScopes: [{ sessionId: 's', projectId: 'p', visibility: 'project' }] })
    const details = observable('skills')
    const sessions = observable<{ current: string | undefined }>({ current: 's' })
    const connected = observable<unknown>({})
    ctx.provide('xagentWorkbench', { snapshot: workbench, details } as never)
    ctx.provide('sessions', { list: sessions } as never)
    ctx.provide('connection', { hostDescription: connected } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const panel = slots.entries('xagent.workbench.skills')[0]!
    expect(panel?.component).toBe(BusinessSkillPanel)
    expect(slots.entries('xagent.workbench.skills')).toHaveLength(1)
    expect(mount).toHaveBeenCalledWith(expect.objectContaining({ package: '@xagent/dsh-business-skill' }))
    const actions = panel.inject!() as unknown as BusinessSkillPanelInjected
    await vi.waitFor(() => { expect(actions.hooks.skills.getSnapshot()).toMatchObject({ phase: 'ready', selected: 'review-facts' }) })
    const check = () => { validateBusinessSkillUi(ctx, (message) => { throw new Error(message) }) }
    expect(check).not.toThrow()
    await actions.select('review-facts'); await actions.loadMore(); await actions.loadHistory('versions')
    await actions.openTranscript(3); await actions.mutate({ kind: 'verdict', slug: 'review-facts', run: 3, verdict: 'pass' })
    await actions.retryMutation(); await actions.refresh()
    expect(actions.hooks.skills.getSnapshot()).toMatchObject({ phase: 'ready' })
    const get = ctx.get.bind(ctx)
    const intercept = vi.spyOn(ctx,
      'get').mockImplementation(((name: string): unknown => name === 'remote.xagentBusinessSkill' ? {} : get(name) as unknown) as never)
    expect(check).toThrow(/Remote identity/)
    intercept.mockRestore()
    const writable = panel as unknown as { component: unknown }
    writable.component = null
    expect(check).toThrow(/Slot/)
    writable.component = BusinessSkillPanel
    const record = panel as unknown as { inject: () => unknown }
    const originalInject = record.inject
    record.inject = () => ({ hooks: { skills: {} } })
    expect(check).toThrow(/snapshot/)
    record.inject = originalInject
    workbench.replace({ ...workbench.getSnapshot(), sessionScopes: [] })
    expect(actions.hooks.skills.getSnapshot()).toEqual({ phase: 'empty' })
    workbench.replace({ ...workbench.getSnapshot(), sessionScopes: [{ sessionId: 's', projectId: 'p', visibility: 'project' }] })
    await vi.waitFor(() => { expect(actions.hooks.skills.getSnapshot()).toMatchObject({ phase: 'ready' }) })
    root()
    expect(actions.hooks.skills.getSnapshot()).toEqual({ phase: 'empty' })
    connected.replace({})
    expect(actions.hooks.skills.getSnapshot()).toEqual({ phase: 'empty' })
    expect(check).not.toThrow()
    const restoreRoot = slots.register({ name: 'root', children: { 'xagent.workbench.skills': { kind: 'single',
      scope: 'root' } } } as never, () => null)
    await vi.waitFor(() => { expect(actions.hooks.skills.getSnapshot()).toMatchObject({ phase: 'ready' }) })
    connected.replace(undefined)
    expect(actions.hooks.skills.getSnapshot()).toEqual({ phase: 'empty' })
    connected.replace({})
    await vi.waitFor(() => { expect(actions.hooks.skills.getSnapshot()).toMatchObject({ phase: 'ready' }) })
    sessions.replace({ current: undefined })
    expect(actions.hooks.skills.getSnapshot()).toEqual({ phase: 'empty' })
    await fiber.dispose()
    expect(slots.entries('xagent.workbench.skills')).toHaveLength(0)
    expect(workbench.listeners.size + details.listeners.size + sessions.listeners.size + connected.listeners.size).toBe(0)
    expect(ctx.get('remote.xagentBusinessSkill')).toBeUndefined()
    expect(writes).not.toHaveBeenCalled()
    expect(openDatabase).not.toHaveBeenCalled()
    writes.mockRestore()
    vi.unstubAllGlobals()
    restoreRoot()
  })
})
