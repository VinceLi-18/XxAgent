import { describe, expect, test } from 'vitest'
import { Session, SessionId, type SessionEvent } from '../src/index.ts'

describe('ignorable event admission', () => {
  test('preserves an explicit envelope marker through append and replay', () => {
    const session = Session.create(SessionId('ignorable'))
    const event = session.append('turn/start', { turn: 1 }, { ignorable: true })
    expect(event).toMatchObject({ type: 'turn/start', ignorable: true, data: { turn: 1 } })
    const replay = Session.create(session.id, JSON.parse(JSON.stringify(session.events)) as SessionEvent[], session.header)
    expect(replay.events[0]).toMatchObject({ ignorable: true })
    expect(session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })).not.toHaveProperty('ignorable')
  })
})
