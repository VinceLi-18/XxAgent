/** Loader-owned authenticated scope bridge for the Business Fact runtime test. */

import type { Context } from '@deepseek-ai/cordis'
import {
  currentXAgentAuthenticatedRequestScope,
  runWithXAgentAuthenticatedRequestScope,
  type XAgentAuthenticatedRequestScope,
} from '@xagent/dsh-principal'

interface XAgentFactScopeFixture {
  run<T>(scope: XAgentAuthenticatedRequestScope, operation: () => T): T
  current(): XAgentAuthenticatedRequestScope | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    xagentFactScopeFixture: XAgentFactScopeFixture
  }
}

export const name = 'xagent-fact-scope-fixture'

/** Publish a runner that shares the Loader's Principal module instance. */
export function apply(ctx: Context): void {
  ctx.provide('xagentFactScopeFixture', {
    run: (scope, operation) => runWithXAgentAuthenticatedRequestScope(scope, operation),
    current: () => currentXAgentAuthenticatedRequestScope(),
  })
}
