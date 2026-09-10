import { generateKeyPairSync } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { remoteMethods, TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import {
  XAgentBackendError,
  type XAgentFactBackend,
  type XAgentFactOutboxItem,
} from '@xagent/dsh-backend-client'
import { verifyDelegationToken } from '@xagent/dsh-delegation-token'
import {
  currentXAgentAuthenticatedRequestScope,
  runWithXAgentAuthenticatedRequestScope,
  type XAgentAuthenticatedSessionRequestScope,
} from '@xagent/dsh-principal'
import { describe, expect, test, vi } from 'vitest'
import {
  apply,
  XAgentFactError,
  XAgentFactService,
} from '../src/index.ts'
import {
  XAgentFactOutboxRegistry,
  XAgentFactReceiptRegistry,
} from '../src/receipt-registry.ts'

/* oxlint-disable typescript/unbound-method -- assertions inspect Vitest backend spies without invoking them. */

const ACTOR = '00000000-0000-0000-0000-000000000101'
const AUTH_SESSION = '00000000-0000-0000-0000-000000000102'
const SESSION = '00000000-0000-0000-0000-000000000201'
const RUNTIME_SESSION = `session-${SESSION}`
const PROJECT = '00000000-0000-0000-0000-000000000301'
const PROPOSAL = '00000000-0000-0000-0000-000000000401'
const REVISION = '00000000-0000-0000-0000-000000000501'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')

function scope(overrides: Partial<XAgentAuthenticatedSessionRequestScope> = {}): XAgentAuthenticatedSessionRequestScope {
  const request = new AbortController()
  const connection = new AbortController()
  return Object.freeze({
    principal: Object.freeze({
      actorId: ACTOR,
      role: 'specialist' as const,
      permissionRevision: 7,
      authSessionId: AUTH_SESSION,
      connectionId: 'connection-1',
    }),
    userToken: 'user-token',
    connectionId: 'connection-1',
    requestSignal: request.signal,
    connectionSignal: connection.signal,
    sessionId: SESSION,
    visibility: 'project' as const,
    projectId: PROJECT,
    ...overrides,
  }) as XAgentAuthenticatedSessionRequestScope
}

interface BackendProbe extends XAgentFactBackend {
  readonly prepareCalls: Parameters<XAgentFactBackend['prepare']>[]
  readonly outboxCalls: Parameters<XAgentFactBackend['pullOutbox']>[]
}

type PrepareArgs = Parameters<XAgentFactBackend['prepare']>
type PullOutboxArgs = Parameters<XAgentFactBackend['pullOutbox']>

function backend(): BackendProbe {
  const prepareCalls: Parameters<XAgentFactBackend['prepare']>[] = []
  const outboxCalls: Parameters<XAgentFactBackend['pullOutbox']>[] = []
  return {
    prepareCalls,
    outboxCalls,
    prepare: vi.fn(async (...args: Parameters<XAgentFactBackend['prepare']>) => {
      prepareCalls.push(args)
      return {
        result: { proposalId: PROPOSAL, status: 'pending' as const },
        receipt: 'opaque-fact-receipt',
        payloadHash: 'a'.repeat(64),
      }
    }),
    listHeads: vi.fn(async () => ({ items: [] })),
    listProposals: vi.fn(async () => ({ items: [] })),
    revision: vi.fn(async () => ({
      revision: {
        id: REVISION,
        projectId: PROJECT,
        fieldKey: 'customer.name',
        label: '客户名称',
        value: { type: 'text' as const, value: 'Alpha' },
        contentRevision: 1,
        proposalId: PROPOSAL,
        proposerId: ACTOR,
        confirmedById: ACTOR,
        evidence: [],
        createdAt: '2026-09-08T00:00:00+00:00',
      },
      history: [],
    })),
    proposal: vi.fn(async () => ({
      id: PROPOSAL,
      projectId: PROJECT,
      fieldKey: 'customer.name',
      label: '客户名称',
      value: { type: 'text' as const, value: 'Alpha' },
      proposerId: ACTOR,
      baseRevision: 0,
      status: 'pending' as const,
      evidence: [],
      createdAt: '2026-09-08T00:00:00+00:00',
      admittedAt: '2026-09-08T00:00:01+00:00',
    })),
    approve: vi.fn(async () => ({
      proposalId: PROPOSAL,
      status: 'confirmed' as const,
      factRevisionId: REVISION,
      contentRevision: 1,
    })),
    reject: vi.fn(async () => ({ proposalId: PROPOSAL, status: 'rejected' as const })),
    withdraw: vi.fn(async () => ({ proposalId: PROPOSAL, status: 'withdrawn' as const })),
    pullOutbox: vi.fn(async (...args: Parameters<XAgentFactBackend['pullOutbox']>) => {
      outboxCalls.push(args)
      return { items: [] }
    }),
  }
}

function service(value = backend()): {
  readonly ctx: Context
  readonly backend: BackendProbe
  readonly receipts: XAgentFactReceiptRegistry
  readonly outbox: XAgentFactOutboxRegistry
  readonly fact: XAgentFactService
} {
  const ctx = new Context()
  const receipts = new XAgentFactReceiptRegistry()
  const outbox = new XAgentFactOutboxRegistry()
  const fact = new XAgentFactService(ctx, value, receipts, outbox, {
    issuer: 'xagent-host',
    audience: 'xagent-api',
    privateKey,
    now: () => 1_800_000_000,
  })
  return { ctx, backend: value, receipts, outbox, fact }
}

function proposalInput(toolCallId = 'call-1') {
  return {
    sessionId: RUNTIME_SESSION,
    toolCallId,
    fieldKey: 'customer.name',
    label: 'Customer',
    value: { type: 'text' as const, value: 'Alpha' },
    evidenceIds: [] as string[],
    assertionReason: 'manual assertion',
  }
}

function agentFor(session: Session): Agent {
  return { session, send: vi.fn(), cancel: vi.fn() } as unknown as Agent
}

function decision(index: number): XAgentFactOutboxItem {
  const suffix = String(index).padStart(12, '0')
  return {
    outboxId: `00000000-0000-0000-0001-${suffix}`,
    payloadHash: index.toString(16).padStart(64, '0'),
    event: {
      type: 'fact/proposal-decided',
      data: {
        proposalId: `00000000-0000-0000-0002-${suffix}`,
        projectId: PROJECT,
        fieldKey: `field.${String(index)}`,
        label: `字段 ${String(index)}`,
        status: 'rejected',
        decisionReason: 'not accepted',
      },
    },
  }
}

async function pluginSession(
  ctx: Context,
  requestScope: XAgentAuthenticatedSessionRequestScope | undefined,
): Promise<{ readonly session: Session; readonly owner: Context['fiber'] }> {
  let session: Session | undefined
  const install = async (): Promise<Context['fiber']> => {
    const plugin = Object.assign((child: Context) => {
      session = child.sessions.create(SessionId(RUNTIME_SESSION))
    }, { inject: ['sessions'] })
    const owner = ctx.plugin(plugin)
    await owner
    return owner
  }
  const owner = requestScope === undefined ? await install() : await runWithXAgentAuthenticatedRequestScope(requestScope, install)
  if (session === undefined) throw new Error('session did not start')
  return { session, owner }
}

function factEvents(session: Session): SessionEvent[] {
  return session.events.filter(event => (event as { readonly type: string }).type === 'fact/proposal-decided')
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class RequestProbeAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly scripted: StreamChunk[][] = []

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield* this.scripted.shift() ?? textResponse(`answer-${String(this.requests.length)}`)
  }
}

class ErrorThenFactAdapter extends RequestProbeAdapter {
  readonly firstStarted = Promise.withResolvers<undefined>()
  readonly releaseFirst = Promise.withResolvers<undefined>()

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      this.firstStarted.resolve(undefined)
      await this.releaseFirst.promise
      throw new Error('first request failed')
    }
    if (this.requests.length === 2) {
      const id = CallId('queued-fact-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'propose_fact', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'propose_fact', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield* textResponse('done')
  }
}

function toolResponse(callId = 'fact-projection-noop'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: CallId(callId), name: 'fact_projection_noop', argumentsDelta: '{}' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: CallId(callId), name: 'fact_projection_noop', arguments: '{}' },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

async function loopHarness(seed?: readonly SessionEvent[], adapter: RequestProbeAdapter = new RequestProbeAdapter()): Promise<{
  readonly ctx: Context
  readonly adapter: RequestProbeAdapter
  readonly backend: BackendProbe
  readonly fact: XAgentFactService
  readonly agent: Agent
}> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'Fact projection test' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const value = backend()
  const fact = new XAgentFactService(
    ctx,
    value,
    new XAgentFactReceiptRegistry(),
    new XAgentFactOutboxRegistry(),
    { issuer: 'xagent-host', audience: 'xagent-api', privateKey },
  )
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId(RUNTIME_SESSION),
    ...seed === undefined ? {} : { seed },
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  return { ctx, adapter, backend: value, fact, agent: handle.agent }
}

async function runMessageTurn(ctx: Context, agent: Agent, message: ReturnType<typeof createUserMessage>): Promise<void> {
  const idle = new Promise<void>((resolve) => {
    const close = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      close()
      resolve()
    })
  })
  runWithXAgentAuthenticatedRequestScope(scope(), () => {
    agent.followup(message)
  })
  await idle
}

async function runUserTurn(ctx: Context, agent: Agent, text: string): Promise<void> {
  await runMessageTurn(
    ctx,
    agent,
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  )
}

function requestText(request: GenerateOptions): string {
  return request.messages.flatMap(message => message.content)
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

async function drainStream(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const chunk of stream) void chunk
}

describe('XAgent Fact provider', () => {
  test('executes a queued follow-up under its physical scope after the active Turn errors', async () => {
    const adapter = new ErrorThenFactAdapter()
    const created = await loopHarness(undefined, adapter)
    created.agent.ctx.tools.register(defineContentToolFixture({
      name: 'propose_fact',
      description: 'Exercise the Fact provider scope wrapper.',
      parameters: {},
      execute: async (_args, execution) => {
        const result = await created.fact.proposeFact(proposalInput(String(execution.callId)))
        return [{ type: 'text', text: JSON.stringify(result) }]
      },
    }))
    const firstScope = scope()
    const queuedScope = scope({
      userToken: 'queued-user-token',
      connectionId: 'connection-2',
      principal: Object.freeze({ ...firstScope.principal, connectionId: 'connection-2' }),
    })
    runWithXAgentAuthenticatedRequestScope(firstScope, () => {
      created.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    })
    await adapter.firstStarted.promise
    runWithXAgentAuthenticatedRequestScope(queuedScope, () => {
      created.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } }))
    })
    adapter.releaseFirst.resolve(undefined)
    await created.agent.whenIdle()
    runWithXAgentAuthenticatedRequestScope(queuedScope, () => {
      created.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'wake queued work' }], source: { kind: 'user' } }))
    })
    await created.agent.whenIdle()

    expect(adapter.requests).toHaveLength(4)
    expect(created.backend.prepare).toHaveBeenCalledWith(
      'queued-user-token',
      expect.any(String),
      expect.objectContaining({ toolCallId: 'queued-fact-call' }),
      expect.any(AbortSignal),
    )
    await created.ctx.fiber.dispose()
  })

  test('claims one complete physical scope before pre-step and preserves queued bindings across an earlier error', async () => {
    const created = service()
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const firstScope = scope()
    const secondScope = scope({
      userToken: 'replacement-token',
      connectionId: 'connection-2',
      principal: Object.freeze({ ...firstScope.principal, connectionId: 'connection-2' }),
    })
    const first = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    const queued = createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(firstScope, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: first })
    })
    agentEvents(created.ctx, agent).emit('agent/inbox/claimed', { message: first, turn: 1 })
    const activeScopes = (created.fact as unknown as {
      activeScopes: Map<Agent, XAgentAuthenticatedSessionRequestScope>
    }).activeScopes
    expect(activeScopes.get(agent)).toBe(firstScope)

    runWithXAgentAuthenticatedRequestScope(secondScope, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: queued })
    })
    agentEvents(created.ctx, agent).emit('agent/error', { turn: 1, step: 1, error: new Error('fixture') })
    expect((created.fact as unknown as { messageScopes: Map<string, unknown> }).messageScopes.has(String(queued.id))).toBe(true)
    agentEvents(created.ctx, agent).emit('agent/inbox/claimed', { message: queued, turn: 2 })
    expect(activeScopes.get(agent)).toBe(secondScope)
    await agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [queued], turn: 2, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [queued] }),
    )
    expect(created.backend.pullOutbox).toHaveBeenLastCalledWith(
      'replacement-token', SESSION, { limit: 32 }, expect.any(AbortSignal),
    )
  })

  test('fails closed for mixed claimed scopes and accepts the surviving scope after discard', async () => {
    const created = service()
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const firstScope = scope()
    const secondScope = scope({
      connectionId: 'connection-2',
      principal: Object.freeze({ ...firstScope.principal, connectionId: 'connection-2' }),
    })
    const first = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'plugin', plugin: 'fixture' } })
    const second = createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(firstScope, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: first })
    })
    runWithXAgentAuthenticatedRequestScope(secondScope, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: second })
    })
    agentEvents(created.ctx, agent).emit('agent/inbox/claimed', { message: first, turn: 1 })
    agentEvents(created.ctx, agent).emit('agent/inbox/claimed', { message: second, turn: 1 })
    const activeScopes = (created.fact as unknown as {
      activeScopes: Map<Agent, XAgentAuthenticatedSessionRequestScope>
    }).activeScopes
    expect(activeScopes.has(agent)).toBe(false)
    await agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [first, second], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [first, second] }),
    )
    expect(created.backend.pullOutbox).not.toHaveBeenCalled()

    const retained = createUserMessage({ content: [{ type: 'text', text: 'retained' }], source: { kind: 'user' } })
    const retainedPeer = createUserMessage({ content: [{ type: 'text', text: 'retained peer' }], source: { kind: 'user' } })
    const discarded = createUserMessage({ content: [{ type: 'text', text: 'discarded' }], source: { kind: 'plugin', plugin: 'fixture' } })
    runWithXAgentAuthenticatedRequestScope(firstScope, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: retained })
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: retainedPeer })
    })
    runWithXAgentAuthenticatedRequestScope(secondScope, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: discarded })
    })
    agentEvents(created.ctx, agent).emit('agent/inbox/discarded', { message: discarded })
    agentEvents(created.ctx, agent).emit('agent/inbox/claimed', { message: retained, turn: 2 })
    agentEvents(created.ctx, agent).emit('agent/inbox/claimed', { message: retainedPeer, turn: 2 })
    expect(activeScopes.get(agent)).toBe(firstScope)

    const foreign = createUserMessage({ content: [{ type: 'text', text: 'foreign' }], source: { kind: 'user' } })
    const otherAgent = agentFor(session)
    runWithXAgentAuthenticatedRequestScope(firstScope, () => {
      agentEvents(created.ctx, otherAgent).emit('agent/inbox/inserted', { message: foreign })
    })
    agentEvents(created.ctx, agent).emit('agent/inbox/claimed', { message: foreign, turn: 3 })
    expect(activeScopes.has(agent)).toBe(false)
  })

  test('projects ordered terminal decisions into exactly the next user model request across restart', async () => {
    const created = await loopHarness()
    await runUserTurn(created.ctx, created.agent, 'first')

    const decisions = [
      {
        ...decision(1).event.data,
        status: 'confirmed' as const,
        factRevisionId: REVISION,
        contentRevision: 1,
        decisionReason: 'approved by manager',
      },
      { ...decision(2).event.data, status: 'rejected' as const, decisionReason: 'unsupported' },
      { ...decision(3).event.data, status: 'withdrawn' as const, decisionReason: 'superseded' },
      { ...decision(4).event.data, status: 'conflicted' as const, decisionReason: 'head advanced' },
    ]
    for (const data of decisions) created.agent.session.append('fact/proposal-decided', data)
    expect(created.adapter.requests).toHaveLength(1)
    expect(created.agent.status).toBe('idle')

    await runUserTurn(created.ctx, created.agent, 'second')
    const second = requestText(created.adapter.requests[1]!)
    expect(decisions.map(item => second.indexOf(item.proposalId))).toEqual([
      expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number),
    ])
    expect(decisions.map(item => second.indexOf(item.proposalId)))
      .toEqual([...decisions].map(item => second.indexOf(item.proposalId)).toSorted((left, right) => left - right))
    expect(second).toContain('approved by manager')
    expect(second).toContain('unsupported')
    expect(second).toContain('superseded')
    expect(second).toContain('head advanced')
    const notice = created.agent.session.events.find(event => (
      event.type === 'user/message' && event.data.source.kind === 'xagent-fact-decisions'
    ))
    expect(notice?.type).toBe('user/message')
    if (notice?.type !== 'user/message') throw new Error('Fact decision notice missing')
    const replacement = created.agent.session.events.find(event => (
      event.type === 'user/message'
      && event.surfaceOp !== 'append'
      && event.sourceEventSeqs?.includes(notice.seq) === true
    ))
    expect(replacement?.type).toBe('user/message')
    if (replacement?.type !== 'user/message' || replacement.surfaceOp === 'append') {
      throw new Error('Fact decision replacement missing')
    }
    const previousSeq = replacement.sourceEventSeqs?.[0]
    expect(previousSeq).toBeTypeOf('number')
    const previous = previousSeq === undefined ? undefined : created.agent.session.events[previousSeq]
    expect(previous?.type).toBe('user/message')
    if (previous?.type !== 'user/message') throw new Error('Fact decision predecessor missing')
    expect(replacement.sourceEventSeqs).toEqual([previous.seq, notice.seq])
    expect(replacement.surfaceOp).toEqual({ op: 'replace', start: previous.seq, end: notice.seq })
    expect(replacement.data).toEqual(previous.data)
    expect(created.agent.session.surface.nodes).not.toContain(notice.seq)

    await runUserTurn(created.ctx, created.agent, 'third')
    const third = requestText(created.adapter.requests[2]!)
    for (const item of decisions) expect(third).not.toContain(item.proposalId)

    const seed = [...created.agent.session.events]
    await created.ctx.fiber.dispose()
    const restarted = await loopHarness(seed)
    await runUserTurn(restarted.ctx, restarted.agent, 'after restart')
    const resumed = requestText(restarted.adapter.requests[0]!)
    for (const item of decisions) expect(resumed).not.toContain(item.proposalId)
    await restarted.ctx.fiber.dispose()
  })

  test('defers a decision pulled during a user-steered tool continuation until the next Turn', async () => {
    const created = await loopHarness()
    const pending = decision(8)
    let pulls = 0
    created.backend.pullOutbox = vi.fn(async () => ({ items: ++pulls === 2 ? [pending] : [] }))
    created.agent.ctx.tools.register(defineContentToolFixture({
      name: 'fact_projection_noop',
      description: 'Steer one real user message into the next step.',
      parameters: {},
      execute: () => {
        created.agent.steer(createUserMessage({
          content: [{ type: 'text', text: 'steered user correction' }],
          source: { kind: 'user' },
        }))
        return Promise.resolve([{ type: 'text', text: 'steered' }])
      },
    }))
    created.adapter.scripted.push(toolResponse(), textResponse('continued'))

    await runUserTurn(created.ctx, created.agent, 'start tool work')

    expect(created.adapter.requests).toHaveLength(2)
    expect(requestText(created.adapter.requests[1]!)).not.toContain(pending.event.data.proposalId)
    await runUserTurn(created.ctx, created.agent, 'new Turn')
    expect(requestText(created.adapter.requests[2]!)).toContain(pending.event.data.proposalId)
    await runUserTurn(created.ctx, created.agent, 'later Turn')
    expect(requestText(created.adapter.requests[3]!)).not.toContain(pending.event.data.proposalId)
    await created.ctx.fiber.dispose()
  })

  test('does not project a pending decision into a plugin-initiated Turn', async () => {
    const created = await loopHarness()
    await runUserTurn(created.ctx, created.agent, 'baseline')
    const pending = decision(9).event.data
    created.agent.session.append('fact/proposal-decided', pending)

    await runMessageTurn(created.ctx, created.agent, createUserMessage({
      content: [{ type: 'text', text: 'background refresh' }],
      source: { kind: 'plugin', plugin: 'fact-test' },
    }))

    expect(requestText(created.adapter.requests[1]!)).not.toContain(pending.proposalId)
    await runUserTurn(created.ctx, created.agent, 'real user Turn')
    expect(requestText(created.adapter.requests[2]!)).toContain(pending.proposalId)
    await runUserTurn(created.ctx, created.agent, 'later Turn')
    expect(requestText(created.adapter.requests[3]!)).not.toContain(pending.proposalId)
    await created.ctx.fiber.dispose()
  })

  test('keeps Outbox pages bounded across tool continuations and restart', async () => {
    let pulls = 0
    const pullOutbox = vi.fn(async () => {
      const page = ++pulls
      return { items: Array.from({ length: 32 }, (_, offset) => decision(page * 100 + offset)) }
    })
    const created = await loopHarness()
    created.backend.pullOutbox = pullOutbox
    created.agent.ctx.tools.register(defineContentToolFixture({
      name: 'fact_projection_noop',
      description: 'Continue one bounded Fact projection Turn.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'continued' }]),
    }))
    created.adapter.scripted.push(toolResponse('fact-page-step-1'), toolResponse('fact-page-step-2'), textResponse('done'))

    await runUserTurn(created.ctx, created.agent, 'process one bounded page')
    const seed = [...created.agent.session.events]
    await created.ctx.fiber.dispose()

    const restarted = await loopHarness(seed)
    restarted.backend.pullOutbox = pullOutbox
    await runUserTurn(restarted.ctx, restarted.agent, 'project the pending page after restart')
    await runUserTurn(restarted.ctx, restarted.agent, 'pull the following page')

    const visibleCounts = [
      ...created.adapter.requests.map(request => request.messages
        .reduce((count, message) => message.source.kind === 'xagent-fact-decisions'
          ? count + message.source.eventSeqs.length
          : count, 0)),
      ...restarted.adapter.requests.map(request => request.messages
        .reduce((count, message) => message.source.kind === 'xagent-fact-decisions'
          ? count + message.source.eventSeqs.length
          : count, 0)),
    ]
    expect(visibleCounts).toEqual([32, 0, 0, 32, 32])
    expect(pullOutbox).toHaveBeenCalledTimes(3)
    expect(requestText(restarted.adapter.requests[0]!)).toContain(decision(200).event.data.proposalId)
    expect(requestText(restarted.adapter.requests[0]!)).not.toContain(decision(300).event.data.proposalId)
    expect(requestText(restarted.adapter.requests[1]!)).toContain(decision(300).event.data.proposalId)
    await restarted.ctx.fiber.dispose()
  })

  test('rejects malformed projected-decision provenance before another model request', async () => {
    for (const sourceEventSeqs of [[-1], [0]]) {
      const created = await loopHarness()
      await runUserTurn(created.ctx, created.agent, 'baseline')
      const citedSeqs = sourceEventSeqs[0] === 0
        ? [created.agent.session.events.find(event => event.type === 'user/message')?.seq ?? 0]
        : sourceEventSeqs
      const malformed = createUserMessage({
        content: [{ type: 'text', text: 'malformed Fact decision notice' }],
        source: { kind: 'xagent-fact-decisions' as const, eventSeqs: citedSeqs },
      })
      created.agent.session.append('user/message', malformed, { surfaceOp: 'append' })

      await runUserTurn(created.ctx, created.agent, 'must fail closed')

      expect(created.adapter.requests).toHaveLength(1)
      expect(created.agent.session.events.findLast(event => event.type === 'turn/end')).toMatchObject({
        data: { reason: { kind: 'error' } },
      })
      await created.ctx.fiber.dispose()
    }
  })

  test('ignores non-loop streams and rejects missing Sessions or non-surface notices', async () => {
    const created = await loopHarness()
    await runUserTurn(created.ctx, created.agent, 'baseline')
    const request = created.adapter.requests[0]!
    const notice = createUserMessage({
      content: [{ type: 'text', text: 'detached Fact decision notice' }],
      source: { kind: 'xagent-fact-decisions' as const, eventSeqs: [] },
    })

    await drainStream(created.ctx.llm.stream({ ...request, messages: [notice] }))
    expect(created.adapter.requests).toHaveLength(2)

    const missing = markAgentLoopRequest({
      ...request,
      sessionId: SessionId('session-00000000-0000-0000-0000-000000000299'),
      messages: [notice],
    })
    expect(() => created.ctx.llm.stream(missing)).toThrow('has no live Session')

    const detached = markAgentLoopRequest({ ...request, messages: [notice] })
    await expect(drainStream(created.ctx.llm.stream(detached)))
      .rejects.toThrow('is not adjacent to a prior user surface node')
    await created.ctx.fiber.dispose()
  })

  test('consumes a projected decision when the downstream stream is empty', async () => {
    const created = await loopHarness()
    await runUserTurn(created.ctx, created.agent, 'baseline')
    const pending = decision(1).event.data
    created.agent.session.append('fact/proposal-decided', pending)
    created.adapter.scripted.push([])

    await runUserTurn(created.ctx, created.agent, 'empty response')
    expect(requestText(created.adapter.requests[1]!)).toContain(pending.proposalId)
    await runUserTurn(created.ctx, created.agent, 'later')
    expect(requestText(created.adapter.requests[2]!)).not.toContain(pending.proposalId)
    await created.ctx.fiber.dispose()
  })

  test('retains an unconsumed decision when downstream throws before entering the model stream', async () => {
    const created = await loopHarness()
    await runUserTurn(created.ctx, created.agent, 'baseline')
    const pending = decision(1).event.data
    created.agent.session.append('fact/proposal-decided', pending)
    let reject = true
    created.ctx.on('llm/stream', (_options, next) => {
      if (!reject) return next()
      reject = false
      return (async function* () {
        throw new Error('downstream unavailable')
      })()
    })

    await runUserTurn(created.ctx, created.agent, 'failed attempt')
    expect(created.adapter.requests).toHaveLength(1)
    expect(created.agent.session.deriveMessages().some(message => JSON.stringify(message).includes(pending.proposalId))).toBe(true)

    await runUserTurn(created.ctx, created.agent, 'retry')
    expect(requestText(created.adapter.requests[1]!)).toContain(pending.proposalId)
    await runUserTurn(created.ctx, created.agent, 'later')
    expect(requestText(created.adapter.requests[2]!)).not.toContain(pending.proposalId)
    await created.ctx.fiber.dispose()
  })

  test('reconstructs an unconsumed decision after restart and hides it from the same-Turn continuation', async () => {
    const created = await loopHarness()
    await runUserTurn(created.ctx, created.agent, 'baseline')
    const pending = decision(1).event.data
    created.agent.session.append('fact/proposal-decided', pending)
    const seed = [...created.agent.session.events]
    await created.ctx.fiber.dispose()

    const restarted = await loopHarness(seed)
    restarted.agent.ctx.tools.register(defineContentToolFixture({
      name: 'fact_projection_noop',
      description: 'Return one fixed value.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'ok' }]),
    }))
    restarted.adapter.scripted.push(toolResponse(), textResponse('continued'))
    await runUserTurn(restarted.ctx, restarted.agent, 'after restart')

    expect(requestText(restarted.adapter.requests[0]!)).toContain(pending.proposalId)
    expect(requestText(restarted.adapter.requests[1]!)).not.toContain(pending.proposalId)
    await runUserTurn(restarted.ctx, restarted.agent, 'later')
    expect(requestText(restarted.adapter.requests[2]!)).not.toContain(pending.proposalId)
    await restarted.ctx.fiber.dispose()
  })

  test('fails closed when decision-notice replacement append or durability flush fails', async () => {
    const appendFailure = await loopHarness()
    await runUserTurn(appendFailure.ctx, appendFailure.agent, 'baseline')
    const appendDecision = decision(1).event.data
    appendFailure.agent.session.append('fact/proposal-decided', appendDecision)
    const originalAppend = appendFailure.agent.session.append.bind(appendFailure.agent.session)
    const append = vi.spyOn(appendFailure.agent.session, 'append').mockImplementation((type, data, ...options) => {
      const surface = options[0] as { readonly surfaceOp?: unknown } | undefined
      if (type === 'user/message' && surface?.surfaceOp !== 'append') throw new Error('replacement append failed')
      return originalAppend(type as never, data as never, ...options as never)
    })
    await runUserTurn(appendFailure.ctx, appendFailure.agent, 'append failure')
    expect(requestText(appendFailure.adapter.requests[1]!)).toContain(appendDecision.proposalId)
    expect(appendFailure.agent.session.deriveMessages().some(message => JSON.stringify(message).includes(appendDecision.proposalId)))
      .toBe(true)
    append.mockRestore()
    await runUserTurn(appendFailure.ctx, appendFailure.agent, 'append recovery')
    expect(requestText(appendFailure.adapter.requests[2]!)).toContain(appendDecision.proposalId)
    await appendFailure.ctx.fiber.dispose()

    const flushFailure = await loopHarness()
    await runUserTurn(flushFailure.ctx, flushFailure.agent, 'baseline')
    const flushDecision = decision(2).event.data
    flushFailure.agent.session.append('fact/proposal-decided', flushDecision)
    const flush = vi.spyOn(flushFailure.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('durability failed'))
    await runUserTurn(flushFailure.ctx, flushFailure.agent, 'flush failure')
    expect(requestText(flushFailure.adapter.requests[1]!)).toContain(flushDecision.proposalId)
    expect(flush).toHaveBeenCalledTimes(2)
    expect(flushFailure.agent.session.deriveMessages().some(message => JSON.stringify(message).includes(flushDecision.proposalId)))
      .toBe(true)
    expect(flushFailure.agent.session.events.findLast(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error' } },
    })
    await runUserTurn(flushFailure.ctx, flushFailure.agent, 'flush recovery')
    expect(requestText(flushFailure.adapter.requests[2]!)).toContain(flushDecision.proposalId)
    await runUserTurn(flushFailure.ctx, flushFailure.agent, 'after flush recovery')
    expect(requestText(flushFailure.adapter.requests[3]!)).not.toContain(flushDecision.proposalId)
    await flushFailure.ctx.fiber.dispose()
  })

  test('retains one retry notice without yielding a model chunk when replacement and restoration flush both fail', async () => {
    const created = await loopHarness()
    await runUserTurn(created.ctx, created.agent, 'baseline')
    const baselineAssistantCount = created.agent.session.events.filter(event => event.type === 'assistant/message').length
    const pending = decision(3).event.data
    created.agent.session.append('fact/proposal-decided', pending)
    const flush = vi.spyOn(created.ctx.sessions, 'flush')
      .mockRejectedValueOnce(new Error('replacement durability failed'))
      .mockRejectedValueOnce(new Error('restoration durability failed'))

    await runUserTurn(created.ctx, created.agent, 'persistent flush failure')

    expect(flush).toHaveBeenCalledTimes(2)
    expect(created.agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(baselineAssistantCount)
    expect(requestText(created.adapter.requests[1]!).split(pending.proposalId)).toHaveLength(2)
    const visible = requestText({ ...created.adapter.requests[1]!, messages: created.agent.session.deriveMessages() })
    expect(visible.split(pending.proposalId)).toHaveLength(2)

    flush.mockRestore()
    await runUserTurn(created.ctx, created.agent, 'persistent flush recovery')
    expect(requestText(created.adapter.requests[2]!).split(pending.proposalId)).toHaveLength(2)
    await runUserTurn(created.ctx, created.agent, 'after persistent flush recovery')
    expect(requestText(created.adapter.requests[3]!)).not.toContain(pending.proposalId)
    await created.ctx.fiber.dispose()
  })

  test('consumes an entered decision request before cancellation reaches the loop', async () => {
    const created = await loopHarness()
    await runUserTurn(created.ctx, created.agent, 'baseline')
    const pending = decision(1).event.data
    created.agent.session.append('fact/proposal-decided', pending)
    created.ctx.on('session/event', (session, event) => {
      if (session !== created.agent.session || event.type !== 'user/message' || event.surfaceOp === 'append') return
      if (event.sourceEventSeqs?.some((seq) => {
        const source = created.agent.session.events[seq]
        return source?.type === 'user/message' && source.data.source.kind === 'xagent-fact-decisions'
      }) === true) {
        created.agent.cancel({ kind: 'user' })
      }
    })

    await runUserTurn(created.ctx, created.agent, 'cancelled request')
    expect(requestText(created.adapter.requests[1]!)).toContain(pending.proposalId)
    await runUserTurn(created.ctx, created.agent, 'after cancellation')
    expect(requestText(created.adapter.requests[2]!)).not.toContain(pending.proposalId)
    await created.ctx.fiber.dispose()
  })

  test('registers one Service, fixed Remote methods, and no receipt-bearing Remote', async () => {
    const created = service()
    expect(created.fact.typertRemote).toMatchObject({
      serviceKey: 'xagentFact',
      namespace: 'xagentFact',
    })
    expect(created.fact.typertRemote.service).toBe(created.fact)
    expect(remoteMethods(created.fact)).toEqual([
      { method: 'listHeads', exportName: 'list-heads', invocation: { kind: 'direct' } },
      { method: 'listProposals', exportName: 'list-proposals', invocation: { kind: 'direct' } },
      { method: 'revision', invocation: { kind: 'direct' } },
      { method: 'proposal', invocation: { kind: 'direct' } },
      { method: 'approve', invocation: { kind: 'direct' } },
      { method: 'reject', invocation: { kind: 'direct' } },
      { method: 'withdraw', invocation: { kind: 'direct' } },
    ])
    expect(created.fact.receipts).not.toBe(created.fact.outbox)

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    apply(ctx, {
      backendOrigin: 'https://api.example.test',
      serviceToken: 'service-token',
      delegationPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      delegationIssuer: 'xagent-host',
      delegationAudience: 'xagent-api',
    })
    expect(ctx.get('xagentFact')).toBeInstanceOf(XAgentFactService)
    await ctx.fiber.dispose()
  })

  test('derives exact proposal authority and a sixty-second one-use delegation from the physical Project scope', async () => {
    const created = service()
    const callerInput = {
      sessionId: RUNTIME_SESSION,
      toolCallId: 'call-propose-1',
      fieldKey: 'customer.name',
      label: '客户名称',
      value: { type: 'text' as const, value: 'Alpha' },
      evidenceIds: ['[资料1]'],
      assertionReason: 'confirmed by operator',
      actorId: 'caller-supplied-actor',
      projectId: 'caller-supplied-project',
      permissionRevision: 999,
      userToken: 'caller-supplied-token',
    }

    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => created.fact.proposeFact(callerInput)))
      .resolves.toEqual({ proposalId: PROPOSAL, status: 'pending' })
    expect(created.backend.prepareCalls).toHaveLength(1)
    const [userToken, delegation, input, signal] = created.backend.prepareCalls[0]!
    expect(userToken).toBe('user-token')
    expect(input).toEqual({
      sessionId: SESSION,
      toolCallId: 'call-propose-1',
      permissionRevision: 7,
      idempotencyKey: input.idempotencyKey,
      fieldKey: 'customer.name',
      label: '客户名称',
      value: { type: 'text', value: 'Alpha' },
      evidenceIds: ['[资料1]'],
      assertionReason: 'confirmed by operator',
    })
    expect(input.idempotencyKey).toMatch(/^propose_fact:[0-9a-f]{64}$/u)
    expect(signal).toBeInstanceOf(AbortSignal)
    const claims = await verifyDelegationToken(delegation, {
      publicKey,
      issuer: 'xagent-host',
      audience: 'xagent-api',
      now: 1_800_000_000,
      expected: {
        actorId: ACTOR,
        projectId: PROJECT,
        sessionId: SESSION,
        toolCallId: 'call-propose-1',
        toolName: 'propose_fact',
        permissionRevision: 7,
      },
      currentPermissionRevision: 7,
      consumeNonce: async nonce => nonce.length > 0,
    })
    expect(claims.expiresAt - claims.issuedAt).toBe(60)
    expect(claims.nonce).not.toHaveLength(0)
    expect(JSON.stringify(input)).not.toContain('caller-supplied')
  })

  test('keeps the receipt private until the matching public tool result binds its event sequence', async () => {
    const created = service()
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    await runWithXAgentAuthenticatedRequestScope(scope(), () => created.fact.proposeFact({
      sessionId: RUNTIME_SESSION,
      toolCallId: 'call-propose-1',
      fieldKey: 'customer.name',
      label: '客户名称',
      value: { type: 'text', value: 'Alpha' },
      evidenceIds: [],
      assertionReason: 'operator assertion',
    }))
    expect(created.receipts.attachments(RUNTIME_SESSION, 0, 100)).toEqual([])

    const call = session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-propose-1' as never,
      name: 'propose_fact',
      arguments: '{}',
    })
    const result = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'fact-result' as never,
        role: 'user',
        source: { kind: 'tool', callId: 'call-propose-1' as never },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-propose-1' as never,
          isError: false,
          content: [{ type: 'text', text: JSON.stringify({ proposalId: PROPOSAL, status: 'pending' }) }],
        }],
      },
      meta: { kind: 'xagent-fact', proposalId: PROPOSAL, status: 'pending' },
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })

    expect(created.receipts.attachments(RUNTIME_SESSION, result.seq, result.seq)).toEqual([{
      eventSequence: result.seq,
      toolCallId: 'call-propose-1',
      proposalId: PROPOSAL,
      receipt: 'opaque-fact-receipt',
      payloadHash: 'a'.repeat(64),
    }])
    expect(JSON.stringify(result)).not.toContain('opaque-fact-receipt')
  })

  test('denies anonymous, Private, mismatched, and missing-project scopes before backend access', async () => {
    const created = service()
    const input = proposalInput()
    await expect(created.fact.proposeFact(input)).rejects.toEqual(new XAgentFactError('unauthenticated'))
    await expect(runWithXAgentAuthenticatedRequestScope(scope({
      visibility: 'private',
      projectId: null,
    }), () => created.fact.proposeFact(input)))
      .rejects.toEqual(new XAgentFactError('fact-session-invalid'))
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => created.fact.proposeFact({
      ...input,
      sessionId: 'session-00000000-0000-0000-0000-000000000299',
    }))).rejects.toEqual(new XAgentFactError('unauthenticated'))
    await expect(created.fact.withRequest(scope({
      visibility: 'private',
      projectId: null,
    }), async () => undefined))
      .rejects.toThrow('project request scope')
    expect(created.backend.prepare).not.toHaveBeenCalled()
  })

  test('rejects every malformed, stale, or nested physical request scope', async () => {
    const created = service()
    const valid = scope()
    const uppercaseSession = 'AAAAAAAA-0000-0000-0000-000000000201'
    const uppercaseProject = 'AAAAAAAA-0000-0000-0000-000000000301'
    const abortedRequest = new AbortController()
    abortedRequest.abort()
    const abortedConnection = new AbortController()
    abortedConnection.abort()
    const candidates: unknown[] = [
      undefined,
      null,
      { ...valid, principal: { ...valid.principal, actorId: 'bad' } },
      { ...valid, visibility: 'other' },
      { ...valid, sessionId: 'bad' },
      { ...valid, sessionId: uppercaseSession },
      { ...valid, projectId: null },
      { ...valid, projectId: 'bad' },
      { ...valid, projectId: uppercaseProject },
      { ...valid, requestSignal: undefined },
      { ...valid, connectionSignal: undefined },
      { ...valid, requestSignal: abortedRequest.signal },
      { ...valid, connectionSignal: abortedConnection.signal },
    ]
    for (const candidate of candidates) {
      await expect(created.fact.withRequest(candidate as never, async () => undefined)).rejects.toThrow()
    }
    await created.fact.withRequest(scope(), async () => {
      await expect(created.fact.withRequest(scope(), async () => undefined)).rejects.toThrow('nested')
      expect(() => {
        void created.fact.approve(
          'session-00000000-0000-0000-0000-000000000299',
          PROPOSAL,
          { idempotencyKey: 'mismatch' },
        )
      }).toThrow(TypertRemoteFailure)
    })
    expect(() => { void created.fact.approve(RUNTIME_SESSION, PROPOSAL, { idempotencyKey: 'no-scope' }) })
      .toThrow('request scope is required')
    await created.fact.dispose()
    await expect(created.fact.withRequest(scope(), async () => undefined)).rejects.toThrow('disposed')
  })

  test('maps proposal failures, omits absent assertion reason, and refuses unusable signing state', async () => {
    const stableBackend = backend()
    stableBackend.prepare = vi.fn(async () => { throw new XAgentBackendError('stale-permission') })
    const stable = service(stableBackend)
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => stable.fact.proposeFact(proposalInput())))
      .rejects.toEqual(new XAgentFactError('stale-permission'))

    const unavailableBackend = backend()
    unavailableBackend.prepare = vi.fn(async () => { throw new Error('upstream secret') })
    const unavailable = service(unavailableBackend)
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => unavailable.fact.proposeFact(proposalInput())))
      .rejects.toEqual(new XAgentFactError('service-unavailable'))

    const malformedBackend = backend()
    malformedBackend.prepare = vi.fn(async () => ({
      result: { proposalId: PROPOSAL, status: 'pending' as const },
      receipt: 'contains spaces',
      payloadHash: 'a'.repeat(64),
    }))
    const malformed = service(malformedBackend)
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => malformed.fact.proposeFact(proposalInput())))
      .rejects.toEqual(new XAgentFactError('service-unavailable'))

    const noAssertion = backend()
    const currentTime = new XAgentFactService(
      new Context(),
      noAssertion,
      new XAgentFactReceiptRegistry(),
      new XAgentFactOutboxRegistry(),
      { issuer: 'xagent-host', audience: 'xagent-api', privateKey },
    )
    const withoutReason = proposalInput('call-no-reason')
    delete (withoutReason as { assertionReason?: string }).assertionReason
    await runWithXAgentAuthenticatedRequestScope(scope(), () => currentTime.proposeFact(withoutReason))
    expect(noAssertion.prepareCalls[0]?.[2]).not.toHaveProperty('assertionReason')

    const unsigned = new XAgentFactService(
      new Context(),
      backend(),
      new XAgentFactReceiptRegistry(),
      new XAgentFactOutboxRegistry(),
      { issuer: 'xagent-host', audience: 'xagent-api' },
    )
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => unsigned.proposeFact(proposalInput())))
      .rejects.toEqual(new XAgentFactError('service-unavailable'))
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => currentTime.proposeFact(proposalInput(''))))
      .rejects.toEqual(new XAgentFactError('service-unavailable'))

    const invalidIssuer = new XAgentFactService(
      new Context(),
      backend(),
      new XAgentFactReceiptRegistry(),
      new XAgentFactOutboxRegistry(),
      { issuer: '', audience: 'xagent-api', privateKey },
    )
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => invalidIssuer.proposeFact(proposalInput())))
      .rejects.toEqual(new XAgentFactError('service-unavailable'))
  })

  test('all Remote calls use the current physical token and fixed Session project', async () => {
    const created = service()
    const signal = new AbortController().signal
    await created.fact.withRequest(scope(), async () => {
      await created.fact.listHeads(RUNTIME_SESSION, { limit: 100 }, signal)
      await created.fact.listProposals(RUNTIME_SESSION, { limit: 50, cursor: 'cursor' }, signal)
      await created.fact.revision(RUNTIME_SESSION, REVISION, signal)
      await created.fact.proposal(RUNTIME_SESSION, PROPOSAL, signal)
      await created.fact.approve(RUNTIME_SESSION, PROPOSAL, { idempotencyKey: 'approve-1', decisionNote: 'ok' }, signal)
      await created.fact.reject(RUNTIME_SESSION, PROPOSAL, { idempotencyKey: 'reject-1', reason: 'bad' }, signal)
      await created.fact.withdraw(RUNTIME_SESSION, PROPOSAL, { idempotencyKey: 'withdraw-1' }, signal)
    })

    expect(created.backend.listHeads).toHaveBeenCalledWith('user-token', PROJECT, { limit: 100 }, expect.any(AbortSignal))
    expect(created.backend.listProposals).toHaveBeenCalledWith(
      'user-token', PROJECT, { limit: 50, cursor: 'cursor' }, expect.any(AbortSignal),
    )
    expect(created.backend.revision).toHaveBeenCalledWith('user-token', REVISION, expect.any(AbortSignal))
    expect(created.backend.proposal).toHaveBeenCalledWith('user-token', PROPOSAL, expect.any(AbortSignal))
    expect(created.backend.approve).toHaveBeenCalledWith(
      'user-token', PROPOSAL, { idempotencyKey: 'approve-1', decisionNote: 'ok' }, expect.any(AbortSignal),
    )
    expect(created.backend.reject).toHaveBeenCalledWith(
      'user-token', PROPOSAL, { idempotencyKey: 'reject-1', reason: 'bad' }, expect.any(AbortSignal),
    )
    expect(created.backend.withdraw).toHaveBeenCalledWith(
      'user-token', PROPOSAL, { idempotencyKey: 'withdraw-1' }, expect.any(AbortSignal),
    )
  })

  test('Remote errors preserve only the stable Fact code set', async () => {
    const value = backend()
    value.approve = vi.fn(async () => { throw new XAgentBackendError('fact-revision-conflict') })
    const created = service(value)
    await expect(created.fact.withRequest(scope(), () => created.fact.approve(
      RUNTIME_SESSION,
      PROPOSAL,
      { idempotencyKey: 'approve-1' },
    ))).rejects.toEqual(new TypertRemoteFailure({
      code: 'fact-revision-conflict',
      message: 'XAgent Fact request failed',
      details: {},
    }))
    value.approve = vi.fn(async () => { throw new XAgentBackendError('sequence-conflict') })
    await expect(created.fact.withRequest(scope(), () => created.fact.approve(
      RUNTIME_SESSION,
      PROPOSAL,
      { idempotencyKey: 'approve-2' },
    ))).rejects.toMatchObject({ failure: { code: 'service-unavailable', details: {} } })
  })

  test('Session open pulls one bounded Outbox page, appends decisions, and never starts a Turn', async () => {
    const value = backend()
    value.pullOutbox = vi.fn(async (...args: Parameters<XAgentFactBackend['pullOutbox']>) => {
      value.outboxCalls.push(args)
      return { items: [decision(1)] }
    })
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, scope())

    await vi.waitFor(() => { expect(factEvents(session)).toHaveLength(1) })
    expect(value.pullOutbox).toHaveBeenCalledWith('user-token', SESSION, { limit: 32 }, expect.any(AbortSignal))
    expect(created.outbox.attachments(RUNTIME_SESSION, 0, 10)).toEqual([{
      eventSequence: 0,
      outboxId: decision(1).outboxId,
      payloadHash: decision(1).payloadHash,
    }])
    expect(session.events.some(event => event.type === 'turn/start')).toBe(false)
  })

  test('Session-open and pre-step triggers coalesce one 32-row pull without driving the Agent', async () => {
    const release = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
    const value = backend()
    value.pullOutbox = vi.fn(async (...args: Parameters<XAgentFactBackend['pullOutbox']>) => {
      value.outboxCalls.push(args)
      return release.promise
    })
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, scope())
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    const message = createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } })
    const send = vi.fn()
    const agent = { session, send, cancel: vi.fn() } as unknown as Agent
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message })
    })
    const preStep = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
    )
    expect(value.pullOutbox).toHaveBeenCalledOnce()
    release.resolve({ items: Array.from({ length: 32 }, (_, index) => decision(index + 1)) })
    await expect(preStep).resolves.toMatchObject({ kind: 'enter' })

    expect(value.pullOutbox).toHaveBeenCalledOnce()
    expect(factEvents(session)).toHaveLength(32)
    expect(created.outbox.attachments(RUNTIME_SESSION, 0, 31)).toHaveLength(32)
    expect(send).not.toHaveBeenCalled()
    expect(session.events.some(event => event.type === 'turn/start')).toBe(false)
  })

  test('Session cancellation clears its Outbox owner synchronously and discards a late result', async () => {
    const release = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
    const value = backend()
    let operationSignal: AbortSignal | undefined
    value.pullOutbox = vi.fn(async (...args: PullOutboxArgs) => {
      operationSignal = args[3]
      return release.promise
    })
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session, owner } = await pluginSession(created.ctx, scope())
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })

    await owner.dispose()
    expect(operationSignal?.aborted).toBe(true)
    release.resolve({ items: [decision(1)] })
    await new Promise<undefined>((resolve) => { setImmediate(resolve, undefined) })
    expect(factEvents(session)).toEqual([])
    expect(created.outbox.attachments(RUNTIME_SESSION, 0, 10)).toEqual([])
  })

  test.each(['request-abort', 'session-dispose'] as const)(
    'stops a multi-row Outbox page after the first synchronous observer %s',
    async (stop) => {
      const release = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
      const value = backend()
      value.pullOutbox = vi.fn(async () => release.promise)
      const created = service(value)
      await created.ctx.plugin(SessionStore)
      const request = new AbortController()
      const opened = await pluginSession(created.ctx, scope({ requestSignal: request.signal }))
      const sessionOwner = opened.owner
      created.ctx.on('session/event', (_session, event) => {
        if (event.type !== 'fact/proposal-decided') return
        if (stop === 'request-abort') request.abort(new Error('request closed'))
        else void sessionOwner.dispose()
      })
      await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })

      release.resolve({ items: [decision(1), decision(2)] })
      await vi.waitFor(() => { expect(factEvents(opened.session)).toHaveLength(1) })
      await new Promise<undefined>((resolve) => { setImmediate(resolve, undefined) })

      expect(factEvents(opened.session)).toHaveLength(1)
      expect(created.outbox.attachments(RUNTIME_SESSION, 0, 10)).toHaveLength(1)
    },
  )

  test('discards an Outbox reservation when its request is cancelled before append', async () => {
    const value = backend()
    value.pullOutbox = vi.fn(async () => ({ items: [decision(1)] }))
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const request = new AbortController()
    const register = created.outbox.register.bind(created.outbox)
    vi.spyOn(created.outbox, 'register').mockImplementation((input) => {
      const inserted = register(input)
      request.abort(new Error('request closed'))
      return inserted
    })

    const { session } = await pluginSession(created.ctx, scope({ requestSignal: request.signal }))
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    await new Promise<undefined>((resolve) => { setImmediate(resolve, undefined) })

    expect(factEvents(session)).toEqual([])
    expect(created.outbox.attachments(RUNTIME_SESSION, 0, 10)).toEqual([])
  })

  test('service disposal rejects new work before abort and waits for in-flight settlement without publishing late receipts', async () => {
    const release = Promise.withResolvers<Awaited<ReturnType<XAgentFactBackend['prepare']>>>()
    const value = backend()
    let operationSignal: AbortSignal | undefined
    value.prepare = vi.fn(async (...args: PrepareArgs) => {
      operationSignal = args[3]
      return release.promise
    })
    const created = service(value)
    const input = {
      sessionId: RUNTIME_SESSION,
      toolCallId: 'call-1',
      fieldKey: 'customer.name',
      label: 'Customer',
      value: { type: 'text' as const, value: 'Alpha' },
      evidenceIds: [],
      assertionReason: 'manual assertion',
    }
    const pending = runWithXAgentAuthenticatedRequestScope(scope(), () => created.fact.proposeFact(input))
    await vi.waitFor(() => { expect(value.prepare).toHaveBeenCalledOnce() })
    let disposed = false
    const disposal = created.fact.dispose().then(() => { disposed = true })

    expect(operationSignal?.aborted).toBe(true)
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => created.fact.proposeFact(input)))
      .rejects.toEqual(new XAgentFactError('service-unavailable'))
    expect(created.receipts.attachments(RUNTIME_SESSION, 0, 100)).toEqual([])
    expect(disposed).toBe(false)
    release.resolve({
      result: { proposalId: PROPOSAL, status: 'pending' },
      receipt: 'late-receipt',
      payloadHash: 'a'.repeat(64),
    })
    await expect(pending).rejects.toEqual(new XAgentFactError('service-unavailable'))
    await disposal
    expect(created.receipts.attachments(RUNTIME_SESSION, 0, 100)).toEqual([])
  })

  test('request cancellation aborts a prepare call and discards its late backend result', async () => {
    const release = Promise.withResolvers<Awaited<ReturnType<XAgentFactBackend['prepare']>>>()
    const value = backend()
    value.prepare = vi.fn(async () => release.promise)
    const created = service(value)
    const request = new AbortController()
    const pending = runWithXAgentAuthenticatedRequestScope(scope({ requestSignal: request.signal }), () =>
      created.fact.proposeFact({
        sessionId: RUNTIME_SESSION,
        toolCallId: 'call-1',
        fieldKey: 'customer.name',
        label: 'Customer',
        value: { type: 'text', value: 'Alpha' },
        evidenceIds: [],
        assertionReason: 'manual assertion',
      }))
    await vi.waitFor(() => { expect(value.prepare).toHaveBeenCalledOnce() })
    request.abort()
    release.resolve({
      result: { proposalId: PROPOSAL, status: 'pending' },
      receipt: 'late-receipt',
      payloadHash: 'a'.repeat(64),
    })
    await expect(pending).rejects.toEqual(new XAgentFactError('service-unavailable'))
    expect(created.receipts.attachments(RUNTIME_SESSION, 0, 100)).toEqual([])
  })

  test('message scope observers invalidate, discard, reject, and clear Agent ownership', async () => {
    const created = service()
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const invalidAgent = agentFor({ id: 'local-session' } as Session)
    const ignored = createUserMessage({ content: [{ type: 'text', text: 'ignored' }], source: { kind: 'user' } })
    agentEvents(created.ctx, invalidAgent).emit('agent/inbox/inserted', { message: ignored })

    const missing = createUserMessage({ content: [{ type: 'text', text: 'missing' }], source: { kind: 'user' } })
    agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: missing })
    agentEvents(created.ctx, agent).emit('agent/inbox/discarded', { message: missing })

    const request = new AbortController()
    const connection = new AbortController()
    const admitted = scope({ requestSignal: request.signal, connectionSignal: connection.signal })
    const cancelled = createUserMessage({ content: [{ type: 'text', text: 'cancelled' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(admitted, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: cancelled })
    })
    request.abort()
    await expect(agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [cancelled], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'reject' as const, reason: 'cancelled' }),
    )).resolves.toEqual({ kind: 'reject', reason: 'cancelled' })

    const connectionCancelled = createUserMessage({
      content: [{ type: 'text', text: 'connection cancelled' }], source: { kind: 'user' },
    })
    runWithXAgentAuthenticatedRequestScope(scope({ connectionSignal: connection.signal }), () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: connectionCancelled })
    })
    connection.abort()

    created.receipts.register({
      sessionId: RUNTIME_SESSION,
      toolCallId: 'unbound-error',
      proposalId: PROPOSAL,
      receipt: 'unbound-error',
      payloadHash: 'a'.repeat(64),
    })
    agentEvents(created.ctx, agent).emit('agent/error', { turn: 1, step: 1, error: new Error('failed') })
    expect(created.receipts.discard(RUNTIME_SESSION, 'unbound-error')).toBe(false)

    created.receipts.register({
      sessionId: RUNTIME_SESSION,
      toolCallId: 'unbound-dispose',
      proposalId: PROPOSAL,
      receipt: 'unbound-dispose',
      payloadHash: 'a'.repeat(64),
    })
    agentEvents(created.ctx, agent).emit('agent/disposed', {})
    expect(created.receipts.discard(RUNTIME_SESSION, 'unbound-dispose')).toBe(false)
  })

  test('pre-step scope propagation is exact for Fact execution and delegates unrelated tools', async () => {
    const created = service()
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const first = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    const second = createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } })
    const admitted = scope()
    runWithXAgentAuthenticatedRequestScope(admitted, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: first })
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: second })
    })
    await agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [first, second], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [first, second] }),
    )

    const success = { isError: false as const, value: null, content: [] }
    const executionOrder: string[] = []
    const flush = vi.spyOn(created.ctx.sessions, 'flush').mockImplementation(async (subject) => {
      expect(subject).toBe(session)
      executionOrder.push('flush')
      return true
    })
    const execution = {
      callId: 'call-1',
      rootCallId: 'call-1',
      name: 'propose_fact',
      arguments: {},
      agent,
      signal: new AbortController().signal,
      token: Symbol('execution'),
    }
    await expect(created.ctx.waterfall(
      'tools/execute', execution as never,
      async () => {
        executionOrder.push('next')
        expect(currentXAgentAuthenticatedRequestScope()).toBe(admitted)
        return success
      },
    )).resolves.toBe(success)
    expect(executionOrder).toEqual(['flush', 'next'])
    await expect(created.ctx.waterfall(
      'tools/execute', { ...execution, name: 'other' } as never,
      async () => {
        expect(currentXAgentAuthenticatedRequestScope()).toBeUndefined()
        return success
      },
    )).resolves.toBe(success)
    expect(flush).toHaveBeenCalledOnce()
    await expect(created.ctx.waterfall(
      'tools/execute', { ...execution, agent: undefined } as never,
      async () => {
        expect(currentXAgentAuthenticatedRequestScope()).toBeUndefined()
        return success
      },
    )).resolves.toBe(success)
    const unmatchedAgent = agentFor(Session.create(SessionId('session-00000000-0000-0000-0000-000000000299')))
    await expect(created.ctx.waterfall(
      'tools/execute', { ...execution, agent: unmatchedAgent } as never,
      async () => {
        expect(currentXAgentAuthenticatedRequestScope()).toBeUndefined()
        return success
      },
    )).resolves.toBe(success)
    expect(flush).toHaveBeenCalledOnce()

    const flushFailure = new Error('Fact call checkpoint failed')
    flush.mockRejectedValueOnce(flushFailure)
    const afterFlushFailure = vi.fn(async () => success)
    await expect(created.ctx.waterfall(
      'tools/execute', execution as never,
      afterFlushFailure,
    )).rejects.toBe(flushFailure)
    expect(afterFlushFailure).not.toHaveBeenCalled()

    const cancelled = new AbortController()
    const cancellation = new Error('Fact call cancelled')
    cancelled.abort(cancellation)
    const afterCancellation = vi.fn(async () => success)
    await expect(created.ctx.waterfall(
      'tools/execute', { ...execution, signal: cancelled.signal } as never,
      afterCancellation,
    )).rejects.toBe(cancellation)
    expect(afterCancellation).not.toHaveBeenCalled()
    expect(flush).toHaveBeenCalledTimes(2)

    const third = createUserMessage({ content: [{ type: 'text', text: 'third' }], source: { kind: 'user' } })
    const otherActor = scope({
      principal: Object.freeze({ ...admitted.principal, actorId: '00000000-0000-0000-0000-000000000199' }),
    })
    runWithXAgentAuthenticatedRequestScope(otherActor, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: third })
    })
    await agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [first, third], turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [first, third] }),
    )
    await agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 3, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'reject' as const, reason: 'stop' }),
    )
  })

  test('Session event observer accepts only the closed public Fact result and clears completed Turns', async () => {
    const created = service()
    await created.ctx.plugin(SessionStore)
    const { session, owner } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const otherAgent = agentFor({ id: 'session-00000000-0000-0000-0000-000000000299' } as Session)
    const activeScopes = (created.fact as unknown as {
      activeScopes: Map<Agent, XAgentAuthenticatedSessionRequestScope>
    }).activeScopes
    activeScopes.set(agent, scope())
    activeScopes.set(otherAgent, scope({ sessionId: '00000000-0000-0000-0000-000000000299' }))

    const resultEvent = (meta: unknown, content: unknown[] = [{
      type: 'tool-result', toolCallId: 'call-event', isError: false, content: [],
    }]): SessionEvent => ({
      type: 'tool/result',
      seq: 10,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'result-event' as never,
          role: 'user',
          source: { kind: 'tool', callId: 'call-event' as never },
          content: content as never,
        },
        meta: meta as never,
      },
      surfaceOp: 'append',
      sourceEventSeqs: [9],
    })
    const invalidEvents: SessionEvent[] = [
      { type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } },
      resultEvent(null),
      resultEvent([]),
      resultEvent('invalid'),
      resultEvent({ kind: 'other', status: 'pending', proposalId: PROPOSAL }),
      resultEvent({ kind: 'xagent-fact', status: 'confirmed', proposalId: PROPOSAL }),
      resultEvent({ kind: 'xagent-fact', status: 'pending', proposalId: 1 }),
      resultEvent({ kind: 'xagent-fact', status: 'pending', proposalId: 'bad' }),
      resultEvent({ kind: 'xagent-fact', status: 'pending', proposalId: PROPOSAL }, [{
        type: 'tool-result', toolCallId: 'call-event', isError: true, content: [],
      }]),
    ]
    for (const event of invalidEvents) created.ctx.emit('session/event', session, event)

    const warnings: unknown[] = []
    created.ctx.logger.warn = ((message: unknown) => { warnings.push(message) }) as typeof created.ctx.logger.warn
    created.ctx.emit('session/event', session, resultEvent({
      kind: 'xagent-fact', status: 'pending', proposalId: PROPOSAL,
    }))
    const bind = vi.spyOn(created.receipts, 'bindEvent').mockImplementation(() => { throw 'opaque failure' })
    created.ctx.emit('session/event', session, resultEvent({
      kind: 'xagent-fact', status: 'pending', proposalId: PROPOSAL,
    }))
    bind.mockRestore()
    expect(warnings).toEqual([
      expect.stringContaining('identity mismatch'),
      expect.stringContaining('unknown error'),
    ])

    created.ctx.emit('session/event', session, {
      type: 'turn/end', seq: 11, time: 0, data: { turn: 1, reason: { kind: 'completed' } },
    })
    expect(activeScopes.has(agent)).toBe(false)
    expect(activeScopes.has(otherAgent)).toBe(true)

    activeScopes.set(agent, scope())
    const pending = createUserMessage({ content: [{ type: 'text', text: 'pending' }], source: { kind: 'user' } })
    const otherPending = createUserMessage({ content: [{ type: 'text', text: 'other pending' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: pending })
    })
    runWithXAgentAuthenticatedRequestScope(scope({ sessionId: '00000000-0000-0000-0000-000000000299' }), () => {
      agentEvents(created.ctx, otherAgent).emit('agent/inbox/inserted', { message: otherPending })
    })
    await owner.dispose()
    expect(activeScopes.has(agent)).toBe(false)
    expect(activeScopes.has(otherAgent)).toBe(true)
  })

  test('Session-open delivery fails closed for mismatched scopes, backend errors, and malformed Outbox rows', async () => {
    const value = backend()
    value.pullOutbox = vi.fn(async () => { throw new XAgentBackendError('service-unavailable') })
    const created = service(value)
    const warnings: unknown[] = []
    created.ctx.logger.warn = ((message: unknown) => { warnings.push(message) }) as typeof created.ctx.logger.warn
    await created.ctx.plugin(SessionStore)

    const mismatched = await pluginSession(created.ctx, scope({ sessionId: '00000000-0000-0000-0000-000000000299' }))
    expect(value.pullOutbox).not.toHaveBeenCalled()
    await mismatched.owner.dispose()
    const matching = await pluginSession(created.ctx, scope())
    await vi.waitFor(() => { expect(warnings).toHaveLength(1) })
    expect(factEvents(matching.session)).toEqual([])

    const malformedBackend = backend()
    malformedBackend.pullOutbox = vi.fn(async () => ({ items: [
      decision(1),
      { ...decision(1), payloadHash: 'b'.repeat(64) },
    ] }))
    const malformed = service(malformedBackend)
    const malformedWarnings: unknown[] = []
    malformed.ctx.logger.warn = ((message: unknown) => { malformedWarnings.push(message) }) as typeof malformed.ctx.logger.warn
    await malformed.ctx.plugin(SessionStore)
    const duplicate = await pluginSession(malformed.ctx, scope())
    await vi.waitFor(() => { expect(malformedWarnings).toHaveLength(1) })
    expect(factEvents(duplicate.session)).toEqual([])

    const wrongProjectBackend = backend()
    wrongProjectBackend.pullOutbox = vi.fn(async () => ({ items: [{
      ...decision(2),
      event: { ...decision(2).event, data: { ...decision(2).event.data, projectId: '00000000-0000-0000-0000-000000000399' } },
    }] }))
    const wrongProject = service(wrongProjectBackend)
    const projectWarnings: unknown[] = []
    wrongProject.ctx.logger.warn = ((message: unknown) => { projectWarnings.push(message) }) as typeof wrongProject.ctx.logger.warn
    await wrongProject.ctx.plugin(SessionStore)
    await pluginSession(wrongProject.ctx, scope())
    await vi.waitFor(() => { expect(projectWarnings).toHaveLength(1) })
  })

  test('Outbox append rollback retains no sidecar and exact pending replay is not duplicated', async () => {
    const value = backend()
    value.pullOutbox = vi.fn(async () => ({ items: [decision(1)] }))
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const admitted = scope()
    const message = createUserMessage({ content: [{ type: 'text', text: 'deliver' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(admitted, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message })
    })
    const originalAppend = session.append.bind(session)
    const append = vi.spyOn(session, 'append').mockImplementation(() => { throw new Error('append failed') })
    await expect(agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
    )).rejects.toEqual(new XAgentFactError('service-unavailable'))
    expect(created.outbox.attachments(RUNTIME_SESSION, 0, 10)).toEqual([])
    append.mockRestore()

    created.outbox.register({
      sessionId: RUNTIME_SESSION,
      eventSequence: session.seq,
      outboxId: decision(1).outboxId,
      payloadHash: decision(1).payloadHash,
    })
    const replay = createUserMessage({ content: [{ type: 'text', text: 'replay' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(admitted, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: replay })
    })
    await agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [replay], turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [replay] }),
    )
    expect(factEvents(session)).toEqual([])
    expect(originalAppend).toBeTypeOf('function')

    const rejectedRegistryBackend = backend()
    rejectedRegistryBackend.pullOutbox = vi.fn(async () => ({ items: [decision(2)] }))
    const rejectedRegistry = service(rejectedRegistryBackend)
    await rejectedRegistry.ctx.plugin(SessionStore)
    const rejectedSession = await pluginSession(rejectedRegistry.ctx, undefined)
    const rejectedAgent = agentFor(rejectedSession.session)
    const rejectedMessage = createUserMessage({
      content: [{ type: 'text', text: 'registry failure' }], source: { kind: 'user' },
    })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      agentEvents(rejectedRegistry.ctx, rejectedAgent).emit('agent/inbox/inserted', { message: rejectedMessage })
    })
    vi.spyOn(rejectedRegistry.outbox, 'register').mockImplementation(() => { throw new Error('registry rejected') })
    await expect(agentEvents(rejectedRegistry.ctx, rejectedAgent).waterfall(
      'agent/pre-step',
      { messages: [rejectedMessage], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [rejectedMessage] }),
    )).rejects.toEqual(new XAgentFactError('service-unavailable'))
    expect(rejectedRegistry.outbox.attachments(RUNTIME_SESSION, 0, 10)).toEqual([])
  })

  test('Outbox owner replacement aborts and drains the prior physical scope', async () => {
    const firstRelease = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
    const value = backend()
    let calls = 0
    const signals: AbortSignal[] = []
    value.pullOutbox = vi.fn(async (_token, _sessionId, _input, signal) => {
      signals.push(signal as AbortSignal)
      calls += 1
      return calls === 1 ? firstRelease.promise : { items: [] }
    })
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const first = createUserMessage({ content: [{ type: 'text', text: 'first scope' }], source: { kind: 'user' } })
    const second = createUserMessage({ content: [{ type: 'text', text: 'second scope' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: first })
    })
    const firstStep = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [first], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [first] }),
    )
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    const replacementScope = scope({
      userToken: 'replacement-token',
      principal: Object.freeze({ ...scope().principal, actorId: '00000000-0000-0000-0000-000000000199' }),
    })
    runWithXAgentAuthenticatedRequestScope(replacementScope, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: second })
    })
    const secondStep = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [second], turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [second] }),
    )
    expect(signals[0]?.aborted).toBe(true)
    firstRelease.resolve({ items: [] })
    await expect(firstStep).rejects.toEqual(new XAgentFactError('service-unavailable'))
    await expect(secondStep).resolves.toMatchObject({ kind: 'enter' })
    expect(value.pullOutbox).toHaveBeenCalledTimes(2)
    expect(value.pullOutbox).toHaveBeenLastCalledWith(
      'replacement-token', SESSION, { limit: 32 }, expect.any(AbortSignal),
    )
  })

  test('concurrent physical-scope replacements serialize behind one Outbox owner', async () => {
    const releases = Array.from({ length: 3 }, () =>
      Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>())
    const signals: AbortSignal[] = []
    const value = backend()
    value.pullOutbox = vi.fn(async (_token, _sessionId, _input, signal) => {
      signals.push(signal as AbortSignal)
      return (releases[signals.length - 1] as (typeof releases)[number]).promise
    })
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const deliver = (requestScope: XAgentAuthenticatedSessionRequestScope): Promise<void> =>
      (created.fact as unknown as {
        deliverOutbox(session: Session, scope: XAgentAuthenticatedSessionRequestScope): Promise<void>
      }).deliverOutbox(session, requestScope)

    const first = deliver(scope())
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    const second = deliver(scope({ userToken: 'second-token' }))
    const third = deliver(scope({ userToken: 'third-token' }))
    releases[0]?.resolve({ items: [] })
    await expect(first).rejects.toEqual(new XAgentFactError('service-unavailable'))
    await Promise.resolve()
    const callsBeforeSecondSettlement = signals.length
    const secondWasAborted = signals[1]?.aborted
    releases[1]?.resolve({ items: [] })
    releases[2]?.resolve({ items: [] })
    await Promise.allSettled([second, third])

    expect(callsBeforeSecondSettlement).toBe(2)
    expect(secondWasAborted).toBe(true)
    expect(value.pullOutbox).toHaveBeenCalledTimes(3)
  })

  test('service disposal prevents a waiting Outbox scope replacement from taking ownership', async () => {
    const release = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
    const value = backend()
    value.pullOutbox = vi.fn(async () => release.promise)
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const first = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    const second = createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: first })
    })
    const firstStep = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [first], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [first] }),
    )
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    runWithXAgentAuthenticatedRequestScope(scope({ userToken: 'replacement-token' }), () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: second })
    })
    const secondStep = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [second], turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [second] }),
    )
    const firstFailure = expect(firstStep).rejects.toEqual(new XAgentFactError('service-unavailable'))
    const secondFailure = expect(secondStep).rejects.toEqual(new XAgentFactError('service-unavailable'))
    const disposal = created.fact.dispose()
    release.resolve({ items: [] })
    await Promise.all([firstFailure, secondFailure, disposal])
    expect(value.pullOutbox).toHaveBeenCalledOnce()
  })

  test('a superseded Outbox owner discards a successful late page before append', async () => {
    const release = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
    const value = backend()
    value.pullOutbox = vi.fn(async () => release.promise)
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const message = createUserMessage({ content: [{ type: 'text', text: 'supersede' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message })
    })
    const step = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
    )
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    const owners = (created.fact as unknown as { outboxOwners: Map<string, { active: boolean }> }).outboxOwners
    const liveOwner = owners.get(RUNTIME_SESSION)
    if (liveOwner === undefined) throw new Error('Outbox owner missing')
    liveOwner.active = false
    release.resolve({ items: [decision(1)] })
    await expect(step).resolves.toMatchObject({ kind: 'enter' })
    expect(factEvents(session)).toEqual([])
  })

  test('live owner invariant detects mismatched Agent and Outbox ownership fields', async () => {
    type Internals = {
      activeScopes: Map<Agent, XAgentAuthenticatedSessionRequestScope>
      outboxOwners: Map<string, {
        session: Session
        scope: XAgentAuthenticatedSessionRequestScope
        controller: AbortController
        settlement: Promise<void>
        closeSignals: () => void
        active: boolean
      }>
    }
    const created = service()
    await created.ctx.plugin(SessionStore)
    const { session: validSession } = await pluginSession(created.ctx, undefined)
    const internals = created.fact as unknown as Internals
    const validAgent = agentFor(validSession)
    internals.activeScopes.set(validAgent, scope())
    expect(created.fact.relationshipIssue()).toBeUndefined()
    internals.activeScopes.set(validAgent, scope({ sessionId: '00000000-0000-0000-0000-000000000299' }))
    expect(created.fact.relationshipIssue()).toContain('active Fact scope')
    internals.activeScopes.set(validAgent, scope({ visibility: 'private', projectId: null } as never))
    expect(created.fact.relationshipIssue()).toContain('active Fact scope')
    internals.activeScopes.clear()

    const owner = (overrides: Partial<Internals['outboxOwners'] extends Map<string, infer T> ? T : never> = {}) => ({
      session: validSession,
      scope: scope(),
      controller: new AbortController(),
      settlement: Promise.resolve(),
      closeSignals: () => undefined,
      active: true,
      ...overrides,
    })
    const check = (key: string, candidate: ReturnType<typeof owner>): string | undefined => {
      internals.outboxOwners.clear()
      internals.outboxOwners.set(key, candidate)
      return created.fact.relationshipIssue()
    }
    expect(check(RUNTIME_SESSION, owner())).toBeUndefined()
    expect(check('wrong', owner())).toContain('Fact Outbox owner')
    expect(check(RUNTIME_SESSION, owner({ session: { id: 'wrong' } as Session }))).toContain('Fact Outbox owner')
    expect(check(RUNTIME_SESSION, owner({ scope: scope({ sessionId: '00000000-0000-0000-0000-000000000299' }) })))
      .toContain('Fact Outbox owner')
    expect(check(RUNTIME_SESSION, owner({ scope: scope({ visibility: 'private', projectId: null } as never) })))
      .toContain('Fact Outbox owner')
    expect(check(RUNTIME_SESSION, owner({ active: false }))).toContain('Fact Outbox owner')
    const aborted = new AbortController()
    aborted.abort()
    expect(check(RUNTIME_SESSION, owner({ controller: aborted }))).toContain('Fact Outbox owner')
    await created.ctx.fiber.dispose()
  })

  test('request cancellation closes an Outbox owner before a late backend result', async () => {
    const release = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
    const value = backend()
    let operationSignal: AbortSignal | undefined
    value.pullOutbox = vi.fn(async (...args: PullOutboxArgs) => {
      operationSignal = args[3]
      return release.promise
    })
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const request = new AbortController()
    const admitted = scope({ requestSignal: request.signal })
    const message = createUserMessage({ content: [{ type: 'text', text: 'cancel Outbox' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(admitted, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message })
    })
    const step = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
    )
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    request.abort()
    expect(operationSignal?.aborted).toBe(true)
    release.resolve({ items: [decision(1)] })
    await expect(step).rejects.toEqual(new XAgentFactError('service-unavailable'))
    expect(factEvents(session)).toEqual([])
  })

  test('service disposal synchronously clears message and Outbox owners, then drains the pull', async () => {
    const release = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
    const value = backend()
    let operationSignal: AbortSignal | undefined
    value.pullOutbox = vi.fn(async (...args: PullOutboxArgs) => {
      operationSignal = args[3]
      return release.promise
    })
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const admitted = scope()
    const active = createUserMessage({ content: [{ type: 'text', text: 'active' }], source: { kind: 'user' } })
    const queued = createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(admitted, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: active })
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: queued })
    })
    const step = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [active], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [active] }),
    )
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    let settled = false
    const disposal = created.fact.dispose().then(() => { settled = true })
    expect(operationSignal?.aborted).toBe(true)
    expect((created.fact as unknown as { messageScopes: Map<string, unknown> }).messageScopes.size).toBe(0)
    expect((created.fact as unknown as { outboxOwners: Map<string, unknown> }).outboxOwners.size).toBe(0)
    expect(settled).toBe(false)
    expect(() => { void created.fact.approve(RUNTIME_SESSION, PROPOSAL, { idempotencyKey: 'late' }) }).toThrow('disposed')
    release.resolve({ items: [decision(1)] })
    await expect(step).rejects.toEqual(new XAgentFactError('service-unavailable'))
    await disposal
    expect(factEvents(session)).toEqual([])
  })
})
