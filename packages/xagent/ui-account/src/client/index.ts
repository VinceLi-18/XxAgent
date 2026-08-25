import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import { AccountFooter } from './AccountFooter.tsx'
import { AccountOverlay } from './AccountOverlay.tsx'
import { AccountController, csrfCookie, type AccountWorkbenchBridge } from './service.ts'

export { AccountController } from './service.ts'
export type { AccountState, AccountWorkbenchBridge, XAgentAccountSummary } from './service.ts'

export const inject = ['slots', 'xagentWorkbench', 'browserRequestHeaders', 'layout']

export function apply(ctx: ClientContext): void {
  const workbench = (ctx as ClientContext & { xagentWorkbench: AccountWorkbenchBridge }).xagentWorkbench
  const account = new AccountController(workbench)
  let authenticated = false
  ctx.effect(() => account.subscribe(() => {
    const next = account.getSnapshot().phase === 'authenticated'
    if (next && !authenticated) ctx.layout.openDetails()
    authenticated = next
  }), 'xagent account: open workbench details after authentication')
  ctx.effect(() => ctx.browserRequestHeaders.register(() => {
    const token = csrfCookie()
    return token === undefined ? undefined : { 'x-xagent-csrf': token }
  }), 'xagent account: browser CSRF header')
  ctx.effect(() => {
    void account.start()
    return () => { account.dispose() }
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'xagent-account', order: -100,
    inject: () => ({ hooks: { account }, login: (email: string, password: string) => account.login(email, password) }),
  }, AccountOverlay))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'xagent-account', order: 100,
    inject: () => ({ hooks: { account }, logout: () => account.logout() }),
  }, AccountFooter))
}
