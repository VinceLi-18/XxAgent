import type { XAgentPrincipal } from '@xagent/dsh-principal'

/** Stable error vocabulary exposed across the Host/FastAPI boundary. */
export type XAgentBackendErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'session-not-found'
  | 'sequence-conflict'
  | 'idempotency-conflict'
  | 'unsupported-version'
  | 'service-unavailable'

/** Principal-scoped FastAPI Session operations used by the remote persistence provider. */
export interface XAgentSessionBackend {
  list(userToken: string, signal?: AbortSignal): Promise<unknown>
  create(userToken: string, body: unknown, signal?: AbortSignal): Promise<unknown>
  open(userToken: string, sessionId: string, signal?: AbortSignal): Promise<unknown>
  events(userToken: string, sessionId: string, body: unknown, signal?: AbortSignal): Promise<unknown>
  append(userToken: string, sessionId: string, body: unknown, signal?: AbortSignal): Promise<unknown>
  fork(userToken: string, sessionId: string, body: unknown, signal?: AbortSignal): Promise<unknown>
  archive(userToken: string, sessionId: string, body: unknown, signal?: AbortSignal): Promise<unknown>
  authorize(
    userToken: string,
    sessionId: string,
    operation: 'read' | 'edit' | 'owner',
    signal?: AbortSignal,
  ): Promise<void>
}

/** Login material returned only to the Host before it writes browser cookies. */
export interface XAgentIssuedLogin {
  accessToken: string
  expiresAt: string
  csrfToken: string
}

/** FastAPI 为当前账号计算的工作台能力。 */
export type XAgentCapability = 'project.create'

/** 当前账号选择的跨项目工作台或单项目上下文。 */
export type XAgentWorkbenchContext =
  | { readonly kind: 'workbench'; readonly projectId?: never }
  | { readonly kind: 'project'; readonly projectId: string }

/** 项目列表与详情共用的安全摘要字段。 */
export interface XAgentProjectSummary {
  readonly id: string
  readonly name: string
  readonly createdAt: string
}

/** 当前账号的完整工作台初始化状态。 */
export interface XAgentWorkbenchBootstrap {
  readonly account: {
    readonly id: string
    readonly email: string
    readonly role: 'manager' | 'specialist'
    readonly permissionRevision: number
  }
  readonly capabilities: readonly XAgentCapability[]
  readonly context: XAgentWorkbenchContext
  readonly projects: readonly XAgentProjectSummary[]
  readonly sessionSummary: {
    readonly privateCount: number
    readonly projectCounts: Readonly<Record<string, number>>
  }
}

/** 当前账号可见的单个项目详情。 */
export interface XAgentProjectDetail {
  readonly accountId: string
  readonly id: string
  readonly name: string
  readonly createdAt: string
  readonly canEdit: boolean
  readonly sessionCount: number
}

/** 为私有 Session 幂等登记项目引用所需的参数。 */
export interface XAgentSessionProjectRefsInput {
  readonly sessionId: string
  readonly projectIds: readonly string[]
  readonly idempotencyKey: string
}

/** 绑定用户令牌的固定工作台后端操作。 */
export interface XAgentWorkbenchBackend {
  bootstrap(userToken: string, signal?: AbortSignal): Promise<XAgentWorkbenchBootstrap>
  selectContext(
    userToken: string,
    context: XAgentWorkbenchContext,
    signal?: AbortSignal,
  ): Promise<XAgentWorkbenchBootstrap>
  createProject(
    userToken: string,
    input: { readonly name: string; readonly idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<XAgentWorkbenchBootstrap>
  project(userToken: string, projectId: string, signal?: AbortSignal): Promise<XAgentProjectDetail>
  addSessionProjectRefs(
    userToken: string,
    input: XAgentSessionProjectRefsInput,
    signal?: AbortSignal,
  ): Promise<void>
}

/** Authentication and Session contract implemented by the XAgent FastAPI client. */
export interface XAgentBackend {
  login(email: string, password: string, signal?: AbortSignal): Promise<XAgentIssuedLogin>
  introspect(userToken: string, signal?: AbortSignal): Promise<XAgentPrincipal>
  revoke(userToken: string, signal?: AbortSignal): Promise<void>
  readonly sessions: XAgentSessionBackend
  readonly workbench?: XAgentWorkbenchBackend
}
