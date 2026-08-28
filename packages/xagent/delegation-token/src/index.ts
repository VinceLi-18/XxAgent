/** XAgent Ed25519 短时、限域、单次委托令牌。 @module @xagent/dsh-delegation-token */

import { createHash, randomBytes, sign, verify } from 'node:crypto'
import type {
  DelegationClaims,
  DelegationScope,
  IssueDelegationOptions,
  RetrievalDelegationScope,
  RetrievalDelegationScopeInput,
  VerifyDelegationOptions,
} from './types.ts'

export type {
  DelegationClaims,
  DelegationScope,
  IssueDelegationOptions,
  RetrievalDelegationScope,
  RetrievalDelegationScopeInput,
  VerifyDelegationOptions,
} from './types.ts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REJECTED = 'delegation rejected'
const CLAIM_KEYS = [
  'actor_id', 'aud', 'exp', 'iat', 'iss', 'nonce', 'permission_revision',
  'project_id', 'session_id', 'tool_call_id', 'tool_name',
] as const

/**
 * Generate an unpredictable per-call nonce for FastAPI's durable single-use check.
 * @returns a 256-bit base64url nonce.
 */
export function newDelegationNonce(): string {
  return randomBytes(32).toString('base64url')
}

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function parsePart(value: string): unknown {
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw new Error(REJECTED)
  return JSON.parse(bytes.toString('utf8'))
}

function validScope(value: DelegationScope): boolean {
  return UUID_PATTERN.test(value.actorId)
    && (value.projectId === null || UUID_PATTERN.test(value.projectId))
    && UUID_PATTERN.test(value.sessionId)
    && value.toolCallId.length > 0
    && value.toolName.length > 0
    && Number.isSafeInteger(value.permissionRevision)
    && value.permissionRevision >= 1
}

/**
 * Canonicalize the explicit Private Session retrieval scope bound by the FastAPI request.
 * @param input - caller-selected projects and private-artifact inclusion.
 * @returns sorted scope values and the FastAPI-compatible canonical JSON digest.
 */
export function canonicalizeRetrievalDelegationScope(
  input: RetrievalDelegationScopeInput,
): RetrievalDelegationScope {
  const rawProjectIds: unknown = input.projectIds
  if (!Array.isArray(rawProjectIds) || typeof input.includePrivate !== 'boolean') throw new Error(REJECTED)
  if (rawProjectIds.some((projectId: unknown) => typeof projectId !== 'string' || !UUID_PATTERN.test(projectId))) {
    throw new Error(REJECTED)
  }
  const projectIds = [...new Set(rawProjectIds.map((projectId: unknown) => (projectId as string).toLowerCase()))]
  if (
    projectIds.length > 20
    || (projectIds.length === 0 && !input.includePrivate)
  ) throw new Error(REJECTED)
  projectIds.sort()
  const canonical = JSON.stringify({
    include_private: input.includePrivate,
    kind: 'private',
    project_ids: projectIds,
  })
  return Object.freeze({
    projectIds: Object.freeze(projectIds),
    includePrivate: input.includePrivate,
    scopeHash: createHash('sha256').update(canonical).digest('hex'),
  })
}

/**
 * Issue one Ed25519 delegation token with a maximum sixty-second lifetime.
 * @param options - exact scope, signer, audience, time, and nonce.
 * @returns the compact signed token.
 */
export function issueDelegationToken(options: IssueDelegationOptions): string {
  if (
    !validScope(options)
    || !Number.isInteger(options.now)
    || !Number.isInteger(options.expiresInSeconds)
    || options.expiresInSeconds < 1
    || options.expiresInSeconds > 60
    || options.issuer.length === 0
    || options.audience.length === 0
    || options.nonce.length === 0
  ) throw new Error(REJECTED)
  const header = encoded({ alg: 'EdDSA', typ: 'JWT' })
  const payload = encoded({
    iss: options.issuer,
    aud: options.audience,
    iat: options.now,
    exp: options.now + options.expiresInSeconds,
    actor_id: options.actorId,
    project_id: options.projectId,
    session_id: options.sessionId,
    tool_call_id: options.toolCallId,
    tool_name: options.toolName,
    permission_revision: options.permissionRevision,
    nonce: options.nonce,
  })
  const signingInput = `${header}.${payload}`
  const signature = sign(null, Buffer.from(signingInput), options.privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}

/**
 * Verify and consume one delegation token against the expected operation.
 * @param token - compact signed token from the trusted issuer.
 * @param options - verifier, expected scope, current revision, and nonce consumer.
 * @returns immutable validated delegation claims.
 */
export async function verifyDelegationToken(
  token: string,
  options: VerifyDelegationOptions,
): Promise<DelegationClaims> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error(REJECTED)
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
    const header = parsePart(headerPart) as Record<string, unknown>
    const payload = parsePart(payloadPart) as Record<string, unknown>
    const signature = Buffer.from(signaturePart, 'base64url')
    if (signature.toString('base64url') !== signaturePart) throw new Error(REJECTED)
    if (
      header.alg !== 'EdDSA'
      || header.typ !== 'JWT'
      || Object.keys(payload).sort().some((key, index) => key !== CLAIM_KEYS[index])
      || Object.keys(payload).length !== CLAIM_KEYS.length
    ) throw new Error(REJECTED)
    if (!verify(null, Buffer.from(`${headerPart}.${payloadPart}`), options.publicKey, signature)) {
      throw new Error(REJECTED)
    }
    const scope: DelegationScope = {
      actorId: payload.actor_id as string,
      projectId: payload.project_id as string | null,
      sessionId: payload.session_id as string,
      toolCallId: payload.tool_call_id as string,
      toolName: payload.tool_name as string,
      permissionRevision: payload.permission_revision as number,
    }
    const issuedAt = payload.iat
    const expiresAt = payload.exp
    const nonce = payload.nonce
    if (
      payload.iss !== options.issuer
      || payload.aud !== options.audience
      || !validScope(scope)
      || typeof issuedAt !== 'number'
      || !Number.isInteger(issuedAt)
      || typeof expiresAt !== 'number'
      || !Number.isInteger(expiresAt)
      || expiresAt - issuedAt > 60
      || expiresAt <= options.now
      || issuedAt > options.now
      || typeof nonce !== 'string'
      || nonce.length === 0
      || scope.permissionRevision !== options.currentPermissionRevision
      || scope.actorId !== options.expected.actorId
      || scope.projectId !== options.expected.projectId
      || scope.sessionId !== options.expected.sessionId
      || scope.toolCallId !== options.expected.toolCallId
      || scope.toolName !== options.expected.toolName
      || scope.permissionRevision !== options.expected.permissionRevision
      || !await options.consumeNonce(nonce)
    ) throw new Error(REJECTED)
    return Object.freeze({ ...scope, nonce, issuedAt, expiresAt })
  } catch {
    throw new Error(REJECTED)
  }
}
