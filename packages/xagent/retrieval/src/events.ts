/** Durable citation-correction facts owned by XAgent retrieval. */

/** Stable reasons retained for one suppressed model draft. */
export type XAgentCitationInvalidReason =
  | 'citation-missing'
  | 'citation-malformed'
  | 'citation-unknown'
  | 'citation-revoked'
  | 'answer-too-large'
  | 'stream-invalid'

/** Log-only record used to audit and reconstruct one correction attempt. */
export interface XAgentCitationCorrectionEventData {
  readonly draftSha256: string
  readonly invalidDraft: string
  readonly reason: XAgentCitationInvalidReason
  readonly invalidIds: readonly string[]
  readonly allowedIds: readonly string[]
}

/** Log-only terminal record for a second invalid answer. */
export interface XAgentCitationFailureEventData {
  readonly draftSha256: string
  readonly reason: XAgentCitationInvalidReason
  readonly invalidIds: readonly string[]
  readonly allowedIds: readonly string[]
}

const HASH = /^[0-9a-f]{64}$/u
const CITATION = /^\[资料([1-9][0-9]*)\]$/u
const REASONS = new Set<XAgentCitationInvalidReason>([
  'citation-missing', 'citation-malformed', 'citation-unknown', 'citation-revoked',
  'answer-too-large', 'stream-invalid',
])

function row(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key)
}

function ids(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 64 || new Set(value).size !== value.length) return false
  return value.every((id) => {
    if (typeof id !== 'string') return false
    const ordinal = CITATION.exec(id)?.[1]
    return ordinal !== undefined && Number.isSafeInteger(Number(ordinal))
  })
}

function diagnostics(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && new Set(value).size === value.length
    && value.every(item => typeof item === 'string' && item.length > 0
      && Array.from(item).length <= 255 && !/[\u0000-\u001f]/u.test(item))
}

/**
 * Validate the two closed XAgent citation event payloads at durable wire boundaries.
 * @param value - decoded Session event candidate.
 * @returns Whether the candidate is a bounded correction or failure event.
 */
export function validateXAgentCitationEvent(value: unknown): boolean {
  const event = row(value)
  if (event === undefined || !exact(event, ['type', 'seq', 'time', 'data'])
    || !Number.isSafeInteger(event.seq) || (event.seq as number) < 0
    || !Number.isSafeInteger(event.time) || (event.time as number) < 0) return false
  if (event.type !== 'xagent/citation-correction' && event.type !== 'xagent/citation-failure') return false
  const data = row(event.data)
  if (data === undefined) return false
  const correction = event.type === 'xagent/citation-correction'
  const keys = correction
    ? ['draftSha256', 'invalidDraft', 'reason', 'invalidIds', 'allowedIds']
    : ['draftSha256', 'reason', 'invalidIds', 'allowedIds']
  if (!exact(data, keys) || typeof data.draftSha256 !== 'string' || !HASH.test(data.draftSha256)
    || typeof data.reason !== 'string' || !REASONS.has(data.reason as XAgentCitationInvalidReason)
    || !diagnostics(data.invalidIds) || !ids(data.allowedIds)) return false
  if (!correction) return true
  if (typeof data.invalidDraft !== 'string' || Buffer.byteLength(data.invalidDraft) > 8192) return false
  return !/[\ud800-\udfff]/u.test(data.invalidDraft)
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** First invalid evidence-bearing draft, hidden from the ordinary transcript. */
    'xagent/citation-correction': XAgentCitationCorrectionEventData
    /** Second invalid evidence-bearing draft, after which the turn fails. */
    'xagent/citation-failure': XAgentCitationFailureEventData
  }
}
