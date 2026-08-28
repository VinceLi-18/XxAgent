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
})
