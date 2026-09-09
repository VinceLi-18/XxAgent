import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { XAgentProposeFactInput } from '@xagent/dsh-fact'
import {
  runWithXAgentAuthenticatedRequestScope,
  type XAgentAuthenticatedSessionRequestScope,
} from '@xagent/dsh-principal'
import { describe, expect, test, vi } from 'vitest'
import * as tool from '../src/index.ts'
import * as invariant from '../src/invariant.ts'

const SESSION = '00000000-0000-0000-0000-000000000201'

class FakeFact extends Service {
  readonly proposeFact = vi.fn(async (_input: XAgentProposeFactInput) => ({
    proposalId: '00000000-0000-0000-0000-000000000401',
    status: 'pending' as const,
  }))

  constructor(ctx: Context) {
    super(ctx, 'xagentFact')
  }
}

function scope(): XAgentAuthenticatedSessionRequestScope {
  return Object.freeze({
    principal: Object.freeze({
      actorId: '00000000-0000-0000-0000-000000000101',
      role: 'specialist' as const,
      permissionRevision: 7,
      authSessionId: '00000000-0000-0000-0000-000000000102',
      connectionId: 'connection-1',
    }),
    userToken: 'user-token',
    connectionId: 'connection-1',
    requestSignal: new AbortController().signal,
    connectionSignal: new AbortController().signal,
    sessionId: SESSION,
    visibility: 'project' as const,
    projectId: '00000000-0000-0000-0000-000000000301',
  })
}

async function liveConsumer(): Promise<{
  readonly ctx: Context
  readonly agent: ReturnType<Context['agentLoop']['create']>
  readonly admitted: XAgentAuthenticatedSessionRequestScope
}> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin((child) => { new FakeFact(child) })
  await ctx.plugin(tool)
  await ctx.plugin(invariant)
  const agent = ctx.agentLoop.create(SessionId(`session-${SESSION}`), { provider: 'mock', model: 'mock' })
  const message = createUserMessage({ content: [{ type: 'text', text: 'fact' }], source: { kind: 'user' } })
  const admitted = scope()
  runWithXAgentAuthenticatedRequestScope(admitted, () => {
    agentEvents(ctx, agent).emit('agent/inbox/inserted', { message })
  })
  await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
  )
  return { ctx, agent, admitted }
}

describe('XAgent Fact tool invariant', () => {
  const throwFailure = (message: string): never => { throw new Error(message) }

  test('installs when the optional Consumer and Fact provider are absent', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(invariant)).resolves.toBeDefined()
    expect(tool.xAgentFactToolRelationshipIssue({
      tools: { get: () => undefined },
    } as unknown as Context)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  test('accepts the live Fact-service and Agent-scoped registry relationship and detects divergence', async () => {
    const { ctx, agent, admitted } = await liveConsumer()
    expect(() => { invariant.validateXAgentFactToolRelationships(ctx, throwFailure) })
      .not.toThrow()

    const getService = vi.spyOn(ctx, 'get').mockImplementation((name) => {
      if (name === 'xagentFact') return undefined
      const service: unknown = Context.prototype.get.call(ctx, name)
      return service
    })
    expect(() => { invariant.validateXAgentFactToolRelationships(ctx, throwFailure) })
      .toThrow('requires the Fact service')
    getService.mockRestore()

    const originalGet = ctx.tools.get.bind(ctx.tools)
    const get = vi.spyOn(ctx.tools, 'get').mockImplementation((name, owner) => {
      if (name === 'propose_fact' && owner === agent) return undefined
      return originalGet(name, owner)
    })
    expect(() => { invariant.validateXAgentFactToolRelationships(ctx, throwFailure) })
      .toThrow('tracked propose_fact registration')
    get.mockRestore()

    const requestSignal = admitted.requestSignal
    if (requestSignal === undefined) throw new Error('Fact invariant test scope lacks request cancellation')
    Object.defineProperty(requestSignal, 'aborted', { value: true, configurable: true })
    expect(() => { invariant.validateXAgentFactToolRelationships(ctx, throwFailure) })
      .toThrow('aborted physical scope')
    Reflect.deleteProperty(requestSignal, 'aborted')
    await ctx.fiber.dispose()
  })

  test('rejects a process-global propose_fact registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(InvariantRegistry)
    ctx.tools.register(defineTool({
      name: 'propose_fact',
      description: 'Invalid global fixture.',
      parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => null,
    }))
    await expect(ctx.plugin(invariant)).rejects.toThrow('must not be registered globally')
    await ctx.fiber.dispose()
  })

  test('disposes and reinstalls its package registration across companion HMR', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(InvariantRegistry)
    const first = ctx.plugin(invariant)
    await first
    expect(() => ctx.invariants.register('@xagent/dsh-tool-fact', () => undefined)).toThrow('already registered')
    await first.dispose()
    const second = ctx.plugin(invariant)
    await second
    expect(() => ctx.invariants.register('@xagent/dsh-tool-fact', () => undefined)).toThrow('already registered')
    await second.dispose()
    await ctx.fiber.dispose()
  })
})
