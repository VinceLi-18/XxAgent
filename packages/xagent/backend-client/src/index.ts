/** 固定访问 XAgent FastAPI 内部接口的 Host 客户端。 @module @xagent/dsh-backend-client */

import { createHash, randomUUID } from 'node:crypto'
import { parseXAgentPrincipal, type XAgentPrincipal } from '@xagent/dsh-principal'
import type {
  XAgentBackend,
  XAgentBackendErrorCode,
  XAgentArtifactBackend,
  XAgentArtifactDetail,
  XAgentArtifactScope,
  XAgentArtifactStatus,
  XAgentArtifactSummary,
  XAgentArtifactUpload,
  XAgentArtifactVersionSummary,
  XAgentCapability,
  XAgentIssuedLogin,
  XAgentProjectDetail,
  XAgentProjectDiscoveryResult,
  XAgentProjectSummary,
  XAgentResolvedCitation,
  XAgentRetrievalBackend,
  XAgentRetrievalCitation,
  XAgentSessionBackend,
  XAgentSessionAppendResult,
  XAgentSessionScopeSummary,
  XAgentWorkbenchBackend,
  XAgentWorkbenchBootstrap,
  XAgentWorkbenchContext,
} from './types.ts'

export type {
  XAgentBackend,
  XAgentBackendErrorCode,
  XAgentArtifactBackend,
  XAgentArtifactCompleteInput,
  XAgentArtifactDetail,
  XAgentArtifactScope,
  XAgentArtifactStatus,
  XAgentArtifactSummary,
  XAgentArtifactUpload,
  XAgentArtifactUploadInput,
  XAgentArtifactVersionSummary,
  XAgentCapability,
  XAgentIssuedLogin,
  XAgentProjectDetail,
  XAgentProjectDiscoveryInput,
  XAgentProjectDiscoveryResult,
  XAgentProjectSummary,
  XAgentResolveCitationInput,
  XAgentResolvedCitation,
  XAgentRetrievalBackend,
  XAgentRetrievalCitation,
  XAgentRetrievalOperationInput,
  XAgentRetrievalProject,
  XAgentArtifactSearchInput,
  XAgentArtifactSearchResult,
  XAgentAuthorizeCitationsInput,
  XAgentCitationIdentity,
  XAgentSessionBackend,
  XAgentSessionAppendInput,
  XAgentSessionAppendResult,
  XAgentSessionRetrievalReceiptAttachment,
  XAgentSessionProjectRefsInput,
  XAgentSessionScopeSummary,
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
  'upload-expired',
  'upload-rejected',
  'invalid-retrieval-scope',
  'retrieval-unavailable',
  'evidence-expired',
  'evidence-conflict',
  'citation-invalid',
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

function exactRecordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  const row = record(value)
  const allowedKeys = new Set([...required, ...optional])
  if (
    Object.keys(row).some(key => !allowedKeys.has(key))
    || required.some(key => !Object.hasOwn(row, key))
  ) failSchema()
  return row
}

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const SESSION_ID_PATTERN = /^(?:session-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function requiredUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) failSchema()
  return value
}

function requiredSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) failSchema()
  return value
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) failSchema()
  return value
}

function boundedString(value: unknown, maximum: number): string {
  const result = requiredString(value)
  if (Array.from(result).length > maximum) failSchema()
  return result
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) failSchema()
  return value as number
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

function parseSessionScope(value: unknown): XAgentSessionScopeSummary {
  const row = exactRecord(value, ['session_id', 'visibility', 'project_id'])
  const sessionId = requiredSessionId(row.session_id)
  if (row.visibility === 'private' && row.project_id === null) {
    return { sessionId, visibility: 'private' }
  }
  if (row.visibility === 'project') {
    return {
      sessionId,
      visibility: 'project',
      projectId: requiredUuid(row.project_id),
    }
  }
  return failSchema()
}

function parseBootstrap(value: unknown): XAgentWorkbenchBootstrap {
  const row = exactRecord(value, [
    'schema_version',
    'account',
    'capabilities',
    'context',
    'projects',
    'session_scopes',
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
  if (!Array.isArray(row.session_scopes)) failSchema()
  const sessionScopes = row.session_scopes.map(parseSessionScope)
  const sessionIds = sessionScopes.map(scope => scope.sessionId)
  if (
    new Set(sessionIds).size !== sessionIds.length
    || sessionScopes.some(scope => scope.visibility === 'project'
      && (scope.projectId === undefined || !projectIds.includes(scope.projectId)))
  ) failSchema()
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
    sessionScopes,
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

const ARTIFACT_STATUSES = new Set<XAgentArtifactStatus>([
  'pending', 'scanning', 'clean', 'quarantined', 'failed',
])
const MAX_ARTIFACT_SIZE = 50 * 1024 * 1024
const MAX_ARTIFACT_ITEMS = 1_000
const MAX_URL_DECODE_ROUNDS = 16
const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const OBJECT_KEY_PATTERN = /artifacts\/[0-9a-f-]{36}\/[0-9a-f-]{36}(?:[/?#]|$)/i
const STAGING_KEY_PATTERN = /staging\/[0-9a-f-]{36}(?:[/?#]|$)/i
const STORAGE_BUCKET = 'xagent-private'
const STORAGE_BUCKET_TOKEN_PATTERN = /(?:^|[^a-z0-9])xagent-private(?:$|[^a-z0-9])/i
const PERCENT_ESCAPE_PATTERN = /%[0-9a-f]{2}/i
const LITERAL_PERCENT_PATTERN = /%(?![0-9a-f]{2})/gi

function artifactStatus(value: unknown): XAgentArtifactStatus {
  if (typeof value !== 'string' || !ARTIFACT_STATUSES.has(value as XAgentArtifactStatus)) failSchema()
  return value as XAgentArtifactStatus
}

function instant(value: unknown): string {
  const result = requiredString(value)
  const match = ISO_INSTANT_PATTERN.exec(result)
  if (match === null || !Number.isFinite(Date.parse(result))) failSchema()
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[8] === undefined ? 0 : Number(match[8])
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9])
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) failSchema()
  return result
}

function artifactSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_ARTIFACT_SIZE) failSchema()
  return value as number
}

function parseArtifactScope(value: unknown): XAgentArtifactScope {
  const row = record(value)
  if (row.kind === 'private') {
    exactRecord(row, ['kind'])
    return { kind: 'private' }
  }
  if (row.kind === 'project') {
    exactRecord(row, ['kind', 'project_id'])
    return { kind: 'project', projectId: requiredUuid(row.project_id) }
  }
  return failSchema()
}

function parseArtifactSummary(value: unknown): XAgentArtifactSummary {
  const row = exactRecordWithOptional(value, [
    'id', 'display_name', 'scope', 'latest_version', 'latest_status',
  ], ['latest_clean_version'])
  const latestVersion = positiveInteger(row.latest_version)
  const latestCleanVersion = Object.hasOwn(row, 'latest_clean_version')
    ? positiveInteger(row.latest_clean_version)
    : undefined
  const latestStatus = artifactStatus(row.latest_status)
  if (
    latestStatus === 'clean'
      ? latestCleanVersion !== latestVersion
      : latestCleanVersion !== undefined && latestCleanVersion >= latestVersion
  ) failSchema()
  return {
    id: requiredUuid(row.id),
    displayName: boundedString(row.display_name, 255),
    scope: parseArtifactScope(row.scope),
    latestVersion,
    latestStatus,
    ...(latestCleanVersion === undefined ? {} : { latestCleanVersion }),
  }
}

function parseArtifactVersion(value: unknown): XAgentArtifactVersionSummary {
  const row = exactRecordWithOptional(value, [
    'id', 'version', 'original_filename', 'uploaded_by', 'status', 'created_at',
  ], ['size', 'content_type', 'sha256'])
  const size = Object.hasOwn(row, 'size') ? artifactSize(row.size) : undefined
  const contentType = Object.hasOwn(row, 'content_type') ? boundedString(row.content_type, 255) : undefined
  let sha256: string | undefined
  if (Object.hasOwn(row, 'sha256')) {
    if (typeof row.sha256 !== 'string' || !SHA256_PATTERN.test(row.sha256)) failSchema()
    sha256 = row.sha256
  }
  return {
    id: requiredUuid(row.id),
    version: positiveInteger(row.version),
    originalFilename: boundedString(row.original_filename, 255),
    uploadedBy: requiredUuid(row.uploaded_by),
    ...(size === undefined ? {} : { size }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(sha256 === undefined ? {} : { sha256 }),
    status: artifactStatus(row.status),
    createdAt: instant(row.created_at),
  }
}

function parseArtifactDetail(value: unknown): XAgentArtifactDetail {
  const row = exactRecordWithOptional(value, [
    'id', 'display_name', 'scope', 'latest_version', 'latest_status', 'can_edit', 'versions',
  ], ['latest_clean_version'])
  if (typeof row.can_edit !== 'boolean' || !Array.isArray(row.versions)) failSchema()
  if (row.versions.length < 1 || row.versions.length > MAX_ARTIFACT_ITEMS) failSchema()
  const summary = parseArtifactSummary(Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'can_edit' && key !== 'versions'),
  ))
  const versions = row.versions.map(parseArtifactVersion)
  const versionIds = new Set<string>()
  const versionNumbers = new Set<number>()
  let previousVersion = Number.POSITIVE_INFINITY
  for (const version of versions) {
    if (
      versionIds.has(version.id)
      || versionNumbers.has(version.version)
      || previousVersion <= version.version
    ) failSchema()
    versionIds.add(version.id)
    versionNumbers.add(version.version)
    previousVersion = version.version
  }
  const latest = versions[0] as XAgentArtifactVersionSummary
  if (summary.latestVersion !== latest.version || summary.latestStatus !== latest.status) failSchema()
  const latestClean = versions.find(version => version.status === 'clean')
  if (summary.latestCleanVersion !== latestClean?.version) failSchema()
  return { ...summary, canEdit: row.can_edit, versions }
}

function validateHttpUrl(value: string, allowRelative: boolean): URL {
  if (
    /\p{White_Space}/u.test(value)
    || value.includes('\\')
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) failSchema()
  const relative = value.startsWith('/') && !value.startsWith('//')
  if ((!allowRelative && relative) || (allowRelative && !relative && !/^https?:\/\//i.test(value))) failSchema()
  let parsed: URL
  try {
    parsed = new URL(value, relative ? 'https://xagent.invalid' : undefined)
  } catch {
    return failSchema()
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.hash !== ''
  ) failSchema()
  return parsed
}

function decodedHttpUrl(value: string, allowRelative: boolean): string {
  let result = value
  for (let round = 0; round < MAX_URL_DECODE_ROUNDS; round += 1) {
    validateHttpUrl(result, allowRelative)
    if (!PERCENT_ESCAPE_PATTERN.test(result)) return result
    let decoded: string
    try {
      decoded = decodeURIComponent(result.replace(LITERAL_PERCENT_PATTERN, '%25'))
    } catch {
      return failSchema()
    }
    result = decoded
  }
  validateHttpUrl(result, allowRelative)
  if (PERCENT_ESCAPE_PATTERN.test(result)) failSchema()
  return result
}

function safeHttpUrl(value: unknown, allowRelative: boolean): { readonly original: string; readonly decoded: string } {
  const result = requiredString(value)
  if (result.length > 16_384) failSchema()
  return { original: result, decoded: decodedHttpUrl(result, allowRelative) }
}

function containsStorageBucket(parsed: URL): boolean {
  if (parsed.hostname.split('.').some(label => label.toLowerCase() === STORAGE_BUCKET)) return true
  const values = [
    ...parsed.pathname.split('/'),
    ...Array.from(parsed.searchParams.entries()).flat(),
    parsed.hash.slice(1),
  ]
  return values.some(value => STORAGE_BUCKET_TOKEN_PATTERN.test(value))
}

function parseArtifactUpload(value: unknown): XAgentArtifactUpload {
  const row = exactRecord(value, ['upload_id', 'put_url', 'expires_at'])
  return {
    id: requiredUuid(row.upload_id),
    putUrl: safeHttpUrl(row.put_url, false).original,
    expiresAt: instant(row.expires_at),
  }
}

function parseArtifactRead(value: unknown): { readonly url: string } {
  const row = exactRecord(value, ['url'])
  const url = safeHttpUrl(row.url, true)
  const parsed = validateHttpUrl(url.decoded, true)
  if (
    OBJECT_KEY_PATTERN.test(url.decoded)
    || STAGING_KEY_PATTERN.test(url.decoded)
    || containsStorageBucket(parsed)
  ) failSchema()
  return { url: url.original }
}

function parseArtifactList(value: unknown): readonly XAgentArtifactSummary[] {
  if (!Array.isArray(value) || value.length > MAX_ARTIFACT_ITEMS) failSchema()
  const artifacts = value.map(parseArtifactSummary)
  const ids = artifacts.map(artifact => artifact.id)
  if (new Set(ids).size !== ids.length) failSchema()
  return artifacts
}

const CITATION_ID_PATTERN = /^\[资料([1-9][0-9]*)\]$/
const OPAQUE_RECEIPT_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_RETRIEVAL_PROJECTS = 20
const MAX_RETRIEVAL_SEARCH_CITATIONS = 8
const MAX_RETRIEVAL_AUTHORIZATION_CITATIONS = 64
const MAX_RETRIEVAL_TEXT_BYTES = 32 * 1024

function payloadHash(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) failSchema()
  return value
}

function opaqueReceipt(value: unknown): string {
  const result = boundedString(value, 1_024)
  if (!OPAQUE_RECEIPT_PATTERN.test(result)) failSchema()
  return result
}

function citationOrdinal(value: unknown): number {
  if (typeof value !== 'string') failSchema()
  const match = CITATION_ID_PATTERN.exec(value)
  if (match === null) failSchema()
  const ordinal = Number(match[1])
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) failSchema()
  return ordinal
}

function citationIdValue(value: unknown): string {
  citationOrdinal(value)
  return value as string
}

function citationIdentity(value: unknown): {
  readonly id: string
  readonly ordinal: number
  readonly artifactId: string
  readonly versionId: string
  readonly chunkId: string
} {
  const row = exactRecord(value, ['id', 'artifact_id', 'version_id', 'chunk_id'])
  const ordinal = citationOrdinal(row.id)
  return {
    id: row.id as string,
    ordinal,
    artifactId: requiredUuid(row.artifact_id),
    versionId: requiredUuid(row.version_id),
    chunkId: requiredUuid(row.chunk_id),
  }
}

function parseRetrievalProject(value: unknown): { readonly projectId: string; readonly name: string } {
  const row = exactRecord(value, ['project_id', 'name'])
  return { projectId: requiredUuid(row.project_id), name: boundedString(row.name, 255) }
}

function parseProjectDiscovery(value: unknown): XAgentProjectDiscoveryResult {
  const row = exactRecord(value, ['schema_version', 'projects', 'receipt', 'payload_sha256'])
  if (row.schema_version !== 1 || !Array.isArray(row.projects) || row.projects.length > MAX_RETRIEVAL_PROJECTS) {
    failSchema()
  }
  const projects = row.projects.map(parseRetrievalProject)
  if (new Set(projects.map(project => project.projectId)).size !== projects.length) failSchema()
  const hash = payloadHash(row.payload_sha256)
  if (canonicalPayloadHash({ schema_version: 1, projects: row.projects }) !== hash) failSchema()
  return {
    projects,
    receipt: opaqueReceipt(row.receipt),
    payloadHash: hash,
  }
}

function parseRetrievalCitation(value: unknown): XAgentRetrievalCitation {
  const row = exactRecord(value, [
    'id', 'artifact_id', 'version_id', 'chunk_id', 'display_name', 'version_number',
    'line_start', 'line_end', 'text', 'scope',
  ])
  const identity = citationIdentity(Object.fromEntries(
    Object.entries(row).filter(([key]) => ['id', 'artifact_id', 'version_id', 'chunk_id'].includes(key)),
  ))
  const lineStart = positiveInteger(row.line_start)
  const lineEnd = positiveInteger(row.line_end)
  if (lineEnd < lineStart || (row.scope !== 'private' && row.scope !== 'project')) failSchema()
  const text = requiredString(row.text)
  return {
    id: identity.id,
    artifactId: identity.artifactId,
    versionId: identity.versionId,
    chunkId: identity.chunkId,
    displayName: boundedString(row.display_name, 255),
    versionNumber: positiveInteger(row.version_number),
    lineStart,
    lineEnd,
    text,
    scope: row.scope,
  }
}

function parseArtifactSearch(value: unknown): {
  readonly citations: readonly XAgentRetrievalCitation[]
  readonly receipt: string
  readonly payloadHash: string
} {
  const row = exactRecord(value, ['schema_version', 'citations', 'receipt', 'payload_sha256'])
  if (row.schema_version !== 1 || !Array.isArray(row.citations) || row.citations.length > MAX_RETRIEVAL_SEARCH_CITATIONS) {
    failSchema()
  }
  if (
    new TextEncoder().encode(JSON.stringify({ schema_version: 1, citations: row.citations })).byteLength
      > MAX_RETRIEVAL_TEXT_BYTES
  ) failSchema()
  const citations = row.citations.map(parseRetrievalCitation)
  if (
    new Set(citations.map(citation => citation.id)).size !== citations.length
    || new Set(citations.map(citation => citation.chunkId)).size !== citations.length
  ) failSchema()
  const ordinals = row.citations.map(citation => citationOrdinal(record(citation).id))
  if (ordinals.some((ordinal, index) => {
    const previous = ordinals[index - 1]
    return previous !== undefined && ordinal !== previous + 1
  })) failSchema()
  const hash = payloadHash(row.payload_sha256)
  if (canonicalPayloadHash({ schema_version: 1, citations: row.citations }) !== hash) failSchema()
  return {
    citations,
    receipt: opaqueReceipt(row.receipt),
    payloadHash: hash,
  }
}

function retrievalOperation(input: {
  readonly sessionId: string
  readonly toolCallId: string
  readonly permissionRevision: number
}): Record<string, unknown> {
  if (
    !UUID_PATTERN.test(input.sessionId)
    || input.toolCallId.length < 1
    || Array.from(input.toolCallId).length > 255
    || !Number.isSafeInteger(input.permissionRevision)
    || input.permissionRevision < 1
  ) failSchema()
  return {
    session_id: input.sessionId,
    tool_call_id: input.toolCallId,
    permission_revision: input.permissionRevision,
  }
}

function canonicalRetrievalProjectIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) failSchema()
  const supplied = value.map(requiredUuid)
  const canonical = [...new Set(supplied.map(projectId => projectId.toLowerCase()))].sort()
  if (
    canonical.length > MAX_RETRIEVAL_PROJECTS
    || supplied.length !== canonical.length
    || supplied.some((projectId, index) => projectId !== canonical[index])
  ) failSchema()
  return Object.freeze(canonical)
}

function citationRequest(value: {
  readonly id: string
  readonly artifactId: string
  readonly versionId: string
  readonly chunkId: string
}): Record<string, unknown> {
  if (
    !UUID_PATTERN.test(value.artifactId)
    || !UUID_PATTERN.test(value.versionId)
    || !UUID_PATTERN.test(value.chunkId)
  ) failSchema()
  citationOrdinal(value.id)
  return {
    id: value.id,
    artifact_id: value.artifactId,
    version_id: value.versionId,
    chunk_id: value.chunkId,
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : 1)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function canonicalPayloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

type RetrievalErrorPair = readonly [number, XAgentBackendErrorCode]

const COMMON_RETRIEVAL_ERRORS: readonly RetrievalErrorPair[] = [
  [401, 'unauthenticated'],
  [404, 'session-not-found'],
  [503, 'service-unavailable'],
]
const PROJECT_DISCOVERY_ERRORS = [...COMMON_RETRIEVAL_ERRORS, [400, 'invalid-retrieval-scope']] as const
const SEARCH_ERRORS = [...COMMON_RETRIEVAL_ERRORS, [400, 'invalid-retrieval-scope'], [503, 'retrieval-unavailable']] as const
const CITATION_ERRORS = [...COMMON_RETRIEVAL_ERRORS, [422, 'citation-invalid']] as const

function retrievalErrorCode(
  status: number,
  value: unknown,
  allowed: readonly RetrievalErrorPair[],
): XAgentBackendErrorCode {
  let code: unknown
  try {
    code = exactRecord(exactRecord(value, ['detail']).detail, ['code']).code
  } catch {
    return 'service-unavailable'
  }
  return allowed.some(([allowedStatus, allowedCode]) => allowedStatus === status && allowedCode === code)
    ? code as XAgentBackendErrorCode
    : 'service-unavailable'
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
  return new TextDecoder('utf-8', { fatal: true }).decode(body)
}

function errorCode(status: number, value: unknown): XAgentBackendErrorCode {
  if (status === 401) return 'unauthenticated'
  const detail = typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>).detail
    : undefined
  const code = typeof detail === 'object' && detail !== null
    ? (detail as Record<string, unknown>).code
    : undefined
  if (typeof code !== 'string' || !STABLE_CODES.has(code as XAgentBackendErrorCode)) {
    return 'service-unavailable'
  }
  const accepted = status === 400 && code === 'unsupported-version'
    || status === 403 && code === 'forbidden'
    || status === 404 && (code === 'not-found' || code === 'session-not-found')
    || status === 409 && (code === 'sequence-conflict' || code === 'idempotency-conflict')
    || status === 410 && code === 'upload-expired'
    || status === 422 && code === 'upload-rejected'
    || status === 503 && code === 'service-unavailable'
  return accepted ? code : 'service-unavailable'
}

const SESSION_APPEND_ERRORS: readonly RetrievalErrorPair[] = [
  [400, 'unsupported-version'],
  [401, 'unauthenticated'],
  [404, 'not-found'],
  [404, 'session-not-found'],
  [409, 'sequence-conflict'],
  [409, 'idempotency-conflict'],
  [409, 'evidence-conflict'],
  [410, 'evidence-expired'],
  [503, 'service-unavailable'],
]

function sessionAppendResult(
  value: unknown,
  expectedLastSequence: number,
): XAgentSessionAppendResult {
  const row = exactRecord(value, ['schema_version', 'last_event_sequence', 'version'])
  if (
    row.schema_version !== 1
    || !Number.isSafeInteger(row.last_event_sequence)
    || row.last_event_sequence !== expectedLastSequence
  ) failSchema()
  return {
    schema_version: 1,
    last_event_sequence: row.last_event_sequence,
    version: positiveInteger(row.version),
  }
}

const COMMON_ARTIFACT_ERROR_CODES: readonly (readonly [number, XAgentBackendErrorCode])[] = [
  [401, 'unauthenticated'],
  [503, 'service-unavailable'],
]

function artifactErrorCodes(
  ...domain: readonly (readonly [number, XAgentBackendErrorCode])[]
): ReadonlyMap<number, XAgentBackendErrorCode> {
  return new Map([...COMMON_ARTIFACT_ERROR_CODES, ...domain])
}

const ARTIFACT_LIST_ERROR_CODES = artifactErrorCodes()
const ARTIFACT_DETAIL_ERROR_CODES = artifactErrorCodes([404, 'not-found'])
const ARTIFACT_CREATE_ERROR_CODES = artifactErrorCodes([409, 'idempotency-conflict'])
const ARTIFACT_CREATE_VERSION_ERROR_CODES = artifactErrorCodes(
  [404, 'not-found'],
  [409, 'idempotency-conflict'],
)
const ARTIFACT_COMPLETE_ERROR_CODES = artifactErrorCodes(
  [404, 'not-found'],
  [409, 'idempotency-conflict'],
  [422, 'upload-rejected'],
)
const ARTIFACT_RETRY_ERROR_CODES = artifactErrorCodes(
  [404, 'not-found'],
  [409, 'idempotency-conflict'],
  [410, 'upload-expired'],
  [422, 'upload-rejected'],
)
const ARTIFACT_READ_ERROR_CODES = artifactErrorCodes(
  [403, 'forbidden'],
  [404, 'not-found'],
)

function artifactErrorCode(
  status: number,
  value: unknown,
  allowed: ReadonlyMap<number, XAgentBackendErrorCode>,
): XAgentBackendErrorCode {
  let code: unknown
  try {
    const response = exactRecord(value, ['detail'])
    code = exactRecord(response.detail, ['code']).code
  } catch {
    return 'service-unavailable'
  }
  const expected = allowed.get(status)
  return expected !== undefined && code === expected ? expected : 'service-unavailable'
}

/** Bounded Host client for XAgent authentication, Session, workbench, and Artifact APIs. */
export class XAgentBackendClient implements XAgentBackend {
  private readonly origin: URL
  private readonly fetcher: typeof globalThis.fetch
  private readonly timeoutMs: number
  private readonly maxRequestBytes: number
  private readonly maxResponseBytes: number
  private readonly connectionId: () => string
  readonly sessions: XAgentSessionBackend
  readonly workbench: XAgentWorkbenchBackend
  readonly artifacts: XAgentArtifactBackend
  readonly retrieval: XAgentRetrievalBackend

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
      append: async (token, id, body, signal) => sessionAppendResult(
        await this.request(
          token,
          `/internal/xagent/sessions/${encodeURIComponent(id)}/append`,
          body,
          signal,
          false,
          true,
          200,
          (status, value) => retrievalErrorCode(status, value, SESSION_APPEND_ERRORS),
        ),
        body.expected_sequence + body.events.length,
      ),
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
    const artifacts: XAgentArtifactBackend = {
      list: async (token, signal) => parseArtifactList(await this.artifactRequest(
        token, '/internal/xagent/artifacts/list', {}, 200, ARTIFACT_LIST_ERROR_CODES, signal,
      )),
      detail: async (token, artifactId, signal) => parseArtifactDetail(await this.artifactRequest(
        token,
        `/internal/xagent/artifacts/${encodeURIComponent(artifactId)}`,
        {},
        200,
        ARTIFACT_DETAIL_ERROR_CODES,
        signal,
      )),
      createUpload: async (token, input, signal) => parseArtifactUpload(await this.artifactRequest(
        token,
        '/internal/xagent/artifacts/uploads',
        { filename: input.filename, size: input.size, idempotency_key: input.idempotencyKey },
        201,
        ARTIFACT_CREATE_ERROR_CODES,
        signal,
      )),
      createVersionUpload: async (token, artifactId, input, signal) => parseArtifactUpload(await this.artifactRequest(
        token,
        `/internal/xagent/artifacts/${encodeURIComponent(artifactId)}/uploads`,
        { filename: input.filename, size: input.size, idempotency_key: input.idempotencyKey },
        201,
        ARTIFACT_CREATE_VERSION_ERROR_CODES,
        signal,
      )),
      completeUpload: async (token, uploadId, input, signal) => parseArtifactDetail(await this.artifactRequest(
        token,
        `/internal/xagent/artifacts/uploads/${encodeURIComponent(uploadId)}/complete`,
        { actual_size: input.size, sha256: input.sha256, idempotency_key: input.idempotencyKey },
        201,
        ARTIFACT_COMPLETE_ERROR_CODES,
        signal,
      )),
      retry: async (token, versionId, idempotencyKey, signal) => parseArtifactDetail(await this.artifactRequest(
        token,
        `/internal/xagent/artifact-versions/${encodeURIComponent(versionId)}/retry`,
        { idempotency_key: idempotencyKey },
        200,
        ARTIFACT_RETRY_ERROR_CODES,
        signal,
      )),
      preview: async (token, versionId, signal) => parseArtifactRead(await this.artifactRequest(
        token,
        `/internal/xagent/artifact-versions/${encodeURIComponent(versionId)}/preview`,
        {},
        200,
        ARTIFACT_READ_ERROR_CODES,
        signal,
      )),
      download: async (token, versionId, signal) => parseArtifactRead(await this.artifactRequest(
        token,
        `/internal/xagent/artifact-versions/${encodeURIComponent(versionId)}/download`,
        {},
        200,
        ARTIFACT_READ_ERROR_CODES,
        signal,
      )),
    }
    this.artifacts = Object.freeze(artifacts)
    const retrieval: XAgentRetrievalBackend = {
      projects: async (token, delegation, input, signal) => {
        if (input.query !== undefined) boundedString(input.query, 255)
        return parseProjectDiscovery(await this.retrievalRequest(
          token,
          delegation,
          '/internal/xagent/retrieval/projects',
          {
            schema_version: 1,
            ...retrievalOperation(input),
            ...(input.query === undefined ? {} : { query: input.query }),
          },
          PROJECT_DISCOVERY_ERRORS,
          signal,
        ))
      },
      search: async (token, delegation, input, signal) => {
        boundedString(input.query, 8_192)
        if (typeof input.includePrivate !== 'boolean') failSchema()
        let projectIds: readonly string[] | undefined
        if (input.projectIds !== undefined) {
          projectIds = canonicalRetrievalProjectIds(input.projectIds)
        }
        if (projectIds !== undefined) {
          if (
            (projectIds.length === 0 && !input.includePrivate)
            || input.scopeHash === undefined
            || !SHA256_PATTERN.test(input.scopeHash)
          ) failSchema()
          const canonicalScope = JSON.stringify({
            include_private: input.includePrivate,
            kind: 'private',
            project_ids: projectIds,
          })
          if (createHash('sha256').update(canonicalScope).digest('hex') !== input.scopeHash) failSchema()
        } else if (input.includePrivate || input.scopeHash !== undefined) {
          failSchema()
        }
        return parseArtifactSearch(await this.retrievalRequest(
          token,
          delegation,
          '/internal/xagent/retrieval/search',
          {
            schema_version: 1,
            ...retrievalOperation(input),
            query: input.query,
            ...(projectIds === undefined ? {} : { project_ids: projectIds }),
            include_private: input.includePrivate,
          },
          SEARCH_ERRORS,
          signal,
        ))
      },
      authorizeCitations: async (token, delegation, input, signal) => {
        if (
          !Array.isArray(input.citations)
          || input.citations.length < 1
          || input.citations.length > MAX_RETRIEVAL_AUTHORIZATION_CITATIONS
        ) failSchema()
        const citations = input.citations.map(citationRequest)
        if (
          new Set(citations.map(citation => citation.id)).size !== citations.length
          || new Set(citations.map(citation => citation.chunk_id)).size !== citations.length
        ) failSchema()
        const value = await this.retrievalRequest(
          token,
          delegation,
          '/internal/xagent/retrieval/citations/authorize',
          { schema_version: 1, ...retrievalOperation(input), citations },
          CITATION_ERRORS,
          signal,
        )
        const row = exactRecord(value, ['schema_version', 'authorized'])
        if (row.schema_version !== 1 || row.authorized !== true) failSchema()
      },
      resolveCitation: async (token, delegation, input, signal): Promise<XAgentResolvedCitation> => {
        const citationId = citationIdValue(input.citationId)
        const value = await this.retrievalRequest(
          token,
          delegation,
          '/internal/xagent/retrieval/citations/resolve',
          { schema_version: 1, ...retrievalOperation(input), citation_id: citationId },
          CITATION_ERRORS,
          signal,
        )
        const row = exactRecord(value, [
          'schema_version', 'artifact_id', 'version_id', 'chunk_id', 'line_start', 'line_end',
        ])
        const lineStart = positiveInteger(row.line_start)
        const lineEnd = positiveInteger(row.line_end)
        const artifactId = requiredUuid(row.artifact_id)
        const versionId = requiredUuid(row.version_id)
        const chunkId = requiredUuid(row.chunk_id)
        if (
          row.schema_version !== 1
          || lineEnd < lineStart
        ) failSchema()
        return { id: citationId, artifactId, versionId, chunkId, lineStart, lineEnd }
      },
    }
    this.retrieval = Object.freeze(retrieval)
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

  private artifactRequest(
    userToken: string,
    path: string,
    body: unknown,
    expectedStatus: number,
    allowedErrors: ReadonlyMap<number, XAgentBackendErrorCode>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(
      userToken,
      path,
      body,
      signal,
      false,
      true,
      expectedStatus,
      (status, value) => artifactErrorCode(status, value, allowedErrors),
    )
  }

  private retrievalRequest(
    userToken: string,
    delegationToken: string,
    path: string,
    body: unknown,
    allowedErrors: readonly RetrievalErrorPair[],
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (delegationToken.length === 0) return Promise.reject(new XAgentBackendError('service-unavailable'))
    return this.request(
      userToken,
      path,
      body,
      signal,
      false,
      true,
      200,
      (status, value) => retrievalErrorCode(status, value, allowedErrors),
      delegationToken,
    )
  }

  private async request(
    userToken: string | undefined,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    allowEmpty = false,
    internal = true,
    expectedStatus?: number,
    mapError = errorCode,
    delegationToken?: string,
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
        if (delegationToken !== undefined) headers.set('x-xagent-delegation', delegationToken)
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
      if (response.ok && expectedStatus !== undefined && response.status !== expectedStatus) {
        throw new XAgentBackendError('service-unavailable')
      }
      let value: unknown
      try {
        value = raw === '' && allowEmpty ? undefined : JSON.parse(raw)
      } catch {
        throw new XAgentBackendError('service-unavailable')
      }
      if (!response.ok) throw new XAgentBackendError(mapError(response.status, value))
      return value
    } catch (error) {
      if (error instanceof XAgentBackendError) throw error
      throw new XAgentBackendError('service-unavailable')
    }
  }
}
