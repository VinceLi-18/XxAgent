// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import { ArtifactPanel } from '../src/client/ArtifactPanel.tsx'
import { apply, inject } from '../src/client/index.ts'

describe('XAgent Artifact UI 插件', () => {
  it('等待项目资料 Slot 与 Remote，并在账号和项目变化时清空后重载', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    const declareRoot = slots.register({
      name: 'root', children: { 'shell.details': { kind: 'single', scope: 'root' } },
    } as never, () => null)
    const declareDetails = slots.register({
      name: 'shell.details', children: { 'xagent.workbench.artifacts': { kind: 'single', scope: 'root' } },
    } as never, () => null)
    const listeners = new Set<() => void>()
    let workbenchState: unknown = {
      phase: 'ready', accountId: 'alice', switching: false, context: { kind: 'workbench' },
    }
    const workbench = {
      snapshot: {
        getSnapshot: () => workbenchState,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
    }
    const list = vi.fn(async (_signal?: AbortSignal) => ({ ok: true as const, value: [] }))
    const remote = {
      list, detail: vi.fn(), 'create-upload': vi.fn(), 'create-version-upload': vi.fn(),
      'complete-upload': vi.fn(), retry: vi.fn(), preview: vi.fn(), download: vi.fn(),
    }
    const disposeNamespace = ctx.reflect.provide('remote.xagentArtifact', remote)
    const mount = vi.fn(async () => async () => { await disposeNamespace() })
    ctx.provide('remote', { $mount: mount } as never)
    ctx.provide('xagentWorkbench', workbench as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect((ctx as Context & { xagentArtifacts?: unknown }).xagentArtifacts).toBeUndefined()
    expect(mount).toHaveBeenCalledWith(expect.objectContaining({ package: '@xagent/dsh-artifact' }))
    expect(slots.entries('xagent.workbench.artifacts')[0]?.component).toBe(ArtifactPanel)
    await vi.waitFor(() => { expect(list).toHaveBeenCalledTimes(1) })
    const firstSignal = (list.mock.calls as unknown as readonly [AbortSignal][])[0]![0]

    workbenchState = { phase: 'empty', accountId: 'bob', switching: false }
    listeners.forEach((listener) => { listener() })
    expect(firstSignal.aborted).toBe(true)
    const injected = slots.entries('xagent.workbench.artifacts')[0]!.inject!() as unknown as {
      useArtifacts: { getSnapshot(): { phase: string } }
    }
    expect(injected).toBeDefined()

    workbenchState = {
      phase: 'ready', accountId: 'bob', switching: false,
      context: { kind: 'project', projectId: 'project-2' },
    }
    listeners.forEach((listener) => { listener() })
    await vi.waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })

    const pendingList = Promise.withResolvers<{ ok: true; value: never[] }>()
    list.mockImplementationOnce(() => pendingList.promise)
    workbenchState = {
      phase: 'ready', accountId: 'bob', switching: false,
      context: { kind: 'workbench' },
    }
    listeners.forEach((listener) => { listener() })
    await vi.waitFor(() => { expect(list).toHaveBeenCalledTimes(3) })
    const pendingSignal = (list.mock.calls as unknown as readonly [AbortSignal][])[2]![0]
    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(pendingSignal.aborted).toBe(true) })
    expect(disposed).toBe(false)
    pendingList.resolve({ ok: true, value: [] })
    await disposing
    expect(slots.entries('xagent.workbench.artifacts')).toHaveLength(0)
    expect(listeners).toHaveLength(0)
    declareDetails()
    declareRoot()
  })
})
