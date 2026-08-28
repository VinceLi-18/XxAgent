/** Authenticated XAgent retrieval service and private receipt lifetime. @module @xagent/dsh-retrieval */

import { createPrivateKey, type KeyObject } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  XAgentBackendClient,
  XAgentBackendError,
  type XAgentArtifactSearchInput,
  type XAgentRetrievalBackend,
} from '@xagent/dsh-backend-client'
import {
  canonicalizeRetrievalDelegationScope,
  issueDelegationToken,
  newDelegationNonce,
} from '@xagent/dsh-delegation-token'
import {
  currentXAgentAuthenticatedRequestScope,
  runWithoutXAgentAuthenticatedRequestScope,
  runWithXAgentAuthenticatedRequestScope,
  type XAgentAuthenticatedSessionRequestScope,
} from '@xagent/dsh-principal'
import { XAgentReceiptRegistry } from './receipt-registry.ts'
import type {
  XAgentAccessibleProjects,
  XAgentArtifactSearch,
  XAgentListAccessibleProjectsInput,
  XAgentRetrievalErrorCode,
  XAgentSearchArtifactsInput,
} from './types.ts'

export type * from './types.ts'
export { XAgentReceiptRegistry } from './receipt-registry.ts'

const SESSION_ID_PATTERN = /^(?:session-)?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const RETRIEVAL_ERRORS = new Set<XAgentRetrievalErrorCode>([
  'unauthenticated', 'session-not-found', 'invalid-retrieval-scope', 'retrieval-unavailable',
  'evidence-expired', 'evidence-conflict', 'citation-invalid', 'service-unavailable',
])

/** Host retrieval provider configuration. */
export interface Config {
  /** FastAPI service origin. */
  backendOrigin: string
  /** Host service identity for internal calls. */
  serviceToken: string
  /** Ed25519 private key PEM used only for per-call delegation. */
  delegationPrivateKey: string
  /** Exact delegation issuer accepted by FastAPI. */
  delegationIssuer: string
  /** Exact delegation audience accepted by FastAPI. */
  delegationAudience: string
  /** Exact pinned BGE tokenizer counter supplied by the Host composition. */
  countQueryTokens: (value: string) => number
}

export const Config: z<Config> = z.object({
  backendOrigin: z.string().required(),
  serviceToken: z.string().required(),
  delegationPrivateKey: z.string().required(),
  delegationIssuer: z.string().required(),
  delegationAudience: z.string().required(),
  countQueryTokens: z.function().required(),
})

export const name = 'xagent-retrieval'

interface ServiceOptions {
  readonly issuer: string
  readonly audience: string
  readonly privateKey?: KeyObject
  readonly now?: () => number
  readonly countQueryTokens?: (value: string) => number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    xagentRetrieval: XAgentRetrieval
  }
}

/** Stable failure with no backend detail or sensitive value. */
export class XAgentRetrievalError extends Error {
  constructor(readonly code: XAgentRetrievalErrorCode) {
    super(code)
    this.name = 'XAgentRetrievalError'
  }
}

function registerReceipt(
  registry: XAgentReceiptRegistry,
  input: { sessionId: string; toolCallId: string; receipt: string; payloadHash: string },
): void {
  try {
    registry.register(input)
  } catch {
    throw new XAgentRetrievalError('service-unavailable')
  }
}

/** Service Definition consumed by model tools and later citation policy. */
export abstract class XAgentRetrieval extends Service {
  /** Opaque receipt lifetime consumed only by XAgent Session persistence. */
  abstract readonly receipts: XAgentReceiptRegistry

  constructor(ctx: Context) {
    super(ctx, 'xagentRetrieval')
  }

  /**
   * Discover accessible projects for the exact authenticated Private Session.
   * @param input - immutable Session/tool identity and optional bounded name query.
   * @returns at most twenty accessible projects and the public payload hash.
   */
  abstract listAccessibleProjects(input: XAgentListAccessibleProjectsInput): Promise<XAgentAccessibleProjects>
  /**
   * Search Artifact evidence within the exact authenticated Session scope.
   * @param input - immutable identity, query, and explicit Private Session selectors.
   * @returns authorized citation excerpts and the public payload hash.
   */
  abstract searchArtifacts(input: XAgentSearchArtifactsInput): Promise<XAgentArtifactSearch>
}

function authenticatedSessionScope(value: unknown): value is XAgentAuthenticatedSessionRequestScope {
  if (typeof value !== 'object' || value === null) return false
  const scope = value as Partial<XAgentAuthenticatedSessionRequestScope>
  return typeof scope.sessionId === 'string'
    && UUID_PATTERN.test(scope.sessionId)
    && (scope.visibility === 'private' || scope.visibility === 'project')
    && ((scope.visibility === 'private' && scope.projectId === null)
      || (scope.visibility === 'project' && typeof scope.projectId === 'string' && UUID_PATTERN.test(scope.projectId)))
    && typeof scope.userToken === 'string'
    && scope.userToken.length > 0
    && typeof scope.connectionId === 'string'
    && scope.connectionId.length > 0
    && scope.principal?.connectionId === scope.connectionId
}

function backendSessionId(value: string): string {
  const match = SESSION_ID_PATTERN.exec(value)
  if (match?.[1] === undefined) throw new XAgentRetrievalError('unauthenticated')
  return match[1].toLowerCase()
}

function matchesBackendSessionId(value: string, expected: string): boolean {
  return SESSION_ID_PATTERN.exec(value)?.[1]?.toLowerCase() === expected
}

function queryValue(value: string, countTokens: (value: string) => number): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new XAgentRetrievalError('invalid-retrieval-scope')
  }
  const tokenCount = countTokens(value)
  if (!Number.isSafeInteger(tokenCount) || tokenCount < 0) {
    throw new XAgentRetrievalError('service-unavailable')
  }
  if (tokenCount > 512) throw new XAgentRetrievalError('invalid-retrieval-scope')
  return value
}

function discoveryQuery(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.length === 0 || value.trim() !== value || Array.from(value).length > 255) {
    throw new XAgentRetrievalError('invalid-retrieval-scope')
  }
  return value
}

function toolResultIdentity(event: SessionEvent): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const block = event.data.message.content[0]
  return String(block.toolCallId)
}

function samePhysicalScope(
  left: XAgentAuthenticatedSessionRequestScope,
  right: XAgentAuthenticatedSessionRequestScope,
): boolean {
  return left.sessionId === right.sessionId
    && left.userToken === right.userToken
    && left.connectionId === right.connectionId
    && left.principal.actorId === right.principal.actorId
    && left.principal.permissionRevision === right.principal.permissionRevision
    && left.principal.authSessionId === right.principal.authSessionId
}

/** FastAPI provider with one operation scope and quiescent disposal. */
export class XAgentRetrievalService extends XAgentRetrieval {
  readonly receipts: XAgentReceiptRegistry
  private readonly backend: XAgentRetrievalBackend
  private readonly controllers = new Map<AbortController, Promise<void>>()
  private readonly issuer: string
  private readonly audience: string
  private readonly privateKey: KeyObject | undefined
  private readonly now: () => number
  private readonly countQueryTokens: (value: string) => number
  private accepting = true
  private readonly closeResultObserver: () => void
  private readonly closePostObserver: () => void
  private readonly closeSessionObserver: () => void
  private readonly closeScopeObservers: readonly (() => void)[]
  private readonly messageScopes = new Map<string, {
    readonly agent: object
    readonly scope?: XAgentAuthenticatedSessionRequestScope
  }>()
  private readonly activeScopes = new Map<object, XAgentAuthenticatedSessionRequestScope>()
  private disposal: Promise<void> | undefined

  constructor(
    ctx: Context,
    backend: XAgentRetrievalBackend,
    receipts: XAgentReceiptRegistry,
    options: ServiceOptions,
  ) {
    super(ctx)
    this.backend = backend
    this.receipts = receipts
    this.issuer = options.issuer
    this.audience = options.audience
    this.privateKey = options.privateKey
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
    if (options.countQueryTokens === undefined) throw new Error('xagent retrieval requires an exact BGE query token counter')
    this.countQueryTokens = options.countQueryTokens
    const closeInserted = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      const scope = currentXAgentAuthenticatedRequestScope()
      if (!authenticatedSessionScope(scope) || !matchesBackendSessionId(String(agent.session.id), scope.sessionId)) return
      for (const [messageId, binding] of this.messageScopes) {
        if (binding.scope?.sessionId === scope.sessionId && !samePhysicalScope(binding.scope, scope)) {
          this.messageScopes.set(messageId, { agent: binding.agent })
        }
      }
      this.messageScopes.set(String(message.id), { agent, scope })
    })
    const closeDiscarded = ctx.on('agent/inbox/discarded', ({ message }) => {
      this.messageScopes.delete(String(message.id))
    })
    const closeDisposed = ctx.on('agent/disposed', ({ agent }) => {
      this.activeScopes.delete(agent)
      for (const [messageId, binding] of this.messageScopes) {
        if (binding.agent === agent) this.messageScopes.delete(messageId)
      }
    })
    const closePreStep = ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const scopes: XAgentAuthenticatedSessionRequestScope[] = []
      let invalidated = false
      for (const message of messages) {
        const binding = this.messageScopes.get(String(message.id))
        this.messageScopes.delete(String(message.id))
        if (binding === undefined || binding.agent !== agent) continue
        const bindingScope = binding.scope
        if (bindingScope === undefined) {
          invalidated = true
        } else if (!scopes.some(value => samePhysicalScope(value, bindingScope))) {
          scopes.push(bindingScope)
        }
      }
      if (invalidated || scopes.length > 1) {
        this.activeScopes.delete(agent)
        return { kind: 'reject' as const }
      }
      if (scopes[0] !== undefined) this.activeScopes.set(agent, scopes[0])
      const decision = await next()
      if (decision.kind === 'reject') this.activeScopes.delete(agent)
      return decision
    })
    const closeToolExecution = ctx.on('tools/execute', (exec, next) => {
      if (exec.name !== 'list_accessible_projects' && exec.name !== 'search_artifacts') return next()
      const scope = exec.agent === undefined ? undefined : this.activeScopes.get(exec.agent)
      return scope === undefined
        ? runWithoutXAgentAuthenticatedRequestScope(next)
        : runWithXAgentAuthenticatedRequestScope(scope, next)
    })
    this.closeScopeObservers = [closeInserted, closeDiscarded, closeDisposed, closePreStep, closeToolExecution]
    this.closeSessionObserver = ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') {
        for (const [agent] of this.activeScopes) {
          if (String((agent as { session?: { id?: unknown } }).session?.id) === String(session.id)) {
            this.activeScopes.delete(agent)
          }
        }
      }
      const meta = event.type === 'tool/result' ? event.data.meta : undefined
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return
      const row = meta as Record<string, unknown>
      if (row.kind !== 'xagent-retrieval' || !HASH_PATTERN.test(String(row.payloadHash))) return
      const toolCallId = toolResultIdentity(event)
      if (toolCallId === undefined) return
      try {
        this.receipts.bindEvent(String(session.id), toolCallId, event.seq, String(row.payloadHash))
      } catch (error: unknown) {
        ctx.logger.warn(`xagent retrieval receipt binding rejected: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
    })
    this.closeResultObserver = ctx.on('tools/result', (exec, result) => {
      this.observeToolResult(exec, result)
    })
    this.closePostObserver = ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      if (exec.name !== 'list_accessible_projects' && exec.name !== 'search_artifacts') return decision
      if (this.accepting || decision.kind === 'block') return decision
      this.receipts.discard(String(exec.agent?.session.id ?? ''), String(exec.callId))
      return {
        kind: 'block' as const,
        feedback: [{ type: 'text' as const, text: 'Error: service-unavailable' }],
      }
    })
    ctx.effect(() => () => this.dispose(), 'xagent retrieval service')
  }

  /** Discover at most twenty accessible projects for a Private Session. */
  async listAccessibleProjects(input: XAgentListAccessibleProjectsInput): Promise<XAgentAccessibleProjects> {
    const scope = this.requireScope(input.sessionId)
    if (scope.visibility !== 'private') throw new XAgentRetrievalError('invalid-retrieval-scope')
    const query = discoveryQuery(input.query)
    const result = await this.call(input.signal, async signal => this.backend.projects(
      scope.userToken,
      this.delegation(scope, input.toolCallId, 'list_accessible_projects'),
      {
        sessionId: scope.sessionId,
        toolCallId: input.toolCallId,
        permissionRevision: scope.principal.permissionRevision,
        ...query === undefined ? {} : { query },
      },
      signal,
    ))
    registerReceipt(this.receipts, {
      sessionId: String(input.sessionId), toolCallId: input.toolCallId,
      receipt: result.receipt, payloadHash: result.payloadHash,
    })
    return Object.freeze({ projects: result.projects, payloadHash: result.payloadHash })
  }

  /** Search only the fixed Project Session or canonical explicit Private Session scope. */
  async searchArtifacts(input: XAgentSearchArtifactsInput): Promise<XAgentArtifactSearch> {
    const scope = this.requireScope(input.sessionId)
    const query = queryValue(input.query, this.countQueryTokens)
    let request: XAgentArtifactSearchInput
    if (scope.visibility === 'project') {
      if (input.projectIds !== undefined || input.includePrivate) {
        throw new XAgentRetrievalError('invalid-retrieval-scope')
      }
      request = {
        sessionId: scope.sessionId, toolCallId: input.toolCallId,
        permissionRevision: scope.principal.permissionRevision, query, includePrivate: false,
      }
    } else {
      const raw = input.projectIds ?? []
      if (raw.some(value => !UUID_PATTERN.test(value) || value !== value.toLowerCase())) {
        throw new XAgentRetrievalError('invalid-retrieval-scope')
      }
      let canonical
      try {
        canonical = canonicalizeRetrievalDelegationScope({ projectIds: raw, includePrivate: input.includePrivate })
      } catch {
        throw new XAgentRetrievalError('invalid-retrieval-scope')
      }
      if (new Set(raw).size !== raw.length) throw new XAgentRetrievalError('invalid-retrieval-scope')
      request = {
        sessionId: scope.sessionId, toolCallId: input.toolCallId,
        permissionRevision: scope.principal.permissionRevision, query,
        projectIds: canonical.projectIds, includePrivate: canonical.includePrivate, scopeHash: canonical.scopeHash,
      }
    }
    const result = await this.call(input.signal, async signal => this.backend.search(
      scope.userToken,
      this.delegation(scope, input.toolCallId, 'search_artifacts'),
      request,
      signal,
    ))
    registerReceipt(this.receipts, {
      sessionId: String(input.sessionId), toolCallId: input.toolCallId,
      receipt: result.receipt, payloadHash: result.payloadHash,
    })
    return Object.freeze({ citations: result.citations, payloadHash: result.payloadHash })
  }

  /** Close admission synchronously, abort every active backend call, and await settlement. */
  async dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.accepting = false
      for (const close of this.closeScopeObservers) close()
      this.messageScopes.clear()
      this.activeScopes.clear()
      const active = [...this.controllers.entries()]
      const receiptDisposal = this.receipts.dispose()
      for (const [controller] of active) controller.abort()
      await Promise.allSettled(active.map(([, settlement]) => settlement))
      await receiptDisposal
      this.closePostObserver()
      this.closeResultObserver()
      this.closeSessionObserver()
    })()
    await this.disposal
  }

  private observeToolResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    if (exec.name !== 'list_accessible_projects' && exec.name !== 'search_artifacts') return
    const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
    if (sessionId === undefined) return
    const toolCallId = String(exec.callId)
    if (result.isError || typeof result.meta !== 'object' || result.meta === null || Array.isArray(result.meta)) {
      this.receipts.discard(sessionId, toolCallId)
      return
    }
    const meta = result.meta as Record<string, unknown>
    if (meta.kind !== 'xagent-retrieval' || !HASH_PATTERN.test(String(meta.payloadHash))) {
      this.receipts.discard(sessionId, toolCallId)
      return
    }
    try {
      this.receipts.publish(sessionId, toolCallId, String(meta.payloadHash))
    } catch (error: unknown) {
      this.receipts.discard(sessionId, toolCallId)
      this.ctx.logger.warn(`xagent retrieval receipt publication rejected: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  private requireScope(sessionId: string): XAgentAuthenticatedSessionRequestScope {
    if (!this.accepting) throw new XAgentRetrievalError('service-unavailable')
    const scope = currentXAgentAuthenticatedRequestScope()
    if (!authenticatedSessionScope(scope) || backendSessionId(sessionId) !== scope.sessionId) {
      throw new XAgentRetrievalError('unauthenticated')
    }
    return scope
  }

  private delegation(
    scope: XAgentAuthenticatedSessionRequestScope,
    toolCallId: string,
    toolName: 'list_accessible_projects' | 'search_artifacts',
  ): string {
    if (this.privateKey === undefined || toolCallId.length === 0) throw new XAgentRetrievalError('service-unavailable')
    try {
      return issueDelegationToken({
        actorId: scope.principal.actorId,
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        toolCallId,
        toolName,
        permissionRevision: scope.principal.permissionRevision,
        issuer: this.issuer,
        audience: this.audience,
        privateKey: this.privateKey,
        now: this.now(),
        expiresInSeconds: 60,
        nonce: newDelegationNonce(),
      })
    } catch {
      throw new XAgentRetrievalError('service-unavailable')
    }
  }

  private async call<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.accepting) throw new XAgentRetrievalError('service-unavailable')
    const controller = new AbortController()
    const merged = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    const settled = Promise.withResolvers<void>()
    this.controllers.set(controller, settled.promise)
    try {
      merged.throwIfAborted()
      const value = await operation(merged)
      merged.throwIfAborted()
      return value
    } catch (error: unknown) {
      if (error instanceof XAgentRetrievalError) throw error
      if (error instanceof XAgentBackendError && RETRIEVAL_ERRORS.has(error.code as XAgentRetrievalErrorCode)) {
        throw new XAgentRetrievalError(error.code as XAgentRetrievalErrorCode)
      }
      throw new XAgentRetrievalError('service-unavailable')
    } finally {
      this.controllers.delete(controller)
      settled.resolve()
    }
  }
}

/**
 * Install the strict FastAPI retrieval provider.
 * @param ctx - Cordis context receiving the service.
 * @param config - backend identity and delegation signer configuration.
 * @returns Nothing; Cordis owns the installed service effect.
 */
export function apply(ctx: Context, config: Config): void {
  const backend = new XAgentBackendClient({ origin: config.backendOrigin, serviceToken: config.serviceToken }).retrieval
  new XAgentRetrievalService(ctx, backend, new XAgentReceiptRegistry(), {
    issuer: config.delegationIssuer,
    audience: config.delegationAudience,
    privateKey: createPrivateKey(config.delegationPrivateKey),
    countQueryTokens: config.countQueryTokens,
  })
}
