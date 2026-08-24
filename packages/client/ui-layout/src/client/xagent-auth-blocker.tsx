import { useEffect, useState, type FormEvent } from 'react'
import css from './AppFrame.module.css'

type AuthState = 'checking' | 'hidden' | 'login' | 'submitting' | 'unavailable'

export interface XAgentAuthBlockerProps {
  reload?: () => void
}

/** 仅在 Host 暴露 XAgent 认证端点时出现的最小登录阻断层。 */
export function XAgentAuthBlocker({ reload = () => { window.location.reload() } }: XAgentAuthBlockerProps) {
  const [state, setState] = useState<AuthState>('checking')
  const [message, setMessage] = useState('')

  useEffect(() => {
    const abort = new AbortController()
    void fetch('/auth/session', { credentials: 'same-origin', signal: abort.signal }).then(
      (response) => {
        if (response.headers.get('x-xagent-auth') !== '1') setState('hidden')
        else if (response.status === 204) setState('hidden')
        else if (response.status === 401) setState('login')
        else setState('unavailable')
      },
      () => { if (!abort.signal.aborted) setState('unavailable') },
    )
    return () => { abort.abort() }
  }, [])

  if (state === 'checking' || state === 'hidden') return null

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = form.get('email')
    const password = form.get('password')
    if (typeof email !== 'string' || typeof password !== 'string') return
    setState('submitting')
    setMessage('')
    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!response.ok) {
        setMessage(response.status === 401 ? '邮箱或密码错误' : '登录服务暂时不可用')
        setState('login')
        return
      }
      reload()
    } catch {
      setMessage('登录服务暂时不可用')
      setState('login')
    }
  }

  return (
    <div className={css.authBlocker} role="dialog" aria-modal="true" aria-labelledby="xagent-login-title">
      <form className={css.authCard} onSubmit={(event) => { void submit(event) }}>
        <p className={css.authEyebrow}>XAgent</p>
        <h1 id="xagent-login-title">登录工作空间</h1>
        <p>使用管理员分配的账号继续。</p>
        {state === 'unavailable'
          ? <p role="alert">认证服务暂时不可用，请稍后重试。</p>
          : <>
            <label>邮箱<input name="email" type="email" autoComplete="username" required /></label>
            <label>密码<input name="password" type="password" autoComplete="current-password" required /></label>
            {message !== '' && <p role="alert">{message}</p>}
            <button type="submit" disabled={state === 'submitting'}>
              {state === 'submitting' ? '登录中…' : '登录'}
            </button>
          </>}
      </form>
    </div>
  )
}
