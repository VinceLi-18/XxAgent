/** Cross-language policy inventory exercised through the real Host providers and Consumers. */
import { readFileSync } from 'node:fs'
import { createHash, generateKeyPairSync } from 'node:crypto'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { XAgentBackendClient } from '@xagent/dsh-backend-client'
import { XAgentFactService } from '@xagent/dsh-fact'
import { XAgentFactReceiptRegistry, XAgentFactOutboxRegistry } from '../../../xagent/fact/src/receipt-registry.ts'
import * as factTool from '@xagent/dsh-tool-fact'
import * as retrievalTools from '@xagent/dsh-tool-retrieval'
import { XAgentRetrievalService, XAgentReceiptRegistry, BGE_M3_MODEL_ID, BGE_M3_REVISION } from '@xagent/dsh-retrieval'
import { expect, test } from 'vitest'
import { entry, loaded, request, setup, sessionId } from '../../../xagent/business-skill/tests/fixtures.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const apiSource = readFileSync(new URL('../../../../services/api/app/models/business_skills.py', import.meta.url), 'utf8')
const primaryLiteral = /BUSINESS_SKILL_PRIMARY_TOOLS = frozenset\(\{([^}]+)\}\)/u.exec(apiSource)?.[1]
if (primaryLiteral === undefined) throw new Error('API primary tool declaration must remain an inspectable closed set')
const primary = [...primaryLiteral.matchAll(/"([a-z_]+)"/gu)].map(match => match[1]!).sort()
const selections = Array.from({ length: 2 ** primary.length }, (_, mask) => primary.filter((_name, index) => (mask & (1 << index)) !== 0))

test.each(selections.map(tools => ({ tools })))('API primary selection $tools resolves through the actual mounted Host closure', async ({ tools }) => {
  const complete = [...new Set(['skill', ...tools, ...(tools.includes('search_artifacts') ? ['submit_cited_answer'] : [])])].sort()
  const { privateKey } = generateKeyPairSync('ed25519')
  const h = await setup(10, undefined, async (ctx) => {
    await ctx.plugin(SessionStore)
    const backend = new XAgentBackendClient({ origin: 'https://backend.example', serviceToken: 'service', fetch: async () => Response.json({ schema_version: 1, items: [], next_cursor: null }) })
    new XAgentRetrievalService(ctx, backend.retrieval, new XAgentReceiptRegistry(), {
      issuer: 'host', audience: 'api', privateKey,
      tokenizer: { modelId: BGE_M3_MODEL_ID, revision: BGE_M3_REVISION, count: async () => 1 },
    })
    await ctx.plugin(retrievalTools)
    new XAgentFactService(ctx, backend.facts, new XAgentFactReceiptRegistry(), new XAgentFactOutboxRegistry(), { issuer: 'host', audience: 'api', privateKey })
    await ctx.plugin(factTool)
  })
  h.state.catalog = [entry()]
  h.state.load = { ...loaded(), complete_tools: complete,
    tool_policy_digest: createHash('sha256').update(JSON.stringify({ complete_tools: complete, version: 1 })).digest('hex') }
  try {
    expect(primary).toEqual(['list_accessible_projects', 'propose_fact', 'search_artifacts'])
    await h.ctx.plugin(LlmRuntime)
    await h.ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([textResponse('Reviewed.')])
    h.ctx.llm.registerAdapter(['mock'], adapter)
    const { agent } = await h.ctx.agents.create({ sessionId: SessionId(`session-${sessionId}`), agentOptions: { provider: 'mock', model: 'mock' } })
    const errors: unknown[] = []
    h.ctx.on('agent/error', ({ error }) => { errors.push(error) })
    await h.service.withRequest(request(), async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/review' }] }))
      await agent.whenIdle()
      expect(errors).toEqual([])
      expect(adapter.requests[0]!.tools?.map(tool => tool.name).sort()).toEqual(complete.filter(name => name !== 'submit_cited_answer'))
    })
  } finally { await h.ctx.fiber.dispose() }
})
