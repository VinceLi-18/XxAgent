import { describe, expect, test } from 'vitest'
import {
  XAgentFactOutboxRegistry,
  XAgentFactReceiptRegistry,
  validateFactRegistryRelationships,
} from '../src/receipt-registry.ts'

const SESSION = 'session-00000000-0000-0000-0000-000000000701'
const OTHER_SESSION = 'session-00000000-0000-0000-0000-000000000702'
const PROPOSAL = '00000000-0000-0000-0000-000000000801'

function registerReceipt(
  registry: XAgentFactReceiptRegistry,
  toolCallId: string,
  eventSequence: number,
  receipt = `receipt-${toolCallId}`,
): void {
  registry.register({
    sessionId: SESSION,
    toolCallId,
    proposalId: PROPOSAL,
    receipt,
    payloadHash: 'a'.repeat(64),
  })
  registry.bindEvent(SESSION, toolCallId, PROPOSAL, eventSequence)
}

describe('XAgent Fact private registries', () => {
  test('receipt attachments stay ordered and commit only through the acknowledged sequence', () => {
    const registry = new XAgentFactReceiptRegistry()
    registerReceipt(registry, 'later', 9)
    registerReceipt(registry, 'earlier', 7)
    registry.register({
      sessionId: OTHER_SESSION,
      toolCallId: 'other',
      proposalId: PROPOSAL,
      receipt: 'other-receipt',
      payloadHash: 'b'.repeat(64),
    })
    registry.bindEvent(OTHER_SESSION, 'other', PROPOSAL, 8)

    expect(registry.attachments(SESSION, 0, 10).map(value => value.eventSequence)).toEqual([7, 9])
    expect(registry.attachments(SESSION, 8, 8)).toEqual([])
    registry.commit(SESSION, 7)
    expect(registry.attachments(SESSION, 0, 10).map(value => value.eventSequence)).toEqual([9])
    expect(registry.attachments(OTHER_SESSION, 0, 10)).toHaveLength(1)
    registry.commit(SESSION, 8)
    expect(registry.attachments(SESSION, 0, 10)).toHaveLength(1)
    registry.commit(SESSION, 9)
    expect(registry.attachments(SESSION, 0, 10)).toEqual([])
  })

  test('an exact preparation replay replaces only the current unbound receipt', () => {
    const registry = new XAgentFactReceiptRegistry()
    registry.register({
      sessionId: SESSION,
      toolCallId: 'call-1',
      proposalId: PROPOSAL,
      receipt: 'first-receipt',
      payloadHash: 'a'.repeat(64),
    })
    registry.register({
      sessionId: SESSION,
      toolCallId: 'call-1',
      proposalId: PROPOSAL,
      receipt: 'rotated-receipt',
      payloadHash: 'a'.repeat(64),
    })
    registry.bindEvent(SESSION, 'call-1', PROPOSAL, 4)

    expect(registry.attachments(SESSION, 4, 4)).toEqual([{
      eventSequence: 4,
      toolCallId: 'call-1',
      proposalId: PROPOSAL,
      receipt: 'rotated-receipt',
      payloadHash: 'a'.repeat(64),
    }])
    expect(() => {
      registry.register({
        sessionId: SESSION,
        toolCallId: 'call-1',
        proposalId: PROPOSAL,
        receipt: 'too-late',
        payloadHash: 'a'.repeat(64),
      })
    }).toThrow('already bound')
  })

  test('identity conflicts, invalid windows, and failed append retries never mutate receipt state', () => {
    const registry = new XAgentFactReceiptRegistry()
    registerReceipt(registry, 'call-1', 5)
    const before = registry.attachments(SESSION, 0, 10)

    expect(() => { registry.bindEvent(SESSION, 'call-1', PROPOSAL, 6) }).toThrow()
    expect(() => {
      registry.register({
        sessionId: SESSION,
        toolCallId: 'call-1',
        proposalId: '00000000-0000-0000-0000-000000000899',
        receipt: 'conflict',
        payloadHash: 'a'.repeat(64),
      })
    }).toThrow()
    expect(registry.attachments(SESSION, 2, 1)).toEqual([])
    expect(registry.attachments(SESSION, 1.5, 2)).toEqual([])
    registry.commit(SESSION, 4.5)
    expect(registry.attachments(SESSION, 0, 10)).toEqual(before)
    expect(registry.attachments(SESSION, 0, 10)).toEqual(before)
  })

  test('receipt admission and binding reject every malformed or conflicting identity', () => {
    const valid = {
      sessionId: SESSION,
      toolCallId: 'call-1',
      proposalId: PROPOSAL,
      receipt: 'receipt_1',
      payloadHash: 'a'.repeat(64),
    }
    for (const candidate of [
      { ...valid, sessionId: '' },
      { ...valid, toolCallId: '' },
      { ...valid, proposalId: 'not-a-uuid' },
      { ...valid, receipt: 'a'.repeat(1_025) },
      { ...valid, receipt: 'contains space' },
      { ...valid, payloadHash: 'not-a-hash' },
    ]) {
      expect(() => { new XAgentFactReceiptRegistry().register(candidate) }).toThrow('registration rejected')
    }

    const registry = new XAgentFactReceiptRegistry()
    registry.register(valid)
    expect(() => { registry.bindEvent(SESSION, 'call-1', PROPOSAL, -1) }).toThrow('event binding rejected')
    expect(() => { registry.bindEvent(SESSION, 'call-1', PROPOSAL, 1.5) }).toThrow('event binding rejected')
    expect(() => { registry.bindEvent(SESSION, 'missing', PROPOSAL, 1) }).toThrow('identity mismatch')
    expect(() => {
      registry.bindEvent(SESSION, 'call-1', '00000000-0000-0000-0000-000000000899', 1)
    }).toThrow('identity mismatch')
    expect(() => {
      registry.register({ ...valid, proposalId: '00000000-0000-0000-0000-000000000899' })
    }).toThrow('replacement identity mismatch')
    expect(() => { registry.register({ ...valid, payloadHash: 'b'.repeat(64) }) })
      .toThrow('replacement identity mismatch')

    registry.register({ ...valid, toolCallId: 'call-2', receipt: 'receipt_2' })
    registry.bindEvent(SESSION, 'call-1', PROPOSAL, 1)
    expect(() => { registry.bindEvent(SESSION, 'call-1', PROPOSAL, 2) }).toThrow('identity mismatch')
    expect(() => { registry.bindEvent(SESSION, 'call-2', PROPOSAL, 1) }).toThrow('sequence already bound')
  })

  test('receipt discard and Session cleanup retain only authoritative bound entries', () => {
    const registry = new XAgentFactReceiptRegistry()
    registry.register({
      sessionId: SESSION,
      toolCallId: 'unbound',
      proposalId: PROPOSAL,
      receipt: 'receipt-unbound',
      payloadHash: 'a'.repeat(64),
    })
    registerReceipt(registry, 'bound', 3)
    registry.register({
      sessionId: OTHER_SESSION,
      toolCallId: 'other',
      proposalId: PROPOSAL,
      receipt: 'receipt-other',
      payloadHash: 'b'.repeat(64),
    })

    expect(registry.discard(SESSION, 'missing')).toBe(false)
    expect(registry.discard(SESSION, 'bound')).toBe(false)
    expect(registry.discard(SESSION, 'unbound')).toBe(true)
    registry.discardSession(SESSION)
    expect(registry.attachments(SESSION, 0, 10)).toHaveLength(1)
    registry.discardSession(OTHER_SESSION)
    expect(registry.discard(OTHER_SESSION, 'other')).toBe(false)
    registry.commit(SESSION, -1)
    expect(registry.attachments(SESSION, 0, 10)).toHaveLength(1)
  })

  test('Outbox attachments deduplicate exact replay and remain separate from proposal receipts', () => {
    const receipts = new XAgentFactReceiptRegistry()
    const outbox = new XAgentFactOutboxRegistry()
    expect(outbox.register({
      sessionId: SESSION,
      eventSequence: 12,
      outboxId: '00000000-0000-0000-0000-000000000901',
      payloadHash: 'b'.repeat(64),
    })).toBe(true)
    expect(outbox.register({
      sessionId: SESSION,
      eventSequence: 12,
      outboxId: '00000000-0000-0000-0000-000000000901',
      payloadHash: 'b'.repeat(64),
    })).toBe(false)
    expect(outbox.attachments(SESSION, 12, 12)).toEqual([{
      eventSequence: 12,
      outboxId: '00000000-0000-0000-0000-000000000901',
      payloadHash: 'b'.repeat(64),
    }])
    expect(receipts.attachments(SESSION, 0, 20)).toEqual([])
    expect(validateFactRegistryRelationships(receipts, outbox)).toBeUndefined()
    outbox.commit(SESSION, 11)
    expect(outbox.attachments(SESSION, 12, 12)).toHaveLength(1)
    outbox.commit(SESSION, 12)
    expect(outbox.attachments(SESSION, 12, 12)).toEqual([])
  })

  test('Outbox conflicts and an append rollback retain the original sidecar', () => {
    const registry = new XAgentFactOutboxRegistry()
    registry.register({
      sessionId: SESSION,
      eventSequence: 3,
      outboxId: '00000000-0000-0000-0000-000000000901',
      payloadHash: 'c'.repeat(64),
    })
    expect(() => {
      registry.register({
        sessionId: SESSION,
        eventSequence: 4,
        outboxId: '00000000-0000-0000-0000-000000000901',
        payloadHash: 'c'.repeat(64),
      })
    }).toThrow()
    expect(() => {
      registry.register({
        sessionId: SESSION,
        eventSequence: 3,
        outboxId: '00000000-0000-0000-0000-000000000902',
        payloadHash: 'd'.repeat(64),
      })
    }).toThrow()
    expect(registry.attachments(SESSION, 0, 10)).toHaveLength(1)
    expect(registry.discard(SESSION, '00000000-0000-0000-0000-000000000901', 4)).toBe(false)
    expect(registry.discard(SESSION, '00000000-0000-0000-0000-000000000901', 3)).toBe(true)
    expect(registry.attachments(SESSION, 0, 10)).toEqual([])
  })

  test('Outbox validates all identity fields, ranges, and exact replay fields', () => {
    const valid = {
      sessionId: SESSION,
      eventSequence: 3,
      outboxId: '00000000-0000-0000-0000-000000000901',
      payloadHash: 'c'.repeat(64),
    }
    for (const candidate of [
      { ...valid, sessionId: '' },
      { ...valid, eventSequence: -1 },
      { ...valid, eventSequence: 1.5 },
      { ...valid, outboxId: 'not-a-uuid' },
      { ...valid, payloadHash: 'not-a-hash' },
    ]) {
      expect(() => { new XAgentFactOutboxRegistry().register(candidate) }).toThrow('registration rejected')
    }

    const registry = new XAgentFactOutboxRegistry()
    registry.register(valid)
    expect(registry.has(SESSION, valid.outboxId)).toBe(true)
    expect(registry.has(SESSION, '00000000-0000-0000-0000-000000000999')).toBe(false)
    expect(() => { registry.register({ ...valid, payloadHash: 'd'.repeat(64) }) }).toThrow('replay identity mismatch')
    expect(registry.attachments(SESSION, 4, 3)).toEqual([])
    expect(registry.attachments(SESSION, 0, 1.5)).toEqual([])
    registry.commit(SESSION, 1.5)
    expect(registry.attachments(SESSION, 0, 10)).toHaveLength(1)
  })

  test('relationship checks reject corrupt key and event-sequence ownership', () => {
    type ReceiptRows = Map<string, {
      sessionId: string
      toolCallId: string
      proposalId: string
      receipt: string
      payloadHash: string
      eventSequence?: number
    }>
    type OutboxRows = Map<string, {
      sessionId: string
      eventSequence: number
      outboxId: string
      payloadHash: string
    }>
    const receipts = new XAgentFactReceiptRegistry()
    const receiptRows = (receipts as unknown as { entries: ReceiptRows }).entries
    receiptRows.set('wrong', {
      sessionId: SESSION,
      toolCallId: 'call-1',
      proposalId: PROPOSAL,
      receipt: 'receipt',
      payloadHash: 'a'.repeat(64),
    })
    expect(receipts.relationshipIssue()).toContain('receipt key')
    receiptRows.clear()
    registerReceipt(receipts, 'call-1', 4)
    receiptRows.set(`${SESSION}\0call-2`, {
      sessionId: SESSION,
      toolCallId: 'call-2',
      proposalId: PROPOSAL,
      receipt: 'receipt-2',
      payloadHash: 'a'.repeat(64),
      eventSequence: 4,
    })
    expect(receipts.relationshipIssue()).toContain('two proposal receipts')
    receiptRows.clear()
    receiptRows.set(`${SESSION}\0unbound`, {
      sessionId: SESSION,
      toolCallId: 'unbound',
      proposalId: PROPOSAL,
      receipt: 'receipt-unbound',
      payloadHash: 'a'.repeat(64),
    })
    expect(receipts.relationshipIssue()).toBeUndefined()
    receiptRows.set(`${SESSION}\0same-sequence-a`, {
      sessionId: SESSION,
      toolCallId: 'same-sequence-a',
      proposalId: PROPOSAL,
      receipt: 'receipt-a',
      payloadHash: 'a'.repeat(64),
      eventSequence: 8,
    })
    receiptRows.set(`${SESSION}\0same-sequence-b`, {
      sessionId: SESSION,
      toolCallId: 'same-sequence-b',
      proposalId: PROPOSAL,
      receipt: 'receipt-b',
      payloadHash: 'a'.repeat(64),
      eventSequence: 8,
    })
    expect(receipts.attachments(SESSION, 8, 8).map(row => row.toolCallId))
      .toEqual(['same-sequence-a', 'same-sequence-b'])

    const outbox = new XAgentFactOutboxRegistry()
    const outboxRows = (outbox as unknown as { entries: OutboxRows }).entries
    outboxRows.set('wrong', {
      sessionId: SESSION,
      eventSequence: 4,
      outboxId: '00000000-0000-0000-0000-000000000901',
      payloadHash: 'b'.repeat(64),
    })
    expect(outbox.relationshipIssue()).toContain('Outbox key')
    outboxRows.clear()
    const first = '00000000-0000-0000-0000-000000000901'
    const second = '00000000-0000-0000-0000-000000000902'
    outboxRows.set(`${SESSION}\0${first}`, {
      sessionId: SESSION, eventSequence: 4, outboxId: first, payloadHash: 'b'.repeat(64),
    })
    outboxRows.set(`${SESSION}\0${second}`, {
      sessionId: SESSION, eventSequence: 4, outboxId: second, payloadHash: 'c'.repeat(64),
    })
    expect(outbox.relationshipIssue()).toContain('two Outbox rows')

    outboxRows.clear()
    const otherSessionRow = '00000000-0000-0000-0000-000000000903'
    outboxRows.set(`${OTHER_SESSION}\0${otherSessionRow}`, {
      sessionId: OTHER_SESSION, eventSequence: 4, outboxId: otherSessionRow, payloadHash: 'd'.repeat(64),
    })
    const earlier = '00000000-0000-0000-0000-000000000904'
    const tieA = '00000000-0000-0000-0000-000000000905'
    const tieB = '00000000-0000-0000-0000-000000000906'
    outboxRows.set(`${SESSION}\0${earlier}`, {
      sessionId: SESSION, eventSequence: 2, outboxId: earlier, payloadHash: 'e'.repeat(64),
    })
    outboxRows.set(`${SESSION}\0${tieB}`, {
      sessionId: SESSION, eventSequence: 5, outboxId: tieB, payloadHash: 'f'.repeat(64),
    })
    outboxRows.set(`${SESSION}\0${tieA}`, {
      sessionId: SESSION, eventSequence: 5, outboxId: tieA, payloadHash: 'f'.repeat(64),
    })
    expect(outbox.attachments(SESSION, 3, 5).map(row => row.outboxId)).toEqual([tieA, tieB])

    const sequenceCheck = new XAgentFactOutboxRegistry()
    sequenceCheck.register({ sessionId: OTHER_SESSION, eventSequence: 4, outboxId: first, payloadHash: 'b'.repeat(64) })
    expect(() => {
      sequenceCheck.register({ sessionId: SESSION, eventSequence: 4, outboxId: second, payloadHash: 'c'.repeat(64) })
    }).not.toThrow()
    const third = '00000000-0000-0000-0000-000000000907'
    expect(() => {
      sequenceCheck.register({ sessionId: SESSION, eventSequence: 5, outboxId: third, payloadHash: 'd'.repeat(64) })
    }).not.toThrow()

    expect(validateFactRegistryRelationships({}, outbox)).toContain('owning implementations')
    expect(validateFactRegistryRelationships(new XAgentFactReceiptRegistry(), outbox)).toContain('two Outbox rows')
  })

  test('disposal closes admission and clears both registries synchronously', async () => {
    const receipts = new XAgentFactReceiptRegistry()
    const outbox = new XAgentFactOutboxRegistry()
    registerReceipt(receipts, 'call-1', 5)
    outbox.register({
      sessionId: SESSION,
      eventSequence: 6,
      outboxId: '00000000-0000-0000-0000-000000000901',
      payloadHash: 'b'.repeat(64),
    })

    const receiptDisposal = receipts.dispose()
    const outboxDisposal = outbox.dispose()
    expect(receipts.attachments(SESSION, 0, 10)).toEqual([])
    expect(outbox.attachments(SESSION, 0, 10)).toEqual([])
    expect(() => {
      receipts.register({
        sessionId: SESSION,
        toolCallId: 'late',
        proposalId: PROPOSAL,
        receipt: 'late',
        payloadHash: 'a'.repeat(64),
      })
    }).toThrow('disposed')
    expect(() => {
      outbox.register({
        sessionId: SESSION,
        eventSequence: 7,
        outboxId: '00000000-0000-0000-0000-000000000902',
        payloadHash: 'b'.repeat(64),
      })
    }).toThrow('disposed')
    await Promise.all([receiptDisposal, outboxDisposal, receipts.dispose(), outbox.dispose()])
  })
})
