import { describe, expect, test } from 'vitest'
import { XAgentReceiptRegistry } from '../src/receipt-registry.ts'

const SESSION = 'session-00000000-0000-0000-0000-000000000701'

describe('XAgentReceiptRegistry', () => {
  test('binds one receipt to its matching tool result and retains it until confirmed append', () => {
    const registry = new XAgentReceiptRegistry()
    registry.register({ sessionId: SESSION, toolCallId: 'call-1', receipt: 'opaque-secret', payloadHash: 'a'.repeat(64) })
    registry.publish(SESSION, 'call-1', 'a'.repeat(64))
    registry.bindEvent(SESSION, 'call-1', 7)

    expect(registry.attachments(SESSION, 7, 7)).toEqual([{
      eventSequence: 7,
      toolCallId: 'call-1',
      receipt: 'opaque-secret',
      payloadHash: 'a'.repeat(64),
    }])
    expect(registry.attachments(SESSION, 7, 7)).toHaveLength(1)
    registry.commit(SESSION, 6)
    expect(registry.attachments(SESSION, 7, 7)).toHaveLength(1)
    registry.commit(SESSION, 7)
    expect(registry.attachments(SESSION, 7, 7)).toEqual([])
  })

  test('rejects cross-session, cross-call, duplicate, conflicting, and re-bound identities', () => {
    const registry = new XAgentReceiptRegistry()
    registry.register({ sessionId: SESSION, toolCallId: 'call-1', receipt: 'opaque-1', payloadHash: 'a'.repeat(64) })
    expect(() => { registry.register({ sessionId: SESSION, toolCallId: 'call-1', receipt: 'opaque-1', payloadHash: 'a'.repeat(64) }) }).toThrow()
    expect(() => { registry.publish('session-other', 'call-1', 'a'.repeat(64)) }).toThrow()
    registry.publish(SESSION, 'call-1', 'a'.repeat(64))
    expect(() => { registry.bindEvent('session-other', 'call-1', 1) }).toThrow()
    expect(() => { registry.bindEvent(SESSION, 'call-2', 1) }).toThrow()
    expect(() => { registry.bindEvent(SESSION, 'call-1', 1, 'b'.repeat(64)) }).toThrow()
    registry.bindEvent(SESSION, 'call-1', 1, 'a'.repeat(64))
    expect(() => { registry.bindEvent(SESSION, 'call-1', 2) }).toThrow()
  })

  test('closes registration and discards every operation whose publication continuation ended', async () => {
    const registry = new XAgentReceiptRegistry()
    registry.register({ sessionId: SESSION, toolCallId: 'call-1', receipt: 'opaque-secret', payloadHash: 'a'.repeat(64) })
    registry.register({ sessionId: SESSION, toolCallId: 'call-2', receipt: 'unpublished-secret', payloadHash: 'b'.repeat(64) })
    registry.publish(SESSION, 'call-1', 'a'.repeat(64))
    const disposing = registry.dispose()
    expect(() => { registry.register({ sessionId: SESSION, toolCallId: 'call-2', receipt: 'later', payloadHash: 'b'.repeat(64) }) }).toThrow()
    await disposing
    expect(registry.discard(SESSION, 'call-2')).toBe(false)
    expect(() => { registry.bindEvent(SESSION, 'call-1', 1, 'a'.repeat(64)) }).toThrow()
    expect(registry.attachments(SESSION, 1, 1)).toEqual([])
  })

  test('confirms non-publication and contains repeated or reentrant settlement', async () => {
    const registry = new XAgentReceiptRegistry()
    registry.register({ sessionId: SESSION, toolCallId: 'call-1', receipt: 'opaque-secret', payloadHash: 'a'.repeat(64) })
    expect(registry.discard(SESSION, 'call-1')).toBe(true)
    expect(registry.discard(SESSION, 'call-1')).toBe(false)
    await Promise.all([registry.dispose(), registry.dispose()])
  })

  test('discards only one Session non-bound operations and retains durable bindings', async () => {
    const registry = new XAgentReceiptRegistry()
    registry.register({ sessionId: SESSION, toolCallId: 'bound', receipt: 'bound', payloadHash: 'a'.repeat(64) })
    registry.publish(SESSION, 'bound', 'a'.repeat(64))
    registry.bindEvent(SESSION, 'bound', 7)
    registry.register({ sessionId: SESSION, toolCallId: 'published', receipt: 'published', payloadHash: 'b'.repeat(64) })
    registry.publish(SESSION, 'published', 'b'.repeat(64))
    registry.register({ sessionId: SESSION, toolCallId: 'registered', receipt: 'registered', payloadHash: 'c'.repeat(64) })
    registry.register({ sessionId: 'session-other', toolCallId: 'other', receipt: 'other', payloadHash: 'd'.repeat(64) })

    registry.discardSession(SESSION)

    expect(registry.attachments(SESSION, 0, 10)).toHaveLength(1)
    expect(registry.discard(SESSION, 'bound')).toBe(false)
    expect(registry.discard(SESSION, 'published')).toBe(false)
    expect(registry.discard(SESSION, 'registered')).toBe(false)
    expect(registry.discard('session-other', 'other')).toBe(true)
    await registry.dispose()
    expect(registry.attachments(SESSION, 0, 10)).toHaveLength(1)
  })

  test('validates event windows and returns sorted owned attachments only', () => {
    const registry = new XAgentReceiptRegistry()
    expect(() => { registry.bindEvent(SESSION, 'missing', -1) }).toThrow('event binding rejected')
    expect(() => { registry.bindEvent(SESSION, 'missing', 1.5) }).toThrow('event binding rejected')
    expect(registry.attachments(SESSION, 2, 1)).toEqual([])
    expect(registry.attachments(SESSION, 1.5, 2)).toEqual([])
    expect(registry.attachments(SESSION, 1, 2.5)).toEqual([])
    registry.commit(SESSION, 1.5)

    for (const [toolCallId, sequence] of [['later', 9], ['earlier', 7]] as const) {
      registry.register({ sessionId: SESSION, toolCallId, receipt: toolCallId, payloadHash: 'a'.repeat(64) })
      registry.publish(SESSION, toolCallId, 'a'.repeat(64))
      registry.bindEvent(SESSION, toolCallId, sequence)
    }
    registry.register({ sessionId: SESSION, toolCallId: 'unbound', receipt: 'unbound', payloadHash: 'a'.repeat(64) })
    registry.register({ sessionId: 'session-other', toolCallId: 'other', receipt: 'other', payloadHash: 'a'.repeat(64) })
    registry.publish('session-other', 'other', 'a'.repeat(64))
    registry.bindEvent('session-other', 'other', 8)

    expect(registry.attachments(SESSION, 8, 8)).toEqual([])
    expect(registry.attachments(SESSION, 0, 10).map(value => value.eventSequence)).toEqual([7, 9])
  })
})
