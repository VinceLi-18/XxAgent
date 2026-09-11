import { createHash, generateKeyPairSync } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionTitle, { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { XAgentBackendClient, type XAgentRetrievalBackend } from '@xagent/dsh-backend-client'
import { BGE_M3_MODEL_ID, BGE_M3_REVISION, CITED_ANSWER_TOOL, XAgentReceiptRegistry, XAgentRetrievalService } from '@xagent/dsh-retrieval'
import * as retrievalTools from '@xagent/dsh-tool-retrieval'
import { runWithXAgentAuthenticatedRequestScope } from '@xagent/dsh-principal'
import { XAgentSessionPersistence } from '@xagent/dsh-session-persistence-api'
import { afterEach, expect, test, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { BusinessSkillTestRunner } from '../src/test-runner.ts'
import * as businessSkill from '../src/index.ts'
import { request } from './fixtures.ts'

const roots: Context[] = []
afterEach(async () => { for (const root of roots.splice(0)) await root.fiber.dispose() })
const testSession = '00000000-0000-0000-0000-000000000701'
const instructions = 'Use this exact draft, then inspect the project evidence.'
const scenario = 'Find the project budget.'

async function harness(script: ConstructorParameters<typeof MockAdapter>[0] = [textResponse('Reviewed.')], primary: string[] = []) {
  const production = [...new Set(['skill', ...primary, ...(primary.includes('search_artifacts') ? ['submit_cited_answer'] : [])])].sort()
  const digest = createHash('sha256').update(JSON.stringify({ complete_tools: production, version: 1 })).digest('hex')
  const input = { expectedDraftRevision: 2, toolPolicyDigest: digest, scenario, idempotencyKey: 'scenario-1' }
  const testRow = { run_number: 1, draft_revision: 2, content_digest: 'a'.repeat(64), tool_policy_digest: digest,
    unexecuted_write_tools: primary.includes('propose_fact') ? ['propose_fact'] : [],
    status: 'running', termination_reason: null as string | null, verdict: null,
    started_at: '2026-09-12T00:00:00Z', settled_at: null as string | null, verdict_at: null }
  const stored: SessionEvent[] = []
  const calls: { path: string; body: Record<string, unknown> }[] = []
  const state = { mounted: false, claimed: true, failure: undefined as string | undefined, titleCalls: 0,
    before: undefined as ((path: string) => Promise<void>) | undefined }
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname
    if (typeof init?.body !== 'string') throw new Error('Expected JSON request body')
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push({ path, body })
    await state.before?.(path)
    if (path.endsWith('/tests/start')) return Response.json({ schema_version: 1, test: { ...testRow, status: 'running', termination_reason: null, settled_at: null },
      session_id: testSession, purpose: 'business_skill_test',
      draft: { revision: 2, description: 'Review evidence.', instructions, primary_tools: primary,
        content_digest: 'a'.repeat(64), tool_policy_digest: digest }, scenario,
      test_tools: production.filter(tool => tool !== 'propose_fact'), unexecuted_write_tools: primary.includes('propose_fact') ? ['propose_fact'] : [] })
    if (path.endsWith('/mount')) {
      if (state.mounted || !state.claimed) return Response.json({ schema_version: 1, claimed: false, test: testRow })
      state.mounted = true
      stored.push(...(body.events as { payload: SessionEvent }[]).map(event => event.payload))
      return Response.json({ schema_version: 1, claimed: true, test: testRow })
    }
    if (path.endsWith('/transcript')) {
      if (state.failure) return Response.json({ detail: { code: state.failure } }, { status: 404 })
      const events = stored.filter(event => event.seq > Number(body.after_sequence ?? -1)).slice(0, Number(body.limit ?? 500))
      return Response.json({ schema_version: 1, test: testRow, events: events.map(event => ({ schema_version: 1,
        sequence: event.seq, event_type: event.type, payload: event, created_at: '2026-09-12T00:00:00Z' })), next_sequence: events.at(-1)?.seq ?? body.after_sequence ?? -1 })
    }
    if (path.endsWith('/append')) {
      if (testRow.status !== 'running') return Response.json({ detail: { code: 'session-not-found' } }, { status: 404 })
      expect(body.expected_sequence).toBe(stored.length - 1)
      stored.push(...(body.events as { payload: SessionEvent }[]).map(event => event.payload))
      return Response.json({ schema_version: 1, last_event_sequence: stored.length - 1, version: 1 })
    }
    if (path.endsWith('/settle') || path.endsWith('/cancel-unmounted')) {
      if (path.endsWith('/cancel-unmounted') && (state.mounted || testRow.status !== 'running')) return Response.json({ schema_version: 1, test: testRow })
      if (testRow.status !== 'running') return Response.json({ detail: { code: 'business-skill-conflict' } }, { status: 409 })
      testRow.termination_reason = body.termination_reason as string | undefined ?? 'cancelled'
      testRow.status = ['completed', 'cancelled'].includes(testRow.termination_reason) ? testRow.termination_reason : 'failed'
      testRow.settled_at = '2026-09-12T00:01:00Z'
      return Response.json({ schema_version: 1, test: testRow })
    }
    throw new Error(`Unexpected backend operation: ${path}`)
  }
  const backend = new XAgentBackendClient({ origin: 'https://backend.example', serviceToken: 'service', fetch })
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  const skillPlugin = await ctx.plugin(SkillRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolSkill)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionTitle, { fallbackMaxWords: 8, fallbackMaxBytes: 80, maxTitleBytes: 100 })
  ctx.sessionTitle.register({ id: SessionTitleProviderId('test-title'), automatic: 'first-prompt', generate: async () => {
    state.titleCalls++
    return { title: 'Wrong title', messageSeqs: [] }
  } })
  const persistence = new XAgentSessionPersistence(ctx, backend)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  let agent: Agent | undefined
  ctx.on('agent/created', ({ agent: value }) => { agent = value })
  const runner = new BusinessSkillTestRunner(ctx, backend.businessSkills, persistence, { provider: 'mock', model: 'mock' })
  const run = (signal = new AbortController().signal) => runWithXAgentAuthenticatedRequestScope(request(), () => runner.run('review', input, signal))
  return { ctx, runner, run, input, adapter, stored, calls, state, testRow, fetch, skillPlugin, get agent() { return agent } }
}

test('the configured capability installs a real runner with only the deployment model route', async () => {
  const h = await harness()
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(h.fetch)
  try {
    const plugin = await h.ctx.plugin(businessSkill, { backendOrigin: 'https://backend.example', serviceToken: 'host',
      maxCatalogEntries: 5, testProvider: 'mock', testModel: 'test-model' })
    await h.ctx.xagentBusinessSkill.withRequest(request(), async () => {
      await expect(h.ctx.xagentBusinessSkill.test('review', h.input)).resolves.toMatchObject({ status: 'completed' })
    })
    expect(h.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'test-model' })
    expect(h.agent?.options).toEqual({ provider: 'mock', model: 'test-model' })
    await plugin.dispose()
  } finally { fetch.mockRestore() }
})

test('missing, private and test-purpose request scopes cannot allocate a run', async () => {
  const h = await harness()
  await expect(h.runner.run('review', h.input, new AbortController().signal)).rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
  const { requestSignal: _requestSignal, ...missingSignal } = request()
  for (const scope of [request({ purpose: 'business_skill_test' }), request({ visibility: 'private', projectId: null }), missingSignal]) {
    await expect(runWithXAgentAuthenticatedRequestScope(scope, () => h.runner.run('review', h.input, new AbortController().signal)))
      .rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
  }
  expect(h.calls).toEqual([])
})

test('a removed Skill registry fails factory setup before the test is claimed', async () => {
  const h = await harness()
  await h.skillPlugin.dispose()
  await expect(h.run()).rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
  expect(h.state.mounted).toBe(false)
})

test('a nonempty unfinished transcript never admits its scenario again', async () => {
  const h = await harness()
  h.stored.push({ seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } })
  await expect(h.run()).resolves.toMatchObject({ status: 'running' })
  expect(h.adapter.requests).toHaveLength(0)
  expect(h.calls.some(call => call.path.endsWith('/mount'))).toBe(false)
})

test.each(['business-skill-conflict', 'not-found'] as const)('a failed mount %s grants neither execution nor settlement', async (code) => {
  const h = await harness()
  h.state.before = async (path) => {
    if (path.endsWith('/mount')) throw new (await import('@xagent/dsh-backend-client')).XAgentBackendError(code)
  }
  const operation = h.run()
  if (code === 'business-skill-conflict') await expect(operation).resolves.toMatchObject({ status: 'running' })
  else await expect(operation).rejects.toMatchObject({ code: 'not-found' })
  expect(h.adapter.requests).toHaveLength(0)
  expect(h.calls.some(call => call.path.endsWith('/settle'))).toBe(false)
})

test('failure after an owned factory publication settles once without invoking the model', async () => {
  const h = await harness()
  vi.spyOn(h.ctx.sessionTitle, 'rename').mockImplementation(() => { throw new Error('title persistence failed') })
  await expect(h.run()).resolves.toMatchObject({ status: 'failed', terminationReason: 'service-unavailable' })
  expect(h.adapter.requests).toHaveLength(0)
  expect(h.calls.filter(call => call.path.endsWith('/settle'))).toHaveLength(1)
})

test('late read-tool output drains before cancellation becomes terminal', async () => {
  const h = await harness([toolCallResponse('read', 'list_accessible_projects', {}), textResponse('Late.')], ['list_accessible_projects'])
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<string>()
  h.ctx.tools.register(defineTool({ name: 'list_accessible_projects', description: 'Read projects', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { entered.resolve(undefined); return await release.promise } }))
  const controller = new AbortController()
  const pending = h.run(controller.signal)
  await entered.promise
  controller.abort()
  expect(h.calls.some(call => call.path.endsWith('/settle'))).toBe(false)
  release.resolve('Late read result')
  await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
  const log = JSON.stringify(h.stored)
  await h.runner.dispose()
  expect(JSON.stringify(h.stored)).toBe(log)
  expect(h.adapter.requests).toHaveLength(1)
})

test('a failed read tool closes subsequent reads for the turn', async () => {
  const h = await harness([toolCallResponse('read1', 'list_accessible_projects', {}), toolCallResponse('read2', 'list_accessible_projects', {}), textResponse('Stopped.')], ['list_accessible_projects'])
  const execute = vi.fn(async () => { throw new Error('read failed') })
  h.ctx.tools.register(defineTool({ name: 'list_accessible_projects', description: 'Read projects', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute }))
  await expect(h.run()).resolves.toMatchObject({ status: 'failed', terminationReason: 'tool-denied' })
  expect(execute).toHaveBeenCalledOnce()
})

test('a terminal run observed during authorization rejects late writes and keeps the authoritative report', async () => {
  const h = await harness([toolCallResponse('read', 'list_accessible_projects', {}), textResponse('Denied.')], ['list_accessible_projects'])
  const execute = vi.fn(async () => 'read')
  h.ctx.tools.register(defineTool({ name: 'list_accessible_projects', description: 'Read', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute }))
  let reads = 0
  h.state.before = async (path) => {
    if (path.endsWith('/transcript') && ++reads === 2) {
      h.testRow.status = 'cancelled'
      h.testRow.termination_reason = 'cancelled'
      h.testRow.settled_at = '2026-09-12T00:01:00Z'
    }
  }
  await expect(h.run()).rejects.toMatchObject({ code: 'session-not-found' })
  expect(execute).not.toHaveBeenCalled()
  expect(h.testRow.status).toBe('cancelled')
})

test('cancellation in pre-execution cannot enter a selected read tool', async () => {
  const h = await harness([toolCallResponse('read', 'list_accessible_projects', {})], ['list_accessible_projects'])
  const controller = new AbortController()
  const execute = vi.fn(async () => 'read')
  h.ctx.tools.register(defineTool({ name: 'list_accessible_projects', description: 'Read', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute }))
  h.ctx.on('agent/created', ({ agent }) => {
    agent.ctx.on('tools/pre-execute', async (_execution, next) => { controller.abort(); return await next() }, { prepend: true })
  })
  await expect(h.run(controller.signal)).resolves.toMatchObject({ status: 'cancelled' })
  expect(execute).not.toHaveBeenCalled()
})

test.each(['/tests/start', '/transcript', '/mount'])('cancellation during %s settles only its owned or empty run', async (stage) => {
  const h = await harness()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  h.state.before = async (path) => { if (path.endsWith(stage)) { entered.resolve(undefined); await release.promise } }
  const controller = new AbortController()
  const pending = h.run(controller.signal)
  await entered.promise
  controller.abort()
  release.resolve(undefined)
  await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
  expect(h.adapter.requests).toHaveLength(0)
  expect(h.calls.filter(call => call.path.endsWith('/settle') || call.path.endsWith('/cancel-unmounted'))).toHaveLength(1)
})

test('concurrent replay joins the same running factory and terminal settlement', async () => {
  const h = await harness()
  const responses = await Promise.all([h.run(), h.run()])
  expect(responses[0]).toEqual(responses[1])
  expect(h.calls.filter(call => call.path.endsWith('/mount'))).toHaveLength(1)
  expect(h.adapter.requests).toHaveLength(1)
})

test('the real retrieval provider adds only its read companion and completes the same turn', async () => {
  const h = await harness([
    toolCallResponse('search', 'search_artifacts', { query: 'evidence' }),
    toolCallResponse('answer', CITED_ANSWER_TOOL, { blocks: [{ type: 'markdown', text: 'Budget is approved.' }, { type: 'citation', id: '[资料1]' }] }),
  ], ['search_artifacts'])
  const search = vi.fn<XAgentRetrievalBackend['search']>(async () => ({ citations: [{ id: '[资料1]',
    artifactId: '00000000-0000-0000-0000-000000000501', versionId: '00000000-0000-0000-0000-000000000601',
    chunkId: '00000000-0000-0000-0000-000000000801', displayName: 'brief.md', versionNumber: 1, lineStart: 1, lineEnd: 2,
    text: 'evidence', scope: 'project' as const }], receipt: 'opaque-receipt', payloadHash: 'b'.repeat(64) }))
  const backend: XAgentRetrievalBackend = {
    projects: vi.fn(),
    search,
    authorizeCitations: vi.fn(async () => {}), resolveCitation: vi.fn(),
  }
  new XAgentRetrievalService(h.ctx, backend, new XAgentReceiptRegistry(), {
    issuer: 'xagent-host', audience: 'xagent-api', privateKey: generateKeyPairSync('ed25519').privateKey,
    tokenizer: { modelId: BGE_M3_MODEL_ID, revision: BGE_M3_REVISION, count: async () => 1 },
  })
  await h.ctx.plugin(retrievalTools)
  await expect(h.run()).resolves.toMatchObject({ status: 'completed' })
  expect(h.adapter.requests.map(item => item.tools?.map(tool => tool.name))).toEqual([
    ['search_artifacts', 'skill'], ['search_artifacts', 'skill', CITED_ANSWER_TOOL],
  ])
  expect(search).toHaveBeenCalledOnce()
  expect(h.stored.filter(event => event.type === 'turn/start')).toHaveLength(1)
})

test('one factory mounts the exact hidden Session and logs explicit draft before the scenario exactly once', async () => {
  const h = await harness()
  const result = await h.run()
  expect(result).toMatchObject({ status: 'completed', terminationReason: 'completed', draftRevision: 2 })
  expect(h.calls.filter(call => call.path.endsWith('/mount'))).toHaveLength(1)
  expect(h.calls.some(call => call.path.endsWith('/create'))).toBe(false)
  expect(h.calls.find(call => call.path.endsWith('/mount'))?.body.runtime_header).toMatchObject({ id: `session-${testSession}`, version: 0 })
  expect(h.stored.filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(h.stored.filter(event => event.type === 'business-skill/activated').map(event => event.data.invocation)).toEqual(['user-explicit'])
  const entered = h.stored.filter(event => event.type === 'user/message').filter(event => event.surfaceOp === 'append')
  expect(entered.map(event => event.data.source.kind)).toEqual(['skill-catalog', 'skill-invocation', 'user'])
  expect(JSON.stringify(entered[1])).toContain(instructions)
  expect(entered[2]!.data.content).toEqual([{ type: 'text', text: scenario }])
  const messages = JSON.stringify(h.adapter.requests[0]!.messages)
  expect(messages.indexOf(instructions)).toBeLessThan(messages.indexOf(scenario))
  expect(h.state.titleCalls).toBe(0)
  expect(h.ctx.agents.list()).toEqual([])
  expect(await h.ctx.sessionPersistence.listForBootstrap()).toEqual([])
  expect(h.calls.filter(call => call.path.endsWith('/settle'))).toHaveLength(1)
  await expect(h.run()).resolves.toEqual(result)
  expect(h.adapter.requests).toHaveLength(1)
})

test.each(['propose_fact', 'write_file', 'project_update', 'publish_skill', 'list_accessible_projects', 'search_artifacts', 'submit_cited_answer'])(
  'forbidden tool %s is absent and denied without executing', async (name) => {
    const h = await harness([toolCallResponse('blocked', name, {}), textResponse('Stopped.')], ['propose_fact'])
    const effects: string[] = []
    h.ctx.tools.register(defineTool({ name, description: 'Forbidden write', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { effects.push(name); return 'written' } }))
    const result = await h.run()
    expect(result).toMatchObject({ status: 'failed', terminationReason: 'tool-denied' })
    expect(h.adapter.requests.every(item => item.tools?.map(tool => tool.name).join() === 'skill')).toBe(true)
    expect(effects).toEqual([])
    expect(h.stored.some(event => event.type === 'tool/result' && event.data.message.content[0].isError)).toBe(true)
  })

test('the final read-only guard cannot be bypassed by an earlier middleware allow', async () => {
  const h = await harness([toolCallResponse('write', 'write_file', {}), textResponse('Denied.')])
  const execute = vi.fn(async () => 'written')
  h.ctx.on('agent/created', ({ agent }) => {
    agent.ctx.get('tools')!.register(defineTool({ name: 'write_file', description: 'Write', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute }))
    agent.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true })
  })
  await expect(h.run()).resolves.toMatchObject({ status: 'failed', terminationReason: 'tool-denied' })
  expect(execute).not.toHaveBeenCalled()
})

test('another provider cannot replace the activated exact draft', async () => {
  const h = await harness([toolCallResponse('other', 'skill', { name: 'another' }), textResponse('Denied.')])
  h.ctx.skills.register({ name: 'another', description: 'Other', content: 'Other instructions', source: 'project' })
  await expect(h.run()).resolves.toMatchObject({ status: 'failed', terminationReason: 'tool-denied' })
  expect(h.stored.filter(event => event.type === 'business-skill/activated')).toHaveLength(1)
  expect(JSON.stringify(h.adapter.requests.at(-1)?.messages)).not.toContain('Other instructions')
})

test('the one-turn pre-step admission refuses a second turn without delegating or injecting', async () => {
  const h = await harness()
  let decision: Promise<unknown> | undefined
  h.ctx.on('agent/created', ({ agent }) => {
    decision = agentEvents(h.ctx, agent).waterfall('agent/pre-step',
      { turn: 2, step: 1, messages: [], signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter', messages: [] }))
  })
  await expect(h.run()).resolves.toMatchObject({ status: 'completed' })
  await expect(decision).resolves.toEqual({ kind: 'reject' })
  expect(h.stored.filter(event => event.type === 'turn/start')).toHaveLength(1)
})

test('model failure settles the run without a second turn', async () => {
  const h = await harness([[{ type: 'finish', reason: { kind: 'error', failure: { message: 'model unavailable', code: 'SERVER' } } }]])
  await expect(h.run()).resolves.toMatchObject({ status: 'failed', terminationReason: 'failed' })
  expect(h.stored.filter(event => event.type === 'turn/start')).toHaveLength(1)
})

test('a mounted run cannot acquire another Agent even when start replays running', async () => {
  const h = await harness()
  h.state.claimed = false
  await expect(h.run()).resolves.toMatchObject({ status: 'running' })
  expect(h.adapter.requests).toHaveLength(0)
  expect(h.calls.filter(call => call.path.endsWith('/settle'))).toHaveLength(0)
  expect(h.ctx.agents.list()).toEqual([])
})

test.each(['cancel', 'dispose'] as const)('%s waits for the one loop and settles cancellation exactly once', async (kind) => {
  const h = await harness(['hang-slow'])
  const started = Promise.withResolvers<undefined>()
  h.ctx.on('agent/request', (_payload, next) => { started.resolve(undefined); return next() })
  const cancel = new AbortController()
  const pending = h.run(cancel.signal)
  await started.promise
  if (kind === 'cancel') cancel.abort()
  else await h.runner.dispose()
  await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
  expect(h.calls.filter(call => call.path.endsWith('/settle'))).toHaveLength(1)
  const after = JSON.stringify(h.stored)
  await h.runner.dispose()
  expect(JSON.stringify(h.stored)).toBe(after)
  expect(h.ctx.agents.list()).toEqual([])
})
