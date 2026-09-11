import { CallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { expect, test } from 'vitest'
import { replaceCompletedInstructions } from '../src/turn-binding.ts'

test('durable projection preserves failed, invalid, unrelated and out-of-turn instructions and is idempotent', () => {
  const session = Session.create(SessionId('projection'))
  session.append('turn/start', { turn: 1 })
  session.append('business-skill/activated', { slug: 'review', version: 1, turn: 1,
    invocation: 'model-tool', toolPolicyDigest: 'a'.repeat(64) }, { ignorable: true })
  const retained: number[] = []
  for (const [id, args] of [['invalid', '{'], ['null', 'null'], ['primitive', '1'], ['missing', '{}'], ['failed', '{"name":"review"}'], ['other', '{"name":"other"}']] as const) {
    session.append('tool/call', { turn: 1, step: 1, callId: CallId(id), name: 'skill', arguments: args })
    retained.push(session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: CallId(id), isError: true, content: [{ type: 'text', text: `${id} failure` }] }) }, { surfaceOp: 'append' }).seq)
  }
  session.append('tool/call', { turn: 1, step: 1, callId: CallId('loaded'), name: 'skill', arguments: '{"name":"review"}' })
  const original = session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: CallId('loaded'), isError: false, content: [{ type: 'text', text: 'First body' }] }) }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  retained.push(session.append('user/message', createUserMessage({ source: { kind: 'skill-invocation', name: 'review', form: 'instructions' },
    content: [{ type: 'text', text: 'Outside the ended turn' }] }), { surfaceOp: 'append' }).seq)
  session.append('turn/start', { turn: 2 })
  session.append('tool/call', { turn: 2, step: 1, callId: CallId('loaded'), name: 'skill', arguments: '{"name":"other"}' })
  replaceCompletedInstructions(session)
  expect(session.surface.nodes).not.toContain(original.seq)
  for (const seq of retained) expect(session.surface.nodes).toContain(seq)
  expect(JSON.stringify(session.deriveMessages())).toContain('Business Skill review v1 was used in turn 1.')
  expect(JSON.stringify(session.deriveMessages())).not.toContain('First body')
  const length = session.events.length
  replaceCompletedInstructions(session)
  expect(session.events).toHaveLength(length)
  expect(session.events[original.seq]).toEqual(original)
})
