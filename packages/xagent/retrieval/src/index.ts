/** Authenticated XAgent retrieval service and private receipt lifetime. @module @xagent/dsh-retrieval */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createPrivateKey, randomUUID, type KeyObject } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
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
import {
  installXAgentCitedAnswerPolicy,
  openCitedAnswerRequest,
  reconstructCitedAnswerEvidence,
  type CitedAnswerRequestOwner,
} from './cited-answer-policy.ts'
import {
  XAgentBgeM3HttpTokenizer,
  validateBgeM3Tokenizer,
  type XAgentBgeM3Tokenizer,
} from './tokenizer.ts'
import type {
  XAgentAccessibleProjects,
  XAgentArtifactSearch,
  XAgentCitationRemote,
  XAgentCitationScopeRunner,
  XAgentCitationTarget,
  XAgentListAccessibleProjectsInput,
  XAgentRetrievalErrorCode,
  XAgentSearchArtifactsInput,
} from './types.ts'

export type * from './types.ts'
export * from './cited-answer.ts'
export * from './cited-answer-policy.ts'
export { XAgentReceiptRegistry } from './receipt-registry.ts'
export * from './tokenizer.ts'

const SESSION_ID_PATTERN = /^(?:session-)?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const CITATION_ID_PATTERN = /^\[资料([1-9][0-9]*)\]$/u
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
export const inject = ['sessions']

interface ServiceOptions {
  readonly issuer: string
  readonly audience: string
  readonly privateKey?: KeyObject
  readonly now?: () => number
  readonly tokenizer?: XAgentBgeM3Tokenizer
}

/** Citation Remote signer and clock configuration. */
export interface XAgentCitationRemoteServiceOptions {
  readonly issuer: string
  readonly audience: string
  readonly privateKey?: KeyObject
  readonly now?: () => number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    xagentRetrieval: XAgentRetrieval
    xagentCitation: XAgentCitationRemoteService
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

/** Service Definition consumed by model tools and the terminal cited-answer runtime. */
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

function toolResultIdentity(event: Extract<SessionEvent, { type: 'tool/result' }>): string {
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

interface CitationRequestScopeState {
  readonly scope: XAgentAuthenticatedSessionRequestScope
  active: boolean
}

type ActiveCitationRequestScope = XAgentAuthenticatedSessionRequestScope & {
  readonly requestSignal: AbortSignal
  readonly connectionSignal: AbortSignal
}

const CITATION_REMOTE_ERRORS = new Set([
  'unauthenticated', 'session-not-found', 'citation-invalid', 'service-unavailable',
])

function citationRemoteFailure(code: string): TypertRemoteFailure {
  return new TypertRemoteFailure({
    code: CITATION_REMOTE_ERRORS.has(code) ? code : 'service-unavailable',
    message: 'XAgent citation request failed',
    details: {},
  })
}

/** Request-scoped citation locator backed by durable provenance and current-actor authorization. */
export class XAgentCitationRemoteService extends TypertRemoteService implements XAgentCitationRemote, XAgentCitationScopeRunner {
  private readonly requestScope = new AsyncLocalStorage<CitationRequestScopeState>()
  private readonly controllers = new Map<AbortController, Promise<void>>()
  private readonly issuer: string
  private readonly audience: string
  private readonly privateKey: KeyObject | undefined
  private readonly now: () => number
  private accepting = true
  private disposal: Promise<void> | undefined

  constructor(
    ctx: Context,
    private readonly backend: XAgentRetrievalBackend,
    options: XAgentCitationRemoteServiceOptions,
  ) {
    super(ctx, 'xagentCitation')
    this.issuer = options.issuer
    this.audience = options.audience
    this.privateKey = options.privateKey
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
    ctx.effect(() => () => this.dispose(), 'dispose xagent citation request scope')
  }

  /**
   * Run one Remote operation inside the Host-authenticated Session scope.
   * @param scope - current physical connection, actor, revision, and Session identity.
   * @param operation - complete downstream Remote operation.
   * @returns the downstream result after request-local identity is cleared.
   */
  async withRequest<T>(scope: XAgentAuthenticatedSessionRequestScope, operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) throw new Error('xagent citation service is disposed')
    if (!authenticatedSessionScope(scope) || scope.requestSignal === undefined || scope.connectionSignal === undefined) {
      throw new Error('invalid xagent citation request scope')
    }
    if (this.requestScope.getStore()?.active === true) throw new Error('nested xagent citation request scope')
    const state: CitationRequestScopeState = { scope, active: true }
    try {
      return await this.requestScope.run(state, operation)
    } finally {
      state.active = false
    }
  }

  /**
   * Resolve one durable cited-answer ID through server-owned provenance and
   * current-actor authorization.
   * @param sessionId - current Browser Session id.
   * @param citationId - persisted short citation id.
   * @param signal - Browser request cancellation.
   * @returns immutable Artifact, Version, Chunk, and line identities without a URL.
   */
  @Remote
  async resolve(sessionId: string, citationId: string, signal?: AbortSignal): Promise<XAgentCitationTarget> {
    const scope = this.requireScope(sessionId)
    const match = CITATION_ID_PATTERN.exec(citationId)
    if (
      citationId.length > 32
      || match === null
      || !Number.isSafeInteger(Number(match[1]))
    ) throw citationRemoteFailure('citation-invalid')
    const toolCallId = randomUUID()
    const merged = AbortSignal.any([
      ...(signal === undefined ? [] : [signal]),
      scope.requestSignal,
      scope.connectionSignal,
    ])
    const resolved = await this.call(merged, operationSignal => this.backend.resolveCitation(
      scope.userToken,
      this.delegation(scope, toolCallId),
      {
        sessionId: scope.sessionId,
        toolCallId,
        permissionRevision: scope.principal.permissionRevision,
        citationId,
      },
      operationSignal,
    ))
    return Object.freeze({
      artifactId: resolved.artifactId,
      versionId: resolved.versionId,
      chunkId: resolved.chunkId,
      lineStart: resolved.lineStart,
      lineEnd: resolved.lineEnd,
    })
  }

  /**
   * Close admission, abort every resolution, and await their settlement.
   * @returns when all owned backend operations have settled.
   */
  async dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.accepting = false
      const active = [...this.controllers.entries()]
      for (const [controller] of active) controller.abort()
      await Promise.allSettled(active.map(([, settlement]) => settlement))
    })()
    await this.disposal
  }

  private requireScope(sessionId: string): ActiveCitationRequestScope {
    if (!this.accepting) throw new Error('xagent citation service is disposed')
    const state = this.requestScope.getStore()
    if (state?.active !== true) throw new Error('xagent citation request scope is required')
    let resolved: string
    try {
      resolved = backendSessionId(sessionId)
    } catch {
      throw citationRemoteFailure('unauthenticated')
    }
    if (resolved !== state.scope.sessionId) throw citationRemoteFailure('unauthenticated')
    return state.scope as ActiveCitationRequestScope
  }

  private delegation(scope: XAgentAuthenticatedSessionRequestScope, toolCallId: string): string {
    if (this.privateKey === undefined) throw citationRemoteFailure('service-unavailable')
    try {
      return issueDelegationToken({
        actorId: scope.principal.actorId,
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        toolCallId,
        toolName: 'resolve_citation',
        permissionRevision: scope.principal.permissionRevision,
        issuer: this.issuer,
        audience: this.audience,
        privateKey: this.privateKey,
        now: this.now(),
        expiresInSeconds: 60,
        nonce: newDelegationNonce(),
      })
    } catch {
      throw citationRemoteFailure('service-unavailable')
    }
  }

  private async call<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const merged = AbortSignal.any([signal, controller.signal])
    const settled = Promise.withResolvers<void>()
    this.controllers.set(controller, settled.promise)
    try {
      merged.throwIfAborted()
      const value = await operation(merged)
      merged.throwIfAborted()
      return value
    } catch (error: unknown) {
      if (error instanceof TypertRemoteFailure) throw error
      if (error instanceof XAgentBackendError) throw citationRemoteFailure(error.code)
      throw citationRemoteFailure('service-unavailable')
    } finally {
      this.controllers.delete(controller)
      settled.resolve()
    }
  }
}

/** FastAPI provider with one operation scope and quiescent disposal. */
export class XAgentRetrievalService extends XAgentRetrieval {
  readonly receipts: XAgentReceiptRegistry
  private readonly backend: XAgentRetrievalBackend
  private readonly controllers = new Map<AbortController, Promise<void>>()
  private readonly citedAnswerOwners = new Map<Agent, {
    readonly scopeIdentity: object
    readonly owner: CitedAnswerRequestOwner
  }>()
  private readonly drainingCitedAnswerOwners = new Set<CitedAnswerRequestOwner>()
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
    readonly identity: object
    readonly scope: XAgentAuthenticatedSessionRequestScope
    readonly signal: AbortSignal
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
      const active = this.activeScopes.get(agent)
      if (active !== undefined && !samePhysicalScope(active.scope, scope) && this.citedAnswerOwners.has(agent)) {
        this.deleteActiveScope(agent)
        agent.cancel({ kind: 'user' })
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
    const closeClaimed = ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const binding = this.messageScopes.get(String(message.id))
      const scope = binding?.scope
      if (binding?.agent !== agent || scope === undefined || scope.requestSignal === undefined
        || scope.connectionSignal === undefined || scope.requestSignal.aborted || scope.connectionSignal.aborted) return
      this.setActiveScope(agent, scope, scope.requestSignal, true)
      this.openCitedAnswerForSession(agent.session)
    })
    const closeDisposed = ctx.on('agent/disposed', ({ agent }) => {
      this.deleteActiveScope(agent)
      this.receipts.discardSession(String(agent.session.id))
      for (const [messageId, binding] of this.messageScopes) {
        if (binding.agent === agent) this.deleteMessageScope(messageId)
      }
    })
    const closeAgentError = ctx.on('agent/error', ({ agent }) => {
      this.deleteActiveScope(agent)
      this.receipts.discardSession(String(agent.session.id))
    })
    const closeSessionDisposed = ctx.on('session/disposed', (session) => {
      this.closeCitedAnswerOwners(agent => String(agent.session.id) === String(session.id))
      this.receipts.discardSession(String(session.id))
    })
    const closePreStep = ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
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
      if (scopes[0] !== undefined) this.setActiveScope(agent, scopes[0], signal)
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
    const closeCitationPolicy = installXAgentCitedAnswerPolicy(ctx, options => this.citedAnswerRequest(options))
    this.closeScopeObservers = [
      closeInserted, closeDiscarded, closeClaimed, closeDisposed, closeAgentError, closeSessionDisposed, closePreStep,
      closeToolExecution, closeCitationPolicy,
    ]
    this.closeSessionObserver = ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') {
        for (const [agent] of this.activeScopes) {
          if (String(agent.session.id) === String(session.id)) {
            this.deleteActiveScope(agent)
          }
        }
      }
      if (event.type !== 'tool/result') return
      const meta = event.data.meta
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return
      const row = meta as Record<string, unknown>
      if (row.kind !== 'xagent-retrieval' || !HASH_PATTERN.test(String(row.payloadHash))) return
      const toolCallId = toolResultIdentity(event)
      try {
        this.receipts.bindEvent(String(session.id), toolCallId, event.seq, String(row.payloadHash))
      } catch (error: unknown) {
        this.receipts.discard(String(session.id), toolCallId)
        ctx.logger.warn(`xagent retrieval receipt binding rejected: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
      if (Array.isArray(row.citations) && row.citations.length > 0) {
        this.openCitedAnswerForSession(session)
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

  /**
   * Close admission synchronously, abort active backend and protected stream operations, and await their settlement.
   * @returns when every owned source iterator has completed cleanup and receipt storage is closed.
   */
  async dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.accepting = false
      for (const close of this.closeScopeObservers) close()
      for (const messageId of this.messageScopes.keys()) this.deleteMessageScope(messageId)
      for (const agent of this.activeScopes.keys()) {
        agent.cancel({ kind: 'user' })
        this.deleteActiveScope(agent)
      }
      const answerOwners = [...this.drainingCitedAnswerOwners]
      const active = [...this.controllers.entries()]
      const receiptDisposal = this.receipts.dispose()
      for (const [controller] of active) controller.abort()
      await Promise.allSettled(active.map(([, settlement]) => settlement))
      await Promise.allSettled(answerOwners.map(owner => owner.settlement))
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

  private setActiveScope(
    agent: Agent,
    scope: XAgentAuthenticatedSessionRequestScope,
    signal: AbortSignal,
    replace = false,
  ): void {
    const current = this.activeScopes.get(agent)
    if (!replace && current !== undefined && samePhysicalScope(current.scope, scope)) return
    this.deleteActiveScope(agent)
    const abort = (): void => {
      this.deleteActiveScope(agent)
      agent.cancel({ kind: 'user' })
    }
    scope.requestSignal?.addEventListener('abort', abort, { once: true })
    scope.connectionSignal?.addEventListener('abort', abort, { once: true })
    this.activeScopes.set(agent, {
      identity: Object.freeze({}),
      scope,
      signal,
      close: () => {
        scope.requestSignal?.removeEventListener('abort', abort)
        scope.connectionSignal?.removeEventListener('abort', abort)
      },
    })
  }

  private deleteActiveScope(agent: Agent): void {
    const binding = this.activeScopes.get(agent)
    binding?.close()
    this.activeScopes.delete(agent)
    if (binding !== undefined) this.closeCitedAnswerOwners(candidate => candidate === agent)
  }

  private closeCitedAnswerOwners(predicate: (agent: Agent) => boolean): void {
    for (const [agent, entry] of this.citedAnswerOwners) {
      if (!predicate(agent)) continue
      this.citedAnswerOwners.delete(agent)
      this.drainCitedAnswerOwner(entry.owner)
    }
  }

  private drainCitedAnswerOwner(owner: CitedAnswerRequestOwner): void {
    owner.close()
    this.drainingCitedAnswerOwners.add(owner)
    void owner.settlement.then(() => { this.drainingCitedAnswerOwners.delete(owner) })
  }

  private requireScope(sessionId: string): XAgentAuthenticatedSessionRequestScope {
    if (!this.accepting) throw new XAgentRetrievalError('service-unavailable')
    const scope = currentXAgentAuthenticatedRequestScope()
    if (!authenticatedSessionScope(scope) || backendSessionId(sessionId) !== scope.sessionId) {
      throw new XAgentRetrievalError('unauthenticated')
    }
    return scope
  }

  private citedAnswerRequest(options: GenerateOptions): CitedAnswerRequestOwner | undefined {
    if (!this.accepting || options.sessionId === undefined) return undefined
    let resolved: CitedAnswerRequestOwner | undefined
    for (const [agent, entry] of this.citedAnswerOwners) {
      if (String(agent.session.id) !== String(options.sessionId)) continue
      if (resolved !== undefined) return undefined
      if (this.activeScopes.get(agent)?.identity !== entry.scopeIdentity
        || entry.owner.identity !== entry.scopeIdentity) return undefined
      const evidence = reconstructCitedAnswerEvidence(options.messages, agent.session)
      if (evidence === undefined || !this.sameEvidence(evidence, entry.owner.allowed)) return undefined
      resolved = entry.owner
    }
    return resolved
  }

  private sameEvidence(left: ReadonlyMap<string, object>, right: ReadonlyMap<string, object>): boolean {
    if (left.size !== right.size) return false
    for (const [id, identity] of left) {
      const other = right.get(id)
      if (other === undefined) return false
      const a = identity as import('@xagent/dsh-backend-client').XAgentCitationIdentity
      const b = other as import('@xagent/dsh-backend-client').XAgentCitationIdentity
      if (a.artifactId !== b.artifactId || a.versionId !== b.versionId || a.chunkId !== b.chunkId) return false
    }
    return true
  }

  private openCitedAnswerForSession(session: import('@deepseek-ai/dsh-session').Session): void {
    for (const [agent, binding] of this.activeScopes) {
      if (String(agent.session.id) !== String(session.id)) continue
      const allowed = reconstructCitedAnswerEvidence(session.deriveMessages(), session)
      if (allowed === undefined) return
      const requestSignal = binding.scope.requestSignal as AbortSignal
      const connectionSignal = binding.scope.connectionSignal as AbortSignal
      const previous = this.citedAnswerOwners.get(agent)
      if (previous !== undefined) this.drainCitedAnswerOwner(previous.owner)
      const owner = openCitedAnswerRequest({
        agent,
        identity: binding.identity,
        allowed,
        signal: AbortSignal.any([binding.signal, requestSignal, connectionSignal]),
        authorize: (citations, signal) => this.authorizeCitations(binding.scope, citations, signal),
      })
      this.citedAnswerOwners.set(agent, { scopeIdentity: binding.identity, owner })
      return
    }
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
  const privateKey = createPrivateKey(config.delegationPrivateKey)
  new XAgentRetrievalService(ctx, backend, new XAgentReceiptRegistry(), {
    issuer: config.delegationIssuer,
    audience: config.delegationAudience,
    privateKey,
    tokenizer: new XAgentBgeM3HttpTokenizer(config.backendOrigin, config.serviceToken),
  })
  new XAgentCitationRemoteService(ctx, backend, {
    issuer: config.delegationIssuer,
    audience: config.delegationAudience,
    privateKey,
  })
}
