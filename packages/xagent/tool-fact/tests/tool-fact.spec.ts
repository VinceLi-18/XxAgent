import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_RUNTIME_CODE_SCHEMAS, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { XAgentFactError, type XAgentProposeFactInput } from '@xagent/dsh-fact'
import {
  runWithXAgentAuthenticatedRequestScope,
  type XAgentAuthenticatedSessionRequestScope,
} from '@xagent/dsh-principal'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as tool from '../src/index.ts'

const ACTOR = '00000000-0000-0000-0000-000000000101'
const AUTH_SESSION = '00000000-0000-0000-0000-000000000102'
const SESSION = '00000000-0000-0000-0000-000000000201'
const RUNTIME_SESSION = `session-${SESSION}`
const PROJECT = '00000000-0000-0000-0000-000000000301'
const PROPOSAL = '00000000-0000-0000-0000-000000000401'
const roots: Context[] = []

afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
})

function requestScope(
  overrides: Partial<XAgentAuthenticatedSessionRequestScope> = {},
): XAgentAuthenticatedSessionRequestScope {
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
    requestSignal: new AbortController().signal,
    connectionSignal: new AbortController().signal,
    sessionId: SESSION,
    visibility: 'project' as const,
    projectId: PROJECT,
    ...overrides,
  }) as XAgentAuthenticatedSessionRequestScope
}

class FakeFact extends Service {
  readonly proposeFact = vi.fn((_input: XAgentProposeFactInput) => Promise.resolve({
    proposalId: PROPOSAL,
    status: 'pending' as const,
  }))

  constructor(ctx: Context) {
    super(ctx, 'xagentFact')
  }
}

async function setup(mode: 'native' | 'code' = 'native', withFact = true) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime, { mode })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  let fact: FakeFact | undefined
  const factFiber = withFact ? ctx.plugin((child) => { fact = new FakeFact(child) }) : undefined
  if (factFiber !== undefined) await factFiber
  const fiber = ctx.plugin(tool)
  await fiber
  const agent = ctx.agentLoop.create(SessionId(RUNTIME_SESSION), { provider: 'mock', model: 'mock' })
  return { agent, ctx, fact, factFiber, fiber }
}

async function enterProjectStep(
  ctx: Context,
  agent: Agent,
  scope = requestScope(),
): Promise<void> {
  const message = createUserMessage({ content: [{ type: 'text', text: 'propose a fact' }], source: { kind: 'user' } })
  runWithXAgentAuthenticatedRequestScope(scope, () => {
    agentEvents(ctx, agent).emit('agent/inbox/inserted', { message })
  })
  await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
  )
}

interface ProposalInput {
  readonly field_key: string
  readonly label: string
  readonly value: { readonly type: 'text' | 'number' | 'boolean' | 'date'; readonly value: string | number | boolean }
  readonly evidence_ids?: readonly string[]
  readonly assertion_reason?: string
}

function proposal(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    field_key: 'customer.name',
    label: 'Customer name',
    value: { type: 'text', value: 'Alpha' },
    evidence_ids: ['[资料1]'],
    ...overrides,
  }
}

function executeProposal(
  ctx: Context,
  agent: Agent,
  arguments_: unknown,
  callId = 'call-propose-1',
  signal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: CallId(callId),
    name: 'propose_fact',
    arguments: arguments_,
    agent,
    signal,
  })
}

describe('Project-only propose_fact registration', () => {
  test('assembles the tool only for the authenticated Project Agent and removes it on scope change', async () => {
    const { agent, ctx } = await setup()
    const sibling = ctx.agentLoop.create(SessionId('session-00000000-0000-0000-0000-000000000202'), {
      provider: 'mock',
      model: 'mock',
    })

    expect(ctx.tools.get('propose_fact')).toBeUndefined()
    expect(ctx.tools.get('propose_fact', agent)).toBeUndefined()
    await enterProjectStep(ctx, agent)
    expect((await ctx.systemPrompt.assemble({ scope: agent })).tools.map(value => value.name)).toContain('propose_fact')
    expect((await ctx.systemPrompt.assemble({ scope: sibling })).tools.map(value => value.name)).not.toContain('propose_fact')

    const message = createUserMessage({ content: [{ type: 'text', text: 'private work' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(requestScope({ visibility: 'private', projectId: null }), () => {
      agentEvents(ctx, agent).emit('agent/inbox/inserted', { message })
    })
    expect(ctx.tools.get('propose_fact', agent)).toBeUndefined()

    await enterProjectStep(ctx, agent, requestScope({ projectId: 'not-a-project' }))
    expect(ctx.tools.get('propose_fact', agent)).toBeUndefined()
  })

  test('rejects anonymous, malformed, cross-Session, and cancelled physical scopes', async () => {
    const { agent, ctx } = await setup()
    const withoutSession = requestScope() as unknown as Record<string, unknown>
    const { sessionId: _sessionId, ...requestOnly } = withoutSession
    const abortedRequest = new AbortController()
    abortedRequest.abort()
    const abortedConnection = new AbortController()
    abortedConnection.abort()
    const rejected: Array<XAgentAuthenticatedSessionRequestScope | undefined> = [
      undefined,
      requestScope({ userToken: '' }),
      requestOnly as unknown as XAgentAuthenticatedSessionRequestScope,
      requestScope({ visibility: 'project', projectId: null as never }),
      requestScope({ projectId: 'not-a-project' }),
      requestScope({ sessionId: '00000000-0000-0000-0000-000000000299' }),
      requestScope({ requestSignal: null as never }),
      requestScope({ connectionSignal: null as never }),
      requestScope({ requestSignal: abortedRequest.signal }),
      requestScope({ connectionSignal: abortedConnection.signal }),
    ]
    for (const candidate of rejected) {
      await enterProjectStep(ctx, agent)
      const message = createUserMessage({ content: [{ type: 'text', text: 'invalid scope' }], source: { kind: 'user' } })
      if (candidate === undefined) {
        agentEvents(ctx, agent).emit('agent/inbox/inserted', { message })
      } else {
        runWithXAgentAuthenticatedRequestScope(candidate, () => {
          agentEvents(ctx, agent).emit('agent/inbox/inserted', { message })
        })
      }
      expect(ctx.tools.get('propose_fact', agent)).toBeUndefined()
    }
  })

  test('rotates exact physical scopes and consumes only consistent claimed inbox bindings', async () => {
    const { agent, ctx } = await setup()
    const stable = requestScope()
    await enterProjectStep(ctx, agent, stable)
    const definition = ctx.tools.get('propose_fact', agent)
    await enterProjectStep(ctx, agent, stable)
    expect(ctx.tools.get('propose_fact', agent)).toBe(definition)

    const changedScopes = [
      requestScope({ projectId: '00000000-0000-0000-0000-000000000302' }),
      requestScope({
        connectionId: 'connection-2',
        principal: Object.freeze({ ...stable.principal, connectionId: 'connection-2' }),
      }),
      requestScope({ userToken: 'replacement-token' }),
      requestScope({ principal: Object.freeze({ ...stable.principal, actorId: '00000000-0000-0000-0000-000000000103' }) }),
      requestScope({ principal: Object.freeze({ ...stable.principal, authSessionId: '00000000-0000-0000-0000-000000000104' }) }),
      requestScope({ principal: Object.freeze({ ...stable.principal, permissionRevision: 8 }) }),
    ]
    for (const changed of changedScopes) {
      await enterProjectStep(ctx, agent, stable)
      const message = createUserMessage({ content: [{ type: 'text', text: 'changed scope' }], source: { kind: 'user' } })
      runWithXAgentAuthenticatedRequestScope(changed, () => {
        agentEvents(ctx, agent).emit('agent/inbox/inserted', { message })
      })
      expect(ctx.tools.get('propose_fact', agent)).toBeUndefined()
    }

    await enterProjectStep(ctx, agent, stable)
    const discarded = createUserMessage({ content: [{ type: 'text', text: 'discarded' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(stable, () => {
      agentEvents(ctx, agent).emit('agent/inbox/inserted', { message: discarded })
    })
    agentEvents(ctx, agent).emit('agent/inbox/discarded', { message: discarded })
    await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [discarded], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [discarded] }),
    )
    expect(ctx.tools.get('propose_fact', agent)).toBeUndefined()

    await enterProjectStep(ctx, agent, stable)
    await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'reject' as const }),
    )
    expect(ctx.tools.get('propose_fact', agent)).toBeUndefined()
  })

  test('removes the registration on physical cancellation, Turn end, Consumer disposal, and Fact HMR', async () => {
    const request = new AbortController()
    const { agent, ctx, factFiber, fiber } = await setup()
    await enterProjectStep(ctx, agent, requestScope({ requestSignal: request.signal }))
    expect(ctx.tools.get('propose_fact', agent)).toBeDefined()
    request.abort()
    expect(ctx.tools.get('propose_fact', agent)).toBeUndefined()

    await enterProjectStep(ctx, agent)
    const sibling = ctx.agentLoop.create(SessionId('session-00000000-0000-0000-0000-000000000202'), {
      provider: 'mock',
      model: 'mock',
    })
    sibling.session.append('turn/start', { turn: 1 })
    expect(ctx.tools.get('propose_fact', agent)).toBeDefined()
    sibling.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(ctx.tools.get('propose_fact', agent)).toBeDefined()
    agent.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    expect(ctx.tools.get('propose_fact', agent)).toBeUndefined()

    await enterProjectStep(ctx, agent)
    agentEvents(ctx, agent).emit('agent/error', { turn: 1, step: 1, error: new Error('fixture') })
    expect(ctx.tools.get('propose_fact', agent)).toBeUndefined()

    await enterProjectStep(ctx, agent)
    agentEvents(ctx, agent).emit('agent/disposed', {})
    expect(ctx.tools.get('propose_fact', agent)).toBeUndefined()

    const connection = new AbortController()
    await enterProjectStep(ctx, agent, requestScope({ connectionSignal: connection.signal }))
    connection.abort()
    expect(ctx.tools.get('propose_fact', agent)).toBeUndefined()

    await enterProjectStep(ctx, agent)
    await factFiber?.dispose()
    expect(ctx.tools.get('propose_fact', agent)).toBeUndefined()
    expect(ctx.tools.get('propose_fact')).toBeUndefined()

    await fiber.dispose()
  })

  test('exposes no schema without the Fact service and no callable result under Code Mode', async () => {
    const absent = await setup('native', false)
    await enterProjectStep(absent.ctx, absent.agent)
    expect(absent.ctx.tools.get('propose_fact', absent.agent)).toBeUndefined()

    const code = await setup('code')
    await enterProjectStep(code.ctx, code.agent)
    expect(code.ctx.tools[TOOL_RUNTIME_CODE_SCHEMAS](code.agent).map(value => value.name)).not.toContain('propose_fact')
    const denied = await executeProposal(code.ctx, code.agent, proposal())
    expect(denied).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    expect(code.fact?.proposeFact).not.toHaveBeenCalled()
  })
})

describe('propose_fact definition and execution', () => {
  test('publishes one native-only closed schema with four exact tagged values and generic render intent', async () => {
    const { agent, ctx } = await setup()
    await enterProjectStep(ctx, agent)
    const definition = ctx.tools.get('propose_fact', agent)
    expect(definition).toBeDefined()
    expect(definition?.nativeOnly).toBe(true)
    expect(definition).not.toHaveProperty('presentCall')
    expect(definition).not.toHaveProperty('presentResult')
    expect(definition?.description).toMatch(/manager review/i)
    expect(definition?.parameters).toEqual({
      type: 'object',
      properties: {
        field_key: { type: 'string', description: 'Stable lowercase field key using letters, digits, dots, underscores, or hyphens; at most 128 UTF-8 bytes.' },
        label: { type: 'string', description: 'Non-empty human-readable Fact label, at most 255 UTF-8 bytes.' },
        value: {
          oneOf: [
            {
              type: 'object', additionalProperties: false,
              properties: {
                type: { type: 'string', const: 'text', description: 'Use text for a text value.' },
                value: { type: 'string', description: 'Text value, at most 16 KiB in UTF-8.' },
              },
              required: ['type', 'value'],
              description: 'A text Fact value.',
            },
            {
              type: 'object', additionalProperties: false,
              properties: {
                type: { type: 'string', const: 'number', description: 'Use number for a numeric value.' },
                value: { type: 'number', description: 'Finite number; integral values must be safe integers.' },
              },
              required: ['type', 'value'],
              description: 'A finite numeric Fact value.',
            },
            {
              type: 'object', additionalProperties: false,
              properties: {
                type: { type: 'string', const: 'boolean', description: 'Use boolean for a true or false value.' },
                value: { type: 'boolean', description: 'Boolean value.' },
              },
              required: ['type', 'value'],
              description: 'A boolean Fact value.',
            },
            {
              type: 'object', additionalProperties: false,
              properties: {
                type: { type: 'string', const: 'date', description: 'Use date for a calendar date.' },
                value: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Valid Gregorian calendar date in YYYY-MM-DD form.' },
              },
              required: ['type', 'value'],
              description: 'A calendar-date Fact value.',
            },
          ],
          description: 'Typed value proposed for the project Fact.',
        },
        evidence_ids: {
          type: 'array', maxItems: 64, uniqueItems: true,
          items: { type: 'string', description: 'Admitted citation ID in [资料N] form.' },
          description: 'Up to 64 distinct citation IDs already admitted to this Session.',
        },
        assertion_reason: { type: 'string', description: 'Non-blank assertion basis, at most 4 KiB in UTF-8; required when evidence_ids is empty or omitted.' },
      },
      required: ['field_key', 'label', 'value'],
      additionalProperties: false,
    })
    expect(definition?.output.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        proposalId: { type: 'string', description: 'Server proposal UUID.' },
        status: { type: 'string', const: 'pending', description: 'Initial proposal review status.' },
      },
      required: ['proposalId', 'status'],
    })
  })

  test('derives Session and call identity and exposes only the pending public result and exact metadata', async () => {
    const { agent, ctx, fact } = await setup()
    await enterProjectStep(ctx, agent)
    const result = await executeProposal(ctx, agent, proposal(), 'call-exact')
    expect(fact?.proposeFact).toHaveBeenCalledOnce()
    const input = fact?.proposeFact.mock.calls[0]?.[0]
    expect(input).toEqual({
      sessionId: RUNTIME_SESSION,
      toolCallId: 'call-exact',
      fieldKey: 'customer.name',
      label: 'Customer name',
      value: { type: 'text', value: 'Alpha' },
      evidenceIds: ['[资料1]'],
      signal: input?.signal,
    })
    expect(input?.signal).toBeInstanceOf(AbortSignal)
    expect(result).toEqual({
      isError: false,
      value: { proposalId: PROPOSAL, status: 'pending' },
      content: [{ type: 'text', text: JSON.stringify({ proposalId: PROPOSAL, status: 'pending' }) }],
      meta: { kind: 'xagent-fact', status: 'pending', proposalId: PROPOSAL },
    })
    expect(JSON.stringify(result)).not.toMatch(/receipt|delegation|token|payloadHash/i)
  })

  test('accepts evidence-free proposals only with a non-blank bounded assertion reason', async () => {
    const { agent, ctx, fact } = await setup()
    await enterProjectStep(ctx, agent)
    const accepted = await executeProposal(ctx, agent, proposal({ evidence_ids: [], assertion_reason: 'Verified by operator.' }))
    expect(accepted.isError).toBe(false)
    expect(fact?.proposeFact).toHaveBeenCalledWith(expect.objectContaining({
      evidenceIds: [],
      assertionReason: 'Verified by operator.',
    }))

    const { evidence_ids: _evidenceIds, ...withoutEvidence } = proposal({ assertion_reason: 'Observed directly.' })
    expect((await executeProposal(ctx, agent, withoutEvidence, 'call-no-evidence')).isError).toBe(false)

    const invalid = [
      proposal({ evidence_ids: [] }),
      proposal({ evidence_ids: [], assertion_reason: '' }),
      proposal({ evidence_ids: [], assertion_reason: '   ' }),
      proposal({ evidence_ids: [], assertion_reason: '界'.repeat(1_366) }),
    ]
    for (const [index, candidate] of invalid.entries()) {
      fact?.proposeFact.mockClear()
      const rejected = await executeProposal(ctx, agent, candidate, `call-reason-${index}`)
      expect(rejected).toMatchObject({ isError: true, error: { info: { code: 'INVALID_ARGS' } } })
      expect(fact?.proposeFact).not.toHaveBeenCalled()
    }
  })

  test('rejects closed-schema, evidence, UTF-8, date, citation, and finite-number violations before the service', async () => {
    const { agent, ctx, fact } = await setup()
    await enterProjectStep(ctx, agent)
    const cases: unknown[] = [
      { ...proposal(), actor_id: ACTOR },
      proposal({ value: { type: 'text', value: 'x', secret: true } as never }),
      proposal({ value: { type: 'date', value: '2026-02-30' } }),
      proposal({ value: { type: 'date', value: '1900-02-29' } }),
      proposal({ value: { type: 'date', value: '0000-01-01' } }),
      proposal({ value: { type: 'date', value: '2026-00-01' } }),
      proposal({ value: { type: 'date', value: '2026-13-01' } }),
      proposal({ value: { type: 'date', value: '2026-01-00' } }),
      proposal({ value: { type: 'number', value: 2 ** 60 } }),
      proposal({ field_key: '' }),
      proposal({ field_key: `${'a'.repeat(128)}b` }),
      proposal({ field_key: 'Customer Name' }),
      proposal({ label: `${'界'.repeat(85)}a` }),
      proposal({ value: { type: 'text', value: `${'界'.repeat(5_461)}ab` } }),
      proposal({ evidence_ids: ['citation-1'] }),
      proposal({ evidence_ids: ['[资料999999999999999999999]'] }),
      proposal({ evidence_ids: Array.from({ length: 65 }, (_, index) => `[资料${index + 1}]`) }),
      proposal({ evidence_ids: ['[资料1]', '[资料1]'] }),
    ]
    for (const [index, candidate] of cases.entries()) {
      const rejected = await executeProposal(ctx, agent, candidate, `call-invalid-${index}`)
      expect(rejected, JSON.stringify(candidate)).toMatchObject({
        isError: true,
        error: { info: { code: 'INVALID_ARGS' } },
      })
    }
    expect(fact?.proposeFact).not.toHaveBeenCalled()
  })

  test('accepts every tagged value and rejects execution without a valid runtime Session', async () => {
    const { agent, ctx, fact } = await setup()
    await enterProjectStep(ctx, agent)
    const values: ProposalInput['value'][] = [
      { type: 'text', value: '' },
      { type: 'number', value: 42 },
      { type: 'number', value: 1.5 },
      { type: 'boolean', value: true },
      { type: 'date', value: '2024-02-29' },
      { type: 'date', value: '2000-02-29' },
    ]
    for (const [index, value] of values.entries()) {
      expect((await executeProposal(ctx, agent, proposal({ value }), `call-tag-${index}`)).isError).toBe(false)
    }
    expect(fact?.proposeFact).toHaveBeenCalledTimes(values.length)

    const definition = ctx.tools.get('propose_fact', agent)
    if (definition === undefined) throw new Error('propose_fact test fixture is not registered')
    await expect(definition.execute(proposal(), {
      callId: CallId('call-no-agent'),
      signal: new AbortController().signal,
    } as never)).rejects.toEqual(new XAgentFactError('fact-session-invalid'))
  })

  test('settles owned cancellation and suppresses a prepared late public result', async () => {
    const { agent, ctx, fact } = await setup()
    await enterProjectStep(ctx, agent)
    const started = Promise.withResolvers<AbortSignal>()
    const quiesced = Promise.withResolvers<undefined>()
    fact?.proposeFact.mockImplementationOnce(async (input) => {
      started.resolve(input.signal as AbortSignal)
      await quiesced.promise
      return { proposalId: PROPOSAL, status: 'pending' }
    })
    const caller = new AbortController()
    const pending = executeProposal(ctx, agent, proposal(), 'call-cancelled', caller.signal)
    const ownedSignal = await started.promise
    caller.abort()
    expect(ownedSignal.aborted).toBe(true)
    let settled = false
    void pending.finally(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    quiesced.resolve(undefined)
    const result = await pending
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'ABORTED' } } })
    expect(JSON.stringify(result)).not.toContain(PROPOSAL)
    expect(result).not.toHaveProperty('meta')
  })
})
