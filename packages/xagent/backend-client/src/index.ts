/** 固定访问 XAgent FastAPI 内部接口的 Host 客户端。 @module @xagent/dsh-backend-client */

import { randomUUID } from 'node:crypto'
import { parseXAgentPrincipal, type XAgentPrincipal } from '@xagent/dsh-principal'
import type {
  XAgentBackend,
  XAgentBackendErrorCode,
  XAgentCapability,
  XAgentIssuedLogin,
  XAgentProjectDetail,
  XAgentProjectSummary,
  XAgentSessionBackend,
  XAgentWorkbenchBackend,
  XAgentWorkbenchBootstrap,
  XAgentWorkbenchContext,
} from './types.ts'

export type {
  XAgentBackend,
  XAgentBackendErrorCode,
  XAgentCapability,
  XAgentIssuedLogin,
  XAgentProjectDetail,
  XAgentProjectSummary,
  XAgentSessionBackend,
  XAgentSessionProjectRefsInput,
  XAgentWorkbenchBackend,
  XAgentWorkbenchBootstrap,
  XAgentWorkbenchContext,
} from './types.ts'

const STABLE_CODES = new Set<XAgentBackendErrorCode>([
  'unauthenticated',
  'forbidden',
  'not-found',
  'session-not-found',
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
  maxRequestBytes?: number
  maxResponseBytes?: number
  connectionId?: () => string
}

function failSchema(): never {
  throw new XAgentBackendError('service-unavailable')
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) failSchema()
  return value as Record<string, unknown>
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = record(value)
  const actual = Object.keys(row).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) failSchema()
  return row
}

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function requiredUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) failSchema()
  return value
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) failSchema()
  return value
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) failSchema()
  return value as number
}

function parseContext(value: unknown): XAgentWorkbenchContext {
  const row = exactRecord(value, ['kind', 'project_id'])
  if (row.kind === 'workbench' && row.project_id === null) return { kind: 'workbench' }
  if (row.kind === 'project') return { kind: 'project', projectId: requiredUuid(row.project_id) }
  return failSchema()
}

function parseProjectSummary(value: unknown): XAgentProjectSummary {
  const row = exactRecord(value, ['id', 'name', 'created_at'])
  const createdAt = requiredString(row.created_at)
  if (!Number.isFinite(Date.parse(createdAt))) failSchema()
  return {
    id: requiredUuid(row.id),
    name: requiredString(row.name),
    createdAt,
  }
}

function parseBootstrap(value: unknown): XAgentWorkbenchBootstrap {
  const row = exactRecord(value, [
    'schema_version',
    'account',
    'capabilities',
    'context',
    'projects',
    'session_summary',
  ])
  if (row.schema_version !== 1) failSchema()
  const account = exactRecord(row.account, ['id', 'email', 'role', 'permission_revision'])
  if (
    account.role !== 'manager' && account.role !== 'specialist'
    || !Number.isSafeInteger(account.permission_revision)
    || (account.permission_revision as number) < 1
  ) failSchema()
  if (!Array.isArray(row.capabilities)) failSchema()
  const capabilities = (row.capabilities as unknown[]).map((capability): XAgentCapability => {
    if (capability !== 'project.create') failSchema()
    return 'project.create'
  })
  if (new Set(capabilities).size !== capabilities.length) failSchema()
  if (!Array.isArray(row.projects)) failSchema()
  const projects = row.projects.map(parseProjectSummary)
  const projectIds = projects.map(project => project.id)
  if (new Set(projectIds).size !== projectIds.length) failSchema()
  const summary = exactRecord(row.session_summary, ['private_count', 'project_counts'])
  const projectCountsRow = record(summary.project_counts)
  const projectCounts: Record<string, number> = {}
  for (const [projectId, value] of Object.entries(projectCountsRow)) {
    requiredUuid(projectId)
    projectCounts[projectId] = count(value)
  }
  const countedProjectIds = Object.keys(projectCounts).sort()
  const expectedProjectIds = [...projectIds].sort()
  if (
    countedProjectIds.length !== expectedProjectIds.length
    || countedProjectIds.some((projectId, index) => projectId !== expectedProjectIds[index])
  ) failSchema()
  return {
    account: {
      id: requiredUuid(account.id),
      email: requiredString(account.email),
      role: account.role,
      permissionRevision: account.permission_revision as number,
    },
    capabilities,
    context: parseContext(row.context),
    projects,
    sessionSummary: {
      privateCount: count(summary.private_count),
      projectCounts,
    },
  }
}

function parseContextSelection(value: unknown): string {
  const row = exactRecord(value, ['schema_version', 'account_id', 'context'])
  if (row.schema_version !== 1) failSchema()
  parseContext(row.context)
  return requiredUuid(row.account_id)
}

function parseCreatedProject(value: unknown): string {
  const row = exactRecord(value, ['schema_version', 'account_id', 'project', 'context'])
  if (row.schema_version !== 1) failSchema()
  const project = parseProjectSummary(row.project)
  const context = parseContext(row.context)
  if (context.kind !== 'project' || context.projectId !== project.id) failSchema()
  return requiredUuid(row.account_id)
}

function parseProjectDetail(value: unknown): XAgentProjectDetail {
  const row = exactRecord(value, ['schema_version', 'account_id', 'project', 'access', 'session_summary'])
  if (row.schema_version !== 1) failSchema()
  const access = exactRecord(row.access, ['can_edit'])
  const summary = exactRecord(row.session_summary, ['session_count'])
  if (typeof access.can_edit !== 'boolean') failSchema()
  const project = parseProjectSummary(row.project)
  return {
    accountId: requiredUuid(row.account_id),
    ...project,
    canEdit: access.can_edit,
    sessionCount: count(summary.session_count),
  }
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
  private readonly maxRequestBytes: number
  private readonly maxResponseBytes: number
  private readonly connectionId: () => string
  readonly sessions: XAgentSessionBackend
  readonly workbench: XAgentWorkbenchBackend

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
    this.maxRequestBytes = options.maxRequestBytes ?? 1024 * 1024
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
    const bootstrap = async (token: string, signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap> =>
      parseBootstrap(await this.request(
        token,
        '/internal/xagent/workbench/bootstrap',
        { schema_version: 1 },
        signal,
      ))
    const workbench: XAgentWorkbenchBackend = {
      bootstrap,
      selectContext: async (token, context, signal) => {
        const accountId = parseContextSelection(await this.request(
          token,
          '/internal/xagent/workbench/context',
          {
            schema_version: 1,
            kind: context.kind,
            project_id: context.kind === 'project' ? context.projectId : null,
          },
          signal,
        ))
        const result = await bootstrap(token, signal)
        if (result.account.id !== accountId) failSchema()
        return result
      },
      createProject: async (token, input, signal) => {
        const accountId = parseCreatedProject(await this.request(
          token,
          '/internal/xagent/projects',
          {
            schema_version: 1,
            name: input.name,
            idempotency_key: input.idempotencyKey,
          },
          signal,
        ))
        const result = await bootstrap(token, signal)
        if (result.account.id !== accountId) failSchema()
        return result
      },
      project: async (token, projectId, signal) => parseProjectDetail(await this.request(
        token,
        `/internal/xagent/projects/${encodeURIComponent(projectId)}`,
        { schema_version: 1 },
        signal,
      )),
      addSessionProjectRefs: async (token, input, signal) => {
        const value = await this.request(
          token,
          '/internal/xagent/session-project-refs',
          {
            schema_version: 1,
            session_id: input.sessionId,
            project_ids: input.projectIds,
            idempotency_key: input.idempotencyKey,
          },
          signal,
          true,
        )
        if (value !== undefined) failSchema()
      },
    }
    this.workbench = Object.freeze(workbench)
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
      if (body !== undefined) {
        const encoded = JSON.stringify(body)
        if (new TextEncoder().encode(encoded).byteLength > this.maxRequestBytes) {
          throw new XAgentBackendError('service-unavailable')
        }
        init.body = encoded
      }
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
