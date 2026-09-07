/**
 * `@xagent/dsh-ui-citation` package invariant companion.
 * @module @xagent/dsh-ui-citation/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@xagent/dsh-ui-citation'

/** Cordis companion plugin name. */
export const name = 'xagent-ui-citation-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns one cancellable controller and one
 * keyed ToolView contribution; lifecycle tests prove both are disposed.
 */
const install: InvariantInstaller = () => {}

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
