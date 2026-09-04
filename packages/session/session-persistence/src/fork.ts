/** Stable logical identity for one durable session-fork operation. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies retries of one logical durable session fork. */
export type SessionForkOperationId = Branded<'SessionForkOperationId'>

/**
 * Brand a caller-owned logical fork identifier.
 * @param value - stable identity shared by every retry of the operation.
 * @returns the same runtime string with fork-operation identity.
 */
export function SessionForkOperationId(value: string): SessionForkOperationId {
  return value as SessionForkOperationId
}
