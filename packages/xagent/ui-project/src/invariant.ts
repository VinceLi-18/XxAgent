/**
 * Package-owned invariant companion for `@xagent/dsh-ui-project`.
 * @module @xagent/dsh-ui-project/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@xagent/dsh-ui-project'

/** Cordis companion plugin name. */
export const name = 'xagent-ui-project-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the Host owns authorization and the client store only
 * publishes server-authorized snapshots; lifecycle and account fencing are
 * covered by the package test suite.
 */
const install: InvariantInstaller = () => {}

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
