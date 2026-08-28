import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  CallId,
  createToolResultMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  CITATION_ANSWER_MAX_BYTES,
  CITATION_CORRECTION_DRAFT_MAX_BYTES,
  installXAgentCitationPolicy,
  type XAgentCitationReleaseInput,
  type XAgentCitationPolicyRequest,
} from '../src/citation-policy.ts'

const SESSION = SessionId('session-00000000-0000-0000-0000-000000000701')
const OTHER_SESSION = SessionId('session-00000000-0000-0000-0000-000000000702')
const sessions: Context[] = []

const citation = {
  id: '[资料1]',
  artifactId: '00000000-0000-0000-0000-000000000501',
  versionId: '00000000-0000-0000-0000-000000000601',
  chunkId: '00000000-0000-0000-0000-000000000801',
}

function evidenceMessage(id = '[资料1]', ordinal = 1) {
  return createToolResultMessage({
    callId: CallId(`search-${String(ordinal)}`),
    isError: false,
    content: [{
      type: 'text',
      text: JSON.stringify({
        citations: [{
          id,
          artifact_id: ordinal === 1 ? citation.artifactId : `00000000-0000-0000-0000-${ordinal.toString(16).padStart(12, '0')}`,
          version_id: ordinal === 1 ? citation.versionId : `10000000-0000-0000-0000-${ordinal.toString(16).padStart(12, '0')}`,
          chunk_id: ordinal === 1 ? citation.chunkId : `20000000-0000-0000-0000-${ordinal.toString(16).padStart(12, '0')}`,
          display_name: 'brief.md',
          version_number: 1,
          line_start: 1,
          line_end: 2,
          text: 'evidence',
          scope: 'project',
        }],
      }),
    }],
  })
}

const ADMITTED_EVIDENCE_MESSAGE = evidenceMessage()

function options(messages: GenerateOptions['messages'] = [ADMITTED_EVIDENCE_MESSAGE]): GenerateOptions {
  return { provider: 'mock', model: 'mock', messages, sessionId: SESSION }
}

async function* source(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* chunks
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function setup() {
  const ctx = new Context()
  sessions.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const session = ctx.sessions.create(SESSION)
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: ADMITTED_EVIDENCE_MESSAGE,
    meta: { kind: 'xagent-retrieval', payloadHash: 'a'.repeat(64), citations: ['[资料1]'] },
  }, { surfaceOp: 'append' })
  const agent = { ctx, session } as Agent
  const identity = Object.freeze({ session: SESSION })
  const authorize = vi.fn(async (_input: XAgentCitationReleaseInput) => {})
  const resolve = vi.fn((request: GenerateOptions): XAgentCitationPolicyRequest | undefined => (
    request.sessionId === SESSION
      ? {
        agent,
        identity,
        session,
        begin: signal => ({ identity, signal: signal ?? new AbortController().signal, settle: () => {} }),
        authorize,
      }
      : undefined
  ))
  const close = installXAgentCitationPolicy(ctx, resolve)
  return { agent, authorize, close, ctx, resolve, session }
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('XAgent citation policy', () => {
  test('returns the ordinary stream unchanged without retrieval evidence', async () => {
    const { authorize, ctx } = await setup()
    let calls = 0
    const downstream = source([
      { type: 'text-delta', index: 0, text: '即' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const wrapped = ctx.waterfall(ctx.llm, 'llm/stream', options([]), () => {
      calls += 1
      return downstream
    })
    expect(calls).toBe(1)
    await expect(collect(wrapped)).resolves.toEqual([
      { type: 'text-delta', index: 0, text: '即' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(authorize).not.toHaveBeenCalled()
  })

  test('buffers one-byte chunks and authorizes used known citations before first release', async () => {
    const { authorize, ctx } = await setup()
    const released: string[] = []
    authorize.mockImplementation(async (input) => { released.push(`authorize:${input.citations[0]?.id}`) })
    const chunks = Array.from('结论[资料1]').map(text => ({ type: 'text-delta' as const, index: 0, text }))
    chunks.push({ type: 'finish', reason: { kind: 'stop' } } as never)
    const stream = ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source(chunks))
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    const firstChunk = first.value as StreamChunk | undefined
    released.push(`release:${firstChunk?.type}`)
    expect(released).toEqual(['authorize:[资料1]', 'release:text-delta'])
    expect(first.value).toEqual({ type: 'text-delta', index: 0, text: '结' })
    await collect({ [Symbol.asyncIterator]: () => iterator })
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION,
      citations: [citation],
    }))
  })

  test('keeps the complete answer suppressed while final authorization is pending', async () => {
    const { authorize, ctx } = await setup()
    const gate = Promise.withResolvers<undefined>()
    authorize.mockImplementation(() => gate.promise)
    const iterator = ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'text-delta', index: 0, text: '结论[资料1]' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]))[Symbol.asyncIterator]()
    const pending = iterator.next()
    let released = false
    void pending.then(() => { released = true })
    await vi.waitFor(() => { expect(authorize).toHaveBeenCalledOnce() })
    expect(released).toBe(false)
    gate.resolve(undefined)
    await expect(pending).resolves.toMatchObject({ value: { type: 'text-delta' } })
  })

  test('buffers a tool-only continuation without authorizing an empty citation set', async () => {
    const { authorize, ctx } = await setup()
    const order: string[] = []
    async function* continuation(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta', index: 0, id: CallId('follow-up'), name: 'search_artifacts', argumentsDelta: '{}',
      }
      yield {
        type: 'block-end', index: 0,
        block: { type: 'tool-call', id: CallId('follow-up'), name: 'search_artifacts', arguments: '{}' },
      }
      order.push('source:complete')
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
    const iterator = ctx.waterfall(ctx.llm, 'llm/stream', options(), continuation)[Symbol.asyncIterator]()
    const first = await iterator.next()
    order.push('release:first')
    expect(order).toEqual(['source:complete', 'release:first'])
    expect(first.value).toEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    await collect({ [Symbol.asyncIterator]: () => iterator })
    expect(authorize).not.toHaveBeenCalled()
  })

  test('suppresses the first invalid draft, logs a bounded correction pair, and retries once', async () => {
    const { agent, ctx, session } = await setup()
    const first = await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'text-delta', index: 0, text: '无引用结论' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    expect(first).toEqual([{
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'CITATION_INVALID', message: '引用校验失败，正在重试。' } },
    }])
    const correction = session.events.find(event => event.type === 'xagent/citation-correction')
    expect(correction).toMatchObject({
      data: {
        reason: 'citation-missing',
        invalidDraft: '无引用结论',
        allowedIds: ['[资料1]'],
      },
    })
    const correctionMessage = session.events.find(event => event.type === 'user/message')
    expect(correctionMessage).toMatchObject({
      data: {
        source: { kind: 'plugin', plugin: 'xagent-retrieval' },
      },
    })
    if (correctionMessage?.type !== 'user/message') throw new Error('missing correction message')
    expect(correctionMessage.data.content).toHaveLength(1)
    const correctionContent = correctionMessage.data.content[0]
    expect(correctionContent?.type).toBe('text')
    if (correctionContent?.type !== 'text') throw new Error('missing correction text')
    expect(correctionContent.text).toContain('[资料1]')
    expect(session.deriveMessages().at(-1)).toEqual(correctionMessage?.data)

    const firstFailure = first[0]?.type === 'finish' && first[0].reason.kind === 'error'
      ? first[0].reason.failure
      : undefined
    if (firstFailure === undefined) throw new Error('missing citation failure')
    const retry = await ctx.waterfall(agent as never, 'agent/request-error', {
      agent, turn: 1, step: 2, provider: 'mock',
      failure: firstFailure,
      retryPolicy: undefined, signal: new AbortController().signal,
    }, () => Promise.resolve(undefined))
    expect(retry).toEqual({ kind: 'retry' })

    const second = await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'text-delta', index: 0, text: '仍然无引用' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    expect(second).toEqual([{
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'CITATION_FAILED', message: '引用校验失败，无法提供经过验证的回答。' } },
    }])
    expect(session.events.filter(event => event.type === 'xagent/citation-correction')).toHaveLength(1)
    expect(session.events.find(event => event.type === 'xagent/citation-failure')).toBeDefined()
    expect(session.deriveMessages()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: [{ type: 'text', text: '引用校验失败，无法提供经过验证的回答。' }] }),
    ]))
    const terminalFailure = second[0]?.type === 'finish' && second[0].reason.kind === 'error'
      ? second[0].reason.failure
      : undefined
    if (terminalFailure === undefined) throw new Error('missing terminal citation failure')
    await expect(ctx.waterfall(agent as never, 'agent/request-error', {
      agent, turn: 1, step: 2, provider: 'mock',
      failure: terminalFailure,
      retryPolicy: undefined, signal: new AbortController().signal,
    }, () => Promise.resolve(undefined))).resolves.toBeUndefined()
  })

  test('does not claim an unrelated CITATION_INVALID failure', async () => {
    const { agent, ctx } = await setup()
    let delegated = 0
    await expect(ctx.waterfall(agent as never, 'agent/request-error', {
      agent, turn: 1, step: 1, provider: 'mock',
      failure: { code: 'CITATION_INVALID', message: 'another provider' },
      retryPolicy: undefined, signal: new AbortController().signal,
    }, () => {
      delegated += 1
      return Promise.resolve(undefined)
    })).resolves.toBeUndefined()
    expect(delegated).toBe(1)
  })

  test('does not claim a terminal failure without its exact protected request identity', async () => {
    const { agent, ctx } = await setup()
    await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'text-delta', index: 0, text: 'uncited' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    await ctx.waterfall(agent as never, 'agent/request-error', {
      agent, turn: 1, step: 1, provider: 'mock',
      failure: { code: 'CITATION_INVALID', message: 'retry' },
      retryPolicy: undefined, signal: new AbortController().signal,
    }, () => Promise.resolve(undefined))
    let delegated = 0
    await expect(ctx.waterfall(agent as never, 'agent/request-error', {
      agent, turn: 1, step: 1, provider: 'mock',
      failure: { code: 'CITATION_FAILED', message: 'terminal' },
      retryPolicy: undefined, signal: new AbortController().signal,
    }, () => {
      delegated += 1
      return Promise.resolve({ kind: 'retry' as const })
    })).resolves.toEqual({ kind: 'retry' })
    expect(delegated).toBe(1)
  })

  test('tracks concurrent retry phases by exact request identity instead of Agent', async () => {
    const { agent, authorize, ctx, resolve, session } = await setup()
    const identityA = Object.freeze({ request: 'a' })
    const identityB = Object.freeze({ request: 'b' })
    resolve.mockImplementation((request: GenerateOptions): XAgentCitationPolicyRequest => ({
      agent, authorize, session,
      identity: request.provider === 'a' ? identityA : identityB,
      begin: signal => ({
        identity: request.provider === 'a' ? identityA : identityB,
        signal: signal ?? new AbortController().signal,
        settle: () => {},
      }),
    }))
    const invalid = (provider: string) => collect(ctx.waterfall(ctx.llm, 'llm/stream', {
      ...options(), provider,
    }, () => source([
      { type: 'text-delta', index: 0, text: `invalid-${provider}` },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    const [draftA, draftB] = await Promise.all([invalid('a'), invalid('b')])
    const failureA = draftA[0]?.type === 'finish' && draftA[0].reason.kind === 'error'
      ? draftA[0].reason.failure : undefined
    const failureB = draftB[0]?.type === 'finish' && draftB[0].reason.kind === 'error'
      ? draftB[0].reason.failure : undefined
    if (failureA === undefined || failureB === undefined) throw new Error('missing concurrent failures')
    const requestError = (failure: typeof failureA) => ctx.waterfall(agent as never, 'agent/request-error', {
      agent, turn: 1, step: 1, provider: 'mock', failure,
      retryPolicy: undefined, signal: new AbortController().signal,
    }, () => Promise.resolve(undefined))
    await expect(requestError(failureA)).resolves.toEqual({ kind: 'retry' })
    await expect(requestError(failureB)).resolves.toEqual({ kind: 'retry' })
  })

  test.each([
    ['unknown citation', '结论[资料2]', 'citation-unknown'],
    ['malformed citation', '结论[资料01]', 'citation-malformed'],
  ])('rejects %s without releasing any draft byte', async (_name, text, reason) => {
    const { ctx, session } = await setup()
    const chunks = await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'text-delta', index: 0, text },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    expect(chunks).toMatchObject([{ type: 'finish', reason: { kind: 'error' } }])
    expect(session.events.find(event => event.type === 'xagent/citation-correction'))
      .toMatchObject({ data: { reason } })
  })

  test.each([
    ['missing closing bracket', '事实一[资料1]；事实二[资料2'],
    ['missing opening bracket', '事实一[资料1]；事实二资料2]'],
    ['corner bracket alias', '事实一[资料1]；事实二【资料2】'],
    ['fullwidth bracket alias', '事实一[资料1]；事实二［资料2］'],
    ['unknown beside valid', '事实一[资料1]；事实二[资料2]'],
  ])('rejects %s even beside one valid citation', async (_name, text) => {
    const { authorize, ctx, session } = await setup()
    const chunks = await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'text-delta', index: 0, text },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    expect(chunks).toMatchObject([{ type: 'finish', reason: { kind: 'error' } }])
    expect(authorize).not.toHaveBeenCalled()
    expect(session.events.find(event => event.type === 'xagent/citation-correction')).toBeDefined()
  })

  test.each([
    ['inline code', '事实来自代码 `[资料1]`'],
    ['fenced code', '事实来自代码\n```text\n[资料1]\n```'],
    ['escaped literal', String.raw`事实来自字面量 \[资料1]`],
  ])('does not accept a citation appearing only in %s', async (_name, text) => {
    const { authorize, ctx, session } = await setup()
    await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'text-delta', index: 0, text },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    expect(authorize).not.toHaveBeenCalled()
    expect(session.events.find(event => event.type === 'xagent/citation-correction'))
      .toMatchObject({ data: { reason: 'citation-missing' } })
  })

  test.each([
    ['unterminated backtick fence', '事实来自代码\n```text\n[资料1]'],
    ['closed tilde fence', '事实来自代码\n~~~text\n[资料1]\n~~~'],
    ['unterminated tilde fence', '事实来自代码\n~~~text\n[资料1]'],
    ['indented code', '事实来自代码\n    [资料1]'],
    ['multi-backtick inline code', '事实来自代码 ``示例 `[资料1]` ``'],
  ])('masks %s through its Markdown extent', async (_name, text) => {
    const { authorize, ctx, session } = await setup()
    await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'text-delta', index: 0, text },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    expect(authorize).not.toHaveBeenCalled()
    expect(session.events.find(event => event.type === 'xagent/citation-correction'))
      .toMatchObject({ data: { reason: 'citation-missing' } })
  })

  test('treats escaped backtick delimiters as prose', async () => {
    const { authorize, ctx } = await setup()
    const chunks = await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'text-delta', index: 0, text: String.raw`结论 \`[资料1]\`` },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
    expect(authorize).toHaveBeenCalledOnce()
  })

  test('ignores citation literals in code when prose has one allowed citation', async () => {
    const { authorize, ctx } = await setup()
    const chunks = await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'text-delta', index: 0, text: '示例 `[资料2]`，结论[资料1]' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ citations: [citation] }))
  })

  test('hashes authoritative block-end replacements in first-seen block order', async () => {
    const { ctx, session } = await setup()
    await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'text-delta', index: 5, text: 'delta-five' },
      { type: 'text-delta', index: 1, text: 'delta-one' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'final-one' } },
      { type: 'block-end', index: 5, block: { type: 'text', text: 'final-five' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    const correction = session.events.find(event => event.type === 'xagent/citation-correction')
    expect(correction).toMatchObject({ data: { invalidDraft: 'final-five\nfinal-one' } })
    if (correction?.type !== 'xagent/citation-correction') throw new Error('missing correction')
    expect(correction.data.draftSha256)
      .toBe(createHash('sha256').update('final-five\nfinal-one').digest('hex'))
  })

  test.each([
    ['reasoning only', [
      { type: 'reasoning-delta' as const, index: 0, text: '分析[资料1]' },
      { type: 'finish' as const, reason: { kind: 'stop' as const } },
    ]],
    ['reasoning and tool', [
      { type: 'reasoning-delta' as const, index: 0, text: '分析[资料1]' },
      { type: 'tool-call-delta' as const, index: 1, id: CallId('follow-up'), name: 'search_artifacts', argumentsDelta: '{}' },
      { type: 'finish' as const, reason: { kind: 'tool-calls' as const } },
    ]],
    ['reasoning with unknown reference', [
      { type: 'reasoning-delta' as const, index: 0, text: '分析[资料2]' },
      { type: 'text-delta' as const, index: 1, text: '结论[资料1]' },
      { type: 'finish' as const, reason: { kind: 'stop' as const } },
    ]],
  ])('suppresses %s without entering citation authorization', async (_name, chunks) => {
    const { authorize, ctx } = await setup()
    authorize.mockRejectedValue(new Error('revoked'))
    const released = await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source(chunks)))
    expect(released).toMatchObject([{ type: 'finish', reason: { kind: 'error' } }])
    expect(released.some(chunk => chunk.type === 'reasoning-delta' || chunk.type === 'text-delta'
      || chunk.type === 'tool-call-delta')).toBe(false)
    expect(authorize).not.toHaveBeenCalled()
  })

  test('bounds a 65-citation evidence set before persisting or prompting', async () => {
    const { ctx, session } = await setup()
    const messages = Array.from({ length: 65 }, (_, index) => evidenceMessage(`[资料${String(index + 1)}]`, index + 1))
    for (const [index, message] of messages.entries()) {
      session.append('tool/result', {
        turn: 1, step: index + 2, message,
        meta: { kind: 'xagent-retrieval', payloadHash: 'b'.repeat(64), citations: [`[资料${String(index + 1)}]`] },
      }, { surfaceOp: 'append' })
    }
    await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(messages), () => source([
      { type: 'text-delta', index: 0, text: '结论[资料1]' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    const correction = session.events.find(event => event.type === 'xagent/citation-correction')
    if (correction?.type !== 'xagent/citation-correction') throw new Error('missing correction')
    expect(correction.data.allowedIds).toHaveLength(64)
    const correctionMessage = session.events.findLast(event => event.type === 'user/message')
    expect(JSON.stringify(correctionMessage)).not.toContain('[资料65]')
  })

  test('fails closed on revocation immediately before release', async () => {
    const { authorize, ctx } = await setup()
    authorize.mockRejectedValue(new Error('revoked'))
    const chunks = await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'text-delta', index: 0, text: '结论[资料1]' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    expect(chunks).toMatchObject([{ type: 'finish', reason: { kind: 'error' } }])
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(false)
  })

  test('clears buffered bytes on cancellation and never authorizes or releases them', async () => {
    const { authorize, ctx } = await setup()
    const controller = new AbortController()
    const request = { ...options(), signal: controller.signal }
    async function* cancelled(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'secret[资料1]' }
      controller.abort()
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }
    }
    const chunks = await collect(ctx.waterfall(ctx.llm, 'llm/stream', request, cancelled))
    expect(chunks).toEqual([])
    expect(authorize).not.toHaveBeenCalled()
  })

  test('bounds complete output and retained correction draft by UTF-8 bytes', async () => {
    const { ctx, session } = await setup()
    const oversized = '资'.repeat(Math.ceil(CITATION_ANSWER_MAX_BYTES / 3) + 1)
    await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'text-delta', index: 0, text: oversized },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    const correction = session.events.find(event => event.type === 'xagent/citation-correction')
    if (correction?.type !== 'xagent/citation-correction') throw new Error('missing correction')
    expect(Buffer.byteLength(correction.data.invalidDraft)).toBeLessThanOrEqual(CITATION_CORRECTION_DRAFT_MAX_BYTES)
    const bounded = '资'.repeat(Math.floor(CITATION_ANSWER_MAX_BYTES / 3))
    expect(correction.data.invalidDraft).toBe(bounded.slice(0, Math.floor(CITATION_CORRECTION_DRAFT_MAX_BYTES / 3)))
    expect(correction.data.draftSha256).toBe(createHash('sha256').update(bounded).digest('hex'))
    expect(correction.data.reason).toBe('answer-too-large')
  })

  test('stops pulling at the first hard stream cap without creating filesystem residue', async () => {
    const { ctx, session } = await setup()
    const existing = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('xagent-citation-')))
    let pulled = 0
    let finalized = false
    async function* adversarial(): AsyncIterable<StreamChunk> {
      try {
        for (let index = 0; index < 4100; index += 1) {
          pulled += 1
          yield { type: 'block-start', index, blockType: 'text' }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        finalized = true
      }
    }
    await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), adversarial))
    expect(pulled).toBe(257)
    expect(finalized).toBe(true)
    expect(new Set(readdirSync(tmpdir()).filter(name => name.startsWith('xagent-citation-')))).toEqual(existing)
    expect(session.events.find(event => event.type === 'xagent/citation-correction'))
      .toMatchObject({ data: { reason: 'answer-too-large' } })
  })

  test('hashes recognized canonical text after an unknown chunk until the termination boundary', async () => {
    const { ctx, session } = await setup()
    await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'future-chunk' } as unknown as StreamChunk,
      { type: 'text-delta', index: 3, text: 'later recognized text' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    const correction = session.events.find(event => event.type === 'xagent/citation-correction')
    expect(correction).toMatchObject({ data: { invalidDraft: 'later recognized text' } })
    if (correction?.type !== 'xagent/citation-correction') throw new Error('missing correction')
    expect(correction.data.draftSha256)
      .toBe(createHash('sha256').update('later recognized text').digest('hex'))
  })

  test('ignores evidence from a different Session and fails closed on unknown stream chunks', async () => {
    const { authorize, ctx } = await setup()
    const ordinary = { ...options([evidenceMessage()]), sessionId: OTHER_SESSION }
    await collect(ctx.waterfall(ctx.llm, 'llm/stream', ordinary, () => source([
      { type: 'text-delta', index: 0, text: 'ordinary' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    expect(authorize).not.toHaveBeenCalled()

    const chunks = await collect(ctx.waterfall(ctx.llm, 'llm/stream', options(), () => source([
      { type: 'future-chunk' } as unknown as StreamChunk,
    ])))
    expect(chunks).toMatchObject([{ type: 'finish', reason: { kind: 'error' } }])
  })
})
