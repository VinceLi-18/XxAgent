/**
 * Package-owned invariant companion for `@xagent/dsh-ui-account`.
 * @module @xagent/dsh-ui-account/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@xagent/dsh-ui-account'

/** Cordis companion plugin name. */
export const name = 'xagent-ui-account-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: authentication responses are external inputs and the
 * client controller owns no cross-plugin mutable state; its lifecycle and
 * account-change behavior are asserted by the package component suite.
 */
const install: InvariantInstaller = () => {}

/**
 * Register the package invariant companion.
 * @param ctx Cordis context carrying the invariant service.
 * @returns The registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
