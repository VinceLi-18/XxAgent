import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { XAgentFactProposal, XAgentFactProposalDecision } from '@xagent/dsh-fact/types'
import type { XAgentFactRemoteClient } from './service.ts'

/** Supported proposal decision operations. */
export type XAgentFactDecisionKind = 'approve' | 'reject' | 'withdraw'

/** Complete retryable decision intent; retained only in controller memory. */
export interface XAgentFactDecisionRequest {
  readonly kind: XAgentFactDecisionKind
  readonly proposalId: string
  readonly idempotencyKey: string
  readonly decisionNote?: string
  readonly reason?: string
}

/** Submit one typed decision to the generated Remote client.
 * @param remote Generated Fact Remote client.
 * @param sessionId Exact Project Session identity.
 * @param request Complete decision intent, including its idempotency key.
 * @param signal Request cancellation signal.
 * @returns The server decision result.
 */
export function submitFactDecision(
  remote: XAgentFactRemoteClient,
  sessionId: string,
  request: XAgentFactDecisionRequest,
  signal: AbortSignal,
): Promise<RemoteResult<XAgentFactProposalDecision>> {
  switch (request.kind) {
    case 'approve':
      return remote.approve(sessionId, request.proposalId, {
        idempotencyKey: request.idempotencyKey,
        ...(request.decisionNote === undefined ? {} : { decisionNote: request.decisionNote }),
      }, signal)
    case 'reject':
      return remote.reject(sessionId, request.proposalId, {
        idempotencyKey: request.idempotencyKey,
        reason: request.reason ?? '',
      }, signal)
    case 'withdraw':
      return remote.withdraw(sessionId, request.proposalId, { idempotencyKey: request.idempotencyKey }, signal)
  }
}

/** Apply browser-side affordance rules before server reauthorization.
 * @param proposal Current proposal detail, when loaded.
 * @param kind Requested decision operation.
 * @param actorId Current authenticated actor.
 * @param role Current account role.
 * @returns Whether the action may be offered by the browser.
 */
export function canSubmitFactDecision(
  proposal: XAgentFactProposal | undefined,
  kind: XAgentFactDecisionKind,
  actorId: string,
  role: 'manager' | 'specialist',
): boolean {
  if (proposal?.status !== 'pending') return false
  return kind === 'withdraw' ? proposal.proposerId === actorId : role === 'manager'
}
