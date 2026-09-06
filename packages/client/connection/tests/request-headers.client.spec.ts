// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { BrowserRequestHeadersService } from '../src/client/request-headers.ts'
import { createWebConnectionRpc } from '../src/client/rpc.ts'
import { WebApiClient } from '../src/client/web-api-client.ts'

class ExposedWebApiClient extends WebApiClient {
  fetch(input: URL, init?: RequestInit): Promise<Response> {
    return this.doFetch(input, init)
  }
}

describe('浏览器 RPC 请求头贡献', () => {
  it('默认保持基础请求头，并随贡献者生命周期增删字段', () => {
    const service = new BrowserRequestHeadersService(new Context())
    const dispose = service.register(() => ({ 'x-fixture-token': 'token' }))
    expect(Object.fromEntries(service.resolve({ 'content-type': 'application/json' }))).toEqual({
      'content-type': 'application/json',
      'x-fixture-token': 'token',
    })
    dispose()
    expect(Object.fromEntries(service.resolve())).toEqual({})
  })

  it('忽略空贡献并拒绝静默覆盖已有字段', () => {
    const service = new BrowserRequestHeadersService(new Context())
    service.register(() => undefined)
    service.register(() => ({ 'content-type': 'text/plain' }))
    expect(() => service.resolve({ 'content-type': 'application/json' }))
      .toThrow('browser request header "content-type" is already set')
  })

  it('贡献者返回空值时保留 RPC 默认请求头', async () => {
    const originalFetch = globalThis.fetch
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new TypeError('Expected a JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string }
      return Response.json({
        type: 'server-response',
        rpcId: request.rpcId,
        result: { ok: true, value: 'accepted' },
      })
    })
    globalThis.fetch = fetcher
    try {
      const service = { resolve: () => undefined } as unknown as BrowserRequestHeadersService
      await expect(createWebConnectionRpc(service).call('/fixture', 'accept', {}, undefined))
        .resolves.toEqual({ ok: true, value: 'accepted' })
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('content-type')).toBe('application/json')
  })

  it('Web API 请求在没有请求头时不注入空 headers 字段', async () => {
    const originalFetch = globalThis.fetch
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({}))
    globalThis.fetch = fetcher
    try {
      await new ExposedWebApiClient().fetch(new URL('https://example.test/api'))
      const service = { resolve: () => undefined } as unknown as BrowserRequestHeadersService
      await new ExposedWebApiClient(service).fetch(
        new URL('https://example.test/api'),
        { headers: { 'x-fixture': 'preserved' } },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(fetcher.mock.calls[0]![1]).not.toHaveProperty('headers')
    expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('x-fixture')).toBe('preserved')
  })
})
