/** Authenticated XAgent retrieval service and private receipt lifetime. @module @xagent/dsh-retrieval */

import { createPrivateKey, randomUUID, type KeyObject } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
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
import { installXAgentCitationPolicy, type XAgentCitationPolicyRequest } from './citation-policy.ts'
import {
  XAgentBgeM3HttpTokenizer,
  validateBgeM3Tokenizer,
  type XAgentBgeM3Tokenizer,
} from './tokenizer.ts'
import type {
  XAgentAccessibleProjects,
  XAgentArtifactSearch,
  XAgentListAccessibleProjectsInput,
  XAgentRetrievalErrorCode,
  XAgentSearchArtifactsInput,
} from './types.ts'

export type * from './types.ts'
export * from './citation-policy.ts'
export * from './events.ts'
export { XAgentReceiptRegistry } from './receipt-registry.ts'
export * from './tokenizer.ts'

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
}

export const Config: z<Config> = z.object({
  backendOrigin: z.string().required(),
  serviceToken: z.string().required(),
  delegationPrivateKey: z.string().required(),
  delegationIssuer: z.string().required(),
  delegationAudience: z.string().required(),
})

export const name = 'xagent-retrieval'

interface ServiceOptions {
  readonly issuer: string
  readonly audience: string
  readonly privateKey?: KeyObject
  readonly now?: () => number
  readonly tokenizer?: XAgentBgeM3Tokenizer
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

async function queryValue(value: string, tokenizer: XAgentBgeM3Tokenizer, signal?: AbortSignal): Promise<string> {
  if (value.length === 0 || value.trim() !== value) {
    throw new XAgentRetrievalError('invalid-retrieval-scope')
  }
  let tokenCount: number
  try {
    tokenCount = await tokenizer.count(value, signal)
  } catch {
    throw new XAgentRetrievalError('service-unavailable')
  }
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
  private readonly tokenizer: XAgentBgeM3Tokenizer
  private accepting = true
  private readonly closeResultObserver: () => void
  private readonly closePostObserver: () => void
  private readonly closeSessionObserver: () => void
  private readonly closeScopeObservers: readonly (() => void)[]
  private readonly messageScopes = new Map<string, {
    readonly agent: object
    readonly scope?: XAgentAuthenticatedSessionRequestScope
    readonly close?: () => void
  }>()
  private readonly activeScopes = new Map<Agent, {
    readonly scope: XAgentAuthenticatedSessionRequestScope
    readonly close: () => void
  }>()
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
    this.tokenizer = validateBgeM3Tokenizer(options.tokenizer)
    const closeInserted = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (!SESSION_ID_PATTERN.test(String(agent.session.id))) return
      const scope = currentXAgentAuthenticatedRequestScope()
      const messageId = String(message.id)
      const requestSignal = scope?.requestSignal
      const connectionSignal = scope?.connectionSignal
      if (!authenticatedSessionScope(scope) || !matchesBackendSessionId(String(agent.session.id), scope.sessionId)
        || requestSignal === undefined || connectionSignal === undefined
        || requestSignal.aborted || connectionSignal.aborted) {
        this.messageScopes.set(messageId, { agent })
        return
      }
      for (const [messageId, binding] of this.messageScopes) {
        if (binding.scope?.sessionId === scope.sessionId && !samePhysicalScope(binding.scope, scope)) {
          this.invalidateMessageScope(messageId)
        }
      }
      const invalidate = (): void => { this.invalidateMessageScope(messageId) }
      requestSignal.addEventListener('abort', invalidate, { once: true })
      connectionSignal.addEventListener('abort', invalidate, { once: true })
      const close = (): void => {
        requestSignal.removeEventListener('abort', invalidate)
        connectionSignal.removeEventListener('abort', invalidate)
      }
      this.messageScopes.set(messageId, { agent, scope, close })
    })
    const closeDiscarded = ctx.on('agent/inbox/discarded', ({ message }) => {
      this.deleteMessageScope(String(message.id))
    })
    const closeDisposed = ctx.on('agent/disposed', ({ agent }) => {
      this.deleteActiveScope(agent)
      this.receipts.discardSession(String(agent.session.id))
      for (const [messageId, binding] of this.messageScopes) {
        if (binding.agent === agent) this.deleteMessageScope(messageId)
      }
    })
    const closeAgentError = ctx.on('agent/error', ({ agent }) => {
      this.receipts.discardSession(String(agent.session.id))
    })
    const closeSessionDisposed = ctx.on('session/disposed', (session) => {
      this.receipts.discardSession(String(session.id))
    })
    const closePreStep = ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const scopes: XAgentAuthenticatedSessionRequestScope[] = []
      let invalidated = false
      for (const message of messages) {
        const binding = this.messageScopes.get(String(message.id))
        this.deleteMessageScope(String(message.id))
        if (binding === undefined || binding.agent !== agent) {
          if (SESSION_ID_PATTERN.test(String(agent.session.id))) invalidated = true
          continue
        }
        const bindingScope = binding.scope
        if (bindingScope === undefined || bindingScope.requestSignal?.aborted === true
          || bindingScope.connectionSignal?.aborted === true) {
          invalidated = true
        } else if (!scopes.some(value => samePhysicalScope(value, bindingScope))) {
          scopes.push(bindingScope)
        }
      }
      if (invalidated || scopes.length > 1) {
        this.deleteActiveScope(agent)
        return { kind: 'reject' as const }
      }
      if (scopes[0] !== undefined) this.setActiveScope(agent, scopes[0])
      const decision = await next()
      if (decision.kind === 'reject') this.deleteActiveScope(agent)
      return decision
    })
    const closeToolExecution = ctx.on('tools/execute', (exec, next) => {
      if (exec.name !== 'list_accessible_projects' && exec.name !== 'search_artifacts') return next()
      const scope = exec.agent === undefined ? undefined : this.activeScopes.get(exec.agent)?.scope
      return scope === undefined
        ? runWithoutXAgentAuthenticatedRequestScope(next)
        : runWithXAgentAuthenticatedRequestScope(scope, next)
    })
    const closeCitationPolicy = installXAgentCitationPolicy(ctx, options => this.citationRequest(options))
    this.closeScopeObservers = [
      closeInserted, closeDiscarded, closeDisposed, closeAgentError, closeSessionDisposed, closePreStep,
      closeToolExecution, closeCitationPolicy,
    ]
    this.closeSessionObserver = ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') {
        for (const [agent] of this.activeScopes) {
          if (String((agent as { session?: { id?: unknown } }).session?.id) === String(session.id)) {
            this.deleteActiveScope(agent)
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
        this.receipts.discard(String(session.id), toolCallId)
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
    const query = await queryValue(input.query, this.tokenizer, input.signal)
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
      for (const messageId of this.messageScopes.keys()) this.deleteMessageScope(messageId)
      for (const agent of this.activeScopes.keys()) {
        agent.cancel({ kind: 'user' })
        this.deleteActiveScope(agent)
      }
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

  private deleteMessageScope(messageId: string): void {
    const binding = this.messageScopes.get(messageId)
    binding?.close?.()
    this.messageScopes.delete(messageId)
  }

  private invalidateMessageScope(messageId: string): void {
    const binding = this.messageScopes.get(messageId)
    if (binding === undefined) return
    binding.close?.()
    this.messageScopes.set(messageId, { agent: binding.agent })
  }

  private setActiveScope(agent: Agent, scope: XAgentAuthenticatedSessionRequestScope): void {
    this.deleteActiveScope(agent)
    const abort = (): void => {
      this.deleteActiveScope(agent)
      agent.cancel({ kind: 'user' })
    }
    scope.requestSignal?.addEventListener('abort', abort, { once: true })
    scope.connectionSignal?.addEventListener('abort', abort, { once: true })
    this.activeScopes.set(agent, {
      scope,
      close: () => {
        scope.requestSignal?.removeEventListener('abort', abort)
        scope.connectionSignal?.removeEventListener('abort', abort)
      },
    })
  }

  private deleteActiveScope(agent: Agent): void {
    this.activeScopes.get(agent)?.close()
    this.activeScopes.delete(agent)
  }

  private requireScope(sessionId: string): XAgentAuthenticatedSessionRequestScope {
    if (!this.accepting) throw new XAgentRetrievalError('service-unavailable')
    const scope = currentXAgentAuthenticatedRequestScope()
    if (!authenticatedSessionScope(scope) || backendSessionId(sessionId) !== scope.sessionId) {
      throw new XAgentRetrievalError('unauthenticated')
    }
    return scope
  }

  private citationRequest(options: GenerateOptions): XAgentCitationPolicyRequest | undefined {
    if (!this.accepting || options.sessionId === undefined) return undefined
    let resolved: XAgentCitationPolicyRequest | undefined
    for (const [agent, binding] of this.activeScopes) {
      if (String(agent.session.id) !== String(options.sessionId)) continue
      if (resolved !== undefined) return undefined
      resolved = {
        agent,
        session: agent.session,
        authorize: input => this.authorizeCitations(binding.scope, input.citations, input.signal),
      }
    }
    return resolved
  }

  private async authorizeCitations(
    scope: XAgentAuthenticatedSessionRequestScope,
    citations: readonly import('@xagent/dsh-backend-client').XAgentCitationIdentity[],
    signal?: AbortSignal,
  ): Promise<void> {
    const toolCallId = randomUUID()
    try {
      await this.call(signal, operationSignal => this.backend.authorizeCitations(
        scope.userToken,
        this.delegation(scope, toolCallId, 'authorize_citations'),
        {
          sessionId: scope.sessionId,
          toolCallId,
          permissionRevision: scope.principal.permissionRevision,
          citations,
        },
        operationSignal,
      ))
    } catch (error: unknown) {
      if (!this.accepting) throw new DOMException('xagent retrieval disposed', 'AbortError')
      throw error
    }
  }

  private delegation(
    scope: XAgentAuthenticatedSessionRequestScope,
    toolCallId: string,
    toolName: 'list_accessible_projects' | 'search_artifacts' | 'authorize_citations',
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
    tokenizer: new XAgentBgeM3HttpTokenizer(config.backendOrigin, config.serviceToken),
  })
}
