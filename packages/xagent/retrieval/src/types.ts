import type { SessionId } from '@deepseek-ai/dsh-session'
import type { XAgentRetrievalCitation, XAgentRetrievalProject } from '@xagent/dsh-backend-client'

/** One canonical cited-answer block. Markdown never carries citation authority. */
export type XAgentCitedAnswerBlock =
  | { readonly type: 'markdown'; readonly text: string }
  | { readonly type: 'citation'; readonly id: string }

/** Canonical terminal answer persisted as the authoritative tool value. */
export interface XAgentCitedAnswer {
  readonly schemaVersion: 1
  readonly blocks: readonly XAgentCitedAnswerBlock[]
  readonly citationIds: readonly string[]
}

/** Replayable presentation metadata derived only from a canonical answer. */
export interface XAgentCitedAnswerMeta {
  readonly kind: 'xagent-cited-answer'
  readonly schemaVersion: 1
  readonly blocks: readonly XAgentCitedAnswerBlock[]
  readonly citationIds: readonly string[]
}

/** Bounded validation reasons that never retain rejected model content. */
export type XAgentCitedAnswerErrorReason =
  | 'invalid-json'
  | 'answer-too-large'
  | 'invalid-schema'
  | 'blocks-out-of-range'
  | 'markdown-required'
  | 'citation-required'
  | 'too-many-citations'
  | 'citation-not-allowed'

/** Stable retrieval failures surfaced by the Host consumer. */
export type XAgentRetrievalErrorCode =
  | 'unauthenticated'
  | 'session-not-found'
  | 'invalid-retrieval-scope'
  | 'retrieval-unavailable'
  | 'evidence-expired'
  | 'evidence-conflict'
  | 'citation-invalid'
  | 'service-unavailable'

/** Identity shared by all model retrieval operations. */
export interface XAgentRetrievalCall {
  readonly sessionId: SessionId
  readonly toolCallId: string
  readonly signal?: AbortSignal
}

/** Optional bounded project name discovery in a Private Session. */
export interface XAgentListAccessibleProjectsInput extends XAgentRetrievalCall {
  readonly query?: string
}

/** Explicit Artifact search input; Session scope is never accepted here. */
export interface XAgentSearchArtifactsInput extends XAgentRetrievalCall {
  readonly query: string
  readonly projectIds?: readonly string[]
  readonly includePrivate: boolean
}

/** Public project discovery result after the opaque receipt is registered privately. */
export interface XAgentAccessibleProjects {
  readonly projects: readonly XAgentRetrievalProject[]
  readonly payloadHash: string
}

/** Public search result after the opaque receipt is registered privately. */
export interface XAgentArtifactSearch {
  readonly citations: readonly XAgentRetrievalCitation[]
  readonly payloadHash: string
}

/** Private append attachment visible only to the XAgent persistence provider. */
export interface XAgentRetrievalReceiptAttachment {
  readonly eventSequence: number
  readonly toolCallId: string
  readonly receipt: string
  readonly payloadHash: string
}

/** Quiescent receipt lifetime used between tool materialization and confirmed append. */
export interface XAgentReceiptRegistryContract {
  register(input: { sessionId: string; toolCallId: string; receipt: string; payloadHash: string }): void
  publish(sessionId: string, toolCallId: string, payloadHash: string): void
  discard(sessionId: string, toolCallId: string): boolean
  bindEvent(sessionId: string, toolCallId: string, eventSequence: number, payloadHash?: string): void
  attachments(sessionId: string, fromSequence: number, toSequence: number): readonly XAgentRetrievalReceiptAttachment[]
  commit(sessionId: string, throughSequence: number): void
  dispose(): Promise<void>
}
