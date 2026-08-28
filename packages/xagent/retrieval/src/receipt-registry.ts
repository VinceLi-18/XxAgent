import type { XAgentReceiptRegistryContract, XAgentRetrievalReceiptAttachment } from './types.ts'

interface Entry {
  readonly sessionId: string
  readonly toolCallId: string
  readonly receipt: string
  readonly payloadHash: string
  readonly settled: PromiseWithResolvers<void>
  state: 'registered' | 'published' | 'bound'
  eventSequence?: number
}

function key(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`
}

function validEntry(input: { sessionId: string; toolCallId: string; receipt: string; payloadHash: string }): boolean {
  return input.sessionId.length > 0
    && input.toolCallId.length > 0
    && input.receipt.length <= 1_024
    && /^[A-Za-z0-9_-]+$/u.test(input.receipt)
    && /^[0-9a-f]{64}$/u.test(input.payloadHash)
}

/** In-memory opaque receipt registry with explicit append confirmation. */
export class XAgentReceiptRegistry implements XAgentReceiptRegistryContract {
  private readonly entries = new Map<string, Entry>()
  private accepting = true

  /** Register a receipt before its model-visible result can be returned. */
  register(input: { sessionId: string; toolCallId: string; receipt: string; payloadHash: string }): void {
    if (!this.accepting || !validEntry(input)) throw new Error('xagent receipt registration rejected')
    const entryKey = key(input.sessionId, input.toolCallId)
    if (this.entries.has(entryKey)) throw new Error('xagent receipt identity already registered')
    this.entries.set(entryKey, { ...input, state: 'registered', settled: Promise.withResolvers<void>() })
  }

  /** Confirm that a final successful Native tool result will be appended. */
  publish(sessionId: string, toolCallId: string, payloadHash: string): void {
    const entry = this.entries.get(key(sessionId, toolCallId))
    if (entry === undefined || entry.state !== 'registered' || entry.payloadHash !== payloadHash) {
      throw new Error('xagent receipt publication identity mismatch')
    }
    entry.state = 'published'
  }

  /** Confirm that a registered operation produced no public successful result. */
  discard(sessionId: string, toolCallId: string): boolean {
    const entryKey = key(sessionId, toolCallId)
    const entry = this.entries.get(entryKey)
    if (entry === undefined || entry.state === 'bound') return false
    this.entries.delete(entryKey)
    entry.settled.resolve()
    return true
  }

  /** Bind a registered receipt to its matching durable tool-result sequence. */
  bindEvent(sessionId: string, toolCallId: string, eventSequence: number, payloadHash?: string): void {
    if (!Number.isSafeInteger(eventSequence) || eventSequence < 0) {
      throw new Error('xagent receipt event binding rejected')
    }
    const entry = this.entries.get(key(sessionId, toolCallId))
    if (entry === undefined || entry.state !== 'published' || entry.eventSequence !== undefined
      || (payloadHash !== undefined && entry.payloadHash !== payloadHash)) {
      throw new Error('xagent receipt event identity mismatch')
    }
    entry.eventSequence = eventSequence
    entry.state = 'bound'
    entry.settled.resolve()
  }

  /** Return owned copies for one exact persistence append window. */
  attachments(sessionId: string, fromSequence: number, toSequence: number): readonly XAgentRetrievalReceiptAttachment[] {
    if (!Number.isSafeInteger(fromSequence) || !Number.isSafeInteger(toSequence) || fromSequence > toSequence) {
      return []
    }
    const result: XAgentRetrievalReceiptAttachment[] = []
    for (const entry of this.entries.values()) {
      if (entry.sessionId !== sessionId || entry.eventSequence === undefined) continue
      if (entry.eventSequence < fromSequence || entry.eventSequence > toSequence) continue
      result.push(Object.freeze({
        eventSequence: entry.eventSequence,
        toolCallId: entry.toolCallId,
        receipt: entry.receipt,
        payloadHash: entry.payloadHash,
      }))
    }
    return Object.freeze(result.sort((left, right) => left.eventSequence - right.eventSequence))
  }

  /** Delete only receipts covered by a confirmed remote append. */
  commit(sessionId: string, throughSequence: number): void {
    if (!Number.isSafeInteger(throughSequence)) return
    for (const [entryKey, entry] of this.entries) {
      if (entry.sessionId === sessionId && entry.eventSequence !== undefined && entry.eventSequence <= throughSequence) {
        this.entries.delete(entryKey)
      }
    }
  }

  /** Close admission and await confirmation for every registered or published operation. */
  async dispose(): Promise<void> {
    this.accepting = false
    const pending: Promise<void>[] = []
    for (const entry of this.entries.values()) {
      if (entry.state === 'registered' || entry.state === 'published') {
        pending.push(entry.settled.promise)
      }
    }
    await Promise.allSettled(pending)
  }
}
