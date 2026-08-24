// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { XAgentAuthBlocker } from '../src/client/xagent-auth-blocker.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('XAgentAuthBlocker', () => {
  it('普通 Profile 没有认证端点时不改变现有界面', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>DSH</html>', { status: 200 })))
    render(<XAgentAuthBlocker />)

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('未登录时阻断界面，成功登录后刷新当前页面', async () => {
    const reload = vi.fn()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('unauthenticated', { status: 401, headers: { 'x-xagent-auth': '1' } }))
      .mockResolvedValueOnce(Response.json({ csrf_token: 'hidden', expires_at: 1 }))
    vi.stubGlobal('fetch', fetcher)
    render(<XAgentAuthBlocker reload={reload} />)

    await screen.findByRole('dialog', { name: '登录工作空间' })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'alice@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'correct horse battery staple' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => { expect(reload).toHaveBeenCalledOnce() })
    expect(fetcher).toHaveBeenLastCalledWith('/auth/login', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ email: 'alice@example.com', password: 'correct horse battery staple' }),
    }))
  })

  it('登录失败只显示稳定文案，不回显响应正文', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('unauthenticated', { status: 401, headers: { 'x-xagent-auth': '1' } }))
      .mockResolvedValueOnce(new Response('internal password detail', { status: 401 }))
    vi.stubGlobal('fetch', fetcher)
    render(<XAgentAuthBlocker />)

    await screen.findByRole('dialog')
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'alice@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    expect((await screen.findByRole('alert')).textContent).toBe('邮箱或密码错误')
    expect(screen.queryByText('internal password detail')).toBeNull()
  })
})
