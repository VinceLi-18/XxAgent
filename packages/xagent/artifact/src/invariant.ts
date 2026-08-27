/** XAgent Artifact Service 与 Typert Remote identity 的运行时关系。 @module @xagent/dsh-artifact/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { XAgentArtifactService } from './index.ts'

const PACKAGE_NAME = '@xagent/dsh-artifact'

/** Cordis companion plugin name. */
export const name = 'xagent-artifact-invariant'
/** Services required before the companion can observe the live binding. */
export const inject = ['invariants']

/**
 * Validate one live Cordis service object against the Typert binding it publishes.
 * @param service - active Artifact service from the Cordis service registry.
 * @param fail - package-attributed invariant failure reporter.
 */
export function validateXAgentArtifactBinding(service: XAgentArtifactService, fail: InvariantFailure): void {
  const binding = service.typertRemote
  if (
    binding.service !== service
    || binding.serviceKey !== service.name
    || binding.namespace !== binding.serviceKey
  ) {
    fail('xagentArtifact binding must identify its live Cordis service and namespace')
  }
}

/** Validate the authoritative Artifact service selected by the current Cordis scope. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  validateXAgentArtifactBinding(ctx.xagentArtifact, fail)
}, { inject: ['xagentArtifact'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the effect-owned registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
