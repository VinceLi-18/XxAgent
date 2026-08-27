import type { KeyObject } from 'node:crypto'

/** Exact actor, project, Session, tool call, and permission revision delegated once. */
export interface DelegationScope {
  actorId: string
  projectId: string | null
  sessionId: string
  toolCallId: string
  toolName: string
  permissionRevision: number
}

/** Signing inputs for a short-lived Ed25519 delegation token. */
export interface IssueDelegationOptions extends DelegationScope {
  issuer: string
  audience: string
  privateKey: KeyObject
  now: number
  expiresInSeconds: number
  nonce: string
}

/** Expected scope and single-use checks for delegation verification. */
export interface VerifyDelegationOptions {
  publicKey: KeyObject
  issuer: string
  audience: string
  now: number
  expected: DelegationScope
  currentPermissionRevision: number
  consumeNonce(nonce: string): Promise<boolean>
}

/** Validated immutable claims returned after signature, scope, expiry, and nonce checks. */
export interface DelegationClaims extends DelegationScope {
  nonce: string
  issuedAt: number
  expiresAt: number
}
