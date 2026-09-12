import { agentEvents } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { generateKeyPairSync, createHash } from 'node:crypto'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { expect, test } from 'vitest'
import { XAgentBackendClient } from '@xagent/dsh-backend-client'
import { XAgentRetrievalService, XAgentReceiptRegistry, BGE_M3_MODEL_ID, BGE_M3_REVISION } from '@xagent/dsh-retrieval'
import * as retrievalTools from '@xagent/dsh-tool-retrieval'
import { claimTurn, entry, loaded, request, setup } from '../../../xagent/business-skill/tests/fixtures.ts'
import * as invariant from '../src/invariant.ts'

function dispatch(h: Awaited<ReturnType<typeof setup>>, names?: string[]) {
  return h.ctx.waterfall('llm/stream', { provider: 'mock', model: 'mock', messages: [], sessionId: h.agent.session.id,
    ...(names === undefined ? {} : { tools: names.map(name => ({ name, description: 'Mutation probe', parameters: {} })) }) },
  () => (async function* () {})())
}

function result(h: Awaited<ReturnType<typeof setup>>, isError: boolean) {
  const event = h.agent.session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: CallId('probe'), content: [{ type: 'text', text: 'Probe result' }], isError }) }, { surfaceOp: 'append' })
  h.ctx.emit('session/event', h.agent.session, event)
}

test('the assembled Skill invariant rejects a live foreign tool registered after activation', async () => {
  const h = await setup()
  await h.ctx.plugin(InvariantRegistry)
  const plugin = h.ctx.plugin(invariant)
  await plugin
  h.state.catalog = [entry()]
  let stale!: SkillDefinition
  try {
    result(h, true)
    expect(() => dispatch(h)).not.toThrow()
    expect(() => h.ctx.waterfall('llm/stream', { provider: 'mock', model: 'mock', messages: [] },
      () => (async function* () {})())).not.toThrow()
    await h.service.withRequest(request(), async () => {
      claimTurn(h.ctx, h.agent)
      h.service.attach(h.agent)
      const definition = (await h.ctx.skills.get('review', { scope: h.agent }))!
      stale = definition
      await agentEvents(h.ctx, h.agent).serial('skill/loaded', { definition, invocation: 'user-explicit' })
      const close = h.agent.ctx.get('tools')!.register(defineTool({ name: 'execute_code', description: 'Foreign execution', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'unsafe' }))
      expect(() => dispatch(h, h.agent.ctx.get('tools')!.schemas(h.agent).map(tool => tool.name))).toThrow(/assembled Business Skill/u)
      expect(() => dispatch(h)).toThrow(/assembled Business Skill/u)
      close()
      expect(() => dispatch(h, ['skill'])).not.toThrow()
      await agentEvents(h.ctx, h.agent).serial('skill/loaded', { definition: { ...definition, provider: 'unrelated' }, invocation: 'user-explicit' })
    })
    agentEvents(h.ctx, h.agent).emit('agent/disposed', {})
    expect(() => dispatch(h)).not.toThrow()
    const missing = new Context()
    try {
      await missing.plugin(InvariantRegistry)
      await missing.plugin(invariant)
      await expect(missing.serial('skill/loaded', { agent: h.agent, definition: stale,
        invocation: 'user-explicit' })).rejects.toThrow(/exact owned backend policy/u)
    } finally { await missing.fiber.dispose() }
    await plugin.dispose()
    expect(() => h.ctx.invariants.register('@xagent/dsh-business', () => {})).not.toThrow()
  } finally { await h.ctx.fiber.dispose() }
})

test.each(['primary-removed', 'search-provider-removed', 'companion'])('live admission detects composed retrieval drift: %s', async (change) => {
  let closeTools!: () => Promise<void>
  let closeRetrieval!: () => Promise<void>
  const h = await setup(10, undefined, async (ctx) => {
    const backend = new XAgentBackendClient({ origin: 'https://backend.example', serviceToken: 'service', fetch: async () => { throw new Error('No retrieval requested') } })
    const provider = ctx.plugin({ apply: (scope) => { new XAgentRetrievalService(scope, backend.retrieval, new XAgentReceiptRegistry(), {
      issuer: 'host', audience: 'api', privateKey: generateKeyPairSync('ed25519').privateKey,
      tokenizer: { modelId: BGE_M3_MODEL_ID, revision: BGE_M3_REVISION, count: async () => 1 },
    }) } })
    await provider
    closeRetrieval = async () => { await provider.dispose() }
    const plugin = ctx.plugin(retrievalTools)
    await plugin
    closeTools = async () => { await plugin.dispose() }
  })
  await h.ctx.plugin(InvariantRegistry)
  await h.ctx.plugin(invariant)
  const complete = change === 'primary-removed' ? ['list_accessible_projects', 'skill'] : ['search_artifacts', 'skill', 'submit_cited_answer']
  h.state.catalog = [entry()]
  h.state.load = { ...loaded(), complete_tools: complete,
    tool_policy_digest: createHash('sha256').update(JSON.stringify({ complete_tools: complete, version: 1 })).digest('hex') }
  try {
    await h.service.withRequest(request(), async () => {
      claimTurn(h.ctx, h.agent)
      h.service.attach(h.agent)
      const definition = (await h.ctx.skills.get('review', { scope: h.agent }))!
      const admit = () => agentEvents(h.ctx, h.agent).serial('skill/loaded', { definition, invocation: 'user-explicit' })
      await admit()
      result(h, false)
      const names = complete.filter(tool => tool !== 'submit_cited_answer')
      expect(() => dispatch(h, names)).not.toThrow()
      if (change === 'search-provider-removed') {
        await closeRetrieval()
        expect(() => dispatch(h, names)).toThrow(/companion/u)
      } else {
        await closeTools()
        if (change === 'primary-removed') {
          expect(() => dispatch(h, ['skill'])).toThrow(/primary/u)
          result(h, true)
          expect(() => dispatch(h, ['skill'])).not.toThrow()
          const end = h.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
          h.ctx.emit('session/event', h.agent.session, end)
          expect(() => dispatch(h)).not.toThrow()
        }
        else {
          h.agent.ctx.get('tools')!.register(defineTool({ name: 'submit_cited_answer', description: 'Orphan companion', parameters: {},
            output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'invalid' }))
          await agentEvents(h.ctx, h.agent).serial('skill/loaded', {
            definition: { ...definition, provider: 'xagent-draft' }, invocation: 'user-explicit',
          })
          expect(() => dispatch(h, ['skill', 'submit_cited_answer'])).toThrow(/requires artifact search/u)
          expect(() => dispatch(h, ['skill', 'search_artifacts', 'submit_cited_answer'])).not.toThrow()
        }
      }
    })
  } finally { await h.ctx.fiber.dispose() }
})
