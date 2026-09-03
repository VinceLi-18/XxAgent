// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import { CitedAnswerView } from '../src/client/CitedAnswerView.tsx'
import { apply, inject } from '../src/client/index.ts'

describe('XAgent citation browser plugin', () => {
  it('mounts the generated Remote and owns the submit_cited_answer ToolView lifecycle', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    const declareRoot = slots.register({
      name: 'root', children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
    } as never, () => null)
    const sessionListeners = new Set<() => void>()
    let current: string | undefined = 'session-701'
    const sessions = {
      list: {
        getSnapshot: () => ({ current }),
        subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } },
      },
    }
    const workbenchListeners = new Set<() => void>()
    const workbench = {
      snapshot: {
        getSnapshot: () => ({ phase: 'ready', switching: false, accountId: 'account-a' }),
        subscribe: (listener: () => void) => { workbenchListeners.add(listener); return () => { workbenchListeners.delete(listener) } },
      },
    }
    const target = { artifactId: 'artifact-1', versionId: 'version-1', chunkId: 'chunk-1', lineStart: 3, lineEnd: 5 }
    const resolve = vi.fn(async () => ({ ok: true as const, value: target }))
    const openCitation = vi.fn(async () => {})
    const cancelCitation = vi.fn()
    let disposeNamespace: (() => Promise<void>) | undefined
    ctx.provide('remote', { $mount: vi.fn(async () => {
      disposeNamespace = ctx.reflect.provide('remote.xagentCitation', { resolve })
      return async () => { await disposeNamespace?.() }
    }) } as never)
    ctx.provide('sessions', sessions as never)
    ctx.provide('xagentWorkbench', workbench as never)
    ctx.provide('xagentArtifactCitationOpener', { openCitation, cancelCitation } as never)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = slots.entries('tool.call.toolview')[0]!
    expect(entry.options).toMatchObject({ key: 'submit_cited_answer' })
    expect(entry.registrant).toBe('xagent-cited-answer')
    expect(entry.component).toBe(CitedAnswerView)
    const injected = entry.inject!() as unknown as {
      openCitation(sessionId: string, citationId: string): Promise<void>
      sessionId: string
    }
    expect(injected.sessionId).toBe('session-701')
    await injected.openCitation('session-701', '[资料1]')
    expect(resolve).toHaveBeenCalledWith('session-701', '[资料1]', expect.any(AbortSignal))
    expect(openCitation).toHaveBeenCalledWith(target)

    current = 'session-702'
    sessionListeners.forEach((listener) => { listener() })
    expect(cancelCitation).toHaveBeenCalledOnce()
    await fiber.dispose()
    expect(slots.entries('tool.call.toolview')).toHaveLength(0)
    expect(sessionListeners).toHaveLength(0)
    expect(workbenchListeners).toHaveLength(0)
    declareRoot()
  })
})
