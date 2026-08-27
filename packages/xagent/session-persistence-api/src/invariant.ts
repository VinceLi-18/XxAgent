/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@xagent/dsh-session-persistence-api'
export const name = 'xagent-session-persistence-api-invariant'
export const inject = ['invariants']
/** No runtime invariant: 远端连续性由 FastAPI 事务与 provider round-trip 测试拥有。 */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
