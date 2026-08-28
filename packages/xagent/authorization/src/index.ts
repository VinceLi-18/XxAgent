/** XAgent Business Session RPC 的统一授权服务。 @module @xagent/dsh-authorization */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ConnectionRequestAuthorizer,
  ConnectionRequestContext,
} from '@deepseek-ai/dsh-client-connection'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { XAgentBackendClient, XAgentBackendError, type XAgentBackend } from '@xagent/dsh-backend-client'
import type { XAgentArtifactScopeRunner } from '@xagent/dsh-artifact'
import {
  runWithXAgentAuthenticatedRequestScope,
  type XAgentAuthenticatedRequestScope,
  type XAgentAuthenticatedSessionRequestScope,
  type XAgentPrincipal,
} from '@xagent/dsh-principal'
import type {
  XAgentProjectScopeRunner,
} from '@xagent/dsh-project'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SESSION_ID_PATTERN = /^(?:session-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

type Permission = 'read' | 'edit'

const SESSION_PERMISSIONS = new Map<string, Permission | 'list' | 'create'>([
  ['list', 'list'],
  ['search', 'list'],
  ['create', 'create'],
  ['history', 'read'],
  ['models', 'read'],
  ['selectModel', 'edit'],
  ['rename', 'edit'],
  ['fork', 'read'],
  ['prompt', 'edit'],
  ['attachment', 'read'],
  ['updateQueue', 'edit'],
  ['cancel', 'edit'],
])

/** Remote Session Persistence operations that require an explicit user-token scope. */
export interface TokenScopedPersistence {
  withUserToken<T>(userToken: string, operation: () => Promise<T>): Promise<T>
  authorizeRequest?(sessionId: string, requestId: string | undefined, userToken: string): void
  flushSession?(sessionId: string): Promise<void>
}

/** XAgent Session authorization plugin configuration. */
export interface Config {
  /** FastAPI 服务的绝对 HTTP origin。 */
  backendOrigin: string
  /** Host 调用内部授权接口时使用的服务身份。 */
  serviceToken: string
}

export const Config: z<Config> = z.object({
  backendOrigin: z.string().required(),
  serviceToken: z.string().required(),
})

export const name = 'xagent-authorization'
export const inject = ['sessionPersistence']

declare module '@deepseek-ai/cordis' {
  interface Context {
    connectionRequestAuthorizer: XAgentAuthorizationService
  }
}

function sessionMethod(endpoint: string): string | undefined {
  if (endpoint.startsWith('session/')) return endpoint.slice('session/'.length)
  if (endpoint.startsWith('session.')) return endpoint.slice('session.'.length)
  return undefined
}

const PROJECT_METHODS = new Set(['bootstrap', 'select-context', 'create-project', 'project'])
const ARTIFACT_METHODS = new Set([
  'list',
  'detail',
  'create-upload',
  'create-version-upload',
  'complete-upload',
  'retry',
  'preview',
  'download',
])

function projectNamespace(endpoint: string): boolean {
  return endpoint.startsWith('xagentProject/') || endpoint.startsWith('xagentProject.')
}

function projectMethod(endpoint: string): string | undefined {
  const method = endpoint.slice('xagentProject'.length + 1)
  return PROJECT_METHODS.has(method) ? method : undefined
}

function artifactNamespace(endpoint: string): boolean {
  return endpoint.startsWith('xagentArtifact/') || endpoint.startsWith('xagentArtifact.')
}

function artifactMethod(endpoint: string): string | undefined {
  const method = endpoint.slice('xagentArtifact'.length + 1)
  return ARTIFACT_METHODS.has(method) ? method : undefined
}

function sessionPermission(
  endpoint: string,
  values: Record<string, unknown> | undefined,
): Permission | 'list' | 'create' | undefined {
  if (endpoint === 'session.export' || endpoint === 'session/export') return 'read'
  if (endpoint === 'workspace/archiveSession' || endpoint === 'workspace.archiveSession') return 'edit'
  const method = sessionMethod(endpoint)
  if (method !== undefined) {
    if (method === 'create' && typeof values?.sessionId === 'string') return 'read'
    return SESSION_PERMISSIONS.get(method)
  }
  return undefined
}

function args(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const value = record.args
  if (value === undefined) return record
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function authenticated(request: ConnectionRequestContext): request is ConnectionRequestContext & {
  userToken: string
  principal: XAgentPrincipal
} {
  const principal = request.principal
  if (typeof request.userToken !== 'string' || request.userToken.length === 0 || typeof principal !== 'object' || principal === null) {
    return false
  }
  const row = principal as Record<string, unknown>
  return typeof row.actorId === 'string'
    && UUID_PATTERN.test(row.actorId)
    && (row.role === 'manager' || row.role === 'specialist')
    && Number.isSafeInteger(row.permissionRevision)
    && (row.permissionRevision as number) >= 1
    && typeof row.authSessionId === 'string'
    && UUID_PATTERN.test(row.authSessionId)
    && row.connectionId === request.connectionId
}

function unauthenticated<T>(): RpcResult<T> {
  return { ok: false, error: { code: 'unauthenticated', message: 'authentication required', details: {} } }
}

function tokenScoped(value: Partial<TokenScopedPersistence>): value is TokenScopedPersistence {
  return typeof value.withUserToken === 'function'
}

function visibleSessionIds(value: unknown): ReadonlySet<string> {
  if (typeof value !== 'object' || value === null) throw new TypeError('invalid session visibility response')
  const sessions = (value as Record<string, unknown>).sessions
  if (!Array.isArray(sessions)) throw new TypeError('invalid session visibility response')
  const ids = new Set<string>()
  for (const item of sessions) {
    if (typeof item !== 'object' || item === null) throw new TypeError('invalid session visibility response')
    const header = (item as Record<string, unknown>).runtime_header
    if (header === null || header === undefined) continue
    if (typeof header !== 'object') throw new TypeError('invalid session visibility response')
    const id = (header as Record<string, unknown>).id
    if (typeof id !== 'string') throw new TypeError('invalid session visibility response')
    ids.add(id)
  }
  return ids
}

function authenticatedSessionScope(
  value: unknown,
  expectedRuntimeId: string,
  scope: XAgentAuthenticatedRequestScope,
): XAgentAuthenticatedSessionRequestScope {
  const expectedMatch = SESSION_ID_PATTERN.exec(expectedRuntimeId)
  if (expectedMatch?.[1] === undefined) throw new TypeError('invalid session scope response')
  const canonicalRuntimeId = `session-${expectedMatch[1].toLowerCase()}`
  if (typeof value !== 'object' || value === null) throw new TypeError('invalid session scope response')
  const sessions = (value as Record<string, unknown>).sessions
  if (!Array.isArray(sessions)) throw new TypeError('invalid session scope response')
  const matches = sessions.filter((item) => {
    if (typeof item !== 'object' || item === null) return false
    const header = (item as Record<string, unknown>).runtime_header
    return typeof header === 'object' && header !== null
      && (header as Record<string, unknown>).id === canonicalRuntimeId
  })
  if (matches.length !== 1) throw new XAgentBackendError('not-found')
  const row = matches[0] as Record<string, unknown>
  const id = row.id
  const visibility = row.visibility
  const projectId = row.project_id
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new TypeError('invalid session scope response')
  if (`session-${id.toLowerCase()}` !== canonicalRuntimeId) throw new TypeError('invalid session scope response')
  if (visibility === 'private' && projectId === null) {
    return Object.freeze({ ...scope, sessionId: id.toLowerCase(), visibility, projectId })
  }
  if (visibility === 'project' && typeof projectId === 'string' && UUID_PATTERN.test(projectId)) {
    return Object.freeze({ ...scope, sessionId: id.toLowerCase(), visibility, projectId: projectId.toLowerCase() })
  }
  throw new TypeError('invalid session scope response')
}

function filterVisible<T>(result: RpcResult<T>, visible: ReadonlySet<string>): RpcResult<T> {
  if (!result.ok || typeof result.value !== 'object' || result.value === null) return result
  const value = result.value as Record<string, unknown>
  if (!Array.isArray(value.items)) return result
  const items = value.items.filter((item) => {
    if (typeof item !== 'object' || item === null) return false
    const id = (item as Record<string, unknown>).sessionId
    return typeof id === 'string' && visible.has(id)
  })
  return { ok: true, value: { ...value, items } as T }
}

/** 对一个认证请求执行 FastAPI 预检，并在隔离的远端持久化令牌作用域中调用业务方法。 */
export class XAgentAuthorization implements ConnectionRequestAuthorizer {
  constructor(
    private readonly backend: XAgentBackend,
    private readonly persistence: TokenScopedPersistence,
    private readonly project?: XAgentProjectScopeRunner | (() => XAgentProjectScopeRunner | undefined),
    private readonly artifact?: XAgentArtifactScopeRunner | (() => XAgentArtifactScopeRunner | undefined),
  ) {}

  async run<T>(
    endpoint: string,
    payload: unknown,
    request: ConnectionRequestContext,
    signal: AbortSignal,
    operation: () => Promise<RpcResult<T>>,
  ): Promise<RpcResult<T>> {
    if (artifactNamespace(endpoint)) {
      if (!authenticated(request)) return unauthenticated()
      if (artifactMethod(endpoint) === undefined) return unauthenticated()
      const artifact = typeof this.artifact === 'function' ? this.artifact() : this.artifact
      if (artifact === undefined) {
        return { ok: false, error: { code: 'internal', message: 'artifact service unavailable', details: {} } }
      }
      const scope = authenticatedScope(request)
      try {
        return await artifact.withRequest(scope, operation)
      } catch {
        return { ok: false, error: { code: 'internal', message: 'artifact operation unavailable', details: {} } }
      }
    }
    if (projectNamespace(endpoint)) {
      if (!authenticated(request)) return unauthenticated()
      if (projectMethod(endpoint) === undefined) return unauthenticated()
      const project = typeof this.project === 'function' ? this.project() : this.project
      if (project === undefined) {
        return { ok: false, error: { code: 'internal', message: 'project service unavailable', details: {} } }
      }
      const scope = authenticatedScope(request)
      try {
        return await project.withRequest(scope, operation)
      } catch {
        return { ok: false, error: { code: 'internal', message: 'project operation unavailable', details: {} } }
      }
    }
    const method = sessionMethod(endpoint)
    const values = args(payload)
    const permission = sessionPermission(endpoint, values)
    if (method === undefined && permission === undefined) {
      if (endpoint.startsWith('workspace/') || endpoint.startsWith('workspace.')) {
        return unauthenticated()
      }
      return operation()
    }
    if (!authenticated(request)) return unauthenticated()
    if (permission === undefined) return unauthenticated()
    try {
      return await this.persistence.withUserToken(request.userToken, async () => {
        let visible: ReadonlySet<string> | undefined
        if (permission === 'list') {
          visible = visibleSessionIds(await this.backend.sessions.list(request.userToken, signal))
        } else if (permission !== 'create') {
          const sessionId = values?.sessionId
          if (typeof sessionId !== 'string') return unauthenticated<T>()
          const match = SESSION_ID_PATTERN.exec(sessionId)
          if (match?.[1] === undefined) return unauthenticated<T>()
          await this.backend.sessions.authorize(request.userToken, match[1], permission, signal)
          this.persistence.authorizeRequest?.(
            sessionId,
            method === 'prompt' ? request.requestId : undefined,
            request.userToken,
          )
        }
        let result: RpcResult<T>
        if (method === 'prompt') {
          const sessionId = values?.sessionId
          if (typeof sessionId !== 'string') return unauthenticated<T>()
          const requestScope = authenticatedScope(request)
          const scoped = authenticatedSessionScope(
            await this.backend.sessions.list(request.userToken, signal), sessionId, requestScope,
          )
          result = await runWithXAgentAuthenticatedRequestScope(scoped, operation)
        } else {
          result = await operation()
        }
        return visible === undefined ? result : filterVisible(result, visible)
      })
    } catch (error) {
      if (error instanceof XAgentBackendError && error.code === 'unauthenticated') return unauthenticated()
      if (error instanceof XAgentBackendError && error.code === 'not-found') {
        const sessionId = values?.sessionId
        if (typeof sessionId === 'string') {
          return {
            ok: false,
            error: { code: 'session-not-found', message: 'session not found', details: { sessionId: sessionId as never } },
          }
        }
      }
      return { ok: false, error: { code: 'internal', message: 'session authorization unavailable', details: {} } }
    }
  }

  async filterEvent(
    endpoint: 'events.mux' | 'events.host',
    frame: unknown,
    request: ConnectionRequestContext,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!authenticated(request)) return undefined
    const value = objectFrame(frame)
    if (value === undefined) return undefined
    if (value.type === 'stream/error' || value.type === 'host/remote-event') return frame
    if (endpoint === 'events.host' && value.type === 'host/archived-sessions-changed') {
      if (!Array.isArray(value.archivedSessionIds)) return undefined
      const archivedSessionIds: string[] = []
      for (const sessionId of value.archivedSessionIds) {
        if (typeof sessionId === 'string' && await this.canRead(request.userToken, sessionId, signal)) {
          archivedSessionIds.push(sessionId)
        }
      }
      return { ...value, archivedSessionIds }
    }
    if (endpoint === 'events.host' && typeof value.type === 'string' && value.type.startsWith('host/workspace-')) {
      return undefined
    }
    if (typeof value.sessionId !== 'string') return undefined
    return await this.canRead(request.userToken, value.sessionId, signal) ? frame : undefined
  }

  private async canRead(userToken: string, sessionId: string, signal: AbortSignal): Promise<boolean> {
    const match = SESSION_ID_PATTERN.exec(sessionId)
    if (match?.[1] === undefined) return false
    try {
      await this.persistence.flushSession?.(sessionId)
      await this.backend.sessions.authorize(userToken, match[1], 'read', signal)
      return true
    } catch (error) {
      if (error instanceof XAgentBackendError && error.code === 'not-found') return false
      throw error
    }
  }
}

function authenticatedScope(
  request: ConnectionRequestContext & { readonly principal: XAgentPrincipal; readonly userToken: string },
): XAgentAuthenticatedRequestScope {
  return Object.freeze({
    principal: request.principal,
    userToken: request.userToken,
    connectionId: request.connectionId,
  })
}

function objectFrame(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Cordis 服务包装；服务键由通用 API Gateway 以可选结构读取。 */
export class XAgentAuthorizationService extends Service implements ConnectionRequestAuthorizer {
  private readonly implementation: XAgentAuthorization

  constructor(
    ctx: Context,
    backend: XAgentBackend,
    persistence: TokenScopedPersistence,
    project?: XAgentProjectScopeRunner | (() => XAgentProjectScopeRunner | undefined),
    artifact?: XAgentArtifactScopeRunner | (() => XAgentArtifactScopeRunner | undefined),
  ) {
    super(ctx, 'connectionRequestAuthorizer')
    this.implementation = new XAgentAuthorization(backend, persistence, project, artifact)
  }

  /**
   * Authorize one connection-bound RPC and run it inside the matching user scope.
   * @param endpoint - closed-table RPC method name.
   * @param payload - untrusted parsed RPC payload.
   * @param request - Host-created physical connection context.
   * @param signal - request cancellation signal.
   * @param operation - downstream operation admitted after authorization.
   * @returns the downstream result or a stable authorization error.
   */
  run<T>(
    endpoint: string,
    payload: unknown,
    request: ConnectionRequestContext,
    signal: AbortSignal,
    operation: () => Promise<RpcResult<T>>,
  ): Promise<RpcResult<T>> {
    return this.implementation.run(endpoint, payload, request, signal, operation)
  }

  /**
   * Remove Session event frames the authenticated connection cannot read.
   * @param endpoint - event stream carrying the frame.
   * @param frame - untrusted candidate event frame.
   * @param request - Host-created physical connection context.
   * @param signal - stream cancellation signal.
   * @returns the original frame when visible, or `undefined` when hidden.
   */
  filterEvent(
    endpoint: 'events.mux' | 'events.host',
    frame: unknown,
    request: ConnectionRequestContext,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.implementation.filterEvent(endpoint, frame, request, signal)
  }
}

/** 安装 Business Session 授权；不改变未装载该插件的 Profile。 */
export function apply(ctx: Context, config: Config): void {
  const persistence = ctx.sessionPersistence as typeof ctx.sessionPersistence & Partial<TokenScopedPersistence>
  if (!tokenScoped(persistence)) {
    throw new Error('xagent authorization requires token-scoped session persistence')
  }
  new XAgentAuthorizationService(
    ctx,
    new XAgentBackendClient({ origin: config.backendOrigin, serviceToken: config.serviceToken }),
    persistence,
    () => ctx.get('xagentProject'),
    () => ctx.get('xagentArtifact'),
  )
}
