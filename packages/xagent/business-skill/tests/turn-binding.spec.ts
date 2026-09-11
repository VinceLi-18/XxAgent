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
  session.append('tool/call', { turn: 1, step: 1, callId: CallId('proposal'), name: 'propose_fact', arguments: '{}' })
  retained.push(session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: CallId('proposal'), isError: false, content: [{ type: 'text', text: 'Unrelated successful tool result' }] }) }, { surfaceOp: 'append' }).seq)
  session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  retained.push(session.append('user/message', createUserMessage({ source: { kind: 'skill-invocation', name: 'review', form: 'instructions' },
    content: [{ type: 'text', text: 'Outside the ended turn' }] }), { surfaceOp: 'append' }).seq)
  session.append('turn/start', { turn: 2 })
  session.append('tool/call', { turn: 2, step: 1, callId: CallId('loaded'), name: 'skill', arguments: '{"name":"other"}' })
  retained.push(session.append('tool/result', { turn: 2, step: 1,
    message: createToolResultMessage({ callId: CallId('loaded'), isError: false, content: [{ type: 'text', text: 'Other turn body' }] }) }, { surfaceOp: 'append' }).seq)
  const replacement = session.append('tool/result', { ...original.data, message: { ...original.data.message,
    content: [{ ...original.data.message.content[0], content: [{ type: 'text', text: 'Pruned first body' }] }] } },
  { surfaceOp: { op: 'replace', start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq] })
  replaceCompletedInstructions(session)
  expect(session.surface.nodes).not.toContain(original.seq)
  expect(session.surface.nodes).not.toContain(replacement.seq)
  for (const seq of retained) expect(session.surface.nodes).toContain(seq)
  expect(JSON.stringify(session.deriveMessages())).toContain('Business Skill review v1 was used in turn 1.')
  expect(JSON.stringify(session.deriveMessages())).not.toContain('First body')
  const length = session.events.length
  replaceCompletedInstructions(session)
  expect(session.events).toHaveLength(length)
  expect(session.events[original.seq]).toEqual(original)
})

test('a checkpoint replacing a Skill message is not an admitted instruction surface', () => {
  const session = Session.create(SessionId('checkpoint'))
  session.append('turn/start', { turn: 1 })
  session.append('business-skill/activated', { slug: 'review', version: 1, turn: 1,
    invocation: 'user-explicit', toolPolicyDigest: 'a'.repeat(64) }, { ignorable: true })
  const original = session.append('user/message', createUserMessage({ source: { kind: 'skill-invocation', name: 'review', form: 'instructions' },
    content: [{ type: 'text', text: 'First body' }] }), { surfaceOp: 'append' })
  const checkpoint = session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Keep this unrelated checkpoint.' }] }),
  { surfaceOp: { op: 'replace', start: original.seq, end: original.seq }, sourceEventSeqs: [original.seq] })
  session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  replaceCompletedInstructions(session)
  expect(session.surface.nodes).toContain(checkpoint.seq)
  expect(JSON.stringify(session.deriveMessages())).toContain('Keep this unrelated checkpoint.')
})
