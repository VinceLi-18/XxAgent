/**
 * XAgent 请求 Principal 的唯一运行时结构与 Cordis 服务定义。
 * @module @xagent/dsh-principal
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { XAgentPrincipal, XAgentPrincipalResolver, XAgentRole } from './types.ts'

export type { XAgentPrincipal, XAgentPrincipalResolver, XAgentRole } from './types.ts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

declare module '@deepseek-ai/cordis' {
  interface Context {
    xagentPrincipal: XAgentPrincipalService
  }
}

/** 将 FastAPI introspection 结果转换为当前物理连接的不可变 Principal。 */
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
    role: role as XAgentRole,
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

  abstract resolve(userToken: string, connectionId: string, signal?: AbortSignal): Promise<XAgentPrincipal>
}

export default XAgentPrincipalService
