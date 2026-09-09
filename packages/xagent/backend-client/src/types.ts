import type { XAgentPrincipal } from '@xagent/dsh-principal'

/** Opaque receipt attached only to its matching Session append event. */
export interface XAgentSessionRetrievalReceiptAttachment {
  readonly event_sequence: number
  readonly tool_call_id: string
  readonly receipt: string
  readonly payload_hash: string
}

/** Private wire receipt for admitting one prepared Fact proposal with its public result. */
export interface XAgentSessionFactProposalReceiptAttachment {
  readonly event_sequence: number
  readonly tool_call_id: string
  readonly proposal_id: string
  readonly receipt: string
  readonly payload_hash: string
}

/** Private wire identity for consuming one Fact decision Outbox row with its Session event. */
export interface XAgentSessionFactOutboxAttachment {
  readonly event_sequence: number
  readonly outbox_id: string
  readonly payload_hash: string
}

/** Closed Session append request including its private retrieval sidecar. */
export interface XAgentSessionAppendInput {
  readonly schema_version: 1
  readonly expected_sequence: number
  readonly idempotency_key: string
  readonly events: readonly unknown[]
  readonly retrieval_receipts: readonly XAgentSessionRetrievalReceiptAttachment[]
  readonly fact_proposal_receipts?: readonly XAgentSessionFactProposalReceiptAttachment[]
  readonly fact_outbox_events?: readonly XAgentSessionFactOutboxAttachment[]
}

/** Closed acknowledgement for one committed Session append batch. */
export interface XAgentSessionAppendResult {
  readonly schema_version: 1
  readonly last_event_sequence: number
  readonly version: number
}

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
  | 'invalid-retrieval-scope'
  | 'retrieval-unavailable'
  | 'evidence-expired'
  | 'evidence-conflict'
  | 'citation-invalid'
  | 'fact-input-invalid'
  | 'fact-evidence-invalid'
  | 'fact-session-invalid'
  | 'fact-receipt-invalid'
  | 'fact-receipt-expired'
  | 'fact-revision-conflict'
  | 'fact-already-decided'
  | 'stale-permission'
  | 'unsupported-version'
  | 'service-unavailable'

/** Principal-scoped FastAPI Session operations used by the remote persistence provider. */
export interface XAgentSessionBackend {
  list(userToken: string, signal?: AbortSignal): Promise<unknown>
  create(userToken: string, body: unknown, signal?: AbortSignal): Promise<unknown>
  open(userToken: string, sessionId: string, signal?: AbortSignal): Promise<unknown>
  events(userToken: string, sessionId: string, body: unknown, signal?: AbortSignal): Promise<unknown>
  append(
    userToken: string,
    sessionId: string,
    body: XAgentSessionAppendInput,
    signal?: AbortSignal,
  ): Promise<XAgentSessionAppendResult>
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

/** Identity shared by citation authorization and resolution requests. */
export interface XAgentCitationIdentity {
  readonly id: string
  readonly artifactId: string
  readonly versionId: string
  readonly chunkId: string
}

/** Common identifiers bound by one retrieval delegation token and request body. */
export interface XAgentRetrievalOperationInput {
  readonly sessionId: string
  readonly toolCallId: string
  readonly permissionRevision: number
}

/** Project discovery request for a Private Session. */
export interface XAgentProjectDiscoveryInput extends XAgentRetrievalOperationInput {
  readonly query?: string
}

/** Explicit Artifact search request with a mandatory local digest for Private Session scope. */
export type XAgentArtifactSearchInput = XAgentRetrievalOperationInput & { readonly query: string } & (
  | { readonly projectIds?: never; readonly includePrivate: false; readonly scopeHash?: never }
  | { readonly projectIds: readonly string[]; readonly includePrivate: boolean; readonly scopeHash: string }
)

/** Authorized project identity returned by project discovery. */
export interface XAgentRetrievalProject {
  readonly projectId: string
  readonly name: string
}

/** Model-visible citation payload returned by Artifact search. */
export interface XAgentRetrievalCitation extends XAgentCitationIdentity {
  readonly displayName: string
  readonly versionNumber: number
  readonly lineStart: number
  readonly lineEnd: number
  readonly text: string
  readonly scope: 'private' | 'project'
}

/** Project discovery payload plus its opaque persistence receipt. */
export interface XAgentProjectDiscoveryResult {
  readonly projects: readonly XAgentRetrievalProject[]
  readonly receipt: string
  readonly payloadHash: string
}

/** Artifact search payload plus its opaque persistence receipt. */
export interface XAgentArtifactSearchResult {
  readonly citations: readonly XAgentRetrievalCitation[]
  readonly receipt: string
  readonly payloadHash: string
}

/** Inputs for validating all citations before answer release. */
export interface XAgentAuthorizeCitationsInput extends XAgentRetrievalOperationInput {
  readonly citations: readonly XAgentCitationIdentity[]
}

/** Input that lets FastAPI resolve one durable citation without caller-supplied evidence identity. */
export interface XAgentResolveCitationInput extends XAgentRetrievalOperationInput {
  /** Session-local short ID whose exact immutable evidence is server-owned. */
  readonly citationId: string
}

/** Reauthorized Artifact navigation target without a storage URL. */
export interface XAgentResolvedCitation extends XAgentCitationIdentity {
  readonly lineStart: number
  readonly lineEnd: number
}

/** Strict Host operations for FastAPI retrieval routes. */
export interface XAgentRetrievalBackend {
  projects(
    userToken: string,
    delegationToken: string,
    input: XAgentProjectDiscoveryInput,
    signal?: AbortSignal,
  ): Promise<XAgentProjectDiscoveryResult>
  search(
    userToken: string,
    delegationToken: string,
    input: XAgentArtifactSearchInput,
    signal?: AbortSignal,
  ): Promise<XAgentArtifactSearchResult>
  authorizeCitations(
    userToken: string,
    delegationToken: string,
    input: XAgentAuthorizeCitationsInput,
    signal?: AbortSignal,
  ): Promise<void>
  resolveCitation(
    userToken: string,
    delegationToken: string,
    input: XAgentResolveCitationInput,
    signal?: AbortSignal,
  ): Promise<XAgentResolvedCitation>
}

/** Closed value accepted for one governed project Fact. */
export type ProjectFactValue =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'date'; readonly value: string }

/** Public lifecycle states for an admitted Fact proposal. */
export type FactProposalPublicStatus =
  | 'pending'
  | 'confirmed'
  | 'rejected'
  | 'withdrawn'
  | 'conflicted'

/** Model-authored fields accepted by the `propose_fact` Consumer. */
export interface ProposeFactInput {
  readonly field_key: string
  readonly label: string
  readonly value: ProjectFactValue
  readonly evidence_ids?: readonly string[]
  readonly assertion_reason?: string
}

/** Minimal public result admitted with a successful Fact proposal. */
export interface ProposeFactResult {
  readonly proposalId: string
  readonly status: 'pending'
}

/** Private prepared-proposal receipt bound to one future Session event. */
export interface XAgentFactProposalReceiptAttachment {
  readonly eventSequence: number
  readonly toolCallId: string
  readonly proposalId: string
  readonly receipt: string
  readonly payloadHash: string
}

/** Private Outbox identity bound to one future Session decision event. */
export interface XAgentFactOutboxAttachment {
  readonly eventSequence: number
  readonly outboxId: string
  readonly payloadHash: string
}

/** Private prepared-proposal sidecars consumed only after an acknowledged Session append. */
export interface XAgentFactReceiptRegistryContract {
  attachments(
    sessionId: string,
    fromSequence: number,
    toSequence: number,
  ): readonly XAgentFactProposalReceiptAttachment[]
  commit(sessionId: string, throughSequence: number): void
}

/** Private Outbox sidecars consumed only after an acknowledged Session append. */
export interface XAgentFactOutboxRegistryContract {
  attachments(
    sessionId: string,
    fromSequence: number,
    toSequence: number,
  ): readonly XAgentFactOutboxAttachment[]
  commit(sessionId: string, throughSequence: number): void
}

/** Optional Fact service fields used exclusively by Session persistence. */
export interface XAgentFactPersistenceSidecars {
  readonly receipts: XAgentFactReceiptRegistryContract
  readonly outbox: XAgentFactOutboxRegistryContract
}

/** Terminal Fact decision projected into the source Session. */
export interface FactProposalDecidedEvent {
  readonly type: 'fact/proposal-decided'
  readonly data: {
    readonly proposalId: string
    readonly projectId: string
    readonly fieldKey: string
    readonly label: string
    readonly status: Exclude<FactProposalPublicStatus, 'pending'>
    readonly factRevisionId?: string
    readonly contentRevision?: number
    readonly decisionReason?: string
  }
}

/** Exact immutable Artifact evidence attached to a Fact proposal or revision. */
export interface XAgentFactEvidence {
  readonly citationId: string
  readonly artifactId: string
  readonly versionId: string
  readonly indexId: string
  readonly indexGeneration: number
  readonly chunkId: string
  readonly lineStart: number
  readonly lineEnd: number
}

/** Public fields of one admitted Fact proposal. */
export interface XAgentFactProposal {
  readonly id: string
  readonly projectId: string
  readonly fieldKey: string
  readonly label: string
  readonly value: ProjectFactValue
  readonly proposerId: string
  readonly baseRevision: number
  readonly assertionReason?: string
  readonly status: FactProposalPublicStatus
  readonly decisionActorId?: string
  readonly decisionReason?: string
  readonly evidence: readonly XAgentFactEvidence[]
  readonly createdAt: string
  readonly admittedAt: string
  readonly decidedAt?: string
}

/** One immutable confirmed revision of a governed project Fact. */
export interface XAgentFactRevision {
  readonly id: string
  readonly projectId: string
  readonly fieldKey: string
  readonly label: string
  readonly value: ProjectFactValue
  readonly contentRevision: number
  readonly proposalId: string
  readonly proposerId: string
  readonly confirmedById: string
  readonly assertionReason?: string
  readonly evidence: readonly XAgentFactEvidence[]
  readonly createdAt: string
}

/** Bounded Fact query page. */
export interface XAgentFactPage<T> {
  readonly items: readonly T[]
  readonly nextCursor?: string
}

/** One selected Fact revision and its newest bounded field history. */
export interface XAgentFactRevisionDetail {
  readonly revision: XAgentFactRevision
  readonly history: readonly XAgentFactRevision[]
}

/** Public result of a successful terminal proposal operation. */
export interface XAgentFactProposalDecision {
  readonly proposalId: string
  readonly status: Exclude<FactProposalPublicStatus, 'pending' | 'conflicted'>
  readonly factRevisionId?: string
  readonly contentRevision?: number
}

/** Private Host result of preparing a proposal before Session admission. */
export interface XAgentFactPrepareResult {
  readonly result: ProposeFactResult
  readonly receipt: string
  readonly payloadHash: string
}

/** One verified Fact decision and the private Outbox identity that admits it. */
export interface XAgentFactOutboxItem {
  readonly outboxId: string
  readonly payloadHash: string
  readonly event: FactProposalDecidedEvent
}

/** Host-only inputs for preparing one Fact proposal. */
export interface XAgentFactPrepareInput {
  readonly sessionId: string
  readonly toolCallId: string
  readonly permissionRevision: number
  readonly idempotencyKey: string
  readonly fieldKey: string
  readonly label: string
  readonly value: ProjectFactValue
  readonly evidenceIds: readonly string[]
  readonly assertionReason?: string
}

/** Cursor and item bound for a Fact list request. */
export interface XAgentFactPageInput {
  readonly limit: number
  readonly cursor?: string
}

/** Manager-authored fields for approving a pending Fact proposal. */
export interface XAgentFactApproveInput {
  readonly idempotencyKey: string
  readonly decisionNote?: string
}

/** Manager-authored fields for rejecting a pending Fact proposal. */
export interface XAgentFactRejectInput {
  readonly idempotencyKey: string
  readonly reason: string
}

/** Proposer-authored identity for withdrawing a pending Fact proposal. */
export interface XAgentFactWithdrawInput {
  readonly idempotencyKey: string
}

/** Strict Host operations for the governed FastAPI Fact routes. */
export interface XAgentFactBackend {
  prepare(
    userToken: string,
    delegationToken: string,
    input: XAgentFactPrepareInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactPrepareResult>
  listHeads(
    userToken: string,
    projectId: string,
    input: XAgentFactPageInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactPage<XAgentFactRevision>>
  listProposals(
    userToken: string,
    projectId: string,
    input: XAgentFactPageInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactPage<XAgentFactProposal>>
  revision(userToken: string, revisionId: string, signal?: AbortSignal): Promise<XAgentFactRevisionDetail>
  proposal(userToken: string, proposalId: string, signal?: AbortSignal): Promise<XAgentFactProposal>
  approve(
    userToken: string,
    proposalId: string,
    input: XAgentFactApproveInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactProposalDecision>
  reject(
    userToken: string,
    proposalId: string,
    input: XAgentFactRejectInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactProposalDecision>
  withdraw(
    userToken: string,
    proposalId: string,
    input: XAgentFactWithdrawInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactProposalDecision>
  pullOutbox(
    userToken: string,
    sessionId: string,
    input: XAgentFactPageInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactPage<XAgentFactOutboxItem>>
}

/** Authentication, Session, workbench, and Artifact operations implemented by the XAgent FastAPI client. */
export interface XAgentBackend {
  login(email: string, password: string, signal?: AbortSignal): Promise<XAgentIssuedLogin>
  introspect(userToken: string, signal?: AbortSignal): Promise<XAgentPrincipal>
  revoke(userToken: string, signal?: AbortSignal): Promise<void>
  readonly sessions: XAgentSessionBackend
  readonly workbench?: XAgentWorkbenchBackend
  readonly artifacts?: XAgentArtifactBackend
  readonly retrieval?: XAgentRetrievalBackend
  readonly facts?: XAgentFactBackend
}
