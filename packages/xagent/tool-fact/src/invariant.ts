/** Runtime checks for scoped XAgent Fact tool ownership. @module @xagent/dsh-tool-fact/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { xAgentFactToolRelationshipIssue } from './index.ts'

const PACKAGE_NAME = '@xagent/dsh-tool-fact'

/** Cordis companion plugin name. */
export const name = 'xagent-tool-fact-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

/**
 * Validate the active Fact-service and Agent-scoped tool relationship.
 * @param ctx - context containing the tool Consumer and its optional provider.
 * @param fail - package-attributed invariant failure reporter.
 */
export function validateXAgentFactToolRelationships(ctx: Context, fail: InvariantFailure): void {
  const issue = xAgentFactToolRelationshipIssue(ctx)
  if (issue !== undefined) fail(issue)
}

/** Recheck after every authoritative tool-registry change. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  validateXAgentFactToolRelationships(ctx, fail)
  ctx.on('tools/change', () => { validateXAgentFactToolRelationships(ctx, fail) })
}, { inject: ['tools'] })

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
