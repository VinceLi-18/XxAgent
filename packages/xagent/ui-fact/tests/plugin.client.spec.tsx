// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import { FactPanel } from '../src/client/FactPanel.tsx'
import { FactToolCard } from '../src/client/FactToolCard.tsx'
import { apply, inject } from '../src/client/index.ts'
import { validateXAgentFactUiRelationships } from '../src/invariant.ts'

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    replace: (next: T) => {
      value = next
      listeners.forEach((listener) => { listener() })
    },
  }
}

interface WorkbenchState {
  phase: 'ready'
  switching: boolean
  accountId: string
  account: { id: string; role: 'manager' }
  context: { kind: 'workbench' } | { kind: 'project'; projectId: string }
  sessionScopes: readonly { sessionId: string; visibility: 'project'; projectId: string }[]
}

describe('XAgent Fact browser assembly', () => {
  it('accepts an absent optional browser relationship service', () => {
    expect(() => {
      validateXAgentFactUiRelationships(new Context(), (message) => { throw new Error(message) })
    }).not.toThrow()
  })

  it('mounts Remote and exact slot/renderer, then calls only for connected matching Project Session scope', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    const declare = () => slots.register({ name: 'root', children: { 'xagent.workbench.facts': { kind: 'single', scope: 'root' }, 'tool.call.toolview': { kind: 'keyed', scope: 'session' } } } as never, () => null)
    const listHeads = vi.fn(async () => ({ ok: true as const, value: { items: [] } }))
    const listProposals = vi.fn(async () => ({ ok: true as const, value: { items: [] } }))
    const remote = { 'list-heads': listHeads, 'list-proposals': listProposals, revision: vi.fn(), proposal: vi.fn(), approve: vi.fn(), reject: vi.fn(), withdraw: vi.fn() }
    const mount = vi.fn(async () => {
      const dispose = ctx.reflect.provide('remote.xagentFact', remote)
      return async () => { await dispose() }
    })
    ctx.provide('remote', { $mount: mount } as never)
    const workbenchState = observable<WorkbenchState>({ phase: 'ready', switching: false, accountId: 'account', account: { id: 'manager', role: 'manager' }, context: { kind: 'project', projectId: 'project' }, sessionScopes: [{ sessionId: 'session', visibility: 'project', projectId: 'project' }] })
    const details = observable<'overview' | 'facts'>('overview')
    ctx.provide('xagentWorkbench', { snapshot: workbenchState, details } as never)
    const sessions = observable<{ current: string | undefined }>({ current: 'session' })
    ctx.provide('sessions', { list: sessions } as never)
    const connected = observable<{} | undefined>({})
    ctx.provide('connection', { hostDescription: connected } as never)
    ctx.provide('xagentArtifactCitationOpener', { openCitation: vi.fn(async () => {}) } as never)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(mount).toHaveBeenCalledOnce()
    expect(listHeads).not.toHaveBeenCalled()
    expect(slots.entries('xagent.workbench.facts')).toHaveLength(0)
    expect(slots.entries('tool.call.toolview')).toHaveLength(0)
    let root = declare()
    await Promise.resolve()
    expect(slots.entries('xagent.workbench.facts')[0]?.component).toBe(FactPanel)
    expect(slots.entries('tool.call.toolview')[0]).toMatchObject({ component: FactToolCard, options: { key: 'propose_fact' } })
    root()
    await Promise.resolve()
    expect(slots.entries('xagent.workbench.facts')).toHaveLength(0)
    expect(slots.entries('tool.call.toolview')).toHaveLength(0)
    expect(() => { validateXAgentFactUiRelationships(ctx, (message) => { throw new Error(message) }) }).not.toThrow()
    root = declare()
    await Promise.resolve()
    expect(slots.entries('xagent.workbench.facts')[0]?.component).toBe(FactPanel)
    expect(slots.entries('tool.call.toolview')[0]?.component).toBe(FactToolCard)
    workbenchState.replace({ ...workbenchState.getSnapshot(), context: { kind: 'workbench' } })
    sessions.replace({ current: undefined })
    sessions.replace({ current: 'session' })
    workbenchState.replace({
      ...workbenchState.getSnapshot(),
      context: { kind: 'project', projectId: 'project' },
      sessionScopes: [{ sessionId: 'session', visibility: 'project', projectId: 'other' }],
    })
    details.replace('facts')
    expect(listHeads).not.toHaveBeenCalled()
    workbenchState.replace({
      ...workbenchState.getSnapshot(),
      sessionScopes: [{ sessionId: 'session', visibility: 'project', projectId: 'project' }],
    })
    await vi.waitFor(() => { expect(listHeads).toHaveBeenCalledWith('session', { limit: 50 }, expect.any(AbortSignal)) })

    const panel = slots.entries('xagent.workbench.facts')[0]!
    const actions = panel.inject!() as unknown as {
      selectHead(id: string): Promise<void>
      selectProposal(id: string): Promise<void>
      loadMoreHeads(): Promise<void>
      loadMoreProposals(): Promise<void>
      approve(id: string, note: string): Promise<void>
      reject(id: string, reason: string): Promise<void>
      withdraw(id: string): Promise<void>
      retryDecision(): Promise<void>
      openEvidence(sessionId: string, evidence: object): Promise<void>
    }
    await actions.loadMoreHeads(); await actions.loadMoreProposals()
    await actions.selectHead('revision'); await actions.selectProposal('proposal')
    await actions.approve('proposal', 'note'); await actions.reject('proposal', 'reason')
    await actions.withdraw('proposal'); await actions.retryDecision()
    await actions.openEvidence('session', {})

    connected.replace(undefined)
    expect((slots.entries('xagent.workbench.facts')[0]!.inject!() as never)).toBeTruthy()
    const failures: string[] = []
    validateXAgentFactUiRelationships((ctx), (message) => { failures.push(message); throw new Error(message) })
    expect(failures).toEqual([])

    const panelRecord = panel as unknown as { component: unknown; inject: (() => unknown) | undefined }
    panelRecord.component = null
    expect(() =>{  validateXAgentFactUiRelationships(ctx, (message) => { throw new Error(message) }) }).toThrow('Slot occupant')
    panelRecord.component = FactPanel
    const tool = slots.entries('tool.call.toolview')[0]!
    const toolRecord = tool as unknown as { component: unknown }
    toolRecord.component = null
    expect(() =>{  validateXAgentFactUiRelationships(ctx, (message) => { throw new Error(message) }) }).toThrow('ToolView renderer')
    toolRecord.component = FactToolCard
    const injectPanel = panelRecord.inject
    panelRecord.inject = () => ({ hooks: { facts: {} } })
    expect(() =>{  validateXAgentFactUiRelationships(ctx, (message) => { throw new Error(message) }) }).toThrow('controller snapshot')
    panelRecord.inject = injectPanel
    await fiber.dispose()
    expect(slots.entries('xagent.workbench.facts')).toHaveLength(0)
    expect(slots.entries('tool.call.toolview')).toHaveLength(0)
    root()
    const afterUnload = declare()
    await Promise.resolve()
    expect(slots.entries('xagent.workbench.facts')).toHaveLength(0)
    expect(slots.entries('tool.call.toolview')).toHaveLength(0)
    afterUnload()
  })

  it('disposes the generated Remote when feature assembly fails', async () => {
    const failure = new Error('feature startup failed')
    const feature = { await: vi.fn(() => Promise.reject(failure)), dispose: vi.fn(async () => {}) }
    const disposeRemote = vi.fn(async () => {})
    const ctx = { remote: { $mount: vi.fn(async () => disposeRemote) }, inject: vi.fn(() => feature) }
    await expect(apply(ctx as never)).rejects.toBe(failure)
    expect(feature.dispose).toHaveBeenCalledOnce()
    expect(disposeRemote).toHaveBeenCalledOnce()
  })
})
