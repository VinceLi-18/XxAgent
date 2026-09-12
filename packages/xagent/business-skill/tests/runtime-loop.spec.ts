import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, interruptedTurnClosers, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { expect, test, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { setup, request, entry, sessionId, loaded, version2 } from './fixtures.ts'

test('prompt admission returns before the accepted turn and retains its Business Skill catalog', async () => {
  const h = await setup()
  h.state.catalog = [entry()]
  const adapter = new MockAdapter([
    toolCallResponse('load', 'skill', { name: 'review' }),
    textResponse('review complete'),
  ])
  await h.ctx.plugin(LlmRuntime)
  await h.ctx.plugin(SessionStore)
  await h.ctx.plugin(AgentLoop, { agents: [] })
  h.ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await h.ctx.agents.create({
    sessionId: SessionId(`session-${sessionId}`),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  try {
    await expect(h.service.withPrompt(request(), async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/review' }] }))
      return 'accepted'
    })).resolves.toBe('accepted')
    await agent.whenIdle()
    expect(agent.session.events.filter(event => event.type === 'business-skill/activated'))
      .toMatchObject([{ data: { slug: 'review', version: 1, turn: 1 } }])
    expect(adapter.requests).toHaveLength(2)
  } finally { await h.ctx.fiber.dispose() }
})

test('prompt scope returns its receipt while model work is active and releases on request cancellation', async () => {
  const h = await setup()
  h.state.catalog = [entry()]
  const adapter = new MockAdapter(['hang', textResponse('next prompt')])
  await h.ctx.plugin(LlmRuntime)
  await h.ctx.plugin(SessionStore)
  await h.ctx.plugin(AgentLoop, { agents: [] })
  h.ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await h.ctx.agents.create({
    sessionId: SessionId(`session-${sessionId}`),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const requestLifetime = new AbortController()
  try {
    await expect(h.service.withPrompt(request({ requestSignal: requestLifetime.signal }), async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Review' }] }))
      return 'accepted'
    })).resolves.toBe('accepted')
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    expect(agent.status).toBe('running')
    expect(JSON.stringify(adapter.requests[0])).toContain('review')
    const unrelated = h.ctx.sessions.create(SessionId('session-unrelated'))
    unrelated.append('turn/start', { turn: 1 })
    unrelated.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(JSON.stringify(await h.ctx.skills.list({ scope: agent }))).toContain('review')
    requestLifetime.abort()
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    await expect(h.service.withPrompt(request(), async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue' }] }))
      return 'accepted-again'
    })).resolves.toBe('accepted-again')
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
  } finally { requestLifetime.abort(); await h.ctx.fiber.dispose() }
})

test('a queued next turn collects its new complete tool set after the cancelled prior turn ends', async () => {
  const h = await setup()
  h.state.catalog = [entry()]
  const adapter = new MockAdapter([textResponse('first answer'), textResponse('second answer')])
  await h.ctx.plugin(LlmRuntime)
  await h.ctx.plugin(SessionStore)
  await h.ctx.plugin(AgentLoop, { agents: [] })
  h.ctx.llm.registerAdapter(['mock'], adapter)
  h.ctx.tools.register(defineTool({ name: 'propose_fact', description: 'Propose a Fact', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] }, execute: async () => 'proposed' }))
  const { agent } = await h.ctx.agents.create({ sessionId: SessionId(`session-${sessionId}`), agentOptions: { provider: 'mock', model: 'mock' } })
  const stopped = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const statuses: string[] = []
  agent.ctx.on('agent/status', ({ status }) => { statuses.push(status) })
  agent.ctx.on('agent/turn-stopping', async ({ turn }) => {
    if (turn === 1) { stopped.resolve(undefined); await release.promise }
  })
  const physical = new AbortController()
  const first = expect(h.service.withRequest(request({ requestSignal: physical.signal }), async () => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/review' }] }))
    await agent.whenIdle()
  })).rejects.toMatchObject({ failure: { code: 'unauthenticated' } })
  try {
    await stopped.promise
    physical.abort()
    expect(agent.ctx.get('tools')!.schemas(agent).map(tool => tool.name)).toEqual(['skill'])
    h.state.catalog = [entry('review', 2, version2)]
    h.state.load = { ...loaded(), version_number: 2, version_key: version2, complete_tools: ['propose_fact', 'skill'],
      tool_policy_digest: 'c586fd2330e52b02fbf91ffc847afbc2404f43c1a87685afbc59efa77834ef51' }
    await h.service.withRequest(request(), async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/review' }] }))
      release.resolve(undefined)
      await agent.whenIdle()
    })
    await first
    expect(statuses).toEqual(['running', 'idle'])
    expect(agent.session.events.filter(event => event.type === 'business-skill/activated').map(event => event.data.version)).toEqual([1, 2])
    expect(adapter.requests.map(item => item.tools?.map(tool => tool.name))).toEqual([['skill'], ['propose_fact', 'skill']])
    expect(agent.session.events.filter(event => event.type === 'request/header').map(event => event.data.header.tools?.map(tool => tool.name)))
      .toEqual([['skill'], ['propose_fact', 'skill']])
  } finally { release.resolve(undefined); await first; await h.ctx.fiber.dispose() }
})

test.each(['allowed-once', 'rejected', 'cancelled', 'unavailable', 'turn-end'] as const)('a durable %s observer cancels request authority without affecting the next turn', async (decision) => {
  const h = await setup()
  h.state.catalog = [entry()]
  h.state.load = { ...loaded(), complete_tools: ['propose_fact', 'skill'],
    tool_policy_digest: 'c586fd2330e52b02fbf91ffc847afbc2404f43c1a87685afbc59efa77834ef51' }
  const adapter = new MockAdapter([toolCallResponse('proposal', 'propose_fact', {}), textResponse('done'), textResponse('next turn')])
  await h.ctx.plugin(LlmRuntime)
  await h.ctx.plugin(SessionStore)
  await h.ctx.plugin(ApprovalService)
  await h.ctx.plugin(AgentLoop, { agents: [] })
  h.ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await h.ctx.agents.create({ sessionId: SessionId(`session-${sessionId}`), agentOptions: { provider: 'mock', model: 'mock' } })
  const effects: string[] = []
  h.ctx.tools.register(defineTool({ name: 'propose_fact', description: 'Propose a Fact', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    execute: async () => { effects.push('proposal'); return 'proposed' } }))
  agent.ctx.get('tools')!.register(defineTool({ name: 'unrelated', description: 'Unrelated tool', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] }, execute: async () => 'unused' }))
  const physical = new AbortController()
  const outcome = decision === 'turn-end' ? 'allowed-once' : decision
  h.ctx.on('approval/request', async () => outcome)
  h.ctx.on('skill/loaded', () => {
    agent.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'propose_fact' ? { kind: 'ask' } : await next())
  })
  h.ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === (decision === 'turn-end' ? 'turn/end' : 'approval/decided')) physical.abort()
  })
  try {
    await expect(h.service.withRequest(request({ requestSignal: physical.signal }), async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/review' }] }))
      await agent.whenIdle()
    })).rejects.toThrow()
    expect(agent.session.events.filter(event => event.type === 'approval/decided').map(event => event.data.outcome)).toEqual([outcome])
    expect(effects).toEqual(decision === 'turn-end' ? ['proposal'] : [])
    expect(agent.session.events.filter(event => event.type === 'tool/result').map(event => event.data.message.content[0].isError)).toEqual([decision !== 'turn-end'])
    expect(adapter.requests.map(item => item.tools?.map(tool => tool.name).sort())).toEqual([
      ['propose_fact', 'skill'], ['propose_fact', 'skill'],
    ])
    await h.service.withRequest(request(), async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/review' }] }))
      await agent.whenIdle()
    })
    expect(agent.session.events.filter(event => event.type === 'business-skill/activated').map(event => event.data.turn)).toEqual([1, 2])
  } finally { await h.ctx.fiber.dispose() }
})

test.each([false, true])('completed turns and crash recovery replace a durably activated Skill result (pruned: %s)', async (pruned) => {
  const first = await setup()
  first.state.catalog = [entry()]
  const firstAdapter = new MockAdapter([toolCallResponse('load', 'skill', { name: 'review' }), textResponse('answer')])
  await first.ctx.plugin(LlmRuntime)
  await first.ctx.plugin(SessionStore)
  await first.ctx.plugin(AgentLoop, { agents: [] })
  first.ctx.llm.registerAdapter(['mock'], firstAdapter)
  await first.ctx.plugin(TokenMeter)
  await first.ctx.plugin(ToolResultPruner, { thresholdChars: 100, headChars: 45, tailChars: 5 })
  let tail: SessionEvent[] = []
  try {
    const { agent } = await first.ctx.agents.create({ sessionId: SessionId(`session-${sessionId}`), agentOptions: { provider: 'mock', model: 'mock' } })
    agent.ctx.on('agent/turn-stopping', () => {
      if (pruned) expect(first.ctx.toolResultPruner.pruneSession(agent.session).pruned).toHaveLength(1)
      tail = structuredClone([...agent.session.events])
    })
    await first.service.withRequest(request(), async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Review' }] }))
      await agent.whenIdle()
    })
    expect(JSON.stringify(tail)).toContain('Read the project evidence before answering.')
    if (pruned) expect(JSON.stringify(tail.at(-1))).toContain('tool result middle pruned')
    expect(JSON.stringify(agent.session.deriveMessages())).toContain('Business Skill review v1 was used in turn 1.')
    expect(JSON.stringify(agent.session.deriveMessages())).not.toContain('tool result middle pruned')
  } finally { await first.ctx.fiber.dispose() }
  const h = await setup()
  h.state.catalog = [entry('review', 2, version2)]
  h.state.load = { ...loaded(), version_number: 2, version_key: version2, instructions: 'Replacement version instructions.' }
  const adapter = new MockAdapter([textResponse('recovered')])
  await h.ctx.plugin(LlmRuntime)
  await h.ctx.plugin(SessionStore)
  await h.ctx.plugin(AgentLoop, { agents: [] })
  h.ctx.llm.registerAdapter(['mock'], adapter)
  try {
    const { agent } = await h.ctx.agents.create({ sessionId: SessionId(`session-${sessionId}`),
      seed: [...tail, ...interruptedTurnClosers(tail)], agentOptions: { provider: 'mock', model: 'mock' } })
    expect(JSON.stringify(agent.session.deriveMessages())).toContain('Business Skill review v1 was used in turn 1.')
    expect(JSON.stringify(agent.session.deriveMessages())).not.toContain('Read the project evidence before answering.')
    await h.service.withRequest(request(), async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/review' }] }))
      await agent.whenIdle()
    })
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('Replacement version instructions.')
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('Business Skill review v1 was used in turn 1.')
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('Read the project evidence before answering.')
    expect(JSON.stringify(agent.session.events.slice(0, tail.length))).toEqual(JSON.stringify(tail))
  } finally { await h.ctx.fiber.dispose() }
})

test('Stop steering preserves the first Skill until the durable turn end', async () => {
  const h = await setup()
  h.state.catalog = [entry(), entry('other', 2, version2)]
  const adapter = new MockAdapter([textResponse('tentative'), toolCallResponse('other-load', 'skill', { name: 'other' }), textResponse('final')])
  await h.ctx.plugin(LlmRuntime)
  await h.ctx.plugin(SessionStore)
  await h.ctx.plugin(AgentLoop, { agents: [] })
  h.ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await h.ctx.agents.create({ sessionId: SessionId(`session-${sessionId}`), agentOptions: { provider: 'mock', model: 'mock' } })
  let stopped = false
  agent.ctx.on('agent/turn-stopping', () => {
    if (stopped) return
    stopped = true
    h.state.load = { ...loaded(), slug: 'other', version_number: 2, version_key: version2, instructions: 'Other instructions.' }
    agent.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue reviewing.' }] }))
  })
  try {
    await h.service.withRequest(request(), async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/review' }] }))
      await agent.whenIdle()
    })
    expect(agent.session.events.filter(event => event.type === 'turn/end')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'business-skill/activated').map(event => event.data.slug)).toEqual(['review'])
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('Read the project evidence before answering.')
    expect(adapter.requests[1]!.tools?.map(tool => tool.name)).toEqual(['skill'])
    expect(JSON.stringify(adapter.requests[2]!.messages)).toContain('business-skill-conflict')
    expect(JSON.stringify(adapter.requests[2]!.messages)).not.toContain('Other instructions.')
    expect(JSON.stringify(agent.session.deriveMessages())).not.toContain('Read the project evidence before answering.')
    expect(JSON.stringify(agent.session.deriveMessages())).toContain('Business Skill review v1 was used in turn 1.')
  } finally { await h.ctx.fiber.dispose() }
})

test.each(['user-explicit', 'model-tool'] as const)('real loop logs the %s narrowed catalog and removes instructions before the following turn', async (invocation) => {
  const h = await setup()
  h.state.catalog = [entry()]
  const adapter = new MockAdapter(invocation === 'user-explicit'
    ? [textResponse('first answer'), textResponse('next answer')]
    : [toolCallResponse('load', 'skill', { name: 'review' }), textResponse('first answer'), textResponse('next answer')])
  await h.ctx.plugin(LlmRuntime)
  await h.ctx.plugin(SessionStore)
  await h.ctx.plugin(AgentLoop, { agents: [] })
  h.ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await h.ctx.agents.create({ sessionId: SessionId(`session-${sessionId}`), agentOptions: { provider: 'mock', model: 'mock' } })
  agent.ctx.get('tools')!.register(defineTool({ name: 'unrelated', description: 'Unrelated tool', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] }, execute: async () => 'unused' }))
  try {
    await h.service.withRequest(request(), async () => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: invocation === 'user-explicit' ? '/review' : 'Review' }], source: { kind: 'user' } }))
      await agent.whenIdle()
    })
    expect(adapter.requests).toHaveLength(invocation === 'user-explicit' ? 1 : 2)
    expect(h.calls.map(call => call.path)).toContain(`/internal/xagent/business-skills/projects/${request().projectId}/runtime/load`)
    expect(adapter.requests.at(-1)!.tools?.map(tool => tool.name)).toEqual(['skill'])
    expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toContain('Read the project evidence before answering.')
    const headers = agent.session.events.filter(event => event.type === 'request/header')
    expect(headers.at(-1)!.data.header.tools?.map(tool => tool.name)).toEqual(['skill'])
    expect(JSON.stringify(agent.session.deriveMessages())).not.toContain('Read the project evidence before answering.')
    h.state.catalog = [entry('review', 2, version2)]
    h.state.load = { ...loaded(), version_number: 2, version_key: version2, instructions: 'Use the published version two.' }
    await h.service.withRequest(request(), async () => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: '/review' }], source: { kind: 'user' } }))
      await agent.whenIdle()
    })
    expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toContain('Use the published version two.')
    expect(JSON.stringify(adapter.requests.at(-1)!.messages)).not.toContain('Read the project evidence before answering.')
    expect(agent.session.events.filter(event => event.type === 'business-skill/activated').map(event => event.data.version)).toEqual([1, 2])
  } finally { await h.ctx.fiber.dispose() }
})
