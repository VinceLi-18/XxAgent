/** 固定访问 XAgent FastAPI 内部接口的 Host 客户端。 @module @xagent/dsh-backend-client */

import { randomUUID } from 'node:crypto'
import { parseXAgentPrincipal, type XAgentPrincipal } from '@xagent/dsh-principal'
import type {
  XAgentBackend,
  XAgentBackendErrorCode,
  XAgentIssuedLogin,
  XAgentSessionBackend,
} from './types.ts'

export type {
  XAgentBackend,
  XAgentBackendErrorCode,
  XAgentIssuedLogin,
  XAgentSessionBackend,
} from './types.ts'

const STABLE_CODES = new Set<XAgentBackendErrorCode>([
  'unauthenticated',
  'not-found',
  'sequence-conflict',
  'idempotency-conflict',
  'unsupported-version',
  'service-unavailable',
])

/** Stable fail-closed error returned by the XAgent backend boundary. */
export class XAgentBackendError extends Error {
  constructor(readonly code: XAgentBackendErrorCode) {
    super(`XAgent backend request failed: ${code}`)
    this.name = 'XAgentBackendError'
  }
}

/** Network, service-identity, timeout, and response-limit settings for the Host client. */
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

/** Bounded Host client for XAgent authentication and Session APIs. */
export class XAgentBackendClient implements XAgentBackend {
  private readonly origin: URL
  private readonly fetcher: typeof globalThis.fetch
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly connectionId: () => string
  readonly sessions: XAgentSessionBackend

  constructor(private readonly options: XAgentBackendClientOptions) {
    let origin: URL
    try {
      origin = new URL(options.origin)
    } catch {
      throw new TypeError('invalid XAgent backend configuration')
    }
    if ((origin.protocol !== 'http:' && origin.protocol !== 'https:') || options.serviceToken.length === 0) {
      throw new TypeError('invalid XAgent backend configuration')
    }
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
      authorize: async (token, id, operation, signal) => {
        await this.request(
          token,
          `/internal/xagent/sessions/${encodeURIComponent(id)}/authorize`,
          { schema_version: 1, operation },
          signal,
          true,
        )
      },
    }
    this.sessions = Object.freeze(sessions)
  }

  async login(email: string, password: string, signal?: AbortSignal): Promise<XAgentIssuedLogin> {
    const value = await this.request(
      undefined,
      '/api/v1/auth/login',
      { email, password },
      signal,
      false,
      false,
    )
    if (typeof value !== 'object' || value === null) {
      throw new XAgentBackendError('service-unavailable')
    }
    const record = value as Record<string, unknown>
    if (
      record.token_type !== 'bearer'
      || typeof record.access_token !== 'string'
      || record.access_token.length === 0
      || typeof record.expires_at !== 'string'
      || record.expires_at.length === 0
      || typeof record.csrf_token !== 'string'
      || record.csrf_token.length === 0
    ) {
      throw new XAgentBackendError('service-unavailable')
    }
    return {
      accessToken: record.access_token,
      expiresAt: record.expires_at,
      csrfToken: record.csrf_token,
    }
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
    userToken: string | undefined,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    allowEmpty = false,
    internal = true,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([timeout, signal])
    let response: Response
    try {
      const headers = new Headers({ 'content-type': 'application/json' })
      if (internal) {
        if (userToken === undefined) throw new XAgentBackendError('unauthenticated')
        headers.set('authorization', `Bearer ${userToken}`)
        headers.set('x-xagent-service-token', this.options.serviceToken)
      }
      const init: RequestInit = {
        method: 'POST',
        redirect: 'manual',
        signal: requestSignal,
        headers,
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
