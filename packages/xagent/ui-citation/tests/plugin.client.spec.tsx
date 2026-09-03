// @vitest-environment jsdom
import { Fragment } from 'react'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type {
  ChatConversationViewNode, ChatSnapshot, ISession, SessionId, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import { EMPTY_CHAT_SNAPSHOT, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as applyConversation, inject as injectConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply as applyTool, inject as injectTool } from '@deepseek-ai/dsh-client-ui-tool/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, within } from '@testing-library/react'
import { CitedAnswerView } from '../src/client/CitedAnswerView.tsx'
import { apply, inject } from '../src/client/index.ts'
import * as CitationPlugin from '../src/client/index.ts'

const SID = 'session-701' as SessionId

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const citedMeta = {
  kind: 'xagent-cited-answer' as const,
  schemaVersion: 1 as const,
  blocks: [
    { type: 'markdown' as const, text: '**季度结论** [资料1](https://attacker.example) 与 `https://attacker.example/code` 都不是资料权限。' },
    { type: 'citation' as const, id: '[资料1]' },
  ],
  citationIds: ['[资料1]'],
}

function toolResult(seq: number, callId: string, name: string, meta?: unknown, argsRaw = '{"secret":"must not render"}'): ToolResultNode {
  return {
    kind: 'tool-result', seq, time: seq * 1_000, callId,
    call: { name, argsRaw }, callTime: seq * 1_000 - 500,
    content: [{ type: 'text', text: 'SECRET RESULT TEXT' }], isError: false, meta,
    callView: null, resultView: null, subCalls: [],
  }
}

function chat(nodes: readonly ToolResultNode[]): ChatSnapshot {
  const projected: ChatConversationViewNode[] = nodes.map(node => ({
    key: `tool:${node.callId}`, kind: 'tool-call', id: node.callId, target: 'chat',
    anchorSeq: node.seq, location: { kind: 'session' }, visibility: 'visible', data: { root: node },
  }))
  const byKey = new Map(projected.map(node => [node.key, node]))
  return {
    ...EMPTY_CHAT_SNAPSHOT,
    order: projected.map(node => node.key),
    nodes: { get: key => byKey.get(key), values: () => projected },
    legacy: {
      nodes, runningCalls: [], partial: null, turnTimings: new Map(), turnEnds: new Map(),
    },
  }
}

type AppRootProps = PropsRenderSlots<'conversation' | 'details'>
function AppRoot({ renderSlot }: AppRootProps) {
  return <Fragment>{renderSlot('conversation', {})}</Fragment>
}

const LAYOUT_CHILDREN = {
  'conversation': { kind: 'single', scope: 'session-maybe' },
  'details': { kind: 'single', scope: 'session' },
} as const

async function renderedBench() {
  const runtime = await SlotTestRuntime.create()
  const target = {
    artifactId: 'artifact-1', versionId: 'version-1', chunkId: 'chunk-secret', lineStart: 3, lineEnd: 5,
  }
  const resolve = vi.fn(async () => ({ ok: true as const, value: target }))
  const openCitation = vi.fn(async () => {})
  runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
  runtime.provide('remote', {
    $on: () => () => {},
    $mount: vi.fn(async () => {
      const dispose = runtime.ctx.reflect.provide('remote.xagentCitation', { resolve })
      return async () => { await dispose() }
    }),
  })
  runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  runtime.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.provide('xagentWorkbench', {
    snapshot: {
      getSnapshot: () => ({
        phase: 'ready' as const, switching: false, creating: false, accountId: 'account-a',
        account: { id: 'account-a', email: 'manager@example.com', role: 'manager' as const, permissionRevision: 1 },
        capabilities: [], context: { kind: 'workbench' as const }, projects: [], sessionScopes: [],
        sessionSummary: { privateCount: 1, projectCounts: {} },
      }),
      subscribe: () => () => {},
    },
  } as never)
  runtime.provide('xagentArtifactCitationOpener', { openCitation, cancelCitation: vi.fn() } as never)
  const nodes = [
    toolResult(3, 'cited', 'submit_cited_answer', citedMeta),
    toolResult(4, 'ordinary', 'ordinary_tool', undefined, '{"n":1}'),
  ]
  await runtime.sessions.add({
    id: SID,
    summary: { title: 'S', displayTitle: 'S' },
    snapshot: { nodes, chat: chat(nodes) },
    session: { loadOlder: vi.fn<ISession['loadOlder']>(), prompt: vi.fn<ISession['prompt']>() },
  })
  await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  await runtime.mount({ inject: [...injectTool], apply: applyTool })
  const citation = await runtime.mount(CitationPlugin)
  return { runtime, citation, resolve, openCitation }
}

describe('XAgent citation browser plugin', () => {
  it('renders cited metadata through the real Tool call tree with inert Markdown and HMR fallback', async () => {
    const b = await renderedBench()
    const view = b.runtime.renderRoot()

    const answer = view.getByRole('article', { name: '已验证回答' })
    expect(within(answer).getByRole('strong').textContent).toBe('季度结论')
    expect(within(answer).queryByRole('link')).toBeNull()
    const chips = within(answer).getAllByRole('button', { name: '已验证资料 [资料1]' })
    expect(chips).toHaveLength(2)
    expect([...answer.querySelectorAll('a, button')].map(node => node.getAttribute('aria-label') ?? node.textContent))
      .toEqual(['已验证资料 [资料1]', '已验证资料 [资料1]'])
    expect(view.getByText('Tool call')).toBeTruthy()
    expect(answer.textContent).not.toContain('SECRET')

    fireEvent.click(chips[0]!)
    await vi.waitFor(() => {
      expect(b.resolve).toHaveBeenCalledWith(SID, '[资料1]', expect.any(AbortSignal))
      expect(b.openCitation).toHaveBeenCalledWith({
        artifactId: 'artifact-1', versionId: 'version-1', lineStart: 3, lineEnd: 5,
      })
    })

    await b.citation.dispose()
    await b.runtime.flush()
    expect(view.queryByRole('article', { name: '已验证回答' })).toBeNull()
    expect(view.getAllByText('Tool call')).toHaveLength(2)

    await b.runtime.mount(CitationPlugin)
    await b.runtime.flush()
    expect(view.getByRole('article', { name: '已验证回答' })).toBeTruthy()
    await b.runtime.dispose()
  })

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
    expect(openCitation).toHaveBeenCalledWith({
      artifactId: 'artifact-1', versionId: 'version-1', lineStart: 3, lineEnd: 5,
    })

    current = 'session-702'
    sessionListeners.forEach((listener) => { listener() })
    expect(cancelCitation).toHaveBeenCalledOnce()
    await fiber.dispose()
    expect(slots.entries('tool.call.toolview')).toHaveLength(0)
    expect(sessionListeners).toHaveLength(0)
    expect(workbenchListeners).toHaveLength(0)
    declareRoot()
  })

  it('loads the client package through a real Loader composition and unloads its keyed ToolView', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xagent-ui-citation-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: 'test:xagent-client-prerequisites'",
      "- name: '@xagent/dsh-ui-citation/client'",
      '',
    ].join('\n'))
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    let releaseRoot = (): void => {}
    const prerequisites = {
      name: 'xagent-client-prerequisites',
      async apply(scope: Context): Promise<() => void> {
        await scope.plugin(SlotRegistry).await()
        const slots = scope.get('slots') as SlotRegistry
        releaseRoot = slots.register({
          name: 'root', children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
        } as never, () => null)
        const disposeNamespace = scope.reflect.provide('remote.xagentCitation', {
          resolve: vi.fn(async () => ({ ok: false as const, error: { code: 'citation-invalid', message: '', details: {} } })),
        })
        scope.provide('remote', { $mount: vi.fn(async () => async () => { await disposeNamespace() }) } as never)
        scope.provide('sessions', {
          list: { getSnapshot: () => ({ current: SID }), subscribe: () => () => {} },
        } as never)
        scope.provide('xagentWorkbench', {
          snapshot: { getSnapshot: () => ({ phase: 'ready', switching: false, accountId: 'account-a' }), subscribe: () => () => {} },
        } as never)
        scope.provide('xagentArtifactCitationOpener', { openCitation: vi.fn(), cancelCitation: vi.fn() } as never)
        return () => { releaseRoot() }
      },
    }
    try {
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      const modules = new Map<string, unknown>([
        ['test:xagent-client-prerequisites', prerequisites],
        ['@xagent/dsh-ui-citation/client', CitationPlugin],
      ])
      ctx.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          const module = modules.get(specifier)
          if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
          return module
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await ctx.loader.await()

      const unloaded = [...ctx.loader.entries()]
        .filter(entry => entry.fiber === undefined && !entry.disabled)
        .map(entry => entry.options.name)
      expect(unloaded).toEqual([])
      expect('default' in CitationPlugin).toBe(false)
      const slots = ctx.get('slots') as SlotRegistry
      const toolView = slots.entries('tool.call.toolview')[0]
      expect(toolView?.options.key).toBe('submit_cited_answer')
      expect(toolView?.component).toBe(CitedAnswerView)

      const citationEntry = [...ctx.loader.entries()].find(entry => entry.options.name === '@xagent/dsh-ui-citation/client')
      await citationEntry?.fiber?.dispose()
      expect(slots.entries('tool.call.toolview')).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
