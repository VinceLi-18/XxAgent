import type { KeyObject } from 'node:crypto'

export interface DelegationScope {
  actorId: string
  projectId: string | null
  sessionId: string
  toolCallId: string
  toolName: string
  permissionRevision: number
}

export interface IssueDelegationOptions extends DelegationScope {
  issuer: string
  audience: string
  privateKey: KeyObject
  now: number
  expiresInSeconds: number
  nonce: string
}

export interface VerifyDelegationOptions {
  publicKey: KeyObject
  issuer: string
  audience: string
  now: number
  expected: DelegationScope
  currentPermissionRevision: number
  consumeNonce(nonce: string): Promise<boolean>
}

export interface DelegationClaims extends DelegationScope {
  nonce: string
  issuedAt: number
  expiresAt: number
}
