/**
 * Package-owned invariant companion for `@xagent/dsh-business`.
 * @module @xagent/dsh-business/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@xagent/dsh-business'

/** Cordis companion plugin name. */
export const name = 'xagent-business-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package is a static patch carrier whose rows,
 * including the Fact provider, proposal tool, and browser occupant, retain
 * their owning packages' invariants. The closure test checks exact composition
 * and exclusion from every other shipped profile.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
