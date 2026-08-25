import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { AccountFooter } from './AccountFooter.tsx'
import { AccountOverlay } from './AccountOverlay.tsx'
import { AccountController, type AccountWorkbenchBridge } from './service.ts'

export { AccountController } from './service.ts'
export type { AccountState, AccountWorkbenchBridge, XAgentAccountSummary } from './service.ts'

export const inject = ['slots', 'xagentWorkbench']

export function apply(ctx: ClientContext): void {
  const workbench = (ctx as ClientContext & { xagentWorkbench: AccountWorkbenchBridge }).xagentWorkbench
  const account = new AccountController(workbench)
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
