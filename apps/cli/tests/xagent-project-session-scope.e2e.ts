import type { ConnectionRequestContext } from '@deepseek-ai/dsh-client-connection'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import { createApiProxy, InProcessApiClient, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId, type RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type {
  XAgentBackend,
  XAgentWorkbenchBackend,
  XAgentWorkbenchBootstrap,
  XAgentWorkbenchContext,
} from '@xagent/dsh-backend-client'
import { XAgentBackendError } from '@xagent/dsh-backend-client'
import { XAgentAuthorization } from '@xagent/dsh-authorization'
import { XAgentProjectService } from '@xagent/dsh-project'
import { XAgentSessionPersistence } from '@xagent/dsh-session-persistence-api'
import { describe, expect, test, vi } from 'vitest'

const actorId = '00000000-0000-0000-0000-000000000001'
const projectId = '00000000-0000-0000-0000-000000000401'
const secondProjectId = '00000000-0000-0000-0000-000000000402'
const request: ConnectionRequestContext = {
  principal: {
    actorId,
    role: 'specialist',
    permissionRevision: 3,
    authSessionId: '00000000-0000-0000-0000-000000000101',
    connectionId: 'connection-alice',
  },
  userToken: 'alice-token',
  connectionId: 'connection-alice',
}

interface StoredSession {
  readonly sessionId: string
  readonly runtimeHeader: SessionHeader
  readonly visibility: 'private' | 'project'
  readonly projectId: string | null
  readonly events: SessionEvent[]
}

interface CompositionOptions {
  forkResponseLosses?: number
  resumeFailures?: number
}

interface ForkClientRuntime {
  refresh(): Promise<void>
  fork(request: { sessionId: SessionId; atSeq?: number }): Promise<SessionId>
}

interface ForkClientRuntimeConstructor {
  new(ctx: Context, api: InProcessApiClient, remote: unknown): ForkClientRuntime
}

/** Load the Client compiler face at runtime for this Host-to-browser integration. */
async function forkClientRuntime(): Promise<ForkClientRuntimeConstructor> {
  const source = new URL('../../../packages/client/runtime/src/client/sessions/service.ts', import.meta.url).href
  const loaded = await import(source) as { SessionRuntime: ForkClientRuntimeConstructor }
  return loaded.SessionRuntime
}

function composition(faults: CompositionOptions = {}): {
  readonly project: XAgentProjectService
  readonly persistence: XAgentSessionPersistence
  readonly authorization: XAgentAuthorization
  readonly backend: XAgentBackend
  readonly contexts: Map<string, XAgentWorkbenchContext>
  readonly revokedSources: Set<string>
  readonly forkCalls: { readonly sourceId: string; readonly body: unknown }[]
  readonly ctx: Context
  readonly stored: StoredSession[]
  readonly createBodies: Record<string, unknown>[]
  readonly workspaces: Workspace[]
  readonly resumeCalls: { count: number }
} {
  const contexts = new Map<string, XAgentWorkbenchContext>([['alice-token', { kind: 'workbench' }]])
  const stored: StoredSession[] = []
  const createBodies: Record<string, unknown>[] = []
  const revokedSources = new Set<string>()
  const forkCalls: { readonly sourceId: string; readonly body: unknown }[] = []
  const forkResults = new Map<string, { throughSequence: number; item: StoredSession }>()
  let nextForkId = 799
  const workspaces: Workspace[] = []
  const resumeCalls = { count: 0 }
  const bootstrap = (token: string): XAgentWorkbenchBootstrap => ({
    account: {
      id: actorId,
      email: 'alice@example.test',
      role: 'specialist',
      permissionRevision: 3,
    },
    capabilities: [],
    context: contexts.get(token) ?? { kind: 'workbench' },
    projects: [
      { id: projectId, name: 'Alpha', createdAt: '2026-08-25T08:00:00+00:00' },
      { id: secondProjectId, name: 'Beta', createdAt: '2026-08-25T08:00:00+00:00' },
    ],
    sessionScopes: stored.map(item => item.visibility === 'private'
      ? { sessionId: item.runtimeHeader.id, visibility: 'private' }
      : { sessionId: item.runtimeHeader.id, visibility: 'project', projectId: item.projectId as string }),
    sessionSummary: {
      privateCount: stored.filter(item => item.visibility === 'private').length,
      projectCounts: {
        [projectId]: stored.filter(item => item.projectId === projectId).length,
      },
    },
  })
  const workbench: XAgentWorkbenchBackend = {
    bootstrap: async token => bootstrap(token),
    selectContext: async (token, context) => {
      contexts.set(token, context)
      return bootstrap(token)
    },
    createProject: vi.fn(),
    project: vi.fn(),
    addSessionProjectRefs: vi.fn(async () => {}),
  }
  const backend: XAgentBackend = {
    login: vi.fn(),
    introspect: vi.fn(),
    revoke: vi.fn(),
    sessions: {
      list: async token => ({
        schema_version: 1,
        sessions: stored.map(item => ({ runtime_header: item.runtimeHeader })),
        token,
      }),
      create: async (token, value) => {
        const body = value as Record<string, unknown>
        createBodies.push(body)
        const runtimeHeader = body.runtime_header as SessionHeader
        const context = contexts.get(token) ?? { kind: 'workbench' }
        const scope = context.kind === 'project'
          ? { visibility: 'project' as const, projectId: context.projectId }
          : { visibility: 'private' as const, projectId: null }
        const sessionId = body.session_id as string
        const events = Array.isArray(body.events)
          ? body.events.map(entry => (entry as { payload: SessionEvent }).payload)
          : []
        stored.push({ sessionId, runtimeHeader, events, ...scope })
        return {
          schema_version: 1,
          session: {
            id: sessionId,
            visibility: scope.visibility,
            project_id: scope.projectId,
          },
        }
      },
      open: vi.fn(async (_token, sessionId) => {
        const item = stored.find(candidate => candidate.sessionId === sessionId)
        if (item === undefined) throw new XAgentBackendError('not-found')
        return {
          schema_version: 1,
          session: { runtime_header: item.runtimeHeader },
          events: item.events.map((payload, sequence) => ({ sequence, payload })),
        }
      }),
      events: vi.fn(),
      append: async (_token, sessionId, body) => {
        const item = stored.find(candidate => candidate.sessionId === sessionId)
        if (item === undefined) throw new XAgentBackendError('not-found')
        const start = body.expected_sequence + 1
        item.events.splice(start, body.events.length, ...body.events.map(entry => (
          entry as { payload: SessionEvent }
        ).payload))
        return {
          schema_version: 1,
          last_event_sequence: item.events.length - 1,
          version: 2,
        }
      },
      fork: async (_token, sourceId, value) => {
        forkCalls.push({ sourceId, body: value })
        const source = stored.find(candidate => candidate.sessionId === sourceId)
        if (source === undefined || revokedSources.has(sourceId)) throw new XAgentBackendError('not-found')
        const body = value as { through_sequence: number; idempotency_key: string }
        const replay = forkResults.get(body.idempotency_key)
        if (replay !== undefined) {
          if (replay.throughSequence !== body.through_sequence) {
            throw new XAgentBackendError('idempotency-conflict')
          }
          return {
            schema_version: 1,
            session: {
              id: replay.item.sessionId,
              visibility: replay.item.visibility,
              project_id: replay.item.projectId,
              runtime_header: replay.item.runtimeHeader,
              last_event_sequence: body.through_sequence,
            },
          }
        }
        const targetId = `00000000-0000-0000-0000-${String(nextForkId++).padStart(12, '0')}`
        const runtimeHeader: SessionHeader = {
          version: 0,
          id: SessionId(`session-${targetId}`),
          createdAt: 1_787_587_200_100,
          ...source.runtimeHeader.cwd === undefined ? {} : { cwd: source.runtimeHeader.cwd },
          parentSession: source.runtimeHeader.id,
          seedLength: body.through_sequence + 1,
          ...source.runtimeHeader.agentPreset === undefined
            ? {}
            : { agentPreset: source.runtimeHeader.agentPreset },
        }
        const child = {
          sessionId: targetId,
          runtimeHeader,
          visibility: source.visibility,
          projectId: source.projectId,
          events: source.events.slice(0, body.through_sequence + 1),
        }
        stored.push(child)
        forkResults.set(body.idempotency_key, { throughSequence: body.through_sequence, item: child })
        if ((faults.forkResponseLosses ?? 0) > 0) {
          faults.forkResponseLosses = (faults.forkResponseLosses ?? 0) - 1
          throw new XAgentBackendError('service-unavailable')
        }
        return {
          schema_version: 1,
          session: {
            id: targetId,
            visibility: source.visibility,
            project_id: source.projectId,
            runtime_header: runtimeHeader,
            last_event_sequence: body.through_sequence,
          },
        }
      },
      archive: vi.fn(),
      authorize: async (_token, sessionId) => {
        if (revokedSources.has(sessionId)) throw new XAgentBackendError('not-found')
      },
    },
    workbench,
  }
  const ctx = new Context()
  const project = new XAgentProjectService(ctx, workbench)
  const persistence = new XAgentSessionPersistence(ctx, backend)
  const authorization = new XAgentAuthorization(backend, persistence, project)
  return {
    project,
    persistence,
    authorization,
    stored,
    createBodies,
    backend,
    contexts,
    revokedSources,
    forkCalls,
    workspaces,
    resumeCalls,
    ctx,
  }
}

async function hostComposition(faults: CompositionOptions = {}) {
  const value = composition(faults)
  const { ctx } = value
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.provide('workspaceRegistry', { list: () => value.workspaces } as never)

  const publish = async (
    ownerCtx: Context,
    session: ReturnType<typeof ctx.sessions.create>,
    setup: CreateAgentOptions['setup'],
    publishDurably: boolean,
  ): Promise<AgentHandle> => {
    const agent = {} as Agent
    const agentCtx = ownerCtx.extend({ agent })
    Object.assign(agent, { id: session.id, session, status: 'idle', ctx: agentCtx })
    await setup?.(agentCtx)
    if (publishDurably) await value.persistence.preparePublication(session)
    ctx.agents.register(agent)
    return { agent, dispose: () => Promise.resolve() }
  }
  ctx.agents.setFactory({
    createAgent: async (ownerCtx, options) => publish(
      ownerCtx,
      ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
      }),
      options.setup,
      true,
    ),
    resume: async (ownerCtx, options) => {
      value.resumeCalls.count++
      if ((faults.resumeFailures ?? 0) > 0) {
        faults.resumeFailures = (faults.resumeFailures ?? 0) - 1
        throw new XAgentBackendError('service-unavailable')
      }
      const loaded = await value.persistence.load(options.resumeSessionId)
      return publish(
        ownerCtx,
        ctx.sessions.create(options.resumeSessionId, {
          seed: [...loaded.events],
          meta: {
            createdAt: loaded.meta.createdAt,
            ...loaded.meta.cwd === undefined ? {} : { cwd: loaded.meta.cwd },
            ...loaded.meta.parentSession === undefined
              ? {}
              : { parentSession: loaded.meta.parentSession },
            ...loaded.meta.seedLength === undefined ? {} : { seedLength: loaded.meta.seedLength },
            ...loaded.meta.agentPreset === undefined ? {} : { agentPreset: loaded.meta.agentPreset },
          },
        }),
        options.setup,
        false,
      )
    },
  })
  return value
}

async function forkHarness(faults: CompositionOptions = {}) {
  const value = await hostComposition(faults)
  const signal = new AbortController().signal
  const sourceId = SessionId('session-00000000-0000-0000-0000-000000000741')
  await value.authorization.run(
    'xagentProject/select-context',
    { args: { context: { kind: 'project', projectId } } },
    request,
    signal,
    async () => ({
      ok: true,
      value: await value.project.selectContext({ kind: 'project', projectId }, signal),
    }),
  )
  await value.authorization.run(
    'session/create',
    { args: {} },
    request,
    signal,
    async () => {
      await value.persistence.create({
        version: 0,
        id: sourceId,
        createdAt: 1_787_587_200_000,
        cwd: '/workspace/alpha',
      })
      return { ok: true, value: { sessionId: sourceId } }
    },
  )
  const source = value.ctx.sessions.create(sourceId, { meta: { cwd: '/workspace/alpha' } })
  source.append('turn/start', { turn: 1 })
  source.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'first turn' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  source.append('turn/start', { turn: 2 })
  source.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'second turn' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  source.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  value.ctx.agents.register({
    id: source.id,
    session: source,
    status: 'idle',
    ctx: value.ctx,
  } as Agent)
  await value.ctx.sessions.flush(source)
  const proxy = createApiProxy(value.ctx, {
    defaultModelSelection: () => ({ provider: 'default', model: 'default' }),
    cwd: '/tmp',
  })
  const handler = toFetchHandler(proxy, {
    requestContext: request,
    authorizer: value.authorization,
  })
  const api = new InProcessApiClient(handler)
  const clientCtx = new Context()
  const SessionRuntime = await forkClientRuntime()
  const runtime = new SessionRuntime(clientCtx, api, {
    commands: {
      list: async () => ({ ok: true, value: [] }),
      execute: async () => ({ ok: true, value: undefined }),
    },
  })
  await runtime.refresh()
  const fork = (atSeq?: number) => runtime.fork({
    sessionId: sourceId,
    ...atSeq === undefined ? {} : { atSeq },
  })
  return { value, sourceId, fork, handler, clientCtx }
}

describe('XAgent 项目上下文与 Session 创建组合', () => {
  test('项目选择、创建和 Bootstrap 分组都使用同一服务端账号上下文', async () => {
    const value = composition()
    const signal = new AbortController().signal
    const projectSession = SessionId('session-00000000-0000-0000-0000-000000000711')
    const privateSession = SessionId('session-00000000-0000-0000-0000-000000000712')

    await expect(value.authorization.run(
      'xagentProject/select-context',
      { args: { context: { kind: 'project', projectId }, visibility: 'private' } },
      request,
      signal,
      async () => ({ ok: true, value: await value.project.selectContext({ kind: 'project', projectId }, signal) }),
    )).resolves.toMatchObject({ ok: true, value: { context: { kind: 'project', projectId } } })
    await expect(value.authorization.run(
      'session/create',
      { args: { visibility: 'private', projectId: null } },
      request,
      signal,
      async () => {
        await value.persistence.create({ version: 0, id: projectSession, createdAt: 1 })
        return { ok: true, value: { sessionId: projectSession } }
      },
    )).resolves.toEqual({ ok: true, value: { sessionId: projectSession } })

    await value.authorization.run(
      'xagentProject/select-context',
      { args: { context: { kind: 'workbench' }, visibility: 'project', projectId } },
      request,
      signal,
      async () => ({ ok: true, value: await value.project.selectContext({ kind: 'workbench' }, signal) }),
    )
    await value.authorization.run(
      'session/create',
      { args: { visibility: 'project', projectId } },
      request,
      signal,
      async () => {
        await value.persistence.create({ version: 0, id: privateSession, createdAt: 2 })
        return { ok: true, value: { sessionId: privateSession } }
      },
    )
    const bootstrapped = await value.authorization.run(
      'xagentProject/bootstrap',
      { args: {} },
      request,
      signal,
      async () => ({ ok: true, value: await value.project.bootstrap(signal) }),
    )
    const listed = await value.persistence.withUserToken('alice-token', () => value.persistence.list())

    expect(value.stored.map(item => [item.runtimeHeader.id, item.visibility, item.projectId])).toEqual([
      [projectSession, 'project', projectId],
      [privateSession, 'private', null],
    ])
    expect(value.createBodies.every(body => !Object.hasOwn(body, 'visibility') && !Object.hasOwn(body, 'project_id')))
      .toBe(true)
    expect(bootstrapped).toMatchObject({
      ok: true,
      value: {
        context: { kind: 'workbench' },
        sessionScopes: [
          { sessionId: projectSession, visibility: 'project', projectId },
          { sessionId: privateSession, visibility: 'private' },
        ],
      },
    })
    expect(listed.map(item => item.id)).toEqual([projectSession, privateSession])
  })

  test('Host fork keeps project A after the caller selects project B and binds the server child id', async () => {
    const value = await hostComposition()
    const signal = new AbortController().signal
    const sourceId = SessionId('session-00000000-0000-0000-0000-000000000731')
    await value.authorization.run(
      'xagentProject/select-context',
      { args: { context: { kind: 'project', projectId } } },
      request,
      signal,
      async () => ({ ok: true, value: await value.project.selectContext({ kind: 'project', projectId }, signal) }),
    )
    await value.authorization.run(
      'session/create',
      { args: {} },
      request,
      signal,
      async () => {
        await value.persistence.create({
          version: 0,
          id: sourceId,
          createdAt: 1_787_587_200_000,
          cwd: '/workspace/alpha',
        })
        return { ok: true, value: { sessionId: sourceId } }
      },
    )
    const source = value.ctx.sessions.create(sourceId, { meta: { cwd: '/workspace/alpha' } })
    source.append('turn/start', { turn: 1 })
    source.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'project A transcript' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    value.ctx.agents.register({ id: source.id, session: source, status: 'idle', ctx: value.ctx } as Agent)
    await value.ctx.sessions.flush(source)

    await value.authorization.run(
      'xagentProject/select-context',
      { args: { context: { kind: 'project', projectId: secondProjectId } } },
      request,
      signal,
      async () => ({
        ok: true,
        value: await value.project.selectContext({ kind: 'project', projectId: secondProjectId }, signal),
      }),
    )
    const proxy = createApiProxy(value.ctx, {
      defaultModelSelection: () => ({ provider: 'default', model: 'default' }),
      cwd: '/tmp',
    })
    const response = await value.authorization.run(
      'session/fork',
      { args: { sessionId: sourceId, visibility: 'project', projectId: secondProjectId } },
      request,
      signal,
      () => proxy.sessions.fork({ rpcId: RpcId('fork-a-to-b'), payload: { sessionId: sourceId } }).then(item => item.result),
    )

    expect(response).toEqual({
      ok: true,
      value: { sessionId: SessionId('session-00000000-0000-0000-0000-000000000799') },
    })
    expect(value.forkCalls).toHaveLength(1)
    const child = value.stored.find(item => item.sessionId === '00000000-0000-0000-0000-000000000799')
    expect(child).toMatchObject({ visibility: 'project', projectId })
    expect(child?.events.map(event => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    expect(value.ctx.sessions.get(SessionId('session-00000000-0000-0000-0000-000000000799'))?.header)
      .toMatchObject({ parentSession: sourceId, seedLength: 3 })
    value.revokedSources.add('00000000-0000-0000-0000-000000000731')
    await expect(value.authorization.run(
      'session/fork',
      { args: { sessionId: sourceId } },
      request,
      signal,
      () => proxy.sessions.fork({ rpcId: RpcId('fork-revoked-source'), payload: { sessionId: sourceId } })
        .then(item => item.result),
    )).resolves.toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    expect(value.forkCalls).toHaveLength(1)
    await value.ctx.fiber.dispose()
  })

  test('production SessionRuntime fork recovers a committed response loss under one RPC identity', async () => {
    const { value, sourceId, fork, handler, clientCtx } = await forkHarness({ forkResponseLosses: 1 })

    await expect(fork()).resolves.toBe(SessionId('session-00000000-0000-0000-0000-000000000799'))
    expect(value.forkCalls.map(call => (
      call.body as { idempotency_key: string }
    ).idempotency_key)).toEqual([expect.stringMatching(/^fork:.+$/), expect.stringMatching(/^fork:.+$/)])
    const firstOperation = (value.forkCalls[0]?.body as { idempotency_key: string }).idempotency_key
    expect((value.forkCalls[1]?.body as { idempotency_key: string }).idempotency_key).toBe(firstOperation)
    expect(value.stored.filter(item => item.runtimeHeader.parentSession === sourceId)).toHaveLength(1)
    expect(value.ctx.agents.list().filter(agent => agent.id !== sourceId)).toHaveLength(1)

    await expect(fork()).resolves.toBe(SessionId('session-00000000-0000-0000-0000-000000000800'))
    const secondOperation = (value.forkCalls.at(-1)?.body as { idempotency_key: string }).idempotency_key
    expect(secondOperation).not.toBe(firstOperation)
    expect(value.stored.filter(item => item.runtimeHeader.parentSession === sourceId)).toHaveLength(2)

    const conflictingRpcId = firstOperation.slice('fork:'.length)
    const conflictResponse = await handler.fetch(new Request('http://dsh.internal/api/session.fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: conflictingRpcId,
        method: 'session.fork',
        payload: { sessionId: sourceId, atSeq: 1 },
      }),
    }))
    const conflict = await conflictResponse.json() as { result: RpcResult<{ sessionId: SessionId }> }
    expect(conflict.result).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(value.forkCalls).toHaveLength(4)
    expect(value.stored.filter(item => item.runtimeHeader.parentSession === sourceId)).toHaveLength(2)
    await clientCtx.fiber.dispose()
    await value.ctx.fiber.dispose()
  })

  test('production SessionRuntime fork retries resume against the same durable child', async () => {
    const { value, sourceId, fork, clientCtx } = await forkHarness({ resumeFailures: 1 })

    await expect(fork()).resolves.toBe(SessionId('session-00000000-0000-0000-0000-000000000799'))
    expect(value.resumeCalls.count).toBe(2)
    expect(value.stored.filter(item => item.runtimeHeader.parentSession === sourceId)).toHaveLength(1)
    expect(value.ctx.agents.list().filter(agent => agent.id !== sourceId)).toHaveLength(1)
    expect(value.forkCalls).toHaveLength(1)
    await clientCtx.fiber.dispose()
    await value.ctx.fiber.dispose()
  })

  test('production SessionRuntime fork retries only a transient Workspace attachment failure', async () => {
    const { value, sourceId, fork, clientCtx } = await forkHarness()
    const attachSession = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('simulated attachment failure'), { code: 'EBUSY' }))
      .mockResolvedValueOnce(undefined)
    value.workspaces.push({
      id: WorkspaceId('00000000-0000-0000-0000-000000000801'),
      path: '/workspace/alpha',
      title: 'Alpha',
      createdAt: '2026-09-04T00:00:00Z',
      updatedAt: '2026-09-04T00:00:00Z',
      sessionIds: [sourceId],
      attachSession,
      setTitle: vi.fn(),
      insertSessionBefore: vi.fn(),
      detachSession: vi.fn(),
      status: vi.fn<() => Promise<'ok' | 'missing-dir'>>(async () => 'ok'),
    })

    await expect(fork()).resolves.toBe(SessionId('session-00000000-0000-0000-0000-000000000799'))
    expect(attachSession).toHaveBeenCalledTimes(2)
    expect(value.resumeCalls.count).toBe(1)
    expect(value.forkCalls).toHaveLength(1)
    expect(value.stored.filter(item => item.runtimeHeader.parentSession === sourceId)).toHaveLength(1)
    expect(value.ctx.agents.list().filter(agent => agent.id !== sourceId)).toHaveLength(1)
    await clientCtx.fiber.dispose()
    await value.ctx.fiber.dispose()
  })

  test('production SessionRuntime fork does not retry a non-transient Workspace attachment failure', async () => {
    const { value, sourceId, fork, clientCtx } = await forkHarness()
    const attachSession = vi.fn().mockRejectedValue(new Error('workspace path no longer matches'))
    value.workspaces.push({
      id: WorkspaceId('00000000-0000-0000-0000-000000000801'),
      path: '/workspace/alpha',
      title: 'Alpha',
      createdAt: '2026-09-04T00:00:00Z',
      updatedAt: '2026-09-04T00:00:00Z',
      sessionIds: [sourceId],
      attachSession,
      setTitle: vi.fn(),
      insertSessionBefore: vi.fn(),
      detachSession: vi.fn(),
      status: vi.fn<() => Promise<'ok' | 'missing-dir'>>(async () => 'ok'),
    })

    await expect(fork()).rejects.toMatchObject({
      rpcError: { code: 'workspace-attach-failed' },
      sourceSessionId: sourceId,
    })
    expect(attachSession).toHaveBeenCalledOnce()
    expect(value.forkCalls).toHaveLength(1)
    expect(value.stored.filter(item => item.runtimeHeader.parentSession === sourceId)).toHaveLength(1)
    await clientCtx.fiber.dispose()
    await value.ctx.fiber.dispose()
  })
})
