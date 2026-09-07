import { Context } from '@deepseek-ai/cordis'
import Invariants from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, test, vi } from 'vitest'
import * as invariant from '../src/invariant.ts'

async function appendMeta(meta: unknown, rejected: boolean): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Invariants)
  await ctx.plugin(invariant)
  const session = ctx.sessions.create(SessionId(`session-invariant-${crypto.randomUUID()}`))
  session.append('turn/start', { turn: 0 })
  session.append('step/start', { turn: 0, step: 0 })
  const call = session.append('tool/call', {
    turn: 0, step: 0, callId: 'call-1' as never, name: 'search_artifacts', arguments: '{}',
  })
  const action = () => session.append('tool/result', {
    turn: 0,
    step: 0,
    message: {
      id: 'm' as never,
      role: 'user',
      source: { kind: 'tool', callId: 'call-1' as never },
      content: [{
        type: 'tool-result', toolCallId: 'call-1' as never, isError: false,
        content: [{ type: 'text', text: 'ok' }],
      }],
    },
    meta: meta as never,
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  if (rejected) expect(action).toThrow()
  else expect(action).not.toThrow()
  await ctx.fiber.dispose()
}

describe('xagent retrieval invariant', () => {
  test('accepts exact live and server-canonical retrieval metadata', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(Invariants)
    await ctx.plugin(invariant)
    const session = ctx.sessions.create(SessionId('session-retrieval-metadata-forms'))
    session.append('turn/start', { turn: 0 })
    session.append('step/start', { turn: 0, step: 0 })
    const firstCall = session.append('tool/call', {
      turn: 0, step: 0, callId: 'call-live' as never, name: 'search_artifacts', arguments: '{}',
    })
    expect(() => session.append('tool/result', {
      turn: 0, step: 0,
      message: {
        id: 'live' as never,
        role: 'user',
        source: { kind: 'tool', callId: 'call-live' as never },
        content: [{ type: 'tool-result', toolCallId: 'call-live' as never, isError: false, content: [{ type: 'text', text: 'ok' }] }],
      },
      meta: { kind: 'xagent-retrieval', payloadHash: 'a'.repeat(64), citations: ['[资料1]'] },
    }, { surfaceOp: 'append', sourceEventSeqs: [firstCall.seq] })).not.toThrow()
    const secondCall = session.append('tool/call', {
      turn: 0, step: 1, callId: 'call-canonical' as never, name: 'search_artifacts', arguments: '{}',
    })
    expect(() => session.append('tool/result', {
      turn: 0, step: 1,
      message: {
        id: 'canonical' as never,
        role: 'user',
        source: { kind: 'tool', callId: 'call-canonical' as never },
        content: [{ type: 'tool-result', toolCallId: 'call-canonical' as never, isError: false, content: [{ type: 'text', text: 'ok' }] }],
      },
      meta: {
        kind: 'xagent-retrieval', tool: 'artifact_search', payloadHash: 'b'.repeat(64),
        scopeHash: 'c'.repeat(64), queryHash: 'd'.repeat(64), citations: ['[资料2]'],
        evidence: [{
          citationId: '[资料2]',
          artifactId: '00000000-0000-0000-0000-000000000501',
          versionId: '00000000-0000-0000-0000-000000000601',
          chunkId: '00000000-0000-0000-0000-000000000701',
          indexId: '00000000-0000-0000-0000-000000000801',
          generation: 1,
        }],
      },
    }, { surfaceOp: 'append', sourceEventSeqs: [secondCall.seq] })).not.toThrow()
  })

  test('rejects a retrieval result whose private metadata leaks an opaque receipt', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(Invariants)
    await ctx.plugin(invariant)
    const session = ctx.sessions.create(SessionId('session-invariant'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    session.append('turn/start', { turn: 0 })
    session.append('step/start', { turn: 0, step: 0 })
    const call = session.append('tool/call', { turn: 0, step: 0, callId: 'call-1' as never, name: 'search_artifacts', arguments: '{}' })
    expect(() => session.append('tool/result', {
      turn: 0, step: 0,
      message: {
        id: 'm' as never,
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' as never },
        content: [{ type: 'tool-result', toolCallId: 'call-1' as never, isError: false, content: [{ type: 'text', text: 'ok' }] }],
      },
      meta: { kind: 'xagent-retrieval', payloadHash: 'a'.repeat(64), citations: [], receipt: 'secret' },
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })).toThrow()
    warn.mockRestore()
  })

  test('rejects cited-answer metadata whose citation ids disagree with its canonical blocks', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(Invariants)
    await ctx.plugin(invariant)
    const session = ctx.sessions.create(SessionId('session-cited-answer-invariant'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    session.append('turn/start', { turn: 0 })
    session.append('step/start', { turn: 0, step: 0 })
    const call = session.append('tool/call', { turn: 0, step: 0, callId: 'call-1' as never, name: 'submit_cited_answer', arguments: '{}' })
    expect(() => session.append('tool/result', {
      turn: 0, step: 0,
      message: {
        id: 'm' as never,
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' as never },
        content: [{ type: 'tool-result', toolCallId: 'call-1' as never, isError: false, content: [{ type: 'text', text: 'answer' }] }],
      },
      meta: {
        kind: 'xagent-cited-answer',
        schemaVersion: 1,
        blocks: [{ type: 'markdown', text: 'answer' }, { type: 'citation', id: '[资料1]' }],
        citationIds: ['[资料2]'],
      },
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })).toThrow()
    warn.mockRestore()
  })

  test('rejects cited-answer metadata with an unbounded citation ordinal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(Invariants)
    await ctx.plugin(invariant)
    const session = ctx.sessions.create(SessionId('session-cited-answer-id-invariant'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    session.append('turn/start', { turn: 0 })
    session.append('step/start', { turn: 0, step: 0 })
    const call = session.append('tool/call', { turn: 0, step: 0, callId: 'call-1' as never, name: 'submit_cited_answer', arguments: '{}' })
    const citationId = '[资料999999999999999999999999999999]'
    expect(() => session.append('tool/result', {
      turn: 0, step: 0,
      message: {
        id: 'm' as never,
        role: 'user',
        source: { kind: 'tool', callId: 'call-1' as never },
        content: [{ type: 'tool-result', toolCallId: 'call-1' as never, isError: false, content: [{ type: 'text', text: 'answer' }] }],
      },
      meta: {
        kind: 'xagent-cited-answer',
        schemaVersion: 1,
        blocks: [{ type: 'markdown', text: 'answer' }, { type: 'citation', id: citationId }],
        citationIds: [citationId],
      },
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })).toThrow()
    warn.mockRestore()
  })

  test('rejects malformed retrieval metadata fields and canonical evidence', async () => {
    const evidence = {
      citationId: '[资料1]',
      artifactId: '00000000-0000-0000-0000-000000000501',
      versionId: '00000000-0000-0000-0000-000000000601',
      chunkId: '00000000-0000-0000-0000-000000000701',
      indexId: '00000000-0000-0000-0000-000000000801',
      generation: 1,
    }
    await appendMeta({ kind: 'xagent-retrieval', payloadHash: 'bad', citations: [] }, true)
    await appendMeta({ kind: 'xagent-retrieval', payloadHash: 'a'.repeat(64), citations: [1] }, true)
    await appendMeta({
      kind: 'xagent-retrieval', tool: 'project_discovery', payloadHash: 'a'.repeat(64),
      scopeHash: 'b'.repeat(64), queryHash: 'c'.repeat(64), citations: ['[资料1]'], evidence: [evidence],
    }, true)
    await appendMeta({
      kind: 'xagent-retrieval', tool: 'artifact_search', payloadHash: 'a'.repeat(64),
      scopeHash: 'b'.repeat(64), queryHash: 'c'.repeat(64), citations: ['[资料1]'], evidence: [null],
    }, true)
  })

  test('ignores unrelated metadata and rejects noncanonical cited-answer projections', async () => {
    await appendMeta([], false)
    await appendMeta({ kind: 'unrelated' }, false)
    await appendMeta({
      kind: 'xagent-cited-answer',
      schemaVersion: 1,
      blocks: [{ type: 'markdown', text: 'answer' }, { type: 'citation', id: '[资料1]' }],
      citationIds: ['[资料1]'],
    }, false)
    await appendMeta({
      kind: 'xagent-cited-answer',
      schemaVersion: 1,
      blocks: [
        { type: 'markdown', text: 'answer' },
        { type: 'citation', id: '[资料1]' },
        { type: 'citation', id: '[资料1]' },
      ],
      citationIds: ['[资料1]'],
    }, true)
    await appendMeta({
      kind: 'xagent-cited-answer',
      schemaVersion: 1,
      blocks: [
        { type: 'markdown', text: 'answer' },
        { type: 'citation', id: '[资料1]' },
        { type: 'markdown', text: 'more' },
        { type: 'citation', id: '[资料2]' },
      ],
      citationIds: ['[资料2]', '[资料1]'],
    }, true)
  })

  test('validates Session events that predate invariant registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('session-preexisting-retrieval-meta'))
    session.append('turn/start', { turn: 0 })
    session.append('step/start', { turn: 0, step: 0 })
    const call = session.append('tool/call', {
      turn: 0, step: 0, callId: 'call-preexisting' as never, name: 'search_artifacts', arguments: '{}',
    })
    session.append('tool/result', {
      turn: 0,
      step: 0,
      message: {
        id: 'm-preexisting' as never,
        role: 'user',
        source: { kind: 'tool', callId: 'call-preexisting' as never },
        content: [{
          type: 'tool-result', toolCallId: 'call-preexisting' as never, isError: false,
          content: [{ type: 'text', text: 'ok' }],
        }],
      },
      meta: { kind: 'xagent-retrieval', payloadHash: 'a'.repeat(64), citations: [] },
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    await ctx.plugin(Invariants)
    await expect(ctx.plugin(invariant)).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
