import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionToken, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, test, vi } from 'vitest'
import {
  CITED_ANSWER_INSTRUCTION,
  CITED_ANSWER_TOOL,
  openCitedAnswerRequest,
  protectCitedAnswerStream,
  reconstructCitedAnswerEvidence,
} from '../src/cited-answer-policy.ts'
import { CITED_ANSWER_MAX_BYTES } from '../src/cited-answer.ts'

const CITATION = Object.freeze({
  id: '[资料1]',
  artifactId: '00000000-0000-0000-0000-000000000501',
  versionId: '00000000-0000-0000-0000-000000000601',
  chunkId: '00000000-0000-0000-0000-000000000801',
})

const WIRE_CITATION = Object.freeze({
  id: CITATION.id,
  artifact_id: CITATION.artifactId,
  version_id: CITATION.versionId,
  chunk_id: CITATION.chunkId,
})

function evidenceSession() {
  const session = Session.create(SessionId('evidence-session'))
  session.append('turn/start', { turn: 0 })
  session.append('step/start', { turn: 0, step: 0 })
  return session
}

function appendEvidence(
  session: Session,
  suffix: string,
  citations: readonly unknown[] = [WIRE_CITATION],
  admittedIds: readonly string[] = citations.map(value => (value as { id: string }).id),
) {
  const callId = `call-${suffix}`
  const message = {
    id: `message-${suffix}` as never,
    role: 'user' as const,
    source: { kind: 'tool' as const, callId: callId as never },
    content: [{
      type: 'tool-result' as const,
      toolCallId: callId as never,
      isError: false,
      content: [{ type: 'text' as const, text: JSON.stringify({ citations }) }],
    }],
  }
  const call = session.append('tool/call', {
    turn: 0, step: 0, callId: callId as never, name: 'search_artifacts', arguments: '{}',
  })
  session.append('tool/result', {
    turn: 0, step: 0, message: message as never,
    meta: { kind: 'xagent-retrieval', payloadHash: 'a'.repeat(64), citations: [...admittedIds] },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  return structuredClone(message) as GenerateOptions['messages'][number]
}

function directExecution(agent: object, overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    callId: CallId('direct'),
    rootCallId: CallId('direct'),
    token: Symbol('direct') as ToolExecutionToken,
    name: CITED_ANSWER_TOOL,
    arguments: {},
    agent: agent as never,
    signal: new AbortController().signal,
    deferContext: vi.fn(),
    concludeTurn: vi.fn(),
    ...overrides,
  }
}

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

describe('cited-answer evidence reconstruction', () => {
  test('rejects malformed model-visible retrieval results', () => {
    const session = evidenceSession()
    const message = appendEvidence(session, 'malformed')
    const toolResult = (content: unknown, isError = false) => ({
      type: 'tool-result', toolCallId: 'call-malformed', isError, content,
    })
    const withContent = (content: unknown) => ({ ...message, content } as unknown as GenerateOptions['messages'][number])
    const malformed: GenerateOptions['messages'][number][] = [
      { ...message, source: { kind: 'user' } } as unknown as GenerateOptions['messages'][number],
      withContent([]),
      withContent([{ type: 'text', text: 'not a result' }]),
      withContent([toolResult([{ type: 'text', text: '{}' }], true)]),
      withContent([toolResult([])]),
      withContent([toolResult([{ type: 'image', data: 'x', mimeType: 'image/png' }])]),
      withContent([toolResult(new Array(1))]),
      withContent([toolResult([{ type: 'text', text: '{' }])]),
      withContent([toolResult([{ type: 'text', text: '[]' }])]),
      withContent([toolResult([{ type: 'text', text: JSON.stringify({ citations: 'invalid' }) }])]),
      withContent([toolResult([{ type: 'text', text: JSON.stringify({ citations: [] }) }])]),
      withContent([toolResult([{ type: 'text', text: JSON.stringify({ citations: Array(9).fill(WIRE_CITATION) }) }])]),
      withContent([toolResult([{ type: 'text', text: JSON.stringify({ citations: [null] }) }])]),
    ]
    for (const candidate of malformed) {
      expect(reconstructCitedAnswerEvidence([candidate], session)).toBeUndefined()
    }
  })

  test.each([
    1,
    { ...WIRE_CITATION, id: '资料1' },
    { ...WIRE_CITATION, id: `[资料${'9'.repeat(400)}]` },
    { ...WIRE_CITATION, artifact_id: 'invalid' },
    { ...WIRE_CITATION, version_id: 'invalid' },
    { ...WIRE_CITATION, chunk_id: 'invalid' },
  ])('rejects malformed citation identity %#', (citation) => {
    const session = evidenceSession()
    const message = appendEvidence(session, 'invalid-identity')
    const candidate = {
      ...message,
      content: [{
        type: 'tool-result', toolCallId: 'call-invalid-identity', isError: false,
        content: [{ type: 'text', text: JSON.stringify({ citations: [citation] }) }],
      }],
    } as unknown as GenerateOptions['messages'][number]
    expect(reconstructCitedAnswerEvidence([candidate], session)).toBeUndefined()
  })

  test('requires exact call, count, and admitted citation order', () => {
    const session = evidenceSession()
    const message = appendEvidence(session, 'exact')
    expect(reconstructCitedAnswerEvidence([{
      ...message, source: { kind: 'tool', callId: CallId('other') },
    }], session)).toBeUndefined()

    const second = { ...WIRE_CITATION, id: '[资料2]' }
    const replaceCitations = (citations: readonly unknown[]) => ({
      ...message,
      content: [{
        type: 'tool-result', toolCallId: 'call-exact', isError: false,
        content: [{ type: 'text', text: JSON.stringify({ citations }) }],
      }],
    } as unknown as GenerateOptions['messages'][number])
    expect(reconstructCitedAnswerEvidence([replaceCitations([WIRE_CITATION, second])], session)).toBeUndefined()
    expect(reconstructCitedAnswerEvidence([replaceCitations([second])], session)).toBeUndefined()
  })

  test.each(['artifact_id', 'version_id', 'chunk_id'] as const)(
    'rejects a repeated citation whose %s conflicts',
    (field) => {
      const session = evidenceSession()
      const first = appendEvidence(session, `conflict-${field}-1`)
      const second = appendEvidence(session, `conflict-${field}-2`, [{
        ...WIRE_CITATION,
        [field]: '00000000-0000-0000-0000-000000000999',
      }])
      expect(reconstructCitedAnswerEvidence([first, second], session)).toBeUndefined()
    },
  )

  test('deduplicates exact identities and bounds the aggregate evidence set', () => {
    const duplicateSession = evidenceSession()
    const first = appendEvidence(duplicateSession, 'duplicate-1')
    const second = appendEvidence(duplicateSession, 'duplicate-2')
    expect([...reconstructCitedAnswerEvidence([first, second], duplicateSession)!.values()]).toEqual([CITATION])

    const oversizedSession = evidenceSession()
    const messages: GenerateOptions['messages'] = []
    for (let offset = 0; offset < 65; offset += 8) {
      const citations = Array.from({ length: Math.min(8, 65 - offset) }, (_, index) => {
        const ordinal = offset + index + 1
        const suffix = ordinal.toString(16).padStart(12, '0')
        return {
          id: `[资料${ordinal}]`,
          artifact_id: `00000000-0000-0000-0000-${suffix}`,
          version_id: `00000000-0000-0000-0001-${suffix}`,
          chunk_id: `00000000-0000-0000-0002-${suffix}`,
        }
      })
      messages.push(appendEvidence(oversizedSession, `bounded-${offset}`, citations))
    }
    expect(reconstructCitedAnswerEvidence(messages, oversizedSession)).toBeUndefined()
  })
})

describe('cited-answer request runtime', () => {
  test('fails closed for an unknown or closed request owner', async () => {
    const { agent } = await setup()
    const options = { provider: 'mock', model: 'mock', messages: [], sessionId: agent.session.id } as GenerateOptions
    const unknown = {
      agent, identity: {}, allowed: new Map(), signal: new AbortController().signal,
      settlement: Promise.resolve(), attempts: 0, close: vi.fn(),
    } as const
    await expect(collect(protectCitedAnswerStream(options, unknown, () => (async function* () {})())))
      .rejects.toMatchObject({ code: 'CITATION_FAILED' })

    const owner = openCitedAnswerRequest({
      agent, identity: Object.freeze({}), allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal, authorize: () => Promise.resolve(),
    })
    owner.close()
    owner.close()
    await expect(collect(protectCitedAnswerStream(options, owner, () => (async function* () {})())))
      .resolves.toEqual([])
    await owner.settlement
  })

  test('closes when a live request lifetime is aborted', async () => {
    const { agent } = await setup()
    const request = new AbortController()
    const owner = openCitedAnswerRequest({
      agent, identity: Object.freeze({}), allowed: new Map([[CITATION.id, CITATION]]),
      signal: request.signal, authorize: () => Promise.resolve(),
    })
    request.abort()
    await owner.settlement
    expect(agent.ctx.tools.get(CITED_ANSWER_TOOL, agent)).toBeUndefined()
  })

  test('rejects every direct terminal admission violation', async () => {
    const { agent, ctx } = await setup()
    const answer = { blocks: [{ type: 'markdown', text: '正文' }, { type: 'citation', id: CITATION.id }] }
    const create = () => {
      const owner = openCitedAnswerRequest({
        agent, identity: Object.freeze({}), allowed: new Map([[CITATION.id, CITATION]]),
        signal: new AbortController().signal, authorize: () => Promise.resolve(),
      })
      const definition = agent.ctx.tools.get(CITED_ANSWER_TOOL, agent)
      if (definition === undefined) throw new Error('missing cited-answer definition')
      return { definition, owner }
    }

    const closed = create()
    closed.owner.close()
    await expect(closed.definition.execute(answer, directExecution(agent)))
      .rejects.toMatchObject({ code: 'CITATION_FAILED' })

    const committed = create()
    await expect(ctx.tools.execute({
      callId: CallId('commit-direct-gate'), name: CITED_ANSWER_TOOL, agent, arguments: answer,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ isError: false })
    await expect(committed.definition.execute(answer, directExecution(agent)))
      .rejects.toMatchObject({ code: 'CITATION_FAILED' })
    committed.owner.close()

    const mismatched = create()
    await expect(mismatched.definition.execute(answer, directExecution({})))
      .rejects.toMatchObject({ code: 'CITATION_FAILED' })
    mismatched.owner.close()

    const nested = create()
    await expect(nested.definition.execute(answer, directExecution(agent, {
      parent: Symbol('parent') as ToolExecutionToken,
    }))).rejects.toMatchObject({ code: 'CITATION_FAILED' })
    nested.owner.close()

    const exhausted = create()
    exhausted.owner.attempts = 2
    await expect(exhausted.definition.execute(answer, directExecution(agent)))
      .rejects.toMatchObject({ code: 'CITATION_FAILED' })
    exhausted.owner.close()
  })

  test('rejects a direct parallel body and a citation lost after normalization', async () => {
    const { agent, ctx } = await setup()
    const authorization = Promise.withResolvers<undefined>()
    const owner = openCitedAnswerRequest({
      agent, identity: Object.freeze({}), allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal, authorize: () => authorization.promise,
    })
    const definition = agent.ctx.tools.get(CITED_ANSWER_TOOL, agent)
    if (definition === undefined) throw new Error('missing cited-answer definition')
    const answer = { blocks: [{ type: 'markdown', text: '正文' }, { type: 'citation', id: CITATION.id }] }
    const first = ctx.tools.execute({
      callId: CallId('direct-parallel-first'), name: CITED_ANSWER_TOOL, agent, arguments: answer,
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(owner.attempts).toBe(1) })
    await expect(definition.execute(answer, directExecution(agent)))
      .rejects.toMatchObject({ code: 'CITATION_INVALID' })
    authorization.resolve(undefined)
    await expect(first).resolves.toMatchObject({ isError: false })
    await owner.settlement
    owner.close()

    const missingAllowed = {
      size: 1,
      keys: () => new Map([[CITATION.id, CITATION]]).keys(),
      get: () => undefined,
    } as unknown as ReadonlyMap<string, typeof CITATION>
    const missingOwner = openCitedAnswerRequest({
      agent, identity: Object.freeze({}), allowed: missingAllowed,
      signal: new AbortController().signal, authorize: () => Promise.resolve(),
    })
    await expect(ctx.tools.execute({
      callId: CallId('missing-after-normalization'), name: CITED_ANSWER_TOOL, agent, arguments: answer,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ isError: true })
    missingOwner.close()
  })

  test('rejects when normalization closes the owner and preserves AbortError authorization failures', async () => {
    const { agent, ctx } = await setup()
    const backing = new Map<string, typeof CITATION>([[CITATION.id, CITATION]])
    const closingAllowed = {
      size: 1,
      keys: () => {
        closingOwner.close()
        return backing.keys()
      },
      get: (id: string) => backing.get(id),
    } as unknown as ReadonlyMap<string, typeof CITATION>
    const closingOwner = openCitedAnswerRequest({
      agent, identity: Object.freeze({}), allowed: closingAllowed,
      signal: new AbortController().signal, authorize: () => Promise.resolve(),
    })
    const answer = { blocks: [{ type: 'markdown', text: '正文' }, { type: 'citation', id: CITATION.id }] }
    await expect(ctx.tools.execute({
      callId: CallId('closed-during-normalization'), name: CITED_ANSWER_TOOL, agent, arguments: answer,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ isError: true })
    await closingOwner.settlement

    const abortOwner = openCitedAnswerRequest({
      agent, identity: Object.freeze({}), allowed: backing,
      signal: new AbortController().signal,
      authorize: () => Promise.reject(new DOMException('backend stopped', 'AbortError')),
    })
    await expect(ctx.tools.execute({
      callId: CallId('authorization-abort'), name: CITED_ANSWER_TOOL, agent, arguments: answer,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ isError: true })
    abortOwner.close()
  })

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
    const definition = agent.ctx.tools.get(CITED_ANSWER_TOOL, agent)
    expect(definition?.nativeOnly).toBe(true)
    expect(definition?.parameters).toMatchObject({
      properties: { blocks: { minItems: 1, maxItems: 256 } },
    })
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
    expect(denied).toMatchObject({ isError: true, error: { message: 'cited answer submission is terminal' } })
    expect(owner.attempts).toBe(1)
    authorization.resolve(undefined)
    await expect(first).resolves.toMatchObject({ isError: false })
    await owner.settlement
  })

  test('does not consume the retry when a concurrent terminal call is denied', async () => {
    const { agent, ctx } = await setup()
    const firstAuthorization = Promise.withResolvers<undefined>()
    const authorize = vi.fn()
      .mockImplementationOnce(() => firstAuthorization.promise)
      .mockResolvedValueOnce(undefined)
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
    const first = ctx.tools.execute({ ...input, callId: CallId('parallel-failing') })
    await vi.waitFor(() => { expect(authorize).toHaveBeenCalledOnce() })
    const denied = await ctx.tools.execute({ ...input, callId: CallId('parallel-denied') })
    expect(denied.isError).toBe(true)
    expect(owner.attempts).toBe(1)
    firstAuthorization.reject(new Error('authorization failed'))
    await expect(first).resolves.toMatchObject({ isError: true })
    const retry = await ctx.tools.execute({ ...input, callId: CallId('retry-after-parallel') })
    expect(retry.isError).toBe(false)
    expect(authorize).toHaveBeenCalledTimes(2)
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

  test('stops an oversized terminal argument delta before forwarding it to the Agent assembler', async () => {
    const { agent } = await setup()
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    let sourceClosed = false
    const chunks = await collect(protectCitedAnswerStream({
      provider: 'mock', model: 'mock', messages: [], sessionId: agent.session.id,
    }, owner, () => (async function* () {
      try {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' } as const
        yield {
          type: 'tool-call-delta', index: 0, id: CallId('oversized'), name: CITED_ANSWER_TOOL,
          argumentsDelta: 'x'.repeat(CITED_ANSWER_MAX_BYTES + 1),
        } as const
        yield { type: 'finish', reason: { kind: 'tool-calls' } } as const
      } finally {
        sourceClosed = true
      }
    })()))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'CITATION_FAILED', message: 'cited answer was not submitted' } } },
    ])
    expect(sourceClosed).toBe(true)
    await owner.settlement
  })

  test('stops an oversized terminal block before forwarding it to the Agent assembler', async () => {
    const { agent } = await setup()
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    const chunks = await collect(protectCitedAnswerStream({
      provider: 'mock', model: 'mock', messages: [], sessionId: agent.session.id,
    }, owner, () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' } as const
      yield {
        type: 'block-end', index: 0,
        block: {
          type: 'tool-call', id: CallId('oversized-block'), name: CITED_ANSWER_TOOL,
          arguments: 'x'.repeat(CITED_ANSWER_MAX_BYTES + 1),
        },
      } as const
      yield { type: 'finish', reason: { kind: 'tool-calls' } } as const
    })()))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'CITATION_FAILED', message: 'cited answer was not submitted' } } },
    ])
    await owner.settlement
  })

  test('leaves an identified ordinary tool and its unnamed continuations unbounded', async () => {
    const { agent } = await setup()
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    const continuation = 'x'.repeat(CITED_ANSWER_MAX_BYTES + 1)
    const chunks = await collect(protectCitedAnswerStream({
      provider: 'mock', model: 'mock', messages: [], sessionId: agent.session.id,
    }, owner, () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' } as const
      yield {
        type: 'tool-call-delta', index: 0, id: CallId('ordinary'),
        name: 'list_accessible_projects', argumentsDelta: '{',
      } as const
      yield {
        type: 'tool-call-delta', index: 0, id: CallId('ordinary'), argumentsDelta: continuation,
      } as const
      yield {
        type: 'block-end', index: 0,
        block: {
          type: 'tool-call', id: CallId('ordinary'), name: 'list_accessible_projects',
          arguments: `{${continuation}`,
        },
      } as const
      yield { type: 'finish', reason: { kind: 'tool-calls' } } as const
    })()))
    expect(chunks).toHaveLength(5)
    expect(chunks[2]).toMatchObject({ type: 'tool-call-delta', argumentsDelta: continuation })
    expect(chunks[2]).not.toHaveProperty('name')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    owner.close()
    await owner.settlement
  })

  test('counts unnamed continuations after a terminal tool identity is established', async () => {
    const { agent } = await setup()
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    const chunks = await collect(protectCitedAnswerStream({
      provider: 'mock', model: 'mock', messages: [], sessionId: agent.session.id,
    }, owner, () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' } as const
      yield {
        type: 'tool-call-delta', index: 0, id: CallId('terminal-continuation'),
        name: CITED_ANSWER_TOOL, argumentsDelta: 'x',
      } as const
      yield {
        type: 'tool-call-delta', index: 0, id: CallId('terminal-continuation'),
        argumentsDelta: 'x'.repeat(CITED_ANSWER_MAX_BYTES),
      } as const
      yield { type: 'finish', reason: { kind: 'tool-calls' } } as const
    })()))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'tool-call-delta', index: 0, id: CallId('terminal-continuation'),
        name: CITED_ANSWER_TOOL, argumentsDelta: 'x',
      },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'CITATION_FAILED', message: 'cited answer was not submitted' } } },
    ])
    await owner.settlement
  })

  test('fails closed when an ordinary tool index closes with the terminal identity', async () => {
    const { agent } = await setup()
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    const chunks = await collect(protectCitedAnswerStream({
      provider: 'mock', model: 'mock', messages: [], sessionId: agent.session.id,
    }, owner, () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' } as const
      yield {
        type: 'tool-call-delta', index: 0, id: CallId('contradictory-ordinary'),
        name: 'list_accessible_projects', argumentsDelta: 'x'.repeat(CITED_ANSWER_MAX_BYTES + 1),
      } as const
      yield {
        type: 'block-end', index: 0,
        block: {
          type: 'tool-call', id: CallId('contradictory-ordinary'), name: CITED_ANSWER_TOOL, arguments: '{}',
        },
      } as const
      yield { type: 'finish', reason: { kind: 'tool-calls' } } as const
    })()))
    expect(chunks).toHaveLength(3)
    expect(chunks[1]).toMatchObject({ type: 'tool-call-delta', name: 'list_accessible_projects' })
    expect(chunks[2]).toEqual({
      type: 'finish', reason: { kind: 'error', failure: { code: 'CITATION_FAILED', message: 'cited answer was not submitted' } },
    })
    await owner.settlement
  })

  test('fails closed when a terminal tool index later claims an ordinary identity', async () => {
    const { agent } = await setup()
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    const chunks = await collect(protectCitedAnswerStream({
      provider: 'mock', model: 'mock', messages: [], sessionId: agent.session.id,
    }, owner, () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' } as const
      yield {
        type: 'tool-call-delta', index: 0, id: CallId('contradictory-terminal'),
        name: CITED_ANSWER_TOOL, argumentsDelta: '{',
      } as const
      yield {
        type: 'tool-call-delta', index: 0, id: CallId('contradictory-terminal'),
        name: 'list_accessible_projects', argumentsDelta: '}',
      } as const
      yield { type: 'finish', reason: { kind: 'tool-calls' } } as const
    })()))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'tool-call-delta', index: 0, id: CallId('contradictory-terminal'),
        name: CITED_ANSWER_TOOL, argumentsDelta: '{',
      },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'CITATION_FAILED', message: 'cited answer was not submitted' } } },
    ])
    await owner.settlement
  })

  test('accepts a tool identity that arrives after its first delta', async () => {
    const { agent } = await setup()
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    const chunks = await collect(protectCitedAnswerStream({
      provider: 'mock', model: 'mock', messages: [], sessionId: agent.session.id,
    }, owner, () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' } as const
      yield {
        type: 'tool-call-delta', index: 0, id: CallId('late-name'), argumentsDelta: '{',
      } as const
      yield {
        type: 'tool-call-delta', index: 0, id: CallId('late-name'),
        name: 'list_accessible_projects', argumentsDelta: '}',
      } as const
      yield { type: 'finish', reason: { kind: 'tool-calls' } } as const
    })()))
    expect(chunks).toHaveLength(4)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    owner.close()
    await owner.settlement
  })

  test('fails an exhausted empty stream and supports an iterator without return', async () => {
    const { agent } = await setup()
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    const empty = {
      [Symbol.asyncIterator]() {
        return { next: async () => ({ done: true as const, value: undefined }) }
      },
    }
    await expect(collect(protectCitedAnswerStream({
      provider: 'mock', model: 'mock', messages: [], sessionId: agent.session.id,
    }, owner, () => empty))).resolves.toEqual([{
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'CITATION_FAILED', message: 'cited answer was not submitted' } },
    }])
    await owner.settlement
  })

  test('closes an active empty stream when the model signal aborts', async () => {
    const { agent } = await setup()
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    const model = new AbortController()
    const started = Promise.withResolvers<undefined>()
    const item = Promise.withResolvers<IteratorResult<StreamChunk>>()
    const pending = collect(protectCitedAnswerStream({
      provider: 'mock', model: 'mock', messages: [], sessionId: agent.session.id, signal: model.signal,
    }, owner, () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            started.resolve(undefined)
            return item.promise
          },
        }
      },
    })))
    await started.promise
    model.abort()
    item.resolve({ done: true, value: undefined })
    await expect(pending).resolves.toEqual([])
    await owner.settlement
  })

  test('settles stream accounting when downstream iterator creation fails', async () => {
    const { agent } = await setup()
    const owner = openCitedAnswerRequest({
      agent,
      identity: Object.freeze({}),
      allowed: new Map([[CITATION.id, CITATION]]),
      signal: new AbortController().signal,
      authorize: () => Promise.resolve(),
    })
    await expect(collect(protectCitedAnswerStream({
      provider: 'mock', model: 'mock', messages: [], sessionId: agent.session.id,
    }, owner, () => ({
      [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        throw new Error('iterator failed')
      },
    })))).rejects.toThrow('iterator failed')
    owner.close()
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
