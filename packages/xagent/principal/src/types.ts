export type XAgentRole = 'manager' | 'specialist'

export interface XAgentPrincipal {
  readonly actorId: string
  readonly role: XAgentRole
  readonly permissionRevision: number
  readonly authSessionId: string
  readonly connectionId: string
}

export interface XAgentPrincipalResolver {
  resolve(userToken: string, connectionId: string, signal?: AbortSignal): Promise<XAgentPrincipal>
}
