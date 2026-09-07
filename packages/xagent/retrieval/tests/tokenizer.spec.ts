import { describe, expect, test, vi } from 'vitest'
import {
  BGE_M3_MODEL_ID,
  BGE_M3_REVISION,
  MAX_BGE_M3_QUERY_BYTES,
  MAX_BGE_M3_REQUEST_BYTES,
  MAX_BGE_M3_RESPONSE_BYTES,
  XAgentBgeM3HttpTokenizer,
  validateBgeM3Tokenizer,
} from '../src/tokenizer.ts'

function response(body: BodyInit | null = JSON.stringify({
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
  test('uses the authenticated backend relay and bounds every legal escaped body', async () => {
    const requests: Array<{ input: string; init: RequestInit }> = []
    const fetch = vi.fn(async (input: string, init: RequestInit) => {
      requests.push({ input, init })
      return response()
    })
    const tokenizer = new XAgentBgeM3HttpTokenizer(
      'http://api.internal/base',
      'service-secret',
      fetch,
    )

    for (const query of [
      '"'.repeat(MAX_BGE_M3_QUERY_BYTES),
      '\\'.repeat(MAX_BGE_M3_QUERY_BYTES),
      '\u0000'.repeat(MAX_BGE_M3_QUERY_BYTES),
      '😀'.repeat(MAX_BGE_M3_QUERY_BYTES / 4),
      'é'.repeat(MAX_BGE_M3_QUERY_BYTES / 2),
    ]) {
      await expect(tokenizer.count(query)).resolves.toBe(17)
    }

    expect(requests).toHaveLength(5)
    const requestSizes: number[] = []
    for (const request of requests) {
      expect(request.input).toBe('http://api.internal/internal/xagent/retrieval/token-count')
      expect(new Headers(request.init.headers).get('x-xagent-service-token')).toBe('service-secret')
      const requestSize = new TextEncoder().encode(request.init.body as string).byteLength
      requestSizes.push(requestSize)
      expect(requestSize).toBeLessThanOrEqual(MAX_BGE_M3_REQUEST_BYTES)
      expect(new Headers(request.init.headers).has('authorization')).toBe(false)
      expect(new Headers(request.init.headers).has('x-xagent-delegation')).toBe(false)
    }
    expect(Math.max(...requestSizes)).toBe(MAX_BGE_M3_REQUEST_BYTES)
  })

  test('rejects malformed UTF-16 and one raw byte over before serialization', async () => {
    const fetch = vi.fn(async () => response())
    const tokenizer = new XAgentBgeM3HttpTokenizer('http://api.internal', 'service-secret', fetch)

    for (const query of ['\ud800', '\udc00', 'x\ud800y', 'x\udc00y']) {
      await expect(tokenizer.count(query)).rejects.toThrow('BGE-M3 tokenizer request rejected')
    }
    await expect(tokenizer.count('x'.repeat(MAX_BGE_M3_QUERY_BYTES + 1)))
      .rejects.toThrow('BGE-M3 tokenizer request rejected')
    expect(fetch).not.toHaveBeenCalled()
  })

  test('rejects an oversized UTF-8 query before transport', async () => {
    const fetch = vi.fn(async () => response())
    const tokenizer = new XAgentBgeM3HttpTokenizer('http://api.internal', 'service-secret', fetch)

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
    const tokenizer = new XAgentBgeM3HttpTokenizer('http://api.internal', 'service-secret', fetch)

    await expect(tokenizer.count('direct call')).resolves.toBe(17)

    const directStall = vi.fn((_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }))
    const direct = new XAgentBgeM3HttpTokenizer('http://api.internal', 'service-secret', directStall)
    const directPending = direct.count('direct timeout')
    directTimeout.abort()
    await expect(directPending).rejects.toThrow('BGE-M3 tokenizer unavailable')

    const caller = new AbortController()
    const stalled = vi.fn((_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }))
    const cancellable = new XAgentBgeM3HttpTokenizer('http://api.internal', 'service-secret', stalled)
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
      const tokenizer = new XAgentBgeM3HttpTokenizer('http://api.internal', 'service-secret', async () => invalid)
      await expect(tokenizer.count('query')).rejects.toThrow('BGE-M3 tokenizer unavailable')
    }
  })

  test('rejects invalid relay configuration before transport', () => {
    expect(() => new XAgentBgeM3HttpTokenizer('not a URL', 'service-secret'))
      .toThrow('invalid XAgent tokenizer configuration')
    expect(() => new XAgentBgeM3HttpTokenizer('file:///tmp/tokenizer', 'service-secret'))
      .toThrow('invalid XAgent tokenizer configuration')
    expect(() => new XAgentBgeM3HttpTokenizer('https://api.internal', ''))
      .toThrow('invalid XAgent tokenizer configuration')
  })

  test('bounds and fatally decodes the streamed response before closed-schema validation', async () => {
    const cases: BodyInit[] = [
      null as never,
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
      'null',
      '[]',
      '1',
    ]

    for (const body of cases) {
      const tokenizer = new XAgentBgeM3HttpTokenizer('http://api.internal', 'service-secret', async () => response(body))
      await expect(tokenizer.count('query')).rejects.toThrow('BGE-M3 tokenizer response rejected')
    }

    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('sensitive transport detail')) },
    })
    const failed = new XAgentBgeM3HttpTokenizer('http://api.internal', 'service-secret', async () => response(failedBody))
    await expect(failed.count('query')).rejects.toThrow(/^BGE-M3 tokenizer unavailable$/u)
  })

  test('aborts a stalled response stream after transport success', async () => {
    const caller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
    })
    const tokenizer = new XAgentBgeM3HttpTokenizer('http://api.internal', 'service-secret', async () => response(body))

    const pending = tokenizer.count('query', caller.signal)
    caller.abort()
    await expect(pending).rejects.toThrow('BGE-M3 tokenizer unavailable')
  })

  test('contains stream cancellation failures for abort and oversized responses', async () => {
    const caller = new AbortController()
    let started!: () => void
    const reading = new Promise<void>((resolve) => { started = resolve })
    const stalledBody = new ReadableStream<Uint8Array>({
      pull: () => {
        started()
        return new Promise<void>(() => {})
      },
      cancel: () => { throw new Error('cancel failed') },
    })
    const stalled = new XAgentBgeM3HttpTokenizer(
      'http://api.internal', 'service-secret', async () => response(stalledBody),
    )
    const pending = stalled.count('query', caller.signal)
    await reading
    caller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('BGE-M3 tokenizer unavailable')

    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_BGE_M3_RESPONSE_BYTES + 1)) },
      cancel: () => { throw new Error('cancel failed') },
    })
    const oversized = new XAgentBgeM3HttpTokenizer(
      'http://api.internal', 'service-secret', async () => response(oversizedBody),
    )
    await expect(oversized.count('query')).rejects.toThrow('BGE-M3 tokenizer response rejected')
  })

  test('accepts only the exact pinned tokenizer provider', () => {
    const valid = { modelId: BGE_M3_MODEL_ID, revision: BGE_M3_REVISION, count: async () => 1 }
    expect(validateBgeM3Tokenizer(valid)).toBe(valid)
    expect(() => validateBgeM3Tokenizer(undefined)).toThrow('requires the pinned BGE-M3 tokenizer')
    expect(() => validateBgeM3Tokenizer({ ...valid, modelId: 'other' }))
      .toThrow('requires the pinned BGE-M3 tokenizer')
    expect(() => validateBgeM3Tokenizer({ ...valid, revision: 'other' }))
      .toThrow('requires the pinned BGE-M3 tokenizer')
  })
})
