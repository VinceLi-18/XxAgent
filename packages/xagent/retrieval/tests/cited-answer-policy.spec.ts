import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { describe, expect, test, vi } from 'vitest'
import {
  CITED_ANSWER_INSTRUCTION,
  CITED_ANSWER_TOOL,
  openCitedAnswerRequest,
  protectCitedAnswerStream,
} from '../src/cited-answer-policy.ts'

const CITATION = Object.freeze({
  id: '[资料1]',
  artifactId: '00000000-0000-0000-0000-000000000501',
  versionId: '00000000-0000-0000-0000-000000000601',
  chunkId: '00000000-0000-0000-0000-000000000801',
})

async function setup() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const agent = ctx.agentLoop.create(SessionId('request-owner'), { provider: 'mock', model: 'mock' })
  return { agent, ctx }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('cited-answer request runtime', () => {
  test('registers the closed terminal tool and order-190 instruction only on its Agent scope', async () => {
    const { agent, ctx } = await setup()
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    expect(ctx.tools.get(CITED_ANSWER_TOOL)).toBeUndefined()
    expect(agent.ctx.tools.get(CITED_ANSWER_TOOL, agent)?.nativeOnly).toBe(true)
    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name)).toContain(CITED_ANSWER_TOOL)
    expect(assembly.sections).toContainEqual({ name: `tool:${CITED_ANSWER_TOOL}`, text: CITED_ANSWER_INSTRUCTION })
    owner.close()
    await owner.settlement
    expect(agent.ctx.tools.get(CITED_ANSWER_TOOL, agent)).toBeUndefined()
  })

  test('reauthorizes canonical citation identities and commits only the exact successful result', async () => {
    const { agent, ctx } = await setup()
    const authorize = vi.fn(() => Promise.resolve())
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize,
    })
    let observed: unknown
    agent.ctx.on('tools/result', (exec, result) => {
      if (exec.name === CITED_ANSWER_TOOL && !result.isError) observed = result
    })
    const result = await ctx.tools.execute({
      callId: CallId('answer'), name: CITED_ANSWER_TOOL, agent,
      arguments: { blocks: [{ type: 'markdown', text: '正文' }, { type: 'citation', id: CITATION.id }] },
      signal: new AbortController().signal,
    })
    expect(authorize).toHaveBeenCalledWith([CITATION], expect.any(AbortSignal))
    expect(result).toMatchObject({
      isError: false,
      value: {
        schemaVersion: 1,
        blocks: [{ type: 'markdown', text: '正文' }, { type: 'citation', id: '[资料1]' }],
        citationIds: ['[资料1]'],
      },
      content: [{ type: 'text', text: '正文【已验证资料：[资料1]】' }],
      meta: {
        kind: 'xagent-cited-answer', schemaVersion: 1,
        blocks: [{ type: 'markdown', text: '正文' }, { type: 'citation', id: '[资料1]' }],
        citationIds: ['[资料1]'],
      },
      concludesTurn: true,
    })
    expect(observed).toBe(result)
    await owner.settlement
  })

  test('rejects nested dispatch and a later call after terminal success', async () => {
    const { agent, ctx } = await setup()
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    const input = {
      name: CITED_ANSWER_TOOL,
      arguments: { blocks: [{ type: 'markdown', text: '正文' }, { type: 'citation', id: CITATION.id }] },
      agent,
      signal: new AbortController().signal,
    }
    const nested = await ctx.tools.execute({
      ...input, callId: CallId('nested'), parent: Symbol('parent') as ToolExecutionToken,
    })
    expect(nested).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    const accepted = await ctx.tools.execute({ ...input, callId: CallId('accepted') })
    expect(accepted.isError).toBe(false)
    const later = await ctx.tools.execute({ ...input, callId: CallId('later') })
    expect(later.isError).toBe(true)
    await owner.settlement
  })

  test('keeps admission open when the authoritative result reports a projection failure', async () => {
    const { agent, ctx } = await setup()
    const authorize = vi.fn(() => Promise.resolve())
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize,
    })
    const definition = agent.ctx.tools.get(CITED_ANSWER_TOOL, agent)
    if (definition === undefined) throw new Error('missing cited-answer definition')
    vi.spyOn(definition.output, 'render').mockImplementationOnce(() => {
      throw new Error('projection failed')
    })
    const input = {
      name: CITED_ANSWER_TOOL,
      arguments: { blocks: [{ type: 'markdown', text: '正文' }, { type: 'citation', id: CITATION.id }] },
      agent,
      signal: new AbortController().signal,
    }
    const failed = await ctx.tools.execute({ ...input, callId: CallId('projection-failed') })
    expect(failed.isError).toBe(true)
    expect(owner.attempts).toBe(1)
    expect(agent.ctx.tools.get(CITED_ANSWER_TOOL, agent)).toBeDefined()

    const accepted = await ctx.tools.execute({ ...input, callId: CallId('projection-retry') })
    expect(accepted.isError).toBe(false)
    expect(authorize).toHaveBeenCalledTimes(2)
    await owner.settlement
  })

  test('denies a parallel terminal dispatch while the exact staged execution is authorizing', async () => {
    const { agent, ctx } = await setup()
    const authorization = Promise.withResolvers<undefined>()
    const authorize = vi.fn(() => authorization.promise)
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize,
    })
    const input = {
      name: CITED_ANSWER_TOOL,
      arguments: { blocks: [{ type: 'markdown', text: '正文' }, { type: 'citation', id: CITATION.id }] },
      agent,
      signal: new AbortController().signal,
    }
    const first = ctx.tools.execute({ ...input, callId: CallId('parallel-first') })
    await vi.waitFor(() => { expect(authorize).toHaveBeenCalledOnce() })
    const denied = await ctx.tools.execute({ ...input, callId: CallId('parallel-second') })
    expect(denied).toMatchObject({ isError: true, error: { info: { code: 'CITATION_INVALID' } } })
    authorization.resolve(undefined)
    await expect(first).resolves.toMatchObject({ isError: false })
    await owner.settlement
  })

  test('keeps sibling owners and their attempt budgets independent', async () => {
    const { agent, ctx } = await setup()
    const sibling = ctx.agentLoop.create(SessionId('request-owner-sibling'), { provider: 'mock', model: 'mock' })
    const first = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    const second = openCitedAnswerRequest({
      agent: sibling,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    const rejected = await ctx.tools.execute({
      callId: CallId('first-invalid'), name: CITED_ANSWER_TOOL, agent,
      arguments: { blocks: [{ type: 'markdown', text: '正文' }, { type: 'citation', id: '[资料9]' }] },
      signal: new AbortController().signal,
    })
    expect(rejected.isError).toBe(true)
    expect(first.attempts).toBe(1)
    expect(second.attempts).toBe(0)
    const accepted = await ctx.tools.execute({
      callId: CallId('second-valid'), name: CITED_ANSWER_TOOL, agent: sibling,
      arguments: { blocks: [{ type: 'markdown', text: '正文' }, { type: 'citation', id: CITATION.id }] },
      signal: new AbortController().signal,
    })
    expect(accepted.isError).toBe(false)
    expect(first.attempts).toBe(1)
    first.close()
    await Promise.all([first.settlement, second.settlement])
  })

  test('drops prose and reasoning while preserving tool/protocol chunks and emits a bounded terminal failure', async () => {
    const { agent } = await setup()
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    const options = {
      provider: 'mock', model: 'mock', messages: [], sessionId: agent.session.id,
    } as GenerateOptions
    const chunks = await collect(protectCitedAnswerStream(options, owner, () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' } as const
      yield { type: 'reasoning-delta', index: 0, text: 'secret reasoning' } as const
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'secret reasoning' } } as const
      yield { type: 'block-start', index: 1, blockType: 'text' } as const
      yield { type: 'text-delta', index: 1, text: 'rejected prose' } as const
      yield { type: 'block-end', index: 1, block: { type: 'text', text: 'rejected prose' } } as const
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } } as const
      yield { type: 'finish', reason: { kind: 'stop' } } as const
    })()))
    expect(JSON.stringify(chunks)).not.toContain('secret reasoning')
    expect(JSON.stringify(chunks)).not.toContain('rejected prose')
    expect(chunks).toEqual([
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'CITATION_FAILED', message: 'cited answer was not submitted' } } },
    ])
    await owner.settlement
  })

  test('closes immediately when request or model admission is already aborted', async () => {
    const { agent } = await setup()
    const request = new AbortController()
    request.abort()
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: request.signal,
      authorize: () => Promise.resolve(),
    })
    await owner.settlement
    expect(agent.ctx.tools.get(CITED_ANSWER_TOOL, agent)).toBeUndefined()

    const liveOwner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    const model = new AbortController()
    model.abort()
    const chunks = await collect(protectCitedAnswerStream({
      provider: 'mock', model: 'mock', messages: [], sessionId: agent.session.id, signal: model.signal,
    }, liveOwner, () => (async function* () {
      yield { type: 'text-delta', index: 0, text: 'must-not-start' } as const
    })()))
    expect(chunks).toEqual([])
    await liveOwner.settlement
  })
})
