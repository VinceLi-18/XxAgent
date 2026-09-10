/** Runtime ownership checks for the XAgent Fact provider. @module @xagent/dsh-fact/invariant */

import { symbols, type Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { XAgentFactService } from './index.ts'
import { validateFactRegistryRelationships } from './receipt-registry.ts'

const PACKAGE_NAME = '@xagent/dsh-fact'

/** Cordis companion plugin name. */
export const name = 'xagent-fact-invariant'
/** Registry required before this optional-provider companion can install. */
export const inject = ['invariants']

/**
 * Validate distinct private-registry ownership and live lifecycle relationships.
 * @param service - active Fact service selected by the current Cordis scope.
 * @param fail - package-attributed invariant failure reporter.
 */
export function validateXAgentFactRelationships(service: XAgentFactService, fail: InvariantFailure): void {
  const original = (service as XAgentFactService & { [symbols.original]?: XAgentFactService })[symbols.original] ?? service
  const registryIssue = validateFactRegistryRelationships(original.receipts, original.outbox)
  if (registryIssue !== undefined) fail(registryIssue)
  const ownerIssue = original.relationshipIssue()
  if (ownerIssue !== undefined) fail(ownerIssue)
}

/** Validate the optional provider when this companion is installed. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const service = ctx.get('xagentFact')
  if (service !== undefined) validateXAgentFactRelationships(service, fail)
}

/** Register this package's optional-provider invariant checks. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
