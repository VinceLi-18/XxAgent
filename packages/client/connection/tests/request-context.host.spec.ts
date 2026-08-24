import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { apply, HostConnectionService, inject } from '../src/index.ts'
import type { ConnectionRequestContextResolver, ConnectionRpcHandler } from '../src/rpc.ts'

function server(routes: WebRoute[]): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
    registerUpgrade: () => () => {},
    tapIndex: () => () => {},
    port: 0,
  }
}

function request(token = 'browser-secret'): IncomingMessage {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'probe/read', payload: {} })
  return Object.assign(Readable.from([Buffer.from(body)]), {
    url: '/rpc/probe/read',
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', cookie: `xagent_session=${token}` },
  }) as unknown as IncomingMessage
}

function response(): { raw: ServerResponse; state: { status: number | undefined; body: string } } {
  const chunks: Buffer[] = []
  const state = { status: undefined as number | undefined, body: '' }
  const raw = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(status: number) { state.status = status; return this },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: string | Uint8Array) {
      if (value !== undefined) chunks.push(Buffer.from(value))
      state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { raw, state }
}

async function mount(resolver?: ConnectionRequestContextResolver) {
  const ctx = new Context()
  const routes: WebRoute[] = []
  ctx.provide('webServer', server(routes) as WebServer)
  if (resolver !== undefined) ctx.provide('connectionRequestContextResolver', resolver)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber
  return { ctx, routes, dispose: () => fiber.dispose() }
}

describe('Connection 请求上下文', () => {
  test('未安装 resolver 时保持兼容并生成 Host connectionId', async () => {
    const { ctx, routes, dispose } = await mount()
    const seen: unknown[] = []
    const remove = ctx.connection.rpc.handle('/rpc', async (_endpoint, _payload, _signal, context) => {
      seen.push(context)
      return { ok: true, value: 'ok' }
    }, { authority: 'trusted-host' })
    const output = response()

    await routes.find(route => route.path === '/rpc')!.handler(request(), output.raw)

    expect(output.state.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ requestId: 'rpc-1' })
    expect(typeof (seen[0] as { connectionId?: unknown }).connectionId).toBe('string')
    await remove()
    await dispose()
  })

  test('resolver 在 handler 前运行且不能覆盖 Host connectionId', async () => {
    const resolver = { resolve: vi.fn(async (_request: Request, connectionId: string) => ({
      principal: { actorId: 'alice' },
      userToken: 'browser-secret',
      connectionId: `forged-${connectionId}`,
    })) }
    const { ctx, routes, dispose } = await mount(resolver)
    const handler = vi.fn<ConnectionRpcHandler>(async (_endpoint, _payload, _signal, context) => (
      { ok: true as const, value: context }
    ))
    const remove = ctx.connection.rpc.handle('/rpc', handler, { authority: 'trusted-host' })
    const output = response()

    await routes.find(route => route.path === '/rpc')!.handler(request(), output.raw)

    expect(resolver.resolve).toHaveBeenCalledOnce()
    const generated = resolver.resolve.mock.calls[0]![1]
    expect(handler).toHaveBeenCalledWith('probe/read', {}, expect.any(AbortSignal), {
      principal: { actorId: 'alice' },
      userToken: 'browser-secret',
      connectionId: generated,
      requestId: 'rpc-1',
    })
    await remove()
    await dispose()
  })

  test('认证拒绝不会调用 handler 或回显异常和凭据', async () => {
    const resolver = { resolve: vi.fn(async () => { throw new Error('browser-secret leaked') }) }
    const { ctx, routes, dispose } = await mount(resolver)
    const handler = vi.fn(async () => ({ ok: true as const, value: 'forbidden' }))
    const remove = ctx.connection.rpc.handle('/rpc', handler, { authority: 'trusted-host' })
    const output = response()

    await routes.find(route => route.path === '/rpc')!.handler(request(), output.raw)

    expect(output.state.status).toBe(401)
    expect(output.state.body).toBe('unauthenticated')
    expect(handler).not.toHaveBeenCalled()
    expect(output.state.body).not.toContain('browser-secret')
    await remove()
    await dispose()
  })

  test('共享 fallback 同样认证，并保留 resolver 省略的可选字段', async () => {
    const rejected = await mount({ resolve: vi.fn(async () => { throw new Error('secret') }) })
    const denied = (rejected.ctx.connection as HostConnectionService).createSharedFetchHandler('/api', {
      fetch: vi.fn(async () => new Response('fallback')),
    })
    await expect(denied.fetch(new Request('http://localhost/api/unclaimed')))
      .resolves.toMatchObject({ status: 401 })
    await rejected.dispose()

    const accepted = await mount({ resolve: vi.fn(async () => ({})) })
    const seen: unknown[] = []
    const fallback = (accepted.ctx.connection as HostConnectionService).createSharedFetchHandler('/api', {
      fetch: vi.fn(async (_request, requestContext) => {
        seen.push(requestContext)
        return new Response('fallback')
      }),
    })
    const response = await fallback.fetch(new Request('http://localhost/api/unclaimed'))
    expect(response.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(typeof (seen[0] as { connectionId: unknown }).connectionId).toBe('string')
    await accepted.dispose()
  })
})
