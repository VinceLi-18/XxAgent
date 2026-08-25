// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { BrowserRequestHeadersService } from '../src/client/request-headers.ts'

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
})
