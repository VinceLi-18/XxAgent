/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@xagent/dsh-backend-client'
export const name = 'xagent-backend-client-invariant'
export const inject = ['invariants']
/** No runtime invariant: 客户端不缓存认证、Session 或 Business Skill 状态，每次调用独立校验。 */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
