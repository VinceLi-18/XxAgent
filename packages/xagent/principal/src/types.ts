/** XAgent 当前支持的账号角色。 */
export type XAgentRole = 'manager' | 'specialist'

/** FastAPI 认证后绑定到一条 Host 物理连接的不可变身份。 */
export interface XAgentPrincipal {
  readonly actorId: string
  readonly role: XAgentRole
  readonly permissionRevision: number
  readonly authSessionId: string
  readonly connectionId: string
}

/** 通过服务端 introspection 解析连接 Principal 的边界。 */
export interface XAgentPrincipalResolver {
  resolve(userToken: string, connectionId: string, signal?: AbortSignal): Promise<XAgentPrincipal>
}

/** Host 从同一已认证物理连接建立的不可变单请求身份。 */
export interface XAgentAuthenticatedRequestScope {
  readonly principal: XAgentPrincipal
  readonly userToken: string
  readonly connectionId: string
  /** AbortSignal for the prompt request that admitted inbox work. */
  readonly requestSignal?: AbortSignal
  /** AbortSignal for the authenticated physical connection. */
  readonly connectionSignal?: AbortSignal
}

/** Authenticated Session facts propagated from one physical prompt request into its agent turn. */
export type XAgentAuthenticatedSessionRequestScope = XAgentAuthenticatedRequestScope & (
  | {
    readonly sessionId: string
    readonly visibility: 'private'
    readonly projectId: null
  }
  | {
    readonly sessionId: string
    readonly visibility: 'project'
    readonly projectId: string
  }
)
