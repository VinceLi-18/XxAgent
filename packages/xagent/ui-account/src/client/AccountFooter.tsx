import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { AccountState } from './service.ts'
import { accountLocale as text } from './locales.ts'
import css from './account.module.css'

export interface AccountFooterInjected {
  hooks: { account: HostObservable<AccountState> }
  logout(): Promise<void>
}
export type AccountFooterProps = PropsRuntime<'sidebar.footer.action'> & SidebarFooterActionOwnerProps & InjectFace<AccountFooterInjected>

export function AccountFooter({ wide, useAccount, logout }: AccountFooterProps) {
  const state = useAccount(value => value)
  if (state.phase !== 'authenticated' || state.account === undefined) return null
  const role = state.account.role === 'manager' ? text.manager : text.specialist
  return (
    <div className={css.footer} title={wide ? undefined : `${state.account.email} · ${role}`}>
      {wide && <div className={css.identity}><strong>{state.account.email}</strong><span>{role}</span></div>}
      <button type="button" aria-label={text.logout} onClick={() => { void logout() }}>{wide ? text.logout : text.compactLogout}</button>
      {state.logoutError !== undefined && <p role="alert">{state.logoutError}</p>}
    </div>
  )
}
