import { useEffect, useRef, type FormEvent } from 'react'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountState } from './service.ts'
import { accountLocale as text } from './locales.ts'
import css from './account.module.css'

export interface AccountOverlayInjected {
  hooks: { account: HostObservable<AccountState> }
  login(email: string, password: string): Promise<void>
}

export type AccountOverlayProps = PropsRuntime<'shell.overlay'> & InjectFace<AccountOverlayInjected>

export function AccountOverlay({ useAccount, login }: AccountOverlayProps) {
  const state = useAccount(value => value)
  const emailRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (state.phase === 'login') emailRef.current?.focus() }, [state.phase])
  if (state.phase === 'checking' || state.phase === 'absent' || state.phase === 'authenticated') return null
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = form.get('email')
    const password = form.get('password')
    if (typeof email === 'string' && typeof password === 'string') void login(email, password)
  }
  return (
    <div className={css.overlay} role="dialog" aria-modal="true" aria-labelledby="xagent-login-title">
      <form className={css.card} onSubmit={submit}>
        <p className={css.eyebrow}>{text.product}</p>
        <h1 id="xagent-login-title">{text.title}</h1>
        <p>{text.hint}</p>
        {state.phase === 'unavailable'
          ? <p role="alert">{text.unavailable}</p>
          : <>
            <label>{text.email}<input ref={emailRef} name="email" type="email" autoComplete="username" required /></label>
            <label>{text.password}<input name="password" type="password" autoComplete="current-password" required /></label>
            {state.message !== undefined && <p role="alert">{state.message}</p>}
            <button type="submit" disabled={state.phase === 'submitting'}>{state.phase === 'submitting' ? text.submitting : text.login}</button>
          </>}
      </form>
    </div>
  )
}
