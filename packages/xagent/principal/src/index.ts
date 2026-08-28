/**
 * XAgent 请求 Principal 的唯一运行时结构与 Cordis 服务定义。
 * @module @xagent/dsh-principal
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Context, Service } from '@deepseek-ai/cordis'
import type { XAgentPrincipal, XAgentPrincipalResolver } from './types.ts'
import type { XAgentAuthenticatedRequestScope } from './types.ts'

export type {
  XAgentAuthenticatedRequestScope,
  XAgentAuthenticatedSessionRequestScope,
  XAgentPrincipal,
  XAgentPrincipalResolver,
  XAgentRole,
} from './types.ts'

const authenticatedRequestScope = new AsyncLocalStorage<XAgentAuthenticatedRequestScope | undefined>()

/**
 * Propagate one immutable physical authentication scope through work spawned by its request.
 * @param scope - Principal, opaque user token, connection, and optional Session facts.
 * @param operation - request admission or downstream work created by that admission.
 * @returns the operation result while descendants inherit the same immutable scope.
 */
export function runWithXAgentAuthenticatedRequestScope<T>(
  scope: XAgentAuthenticatedRequestScope,
  operation: () => T,
): T {
  return authenticatedRequestScope.run(Object.freeze(scope), operation)
}

/**
 * Read the authenticated physical request that created the current async work.
 * @returns the immutable request scope, or undefined outside authenticated work.
 */
export function currentXAgentAuthenticatedRequestScope(): XAgentAuthenticatedRequestScope | undefined {
  return authenticatedRequestScope.getStore()
}

/**
 * Suppress any inherited physical request while running work with no admitted prompt scope.
 * @param operation - downstream work that must fail closed instead of inheriting an older request.
 * @returns the operation result outside every authenticated request scope.
 */
export function runWithoutXAgentAuthenticatedRequestScope<T>(operation: () => T): T {
  return authenticatedRequestScope.run(undefined, operation)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

declare module '@deepseek-ai/cordis' {
  interface Context {
    xagentPrincipal: XAgentPrincipalService
  }
}

/**
 * 将 FastAPI introspection 结果转换为当前物理连接的不可变 Principal。
 * @param value - FastAPI 返回的待校验 Principal payload。
 * @param connectionId - Host 生成的物理连接标识。
 * @returns 结构与标识均已校验的不可变 Principal。
 */
export function parseXAgentPrincipal(value: unknown, connectionId: string): XAgentPrincipal {
  if (typeof value !== 'object' || value === null || connectionId.length === 0) {
    throw new TypeError('invalid principal')
  }
  const row = value as Record<string, unknown>
  const actorId = row.actor_id
  const role = row.role
  const permissionRevision = row.permission_revision
  const authSessionId = row.auth_session_id
  if (
    typeof actorId !== 'string'
    || !UUID_PATTERN.test(actorId)
    || (role !== 'manager' && role !== 'specialist')
    || !Number.isSafeInteger(permissionRevision)
    || (permissionRevision as number) < 1
    || typeof authSessionId !== 'string'
    || !UUID_PATTERN.test(authSessionId)
  ) {
    throw new TypeError('invalid principal')
  }
  return Object.freeze({
    actorId,
    role,
    permissionRevision: permissionRevision as number,
    authSessionId,
    connectionId,
  })
}

/** XAgent Host 的 Principal 解析服务；实现必须通过 FastAPI introspection。 */
export abstract class XAgentPrincipalService extends Service implements XAgentPrincipalResolver {
  constructor(ctx: Context) {
    super(ctx, 'xagentPrincipal')
  }

  /**
   * Introspect a login token and bind the resulting actor to one Host connection.
   * @param userToken - opaque FastAPI login token.
   * @param connectionId - Host-generated physical connection identifier.
   * @param signal - optional introspection cancellation signal.
   * @returns an immutable validated Principal.
   */
  abstract resolve(userToken: string, connectionId: string, signal?: AbortSignal): Promise<XAgentPrincipal>
}

export default XAgentPrincipalService
