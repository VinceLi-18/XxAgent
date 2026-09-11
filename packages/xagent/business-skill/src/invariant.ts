/** Correlate actual Skill admission with its authorized Agent-owned definition. @module @xagent/dsh-business-skill/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { XAgentBusinessSkillService } from './index.ts'
import type {} from '@deepseek-ai/dsh-tool-skill'
/** Companion plugin name. */
export const name = 'xagent-business-skill-invariant'
/** Registry receiving the package's runtime relationship checks. */
export const inject = ['invariants']

const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('skill/loaded', ({ agent, definition }) => {
    if (definition.provider !== 'xagent-project') return
    const service: XAgentBusinessSkillService | undefined = ctx.get('xagentBusinessSkill')
    const version = service?.loadedVersion(agent, definition)
    if (version === undefined || version.slug !== definition.name || version.instructions !== definition.content
      || version.description !== definition.description) {
      fail('Business Skill admission requires the owned authorized definition for this Agent and physical request')
    }
  }, { global: true })
}

/** Register the reversible Business Skill admission relationship check. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@xagent/dsh-business-skill', install))
