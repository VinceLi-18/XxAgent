/** Runtime ownership checks for the XAgent Fact browser UI. @module @xagent/dsh-ui-fact/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { XAgentFactUiRelationships } from './relationships.ts'

const PACKAGE_NAME = '@xagent/dsh-ui-fact'

/** Cordis companion plugin name. */
export const name = 'xagent-ui-fact-invariant'
/** Registry required before the optional browser companion can install. */
export const inject = ['invariants']

/** Validate the live Slot, renderer, and controller/Remote relationship when present.
 * @param ctx Cordis context containing the optional browser relationship service.
 * @param fail Invariant failure reporter.
 */
export function validateXAgentFactUiRelationships(ctx: Context, fail: InvariantFailure): void {
  const relationships: XAgentFactUiRelationships | undefined = ctx.get('xagentFactUiRelationships')
  const issue = relationships?.issue()
  if (issue !== undefined) fail(issue)
}

const install: InvariantInstaller = (ctx, fail) => { validateXAgentFactUiRelationships(ctx, fail) }

/** Register the optional browser relationship check. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
