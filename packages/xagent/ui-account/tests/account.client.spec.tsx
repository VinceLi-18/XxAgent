// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { BrowserRequestHeadersService } from '@deepseek-ai/dsh-client-connection/client'
import { AccountController } from '../src/client/service.ts'
import { AccountFooter } from '../src/client/AccountFooter.tsx'
import { AccountOverlay } from '../src/client/AccountOverlay.tsx'
import { apply, inject } from '../src/client/index.ts'
import type { AccountWorkbenchBridge } from '../src/client/service.ts'

function bridge() {
  let state: ReturnType<AccountWorkbenchBridge['snapshot']['getSnapshot']> = { phase: 'empty' }
  const listeners = new Set<() => void>()
  return {
    snapshot: {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    bootstrap: vi.fn(async () => {
      state = { phase: 'ready', account: { id: 'account-1', email: 'manager@example.com', role: 'manager' } }
      listeners.forEach((listener) => { listener() })
    }),
    reset: vi.fn(() => {
      state = { phase: 'empty' }
      listeners.forEach((listener) => { listener() })
    }),
  } satisfies AccountWorkbenchBridge
}

function hook(controller: AccountController) {
  return function useAccount<S>(selector: (state: ReturnType<AccountController['getSnapshot']>) => S): S {
    return selector(useSyncExternalStore(controller.subscribe, controller.getSnapshot))
  }
}

function mount(controller: AccountController) {
  const useAccount = hook(controller)
  const standard = { useSessions: vi.fn() as never, useWorkspaces: vi.fn() as never }
  return render(<>
    <AccountOverlay {...standard} useAccount={useAccount} login={(email, password) => controller.login(email, password)} />
    <AccountFooter {...standard} wide useAccount={useAccount} logout={() => controller.logout()} />
  </>)
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('XAgent 正式账号界面', () => {
  it('只通过正式插槽注册，并随声明重载和插件卸载', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    const declare = () => slots.register({
      name: 'root',
      children: {
        'shell.overlay': { kind: 'list', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)
    let disposeDeclaration = declare()
    ctx.provide('xagentWorkbench', bridge() as never)
    const requestHeaders = new BrowserRequestHeadersService(ctx)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    document.cookie = 'xagent_csrf=plugin-token; Path=/'
    expect(requestHeaders.resolve().get('x-xagent-csrf')).toBe('plugin-token')
    expect(slots.entries('shell.overlay')[0]?.component).toBe(AccountOverlay)
    expect(slots.entries('sidebar.footer.action')[0]?.component).toBe(AccountFooter)
    disposeDeclaration()
    expect(slots.entries('shell.overlay')).toHaveLength(0)
    expect(slots.entries('sidebar.footer.action')).toHaveLength(0)
    disposeDeclaration = declare()
    await Promise.resolve()
    expect(slots.entries('shell.overlay')).toHaveLength(1)
    expect(slots.entries('sidebar.footer.action')).toHaveLength(1)
    await fiber.dispose()
    expect(requestHeaders.resolve().get('x-xagent-csrf')).toBeNull()
    expect(slots.entries('shell.overlay')).toHaveLength(0)
    expect(slots.entries('sidebar.footer.action')).toHaveLength(0)
    disposeDeclaration()
  })

  it('Host 没有 XAgent 认证标识时完全不出现，也不触发工作台 Bootstrap', async () => {
    const workbench = bridge()
    const fetcher = vi.fn(async () => new Response('<html>DSH</html>', { status: 200 }))
    const controller = new AccountController(workbench, fetcher)
    mount(controller)
    await act(async () => { await controller.start() })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('退出登录')).toBeNull()
    expect(workbench.bootstrap).not.toHaveBeenCalled()
  })

  it('401 显示独立登录页，并支持焦点、autocomplete、键盘提交和成功 Bootstrap', async () => {
    const workbench = bridge()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('unauthenticated', { status: 401, headers: { 'x-xagent-auth': '1' } }))
      .mockResolvedValueOnce(Response.json({ csrf_token: 'csrf-login', expires_at: '2026-08-25T18:00:00Z' }))
    const controller = new AccountController(workbench, fetcher)
    mount(controller)
    await act(async () => { await controller.start() })

    const email = screen.getByLabelText('邮箱') as HTMLInputElement
    const password = screen.getByLabelText('密码') as HTMLInputElement
    expect(document.activeElement).toBe(email)
    expect(email.autocomplete).toBe('username')
    expect(password.autocomplete).toBe('current-password')
    expect(screen.queryByText(/注册|找回密码|记住我|OIDC/i)).toBeNull()
    fireEvent.change(email, { target: { value: 'manager@example.com' } })
    fireEvent.change(password, { target: { value: 'correct horse battery staple' } })
    fireEvent.keyDown(password, { key: 'Enter', code: 'Enter' })
    fireEvent.submit(password.closest('form')!)

    await waitFor(() => { expect(screen.getByText('manager@example.com')).toBeTruthy() })
    expect(screen.getByText('管理者')).toBeTruthy()
    expect(fetcher).toHaveBeenLastCalledWith('/auth/login', expect.objectContaining({
      method: 'POST', credentials: 'same-origin',
      body: JSON.stringify({ email: 'manager@example.com', password: 'correct horse battery staple' }),
    }))
    expect(workbench.reset).toHaveBeenCalledWith(undefined)
    expect(workbench.bootstrap).toHaveBeenCalledOnce()
  })

  it('错误凭据和服务不可用只显示稳定中文文案', async () => {
    const workbench = bridge()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('unauthenticated', { status: 401, headers: { 'x-xagent-auth': '1' } }))
      .mockResolvedValueOnce(new Response('secret detail', { status: 401 }))
    const controller = new AccountController(workbench, fetcher)
    mount(controller)
    await act(async () => { await controller.start() })
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'a@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect((await screen.findByRole('alert')).textContent).toBe('邮箱或密码错误')
    expect(screen.queryByText('secret detail')).toBeNull()
  })

  it('退出携带 Cookie 与 CSRF；204/401 清空账号，503 则保留账号', async () => {
    const workbench = bridge()
    await workbench.bootstrap()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'x-xagent-auth': '1' } }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    document.cookie = 'xagent_csrf=csrf-cookie; Path=/'
    const controller = new AccountController(workbench, fetcher)
    mount(controller)
    await act(async () => { await controller.start() })
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    expect((await screen.findByRole('alert')).textContent).toBe('退出服务暂时不可用')
    expect(screen.getByText('manager@example.com')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    await waitFor(() => { expect(screen.getByRole('dialog', { name: '登录工作空间' })).toBeTruthy() })
    expect(fetcher).toHaveBeenLastCalledWith('/auth/logout', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', headers: { 'x-xagent-csrf': 'csrf-cookie' },
    }))
    expect(workbench.reset).toHaveBeenCalledWith(undefined)
  })

  it.each([204, 401])('退出返回 %s 时清空账号并回到登录页', async (status) => {
    const workbench = bridge()
    await workbench.bootstrap()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'x-xagent-auth': '1' } }))
      .mockResolvedValueOnce(new Response(null, { status }))
    const controller = new AccountController(workbench, fetcher)
    mount(controller)
    await act(async () => { await controller.start() })
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    await waitFor(() => { expect(screen.getByRole('dialog', { name: '登录工作空间' })).toBeTruthy() })
    expect(workbench.reset).toHaveBeenCalledWith(undefined)
  })

  it('旧账号的迟到 Bootstrap 不会覆盖退出后的登录状态', async () => {
    let finishBootstrap: (() => void) | undefined
    const workbench = bridge()
    workbench.bootstrap.mockImplementationOnce(() => new Promise<void>((resolve) => { finishBootstrap = resolve }))
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'x-xagent-auth': '1' } }))
    const controller = new AccountController(workbench, fetcher)
    mount(controller)
    const start = controller.start()
    controller.resetToLogin()
    finishBootstrap?.()
    await act(async () => { await start })
    expect(screen.getByRole('dialog', { name: '登录工作空间' })).toBeTruthy()
  })
})
