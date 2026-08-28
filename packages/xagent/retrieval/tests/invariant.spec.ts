import { Context } from '@deepseek-ai/cordis'
import Invariants from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, test, vi } from 'vitest'
import * as invariant from '../src/invariant.ts'

describe('xagent retrieval invariant', () => {
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
})
