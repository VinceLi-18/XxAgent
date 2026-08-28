import { describe, expect, test, vi } from 'vitest'
import {
  BGE_M3_MODEL_ID,
  BGE_M3_REVISION,
  MAX_BGE_M3_QUERY_BYTES,
  MAX_BGE_M3_RESPONSE_BYTES,
  XAgentBgeM3HttpTokenizer,
} from '../src/tokenizer.ts'

function response(body: BodyInit = JSON.stringify({
  model: BGE_M3_MODEL_ID,
  revision: BGE_M3_REVISION,
  token_count: 17,
}), init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('XAgentBgeM3HttpTokenizer', () => {
  test('rejects an oversized UTF-8 query before transport', async () => {
    const fetch = vi.fn(async () => response())
    const tokenizer = new XAgentBgeM3HttpTokenizer('http://embedding.internal', fetch)

    await expect(tokenizer.count('资'.repeat(Math.floor(MAX_BGE_M3_QUERY_BYTES / 3) + 1)))
      .rejects.toThrow('BGE-M3 tokenizer request rejected')
    expect(fetch).not.toHaveBeenCalled()
  })

  test('always applies its fixed timeout, caller cancellation, and redirect refusal', async () => {
    const successTimeout = new AbortController()
    const directTimeout = new AbortController()
    const callerTimeout = new AbortController()
    const timeouts = [successTimeout, directTimeout, callerTimeout]
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => timeouts.shift()?.signal ?? AbortSignal.abort())
    const fetch = vi.fn(async (_input: string, init: RequestInit) => {
      expect(init.redirect).toBe('manual')
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return response()
    })
    const tokenizer = new XAgentBgeM3HttpTokenizer('http://embedding.internal', fetch)

    await expect(tokenizer.count('direct call')).resolves.toBe(17)

    const directStall = vi.fn((_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }))
    const direct = new XAgentBgeM3HttpTokenizer('http://embedding.internal', directStall)
    const directPending = direct.count('direct timeout')
    directTimeout.abort()
    await expect(directPending).rejects.toThrow('BGE-M3 tokenizer unavailable')

    const caller = new AbortController()
    const stalled = vi.fn((_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }))
    const cancellable = new XAgentBgeM3HttpTokenizer('http://embedding.internal', stalled)
    const pending = cancellable.count('cancel me', caller.signal)
    caller.abort()
    await expect(pending).rejects.toThrow('BGE-M3 tokenizer unavailable')
    expect(timeoutSpy).toHaveBeenCalledTimes(3)
    expect(new Set(timeoutSpy.mock.calls.map(call => call[0])).size).toBe(1)
    timeoutSpy.mockRestore()
  })

  test('rejects redirects, non-200 status, and a non-exact JSON content type', async () => {
    for (const invalid of [
      response('', { status: 302, headers: { location: 'http://elsewhere/token-count' } }),
      response('', { status: 201 }),
      response('{}', { headers: { 'content-type': 'application/problem+json' } }),
      response('{}', { headers: { 'content-type': 'application/json; charset=utf-8' } }),
    ]) {
      const tokenizer = new XAgentBgeM3HttpTokenizer('http://embedding.internal', async () => invalid)
      await expect(tokenizer.count('query')).rejects.toThrow('BGE-M3 tokenizer unavailable')
    }
  })

  test('bounds and fatally decodes the streamed response before closed-schema validation', async () => {
    const cases: BodyInit[] = [
      new Uint8Array(MAX_BGE_M3_RESPONSE_BYTES + 1),
      new Uint8Array([0xc3, 0x28]),
      '{',
      JSON.stringify({
        model: BGE_M3_MODEL_ID,
        revision: BGE_M3_REVISION,
        token_count: 1,
        extra: true,
      }),
      JSON.stringify({ model: BGE_M3_MODEL_ID, revision: BGE_M3_REVISION, token_count: 1.5 }),
    ]

    for (const body of cases) {
      const tokenizer = new XAgentBgeM3HttpTokenizer('http://embedding.internal', async () => response(body))
      await expect(tokenizer.count('query')).rejects.toThrow('BGE-M3 tokenizer response rejected')
    }

    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('sensitive transport detail')) },
    })
    const failed = new XAgentBgeM3HttpTokenizer('http://embedding.internal', async () => response(failedBody))
    await expect(failed.count('query')).rejects.toThrow(/^BGE-M3 tokenizer unavailable$/u)
  })

  test('aborts a stalled response stream after transport success', async () => {
    const caller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
    })
    const tokenizer = new XAgentBgeM3HttpTokenizer('http://embedding.internal', async () => response(body))

    const pending = tokenizer.count('query', caller.signal)
    caller.abort()
    await expect(pending).rejects.toThrow('BGE-M3 tokenizer unavailable')
  })
})
