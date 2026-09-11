import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { expect, test } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { setup, request, entry, sessionId, loaded, version2 } from './fixtures.ts'

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
