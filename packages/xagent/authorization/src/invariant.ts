/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@xagent/dsh-authorization'
export const name = 'xagent-authorization-invariant'
export const inject = ['invariants']
/** No runtime invariant: endpoint 权限映射由授权测试和 FastAPI RLS 共同固定。 */
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
