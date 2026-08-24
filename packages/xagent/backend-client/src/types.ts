import type { XAgentPrincipal } from '@xagent/dsh-principal'

/** Stable error vocabulary exposed across the Host/FastAPI boundary. */
export type XAgentBackendErrorCode =
  | 'unauthenticated'
  | 'not-found'
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

/** Authentication and Session contract implemented by the XAgent FastAPI client. */
export interface XAgentBackend {
  login(email: string, password: string, signal?: AbortSignal): Promise<XAgentIssuedLogin>
  introspect(userToken: string, signal?: AbortSignal): Promise<XAgentPrincipal>
  revoke(userToken: string, signal?: AbortSignal): Promise<void>
  readonly sessions: XAgentSessionBackend
}
