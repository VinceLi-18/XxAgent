/** 固定访问 XAgent FastAPI 内部接口的 Host 客户端。 @module @xagent/dsh-backend-client */

import { randomUUID } from 'node:crypto'
import { parseXAgentPrincipal, type XAgentPrincipal } from '@xagent/dsh-principal'
import type { XAgentBackend, XAgentBackendErrorCode, XAgentSessionBackend } from './types.ts'

export type { XAgentBackend, XAgentBackendErrorCode, XAgentSessionBackend } from './types.ts'

const STABLE_CODES = new Set<XAgentBackendErrorCode>([
  'unauthenticated',
  'not-found',
  'sequence-conflict',
  'idempotency-conflict',
  'unsupported-version',
  'service-unavailable',
])

export class XAgentBackendError extends Error {
  constructor(readonly code: XAgentBackendErrorCode) {
    super(`XAgent backend request failed: ${code}`)
    this.name = 'XAgentBackendError'
  }
}

export interface XAgentBackendClientOptions {
  origin: string
  serviceToken: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maxResponseBytes?: number
  connectionId?: () => string
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new XAgentBackendError('service-unavailable')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

function errorCode(status: number, value: unknown): XAgentBackendErrorCode {
  if (status === 401) return 'unauthenticated'
  const detail = typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>).detail
    : undefined
  const code = typeof detail === 'object' && detail !== null
    ? (detail as Record<string, unknown>).code
    : undefined
  return typeof code === 'string' && STABLE_CODES.has(code as XAgentBackendErrorCode)
    ? code as XAgentBackendErrorCode
    : 'service-unavailable'
}

export class XAgentBackendClient implements XAgentBackend {
  private readonly origin: URL
  private readonly fetcher: typeof globalThis.fetch
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly connectionId: () => string
  readonly sessions: XAgentSessionBackend

  constructor(private readonly options: XAgentBackendClientOptions) {
    const origin = new URL(options.origin)
    this.origin = new URL(origin.origin)
    this.fetcher = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024
    this.connectionId = options.connectionId ?? randomUUID
    const sessions: XAgentSessionBackend = {
      list: (token, signal) => this.request(token, '/internal/xagent/sessions/list', { schema_version: 1 }, signal),
      create: (token, body, signal) => this.request(token, '/internal/xagent/sessions', body, signal),
      open: (token, id, signal) => this.request(token, `/internal/xagent/sessions/${encodeURIComponent(id)}/open`, { schema_version: 1 }, signal),
      events: (token, id, body, signal) => this.request(token, `/internal/xagent/sessions/${encodeURIComponent(id)}/events`, body, signal),
      append: (token, id, body, signal) => this.request(token, `/internal/xagent/sessions/${encodeURIComponent(id)}/append`, body, signal),
      fork: (token, id, body, signal) => this.request(token, `/internal/xagent/sessions/${encodeURIComponent(id)}/fork`, body, signal),
      archive: (token, id, body, signal) => this.request(token, `/internal/xagent/sessions/${encodeURIComponent(id)}/archive`, body, signal),
    }
    this.sessions = Object.freeze(sessions)
  }

  async introspect(userToken: string, signal?: AbortSignal): Promise<XAgentPrincipal> {
    const value = await this.request(userToken, '/internal/xagent/auth/introspect', undefined, signal)
    try {
      return parseXAgentPrincipal(value, this.connectionId())
    } catch {
      throw new XAgentBackendError('service-unavailable')
    }
  }

  async revoke(userToken: string, signal?: AbortSignal): Promise<void> {
    await this.request(userToken, '/internal/xagent/auth/revoke', undefined, signal, true)
  }

  private async request(
    userToken: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    allowEmpty = false,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([timeout, signal])
    let response: Response
    try {
      const init: RequestInit = {
        method: 'POST',
        redirect: 'manual',
        signal: requestSignal,
        headers: {
          authorization: `Bearer ${userToken}`,
          'content-type': 'application/json',
          'x-xagent-service-token': this.options.serviceToken,
        },
      }
      if (body !== undefined) init.body = JSON.stringify(body)
      response = await this.fetcher(new URL(path, this.origin), init)
      const raw = await readBounded(response, this.maxResponseBytes)
      let value: unknown
      try {
        value = raw === '' && allowEmpty ? undefined : JSON.parse(raw)
      } catch {
        throw new XAgentBackendError('service-unavailable')
      }
      if (!response.ok) throw new XAgentBackendError(errorCode(response.status, value))
      return value
    } catch (error) {
      if (error instanceof XAgentBackendError) throw error
      throw new XAgentBackendError('service-unavailable')
    }
  }
}
