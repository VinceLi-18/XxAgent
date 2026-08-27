/**
 * `@xagent/dsh-ui-artifact` 的包级 invariant companion。
 * @module @xagent/dsh-ui-artifact/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@xagent/dsh-ui-artifact'

/** Cordis companion 插件名。 */
export const name = 'xagent-ui-artifact-invariant'
/** companion 注册前所需服务。 */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns one cancellable controller and one
 * Slot contribution; the real plugin lifecycle test proves both are disposed.
 */
const install: InvariantInstaller = () => {}

/** 注册本包的 invariant companion。 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
