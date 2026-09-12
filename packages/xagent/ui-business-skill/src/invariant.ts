/** Live browser relationships; the Host-only instance has no panel to inspect. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './relationships.ts'
/** Runtime diagnostic registry dependency. */
export const inject = ['invariants']
/** Cordis companion name. */
export const name = 'xagent-ui-business-skill-invariant'
/** Register the live browser ownership check.
 * @param ctx Diagnostic registry context.
 * @returns Invariant registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register('@xagent/dsh-ui-business-skill', install))
/** Check the generated Remote identity and single Slot relationship when mounted.
 * @param ctx Context with an optional browser relationship service.
 * @param fail Reporter for a broken live ownership relationship.
 */
export function validateBusinessSkillUi(ctx: Context, fail: InvariantFailure): void {
  const issue = ctx.get('xagentBusinessSkillUiRelationships')?.issue()
  if (issue !== undefined) fail(issue)
}

const install: InvariantInstaller = (ctx, fail) => { validateBusinessSkillUi(ctx, fail) }
