import type {
  XAgentFactOutboxAttachment,
  XAgentFactOutboxRegistryContract,
  XAgentFactProposalReceiptAttachment,
  XAgentFactReceiptRegistryContract,
} from '@xagent/dsh-backend-client'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const RECEIPT = /^[A-Za-z0-9_-]+$/u

interface ReceiptEntry {
  readonly sessionId: string
  readonly toolCallId: string
  readonly proposalId: string
  readonly receipt: string
  readonly payloadHash: string
  eventSequence?: number
}

interface OutboxEntry {
  readonly sessionId: string
  readonly eventSequence: number
  readonly outboxId: string
  readonly payloadHash: string
}

function receiptKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`
}

function outboxKey(sessionId: string, outboxId: string): string {
  return `${sessionId}\u0000${outboxId}`
}

function validRange(fromSequence: number, toSequence: number): boolean {
  return Number.isSafeInteger(fromSequence)
    && Number.isSafeInteger(toSequence)
    && fromSequence >= 0
    && fromSequence <= toSequence
}

function validReceipt(input: Omit<ReceiptEntry, 'eventSequence'>): boolean {
  return input.sessionId.length > 0
    && input.toolCallId.length > 0
    && UUID.test(input.proposalId)
    && input.receipt.length <= 1_024
    && RECEIPT.test(input.receipt)
    && SHA256.test(input.payloadHash)
}

/** Private prepared-proposal receipts retained until confirmed Session append. */
export class XAgentFactReceiptRegistry implements XAgentFactReceiptRegistryContract {
  private readonly entries = new Map<string, ReceiptEntry>()
  private accepting = true

  /**
   * Register or rotate one unbound receipt for the same public proposal result.
   * @param input - private receipt and stable preparation identities.
   */
  register(input: Omit<ReceiptEntry, 'eventSequence'>): void {
    if (!this.accepting) throw new Error('xagent Fact receipt registry is disposed')
    if (!validReceipt(input)) throw new Error('xagent Fact receipt registration rejected')
    const key = receiptKey(input.sessionId, input.toolCallId)
    const current = this.entries.get(key)
    if (current?.eventSequence !== undefined) throw new Error('xagent Fact receipt is already bound')
    if (current !== undefined
      && (current.proposalId !== input.proposalId || current.payloadHash !== input.payloadHash)) {
      throw new Error('xagent Fact receipt replacement identity mismatch')
    }
    this.entries.set(key, { ...input })
  }

  /**
   * Bind the current receipt to the matching public Fact tool-result sequence.
   * @param sessionId - owning runtime Session identity.
   * @param toolCallId - authoritative tool call that produced the public result.
   * @param proposalId - public proposal identity returned by preparation.
   * @param eventSequence - appended tool-result sequence.
   */
  bindEvent(sessionId: string, toolCallId: string, proposalId: string, eventSequence: number): void {
    if (!Number.isSafeInteger(eventSequence) || eventSequence < 0) {
      throw new Error('xagent Fact receipt event binding rejected')
    }
    const entry = this.entries.get(receiptKey(sessionId, toolCallId))
    if (entry === undefined || entry.proposalId !== proposalId || entry.eventSequence !== undefined) {
      throw new Error('xagent Fact receipt event identity mismatch')
    }
    for (const candidate of this.entries.values()) {
      if (candidate !== entry && candidate.sessionId === sessionId && candidate.eventSequence === eventSequence) {
        throw new Error('xagent Fact receipt event sequence already bound')
      }
    }
    entry.eventSequence = eventSequence
  }

  /**
   * Discard one preparation that never produced an authoritative public result.
   * @param sessionId - owning runtime Session identity.
   * @param toolCallId - abandoned tool-call identity.
   * @returns whether an unbound receipt was removed.
   */
  discard(sessionId: string, toolCallId: string): boolean {
    const key = receiptKey(sessionId, toolCallId)
    const entry = this.entries.get(key)
    if (entry === undefined || entry.eventSequence !== undefined) return false
    return this.entries.delete(key)
  }

  /**
   * Discard unbound preparations owned by a terminated Session.
   * @param sessionId - terminated runtime Session identity.
   */
  discardSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId && entry.eventSequence === undefined) this.entries.delete(key)
    }
  }

  /** Return immutable receipt sidecars in one inclusive append sequence range. */
  attachments(
    sessionId: string,
    fromSequence: number,
    toSequence: number,
  ): readonly XAgentFactProposalReceiptAttachment[] {
    if (!validRange(fromSequence, toSequence)) return []
    const attachments: XAgentFactProposalReceiptAttachment[] = []
    for (const entry of this.entries.values()) {
      if (entry.sessionId !== sessionId || entry.eventSequence === undefined
        || entry.eventSequence < fromSequence || entry.eventSequence > toSequence) continue
      attachments.push(Object.freeze({
        eventSequence: entry.eventSequence,
        toolCallId: entry.toolCallId,
        proposalId: entry.proposalId,
        receipt: entry.receipt,
        payloadHash: entry.payloadHash,
      }))
    }
    attachments.sort((left, right) => left.eventSequence - right.eventSequence
      || left.toolCallId.localeCompare(right.toolCallId))
    return Object.freeze(attachments)
  }

  /** Delete only receipts covered by a confirmed remote append. */
  commit(sessionId: string, throughSequence: number): void {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) return
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId && entry.eventSequence !== undefined
        && entry.eventSequence <= throughSequence) this.entries.delete(key)
    }
  }

  /** Close admission and synchronously clear every receipt. */
  dispose(): Promise<void> {
    this.accepting = false
    this.entries.clear()
    return Promise.resolve(undefined)
  }

  /**
   * Return the first violated internal key/state relationship without exposing secrets.
   * @returns a stable diagnostic when receipt identity ownership is inconsistent.
   */
  relationshipIssue(): string | undefined {
    const sequences = new Set<string>()
    for (const [key, entry] of this.entries) {
      if (key !== receiptKey(entry.sessionId, entry.toolCallId)) return 'receipt key does not match its Session and tool call'
      if (entry.eventSequence === undefined) continue
      const sequenceKey = `${entry.sessionId}\u0000${String(entry.eventSequence)}`
      if (sequences.has(sequenceKey)) return 'two proposal receipts own one Session event sequence'
      sequences.add(sequenceKey)
    }
    return undefined
  }
}

/** Private Outbox event identities retained until confirmed Session append. */
export class XAgentFactOutboxRegistry implements XAgentFactOutboxRegistryContract {
  private readonly entries = new Map<string, OutboxEntry>()
  private accepting = true

  /**
   * Register one event sidecar.
   * @param input - Outbox identity and its reserved Session event sequence.
   * @returns false for an exact response-loss replay; true for a new reservation.
   */
  register(input: OutboxEntry): boolean {
    if (!this.accepting) throw new Error('xagent Fact Outbox registry is disposed')
    if (input.sessionId.length === 0
      || !Number.isSafeInteger(input.eventSequence)
      || input.eventSequence < 0
      || !UUID.test(input.outboxId)
      || !SHA256.test(input.payloadHash)) {
      throw new Error('xagent Fact Outbox registration rejected')
    }
    const key = outboxKey(input.sessionId, input.outboxId)
    const current = this.entries.get(key)
    if (current !== undefined) {
      if (current.eventSequence === input.eventSequence && current.payloadHash === input.payloadHash) return false
      throw new Error('xagent Fact Outbox replay identity mismatch')
    }
    for (const entry of this.entries.values()) {
      if (entry.sessionId === input.sessionId && entry.eventSequence === input.eventSequence) {
        throw new Error('xagent Fact Outbox event sequence already bound')
      }
    }
    this.entries.set(key, { ...input })
    return true
  }

  /**
   * Return whether an Outbox row already owns a pending Session event.
   * @param sessionId - owning runtime Session identity.
   * @param outboxId - durable backend Outbox identity.
   * @returns whether the exact row has a pending reservation.
   */
  has(sessionId: string, outboxId: string): boolean {
    return this.entries.has(outboxKey(sessionId, outboxId))
  }

  /**
   * Remove a reservation only when its exact event append failed.
   * @param sessionId - owning runtime Session identity.
   * @param outboxId - durable backend Outbox identity.
   * @param eventSequence - exact reserved event sequence.
   * @returns whether the matching reservation was removed.
   */
  discard(sessionId: string, outboxId: string, eventSequence: number): boolean {
    const key = outboxKey(sessionId, outboxId)
    const entry = this.entries.get(key)
    if (entry?.eventSequence !== eventSequence) return false
    return this.entries.delete(key)
  }

  /* jscpd:ignore-start */
  /** Return immutable Outbox sidecars in one inclusive append sequence range. */
  attachments(
    sessionId: string,
    fromSequence: number,
    toSequence: number,
  ): readonly XAgentFactOutboxAttachment[] {
    if (!validRange(fromSequence, toSequence)) return []
    const attachments: XAgentFactOutboxAttachment[] = []
    for (const entry of this.entries.values()) {
      if (entry.sessionId !== sessionId || entry.eventSequence < fromSequence || entry.eventSequence > toSequence) continue
      attachments.push(Object.freeze({
        eventSequence: entry.eventSequence,
        outboxId: entry.outboxId,
        payloadHash: entry.payloadHash,
      }))
    }
    attachments.sort((left, right) => left.eventSequence - right.eventSequence
      || left.outboxId.localeCompare(right.outboxId))
    return Object.freeze(attachments)
  }

  /** Delete only Outbox sidecars covered by a confirmed remote append. */
  commit(sessionId: string, throughSequence: number): void {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) return
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId && entry.eventSequence <= throughSequence) this.entries.delete(key)
    }
  }

  /** Close admission and synchronously clear every Outbox sidecar. */
  dispose(): Promise<void> {
    this.accepting = false
    this.entries.clear()
    return Promise.resolve()
  }
  /* jscpd:ignore-end */

  /**
   * Return the first violated internal key/state relationship.
   * @returns a stable diagnostic when Outbox identity ownership is inconsistent.
   */
  relationshipIssue(): string | undefined {
    const sequences = new Set<string>()
    for (const [key, entry] of this.entries) {
      if (key !== outboxKey(entry.sessionId, entry.outboxId)) return 'Outbox key does not match its Session and row'
      const sequenceKey = `${entry.sessionId}\u0000${String(entry.eventSequence)}`
      if (sequences.has(sequenceKey)) return 'two Outbox rows own one Session event sequence'
      sequences.add(sequenceKey)
    }
    return undefined
  }
}

/**
 * Validate the mutable ownership relationships of the two private registries.
 * @param receipts - candidate proposal-receipt registry.
 * @param outbox - candidate Outbox identity registry.
 * @returns the first ownership diagnostic, or undefined when relationships are valid.
 */
export function validateFactRegistryRelationships(
  receipts: unknown,
  outbox: unknown,
): string | undefined {
  if (receipts === outbox) return 'proposal receipts and Outbox identities must use separate registries'
  if (!(receipts instanceof XAgentFactReceiptRegistry) || !(outbox instanceof XAgentFactOutboxRegistry)) {
    return 'Fact private registries must use their owning implementations'
  }
  return receipts.relationshipIssue() ?? outbox.relationshipIssue()
}
