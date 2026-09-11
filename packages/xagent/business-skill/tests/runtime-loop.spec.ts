import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, interruptedTurnClosers, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { expect, test } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { setup, request, entry, sessionId, loaded, version2 } from './fixtures.ts'

test('crash recovery replaces a durably activated Skill result before a new turn repins', async () => {
  const first = await setup()
  first.state.catalog = [entry()]
  const firstAdapter = new MockAdapter([toolCallResponse('load', 'skill', { name: 'review' }), textResponse('answer')])
  await first.ctx.plugin(LlmRuntime)
  await first.ctx.plugin(SessionStore)
  await first.ctx.plugin(AgentLoop, { agents: [] })
  first.ctx.llm.registerAdapter(['mock'], firstAdapter)
  let tail: SessionEvent[]
  try {
    const { agent } = await first.ctx.agents.create({ sessionId: SessionId(`session-${sessionId}`), agentOptions: { provider: 'mock', model: 'mock' } })
    await first.service.withRequest(request(), async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Review' }] }))
      await agent.whenIdle()
    })
    const result = agent.session.events.find(event => event.type === 'tool/result' && event.data.message.source.callId === 'load')!
    tail = structuredClone(agent.session.events.slice(0, result.seq + 1))
    expect(JSON.stringify(tail.at(-1))).toContain('Read the project evidence before answering.')
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
