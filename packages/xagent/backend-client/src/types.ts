import type { XAgentPrincipal } from '@xagent/dsh-principal'

export type XAgentBackendErrorCode =
  | 'unauthenticated'
  | 'not-found'
  | 'sequence-conflict'
  | 'idempotency-conflict'
  | 'unsupported-version'
  | 'service-unavailable'

export interface XAgentSessionBackend {
  list(userToken: string, signal?: AbortSignal): Promise<unknown>
  create(userToken: string, body: unknown, signal?: AbortSignal): Promise<unknown>
  open(userToken: string, sessionId: string, signal?: AbortSignal): Promise<unknown>
  events(userToken: string, sessionId: string, body: unknown, signal?: AbortSignal): Promise<unknown>
  append(userToken: string, sessionId: string, body: unknown, signal?: AbortSignal): Promise<unknown>
  fork(userToken: string, sessionId: string, body: unknown, signal?: AbortSignal): Promise<unknown>
  archive(userToken: string, sessionId: string, body: unknown, signal?: AbortSignal): Promise<unknown>
}

export interface XAgentBackend {
  introspect(userToken: string, signal?: AbortSignal): Promise<XAgentPrincipal>
  revoke(userToken: string, signal?: AbortSignal): Promise<void>
  readonly sessions: XAgentSessionBackend
}
