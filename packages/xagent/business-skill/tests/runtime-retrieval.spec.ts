import { generateKeyPairSync } from 'node:crypto'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { XAgentRetrievalBackend } from '@xagent/dsh-backend-client'
import { BGE_M3_MODEL_ID, BGE_M3_REVISION, CITED_ANSWER_TOOL, XAgentReceiptRegistry, XAgentRetrievalService } from '@xagent/dsh-retrieval'
import * as retrievalTools from '@xagent/dsh-tool-retrieval'
import { expect, test, vi } from 'vitest'
import { MockAdapter, toolCallResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { setup, request, entry, loaded, sessionId } from './fixtures.ts'

const { privateKey } = generateKeyPairSync('ed25519')

test.each([false, true])('fresh retrieval companion admission requires the real search registration (fake=%s)', async (fake) => {
  const backend = {
    projects: vi.fn<XAgentRetrievalBackend['projects']>(),
    search: vi.fn<XAgentRetrievalBackend['search']>(async () => ({
      citations: [{ id: '[资料1]', artifactId: '00000000-0000-0000-0000-000000000501',
        versionId: '00000000-0000-0000-0000-000000000601', chunkId: '00000000-0000-0000-0000-000000000801',
        displayName: 'brief.md', versionNumber: 1, lineStart: 1, lineEnd: 2, text: 'evidence', scope: 'project' as const }],
      receipt: 'opaque-search-receipt', payloadHash: 'b'.repeat(64),
    })),
    authorizeCitations: vi.fn<XAgentRetrievalBackend['authorizeCitations']>(async () => {}),
    resolveCitation: vi.fn<XAgentRetrievalBackend['resolveCitation']>(),
  } satisfies XAgentRetrievalBackend
  const h = await setup(10, undefined, async (ctx) => {
    await ctx.plugin(SessionStore)
    new XAgentRetrievalService(ctx, backend, new XAgentReceiptRegistry(), {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey,
      tokenizer: { modelId: BGE_M3_MODEL_ID, revision: BGE_M3_REVISION, count: async () => 1 },
    })
    if (fake) ctx.tools.register(defineTool({ name: 'search_artifacts', description: 'Fake search', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] }, execute: async () => 'fake' }))
    else await ctx.plugin(retrievalTools)
  })
  h.state.catalog = [entry()]
  h.state.load = { ...loaded(), complete_tools: ['search_artifacts', 'skill', 'submit_cited_answer'],
    tool_policy_digest: '0467a4190459f1d238addecd96a8d71b30690ac22d74add2d46751f5e1dcdc25' }
  const adapter = new MockAdapter(fake ? [textResponse('denied')] : [
    toolCallResponse('search', 'search_artifacts', { query: 'evidence' }),
    toolCallResponse('answer', CITED_ANSWER_TOOL, { blocks: [{ type: 'markdown', text: 'Evidence says yes.' }, { type: 'citation', id: '[资料1]' }] }),
  ])
  await h.ctx.plugin(LlmRuntime)
  await h.ctx.plugin(AgentLoop, { agents: [] })
  h.ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await h.ctx.agents.create({ sessionId: SessionId(`session-${sessionId}`), agentOptions: { provider: 'mock', model: 'mock' } })
  try {
    expect(h.ctx.tools.get(CITED_ANSWER_TOOL, agent)).toBeUndefined()
    await h.service.withRequest(request(), async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/review' }] }))
      await agent.whenIdle()
    })
    expect(agent.session.events.filter(event => event.type === 'business-skill/activated')).toHaveLength(fake ? 0 : 1)
    if (fake) {
      expect(JSON.stringify(agent.session.events)).toContain('business-skill-policy-changed')
      expect(backend.search).not.toHaveBeenCalled()
    } else {
      expect(adapter.requests[0]!.tools?.map(tool => tool.name)).toEqual(['search_artifacts', 'skill'])
      expect(adapter.requests[1]!.tools?.map(tool => tool.name)).toEqual(['search_artifacts', 'skill', CITED_ANSWER_TOOL])
      expect(backend.search).toHaveBeenCalledOnce()
      expect(backend.authorizeCitations).toHaveBeenCalledOnce()
      expect(h.calls.filter(call => call.path.endsWith('/authorize-tool')).map(call => call.body.tool_name)).toEqual(['search_artifacts', CITED_ANSWER_TOOL])
      expect(agent.session.events.filter(event => event.type === 'tool/result').every(event => !event.data.message.content[0].isError)).toBe(true)
    }
  } finally { await h.ctx.fiber.dispose() }
})
