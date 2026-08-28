import type { SessionId } from '@deepseek-ai/dsh-session'
import type { XAgentRetrievalCitation, XAgentRetrievalProject } from '@xagent/dsh-backend-client'

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
  bindEvent(sessionId: string, toolCallId: string, eventSequence: number, payloadHash?: string): void
  attachments(sessionId: string, fromSequence: number, toSequence: number): readonly XAgentRetrievalReceiptAttachment[]
  commit(sessionId: string, throughSequence: number): void
  dispose(): Promise<void>
}
