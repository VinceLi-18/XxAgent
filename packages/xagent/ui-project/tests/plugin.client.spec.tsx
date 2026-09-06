// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import type { XAgentWorkbenchBootstrap } from '@xagent/dsh-project/types'
import { apply as applyHost } from '../src/index.ts'
import { ContextMarker } from '../src/client/ContextMarker.tsx'
import { ProjectBrowser, type ProjectBrowserInjected } from '../src/client/ProjectBrowser.tsx'
import { WorkbenchDetails, type WorkbenchDetailsInjected } from '../src/client/WorkbenchDetails.tsx'
import { WorkbenchOperationShield } from '../src/client/WorkbenchOperationShield.tsx'
import { apply, inject } from '../src/client/index.ts'
import type { XAgentProjectRemoteClient } from '../src/client/service.ts'

const ACCOUNT_ID = '00000000-0000-0000-0000-000000000101'

function bootstrap(): XAgentWorkbenchBootstrap {
  return {
    account: { id: ACCOUNT_ID, email: 'manager@example.com', role: 'manager', permissionRevision: 1 },
    capabilities: ['project.create'], context: { kind: 'workbench' }, projects: [], sessionScopes: [],
    sessionSummary: { privateCount: 0, projectCounts: {} },
  }
}

function remote(): { client: XAgentProjectRemoteClient; projectMock: ReturnType<typeof vi.fn> } {
  const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value })
  const projectMock = vi.fn(() => ok({
    accountId: ACCOUNT_ID, id: 'project-1', name: 'Alpha', createdAt: '2026-08-25T08:00:00Z',
    canEdit: true, sessionCount: 0,
  }))
  return { client: {
    bootstrap: vi.fn(() => ok(bootstrap())),
    'select-context': vi.fn(() => ok(bootstrap())),
    'create-project': vi.fn(() => ok(bootstrap())),
    project: projectMock,
  }, projectMock }
}

describe('XAgent Project UI 插件', () => {
  it('只通过正式插槽注册，并随声明重载和插件卸载', async () => {
    expect(inject).not.toContain('remote.xagentProject')
    applyHost()
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    const declare = () => slots.register({
      name: 'root',
      children: {
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        'conversation.context': { kind: 'single', scope: 'root' },
        'shell.details': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)
    let disposeDeclaration = declare()
    const { client: projectRemote, projectMock } = remote()
    const sessions = { clear: vi.fn(), open: vi.fn() }
    ctx.provide('sessions', sessions as never)
    const layout = { openDetails: vi.fn(), closeDetails: vi.fn() }
    ctx.provide('layout', layout as never)
    const disposeNamespace = ctx.reflect.provide('remote.xagentProject', projectRemote)
    const mount = vi.fn(async () => async () => { await disposeNamespace() })
    ctx.provide('remote', { $mount: mount, xagentProject: projectRemote } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(slots.entries('sidebar.workspaces')[0]?.component).toBe(ProjectBrowser)
    expect(slots.entries('conversation.context')[0]?.component).toBe(ContextMarker)
    expect(slots.entries('shell.details')[0]?.component).toBe(WorkbenchDetails)
    expect(slots.spec('xagent.workbench.artifacts')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.entries('shell.overlay')[0]?.component).toBe(WorkbenchOperationShield)
    const workbench = ctx.get('xagentWorkbench')!
    await workbench.bootstrap()
    expect(mount).toHaveBeenCalledTimes(1)
    expect(mount).toHaveBeenCalledWith(expect.objectContaining({ package: '@xagent/dsh-project' }))
    const browser = slots.entries('sidebar.workspaces')[0]!.inject!() as unknown as ProjectBrowserInjected
    await browser.selectContext({ kind: 'workbench' })
    await browser.createProject('Alpha')
    browser.openSession('session-1')
    expect(sessions.clear).toHaveBeenCalledTimes(2)
    expect(layout.openDetails).toHaveBeenCalledTimes(2)
    expect(sessions.open).toHaveBeenCalledWith('session-1')
    const details = slots.entries('shell.details')[0]!.inject!() as unknown as WorkbenchDetailsInjected
    await details.loadProject('project-1')
    expect(projectMock).toHaveBeenCalledWith('project-1', expect.any(AbortSignal))
    expect(slots.entries('conversation.context')[0]!.inject!()).toBeDefined()
    expect(slots.entries('shell.overlay')[0]!.inject!()).toBeDefined()

    disposeDeclaration()
    expect(slots.entries('sidebar.workspaces')).toHaveLength(0)
    expect(slots.entries('conversation.context')).toHaveLength(0)
    expect(slots.entries('shell.details')).toHaveLength(0)
    expect(slots.spec('xagent.workbench.artifacts')).toBeUndefined()
    expect(slots.entries('shell.overlay')).toHaveLength(0)
    disposeDeclaration = declare()
    await Promise.resolve()
    expect(slots.entries('sidebar.workspaces')).toHaveLength(1)
    expect(slots.entries('conversation.context')).toHaveLength(1)
    expect(slots.entries('shell.details')).toHaveLength(1)
    expect(slots.spec('xagent.workbench.artifacts')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.entries('shell.overlay')).toHaveLength(1)

    await fiber.dispose()
    expect(slots.entries('sidebar.workspaces')).toHaveLength(0)
    expect(slots.entries('conversation.context')).toHaveLength(0)
    expect(slots.entries('shell.details')).toHaveLength(0)
    expect(slots.spec('xagent.workbench.artifacts')).toBeUndefined()
    expect(slots.entries('shell.overlay')).toHaveLength(0)
    expect(ctx.get('xagentWorkbench')).toBeUndefined()
    disposeDeclaration()
  })
})
