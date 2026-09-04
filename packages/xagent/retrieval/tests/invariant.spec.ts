import { Context } from '@deepseek-ai/cordis'
import Invariants from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, test, vi } from 'vitest'
import * as invariant from '../src/invariant.ts'

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
})
