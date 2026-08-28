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

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** First invalid evidence-bearing draft, hidden from the ordinary transcript. */
    'xagent/citation-correction': XAgentCitationCorrectionEventData
    /** Second invalid evidence-bearing draft, after which the turn fails. */
    'xagent/citation-failure': XAgentCitationFailureEventData
  }
}
