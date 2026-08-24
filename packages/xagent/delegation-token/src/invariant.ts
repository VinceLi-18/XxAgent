/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@xagent/dsh-delegation-token'
export const name = 'xagent-delegation-token-invariant'
export const inject = ['invariants']
/** No runtime invariant: nonce 的原子消费由调用方持久化存储拥有。 */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
