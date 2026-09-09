import type {
  FactProposalPublicStatus,
  ProjectFactValue,
  XAgentFactApproveInput,
  XAgentFactPage,
  XAgentFactPageInput,
  XAgentFactProposal,
  XAgentFactProposalDecision,
  XAgentFactRejectInput,
  XAgentFactRevision,
  XAgentFactRevisionDetail,
  XAgentFactWithdrawInput,
} from '@xagent/dsh-backend-client'
import type { XAgentAuthenticatedSessionRequestScope } from '@xagent/dsh-principal'

export type {
  FactProposalDecidedEvent,
  FactProposalPublicStatus,
  ProjectFactValue,
  ProposeFactResult,
  XAgentFactEvidence,
  XAgentFactOutboxAttachment,
  XAgentFactPage,
  XAgentFactProposal,
  XAgentFactProposalDecision,
  XAgentFactProposalReceiptAttachment,
  XAgentFactRevision,
  XAgentFactRevisionDetail,
} from '@xagent/dsh-backend-client'

/** Stable Fact failures surfaced to the model-facing Consumer. */
export type XAgentFactErrorCode =
  | 'unauthenticated'
  | 'not-found'
  | 'fact-input-invalid'
  | 'fact-evidence-invalid'
  | 'fact-session-invalid'
  | 'stale-permission'
  | 'idempotency-conflict'
  | 'fact-revision-conflict'
  | 'fact-already-decided'
  | 'service-unavailable'

/** Host-derived inputs for one governed Fact proposal preparation. */
export interface XAgentProposeFactInput {
  readonly sessionId: string
  readonly toolCallId: string
  readonly fieldKey: string
  readonly label: string
  readonly value: ProjectFactValue
  readonly evidenceIds: readonly string[]
  readonly assertionReason?: string
  readonly signal?: AbortSignal
}

/** Service Definition consumed by the Project-only model tool. */
export interface XAgentFactServiceContract {
  /** Prepare one proposal and retain its admission receipt outside the result. */
  proposeFact(input: XAgentProposeFactInput): Promise<{ readonly proposalId: string; readonly status: 'pending' }>
}

/** Authenticated Project Session scope runner used by the Host request authorizer. */
export interface XAgentFactScopeRunner {
  /** Run one Remote call under the physical connection's immutable Project Session identity. */
  withRequest<T>(scope: XAgentAuthenticatedSessionRequestScope, operation: () => Promise<T>): Promise<T>
}

/** Browser-visible Fact Remote; every Session selector must match the physical request scope. */
export interface XAgentFactRemote {
  /** List current Fact heads in the Session's fixed project. */
  listHeads(
    sessionId: string,
    input: XAgentFactPageInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactPage<XAgentFactRevision>>
  /** List public proposals in the Session's fixed project. */
  listProposals(
    sessionId: string,
    input: XAgentFactPageInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactPage<XAgentFactProposal>>
  /** Read one immutable revision under current FastAPI authorization. */
  revision(sessionId: string, revisionId: string, signal?: AbortSignal): Promise<XAgentFactRevisionDetail>
  /** Read one public proposal under current FastAPI authorization. */
  proposal(sessionId: string, proposalId: string, signal?: AbortSignal): Promise<XAgentFactProposal>
  /** Approve one pending proposal without accepting caller authority fields. */
  approve(
    sessionId: string,
    proposalId: string,
    input: XAgentFactApproveInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactProposalDecision>
  /** Reject one pending proposal without accepting caller authority fields. */
  reject(
    sessionId: string,
    proposalId: string,
    input: XAgentFactRejectInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactProposalDecision>
  /** Withdraw one pending proposal without accepting caller authority fields. */
  withdraw(
    sessionId: string,
    proposalId: string,
    input: XAgentFactWithdrawInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactProposalDecision>
}

/** Public Fact proposal statuses re-exported for Consumer implementations. */
export type XAgentFactStatus = FactProposalPublicStatus
