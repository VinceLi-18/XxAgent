import type { XAgentPrincipal } from '@xagent/dsh-principal'

/** Stable error vocabulary exposed across the Host/FastAPI boundary. */
export type XAgentBackendErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'session-not-found'
  | 'sequence-conflict'
  | 'idempotency-conflict'
  | 'upload-expired'
  | 'upload-rejected'
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

/** 服务端授权后的单个 Session 工作上下文索引。 */
export interface XAgentSessionScopeSummary {
  readonly sessionId: string
  readonly visibility: 'private' | 'project'
  readonly projectId?: string
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
  readonly sessionScopes: readonly XAgentSessionScopeSummary[]
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

/** 资料版本在异步安全处理流程中的公开状态。 */
export type XAgentArtifactStatus = 'pending' | 'scanning' | 'clean' | 'quarantined' | 'failed'

/** 当前工作台内资料的私人或项目归属。 */
export type XAgentArtifactScope =
  | { readonly kind: 'private'; readonly projectId?: never }
  | { readonly kind: 'project'; readonly projectId: string }

/** 资料列表返回的当前状态与最近安全版本。 */
export interface XAgentArtifactSummary {
  readonly id: string
  readonly displayName: string
  readonly scope: XAgentArtifactScope
  readonly latestVersion: number
  readonly latestStatus: XAgentArtifactStatus
  readonly latestCleanVersion?: number
}

/** 资料详情中的单个不可变版本。 */
export interface XAgentArtifactVersionSummary {
  readonly id: string
  readonly version: number
  readonly originalFilename: string
  readonly uploadedBy: string
  readonly size?: number
  readonly contentType?: string
  readonly sha256?: string
  readonly status: XAgentArtifactStatus
  readonly createdAt: string
}

/** 资料摘要、当前编辑权限与严格降序版本历史。 */
export interface XAgentArtifactDetail extends XAgentArtifactSummary {
  readonly canEdit: boolean
  readonly versions: readonly XAgentArtifactVersionSummary[]
}

/** 创建资料或新版本暂存上传的输入。 */
export interface XAgentArtifactUploadInput {
  readonly filename: string
  readonly size: number
  readonly idempotencyKey: string
}

/** 完成暂存上传并进入异步扫描队列的输入。 */
export interface XAgentArtifactCompleteInput {
  readonly size: number
  readonly sha256: string
  readonly idempotencyKey: string
}

/** Browser 直接 PUT 暂存正文所需的短期授权。 */
export interface XAgentArtifactUpload {
  readonly id: string
  readonly putUrl: string
  readonly expiresAt: string
}

/** 绑定用户令牌的固定资料后端操作。 */
export interface XAgentArtifactBackend {
  list(userToken: string, signal?: AbortSignal): Promise<readonly XAgentArtifactSummary[]>
  detail(userToken: string, artifactId: string, signal?: AbortSignal): Promise<XAgentArtifactDetail>
  createUpload(
    userToken: string,
    input: XAgentArtifactUploadInput,
    signal?: AbortSignal,
  ): Promise<XAgentArtifactUpload>
  createVersionUpload(
    userToken: string,
    artifactId: string,
    input: XAgentArtifactUploadInput,
    signal?: AbortSignal,
  ): Promise<XAgentArtifactUpload>
  completeUpload(
    userToken: string,
    uploadId: string,
    input: XAgentArtifactCompleteInput,
    signal?: AbortSignal,
  ): Promise<XAgentArtifactDetail>
  retry(
    userToken: string,
    versionId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<XAgentArtifactDetail>
  preview(userToken: string, versionId: string, signal?: AbortSignal): Promise<{ readonly url: string }>
  download(userToken: string, versionId: string, signal?: AbortSignal): Promise<{ readonly url: string }>
}

/** Authentication, Session, workbench, and Artifact operations implemented by the XAgent FastAPI client. */
export interface XAgentBackend {
  login(email: string, password: string, signal?: AbortSignal): Promise<XAgentIssuedLogin>
  introspect(userToken: string, signal?: AbortSignal): Promise<XAgentPrincipal>
  revoke(userToken: string, signal?: AbortSignal): Promise<void>
  readonly sessions: XAgentSessionBackend
  readonly workbench?: XAgentWorkbenchBackend
  readonly artifacts?: XAgentArtifactBackend
}
