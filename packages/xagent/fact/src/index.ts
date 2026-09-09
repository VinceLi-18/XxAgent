/** Governed XAgent Fact Service Provider and request-scoped Browser Remote. @module @xagent/dsh-fact */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createPrivateKey, type KeyObject } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  XAgentBackendClient,
  XAgentBackendError,
  type FactProposalDecidedEvent,
  type XAgentFactApproveInput,
  type XAgentFactBackend,
  type XAgentFactPage,
  type XAgentFactPageInput,
  type XAgentFactProposal,
  type XAgentFactProposalDecision,
  type XAgentFactRejectInput,
  type XAgentFactRevision,
  type XAgentFactRevisionDetail,
  type XAgentFactWithdrawInput,
} from '@xagent/dsh-backend-client'
import {
  currentXAgentAuthenticatedRequestScope,
  isXAgentAuthenticatedRequestScope,
  runWithoutXAgentAuthenticatedRequestScope,
  runWithXAgentAuthenticatedRequestScope,
  type XAgentAuthenticatedSessionRequestScope,
} from '@xagent/dsh-principal'
import { issueDelegationToken, newDelegationNonce } from '@xagent/dsh-delegation-token'
import { XAgentFactOutboxRegistry, XAgentFactReceiptRegistry } from './receipt-registry.ts'
import type {
  XAgentFactErrorCode,
  XAgentFactRemote,
  XAgentFactScopeRunner,
  XAgentFactServiceContract,
  XAgentProposeFactInput,
} from './types.ts'

export type * from './types.ts'

/* jscpd:ignore-start */
/** Host configuration for the governed Fact provider. */
export interface Config {
  /** FastAPI service origin. */
  backendOrigin: string
  /** Host service identity for internal calls. */
  serviceToken: string
  /** Ed25519 private key PEM used only for proposal delegation. */
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
/* jscpd:ignore-end */

/** Fact signer and deterministic-clock dependencies. */
export interface XAgentFactServiceOptions {
  readonly issuer: string
  readonly audience: string
  readonly privateKey?: KeyObject
  readonly now?: () => number
}

export const name = 'xagent-fact'
export const inject = ['sessions']

const SESSION_ID = /^(?:session-)?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const FACT_REMOTE_ERRORS = new Set<XAgentFactErrorCode>([
  'unauthenticated',
  'not-found',
  'fact-input-invalid',
  'fact-evidence-invalid',
  'fact-session-invalid',
  'stale-permission',
  'idempotency-conflict',
  'fact-revision-conflict',
  'fact-already-decided',
  'service-unavailable',
])

interface RequestScopeState {
  readonly scope: XAgentAuthenticatedSessionRequestScope
  active: boolean
}

type XAgentFactProjectRequestScope = XAgentAuthenticatedSessionRequestScope & {
  readonly visibility: 'project'
  readonly projectId: string
  readonly requestSignal: AbortSignal
  readonly connectionSignal: AbortSignal
}

interface MessageScopeBinding {
  readonly agent: Agent
  readonly scope?: XAgentAuthenticatedSessionRequestScope
  readonly close?: () => void
}

interface OutboxOwner {
  readonly session: Session
  readonly scope: XAgentFactProjectRequestScope
  readonly controller: AbortController
  readonly settlement: Promise<void>
  readonly closeSignals: () => void
  active: boolean
}

function backendSessionId(value: string): string | undefined {
  return SESSION_ID.exec(value)?.[1]
}

function isProjectScope(value: unknown): value is XAgentFactProjectRequestScope {
  if (typeof value !== 'object' || value === null) return false
  const scope = value as XAgentAuthenticatedSessionRequestScope
  return isXAgentAuthenticatedRequestScope(scope)
    && scope.visibility === 'project'
    && UUID.test(scope.sessionId)
    && scope.sessionId === scope.sessionId.toLowerCase()
    && typeof scope.projectId === 'string'
    && UUID.test(scope.projectId)
    && scope.projectId === scope.projectId.toLowerCase()
    && scope.requestSignal instanceof AbortSignal
    && scope.connectionSignal instanceof AbortSignal
    && !scope.requestSignal.aborted
    && !scope.connectionSignal.aborted
}

function samePhysicalScope(left: XAgentAuthenticatedSessionRequestScope, right: XAgentAuthenticatedSessionRequestScope): boolean {
  return left.sessionId === right.sessionId
    && left.projectId === right.projectId
    && left.userToken === right.userToken
    && left.connectionId === right.connectionId
    && left.principal.actorId === right.principal.actorId
    && left.principal.authSessionId === right.principal.authSessionId
    && left.principal.permissionRevision === right.principal.permissionRevision
}

function factToolResult(event: SessionEvent): { readonly toolCallId: string; readonly proposalId: string } | undefined {
  if (event.type !== 'tool/result') return undefined
  const meta = event.data.meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const row = meta as Record<string, unknown>
  if (
    row.kind !== 'xagent-fact'
    || row.status !== 'pending'
    || typeof row.proposalId !== 'string'
    || !UUID.test(row.proposalId)
  ) return undefined
  const block = event.data.message.content[0]
  if (block.isError) return undefined
  return { toolCallId: String(block.toolCallId), proposalId: row.proposalId }
}

function idempotencyKey(sessionId: string, toolCallId: string): string {
  const digest = createHash('sha256').update(sessionId).update('\0').update(toolCallId).digest('hex')
  return `propose_fact:${digest}`
}

function factRemoteFailure(error: unknown): TypertRemoteFailure {
  const code = error instanceof XAgentBackendError && FACT_REMOTE_ERRORS.has(error.code as XAgentFactErrorCode)
    ? error.code as XAgentFactErrorCode
    : 'service-unavailable'
  return new TypertRemoteFailure({ code, message: 'XAgent Fact request failed', details: {} })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    xagentFact: XAgentFactService
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Terminal governed Fact decision delivered from the durable backend Outbox. */
    'fact/proposal-decided': FactProposalDecidedEvent['data']
  }
}

/** Stable failure with no backend detail or sensitive value. */
export class XAgentFactError extends Error {
  constructor(readonly code: XAgentFactErrorCode) {
    super(code)
    this.name = 'XAgentFactError'
  }
}

/** Request-scoped FastAPI Fact provider. */
export class XAgentFactService extends TypertRemoteService implements XAgentFactServiceContract, XAgentFactRemote, XAgentFactScopeRunner {
  private readonly requestScope = new AsyncLocalStorage<RequestScopeState>()
  private readonly controllers = new Map<AbortController, Promise<void>>()
  private readonly messageScopes = new Map<string, MessageScopeBinding>()
  private readonly activeScopes = new Map<Agent, XAgentAuthenticatedSessionRequestScope>()
  private readonly outboxOwners = new Map<string, OutboxOwner>()
  private readonly issuer: string
  private readonly audience: string
  private readonly privateKey: KeyObject | undefined
  private readonly now: () => number
  private readonly closeObservers: readonly (() => void)[]
  private accepting = true
  private disposal: Promise<void> | undefined

  constructor(
    ctx: Context,
    private readonly backend: XAgentFactBackend,
    readonly receipts: XAgentFactReceiptRegistry,
    readonly outbox: XAgentFactOutboxRegistry,
    options: XAgentFactServiceOptions,
  ) {
    super(ctx, 'xagentFact')
    this.issuer = options.issuer
    this.audience = options.audience
    this.privateKey = options.privateKey
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000))
    const closeInserted = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (backendSessionId(String(agent.session.id)) === undefined) return
      const scope = currentXAgentAuthenticatedRequestScope()
      if (!isProjectScope(scope) || backendSessionId(String(agent.session.id)) !== scope.sessionId) {
        this.messageScopes.set(String(message.id), { agent })
        return
      }
      const invalidate = (): void => { this.invalidateMessageScope(String(message.id)) }
      scope.requestSignal.addEventListener('abort', invalidate, { once: true })
      scope.connectionSignal.addEventListener('abort', invalidate, { once: true })
      this.messageScopes.set(String(message.id), {
        agent,
        scope,
        close: () => {
          scope.requestSignal.removeEventListener('abort', invalidate)
          scope.connectionSignal.removeEventListener('abort', invalidate)
        },
      })
    })
    const closeDiscarded = ctx.on('agent/inbox/discarded', ({ message }) => {
      this.deleteMessageScope(String(message.id))
    })
    const closeAgentDisposed = ctx.on('agent/disposed', ({ agent }) => {
      this.clearAgent(agent)
      this.receipts.discardSession(String(agent.session.id))
    })
    const closeAgentError = ctx.on('agent/error', ({ agent }) => {
      this.clearAgent(agent)
      this.receipts.discardSession(String(agent.session.id))
    })
    const closeSessionCreated = ctx.on('session/created', (session) => {
      const scope = currentXAgentAuthenticatedRequestScope()
      if (!isProjectScope(scope) || backendSessionId(String(session.id)) !== scope.sessionId) return
      void this.deliverOutbox(session, scope).catch((error: unknown) => {
        ctx.logger.warn(`xagent Fact Outbox delivery failed for "${String(session.id)}": ${String(error)}`)
      })
    })
    const closeSessionDisposed = ctx.on('session/disposed', (session) => {
      this.closeOutboxOwner(String(session.id))
      this.receipts.discardSession(String(session.id))
      for (const agent of this.activeScopes.keys()) {
        if (String(agent.session.id) === String(session.id)) this.clearAgent(agent)
      }
    })
    const closeSessionEvent = ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') {
        for (const agent of this.activeScopes.keys()) {
          if (String(agent.session.id) === String(session.id)) this.activeScopes.delete(agent)
        }
      }
      const result = factToolResult(event)
      if (result === undefined) return
      try {
        this.receipts.bindEvent(String(session.id), result.toolCallId, result.proposalId, event.seq)
      } catch (error: unknown) {
        this.receipts.discard(String(session.id), result.toolCallId)
        ctx.logger.warn(`xagent Fact receipt binding rejected: ${error instanceof Error ? error.message : 'unknown error'}`)
      }
    })
    const closePreStep = ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      if (messages.length > 0) {
        const scopes: XAgentAuthenticatedSessionRequestScope[] = []
        let invalid = false
        for (const message of messages) {
          const binding = this.messageScopes.get(String(message.id))
          this.deleteMessageScope(String(message.id))
          if (binding?.agent !== agent || binding.scope === undefined || !isProjectScope(binding.scope)) {
            invalid = true
          } else if (!scopes.some(value => samePhysicalScope(value, binding.scope as XAgentAuthenticatedSessionRequestScope))) {
            scopes.push(binding.scope)
          }
        }
        if (invalid || scopes.length !== 1) this.activeScopes.delete(agent)
        else this.activeScopes.set(agent, scopes[0] as XAgentAuthenticatedSessionRequestScope)
      }
      const scope = this.activeScopes.get(agent)
      if (scope !== undefined && isProjectScope(scope)
        && backendSessionId(String(agent.session.id)) === scope.sessionId) {
        await this.deliverOutbox(agent.session, scope, signal)
      }
      const decision = await next()
      if (decision.kind === 'reject') this.activeScopes.delete(agent)
      return decision
    })
    const closeToolExecution = ctx.on('tools/execute', (
      execution: ToolDispatchExecution,
      next: () => Promise<ToolExecutionResult>,
    ) => {
      if (execution.name !== 'propose_fact') return next()
      const scope = execution.agent === undefined ? undefined : this.activeScopes.get(execution.agent)
      return scope === undefined
        ? runWithoutXAgentAuthenticatedRequestScope(next)
        : runWithXAgentAuthenticatedRequestScope(scope, next)
    })
    this.closeObservers = [
      closeInserted,
      closeDiscarded,
      closeAgentDisposed,
      closeAgentError,
      closeSessionCreated,
      closeSessionDisposed,
      closeSessionEvent,
      closePreStep,
      closeToolExecution,
    ]
    ctx.effect(() => () => this.dispose(), 'xagent Fact service')
  }

  /**
   * Prepare one proposal and register its private receipt before returning the public result.
   * @param input - business fields, evidence identities, and the authoritative tool-call identity.
   * @returns the public pending proposal identity without its private receipt.
   */
  async proposeFact(input: XAgentProposeFactInput): Promise<{ readonly proposalId: string; readonly status: 'pending' }> {
    const scope = this.requireToolScope(input.sessionId)
    const result = await this.call(
      [input.signal, scope.requestSignal, scope.connectionSignal],
      signal => this.backend.prepare(
        scope.userToken,
        this.delegation(scope, input.toolCallId),
        {
          sessionId: scope.sessionId,
          toolCallId: input.toolCallId,
          permissionRevision: scope.principal.permissionRevision,
          idempotencyKey: idempotencyKey(scope.sessionId, input.toolCallId),
          fieldKey: input.fieldKey,
          label: input.label,
          value: input.value,
          evidenceIds: input.evidenceIds,
          ...input.assertionReason === undefined ? {} : { assertionReason: input.assertionReason },
        },
        signal,
      ),
      error => this.factError(error),
    )
    try {
      this.receipts.register({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        proposalId: result.result.proposalId,
        receipt: result.receipt,
        payloadHash: result.payloadHash,
      })
    } catch {
      throw new XAgentFactError('service-unavailable')
    }
    return Object.freeze({ proposalId: result.result.proposalId, status: 'pending' as const })
  }

  /**
   * Run one Remote operation under an authenticated Project Session scope.
   * @param scope - immutable identity derived from the physical authenticated connection.
   * @param operation - one complete Remote operation to bind to that identity.
   * @returns the operation result while the scope remains active.
   */
  async withRequest<T>(scope: XAgentAuthenticatedSessionRequestScope, operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) throw new Error('xagent Fact service is disposed')
    if (!isProjectScope(scope)) throw new Error('invalid xagent Fact project request scope')
    if (this.requestScope.getStore()?.active === true) throw new Error('nested xagent Fact request scope')
    const state: RequestScopeState = { scope, active: true }
    try {
      return await this.requestScope.run(state, operation)
    } finally {
      state.active = false
    }
  }

  /**
   * List current Fact heads.
   * @param sessionId - caller-selected Session, which must equal the physical request Session.
   * @param input - bounded page selection.
   * @param signal - optional caller cancellation.
   * @returns one page of current Fact revisions in the fixed project.
   */
  @Remote('list-heads')
  listHeads(sessionId: string, input: XAgentFactPageInput, signal?: AbortSignal): Promise<XAgentFactPage<XAgentFactRevision>> {
    const scope = this.requireRemoteScope(sessionId)
    return this.remoteCall(scope, signal, operationSignal =>
      this.backend.listHeads(scope.userToken, scope.projectId, input, operationSignal))
  }

  /**
   * List public proposals.
   * @param sessionId - caller-selected Session, which must equal the physical request Session.
   * @param input - bounded page selection.
   * @param signal - optional caller cancellation.
   * @returns one page of public proposals in the fixed project.
   */
  @Remote('list-proposals')
  listProposals(sessionId: string, input: XAgentFactPageInput, signal?: AbortSignal): Promise<XAgentFactPage<XAgentFactProposal>> {
    const scope = this.requireRemoteScope(sessionId)
    return this.remoteCall(scope, signal, operationSignal =>
      this.backend.listProposals(scope.userToken, scope.projectId, input, operationSignal))
  }

  /**
   * Read one revision.
   * @param sessionId - caller-selected Session, which must equal the physical request Session.
   * @param revisionId - immutable revision identity.
   * @param signal - optional caller cancellation.
   * @returns the revision and its history under current authorization.
   */
  @Remote
  revision(sessionId: string, revisionId: string, signal?: AbortSignal): Promise<XAgentFactRevisionDetail> {
    const scope = this.requireRemoteScope(sessionId)
    return this.remoteCall(scope, signal, operationSignal =>
      this.backend.revision(scope.userToken, revisionId, operationSignal))
  }

  /**
   * Read one proposal.
   * @param sessionId - caller-selected Session, which must equal the physical request Session.
   * @param proposalId - proposal identity to reauthorize.
   * @param signal - optional caller cancellation.
   * @returns the current public proposal state.
   */
  @Remote
  proposal(sessionId: string, proposalId: string, signal?: AbortSignal): Promise<XAgentFactProposal> {
    const scope = this.requireRemoteScope(sessionId)
    return this.remoteCall(scope, signal, operationSignal =>
      this.backend.proposal(scope.userToken, proposalId, operationSignal))
  }

  /**
   * Approve one proposal.
   * @param sessionId - caller-selected Session, which must equal the physical request Session.
   * @param proposalId - pending proposal identity.
   * @param input - decision note and fresh operation idempotency key.
   * @param signal - optional caller cancellation.
   * @returns the durable terminal decision.
   */
  @Remote
  approve(
    sessionId: string,
    proposalId: string,
    input: XAgentFactApproveInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactProposalDecision> {
    const scope = this.requireRemoteScope(sessionId)
    return this.remoteCall(scope, signal, operationSignal =>
      this.backend.approve(scope.userToken, proposalId, input, operationSignal))
  }

  /**
   * Reject one proposal.
   * @param sessionId - caller-selected Session, which must equal the physical request Session.
   * @param proposalId - pending proposal identity.
   * @param input - rejection reason and fresh operation idempotency key.
   * @param signal - optional caller cancellation.
   * @returns the durable terminal decision.
   */
  @Remote
  reject(
    sessionId: string,
    proposalId: string,
    input: XAgentFactRejectInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactProposalDecision> {
    const scope = this.requireRemoteScope(sessionId)
    return this.remoteCall(scope, signal, operationSignal =>
      this.backend.reject(scope.userToken, proposalId, input, operationSignal))
  }

  /**
   * Withdraw one proposal.
   * @param sessionId - caller-selected Session, which must equal the physical request Session.
   * @param proposalId - pending proposal identity.
   * @param input - fresh operation idempotency key.
   * @param signal - optional caller cancellation.
   * @returns the durable terminal decision.
   */
  @Remote
  withdraw(
    sessionId: string,
    proposalId: string,
    input: XAgentFactWithdrawInput,
    signal?: AbortSignal,
  ): Promise<XAgentFactProposalDecision> {
    const scope = this.requireRemoteScope(sessionId)
    return this.remoteCall(scope, signal, operationSignal =>
      this.backend.withdraw(scope.userToken, proposalId, input, operationSignal))
  }

  /** Close new work synchronously, abort owned calls, and await their settlement. */
  async dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.accepting = false
      for (const close of this.closeObservers) close()
      for (const messageId of this.messageScopes.keys()) this.deleteMessageScope(messageId)
      this.activeScopes.clear()
      const outboxOwners = [...this.outboxOwners.values()]
      this.outboxOwners.clear()
      for (const owner of outboxOwners) {
        owner.active = false
        owner.closeSignals()
        owner.controller.abort()
      }
      const active = [...this.controllers.entries()]
      const registryDisposals = [this.receipts.dispose(), this.outbox.dispose()]
      for (const [controller] of active) controller.abort()
      await Promise.allSettled(active.map(([, settlement]) => settlement))
      await Promise.allSettled(outboxOwners.map(owner => owner.settlement))
      await Promise.all(registryDisposals)
    })()
    await this.disposal
  }

  /**
   * Return the first violated live owner relationship without inspecting fixed examples.
   * @returns a stable diagnostic when active scope or Outbox ownership is inconsistent.
   */
  relationshipIssue(): string | undefined {
    for (const [agent, scope] of this.activeScopes) {
      if (!isProjectScope(scope) || backendSessionId(String(agent.session.id)) !== scope.sessionId) {
        return 'active Fact scope must match its Agent Session and fixed project'
      }
    }
    for (const [sessionId, owner] of this.outboxOwners) {
      if (sessionId !== String(owner.session.id)
        || backendSessionId(sessionId) !== owner.scope.sessionId
        || !isProjectScope(owner.scope)
        || !owner.active
        || owner.controller.signal.aborted
        || this.ctx.sessions.get(owner.session.id) !== owner.session) {
        return 'Fact Outbox owner must be active and match its physical Project Session'
      }
    }
    return undefined
  }

  private requireToolScope(sessionId: string): XAgentAuthenticatedSessionRequestScope & {
    readonly visibility: 'project'
    readonly projectId: string
    readonly requestSignal: AbortSignal
    readonly connectionSignal: AbortSignal
  } {
    if (!this.accepting) throw new XAgentFactError('service-unavailable')
    const current = currentXAgentAuthenticatedRequestScope()
    if (current !== undefined && 'visibility' in current && current.visibility === 'private') {
      throw new XAgentFactError('fact-session-invalid')
    }
    if (!isProjectScope(current) || backendSessionId(sessionId) !== current.sessionId) {
      throw new XAgentFactError('unauthenticated')
    }
    return current
  }

  private requireRemoteScope(sessionId: string): XAgentAuthenticatedSessionRequestScope & {
    readonly visibility: 'project'
    readonly projectId: string
    readonly requestSignal: AbortSignal
    readonly connectionSignal: AbortSignal
  } {
    if (!this.accepting) throw new Error('xagent Fact service is disposed')
    const state = this.requestScope.getStore()
    if (state?.active !== true) throw new Error('xagent Fact request scope is required')
    if (!isProjectScope(state.scope) || backendSessionId(sessionId) !== state.scope.sessionId) {
      throw factRemoteFailure(new XAgentBackendError('unauthenticated'))
    }
    return state.scope
  }

  private delegation(scope: XAgentAuthenticatedSessionRequestScope, toolCallId: string): string {
    if (this.privateKey === undefined || toolCallId.length === 0 || typeof scope.projectId !== 'string') {
      throw new XAgentFactError('service-unavailable')
    }
    try {
      return issueDelegationToken({
        actorId: scope.principal.actorId,
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        toolCallId,
        toolName: 'propose_fact',
        permissionRevision: scope.principal.permissionRevision,
        issuer: this.issuer,
        audience: this.audience,
        privateKey: this.privateKey,
        now: this.now(),
        expiresInSeconds: 60,
        nonce: newDelegationNonce(),
      })
    } catch {
      throw new XAgentFactError('service-unavailable')
    }
  }

  private factError(error: unknown): XAgentFactError {
    if (error instanceof XAgentFactError) return error
    if (error instanceof XAgentBackendError && FACT_REMOTE_ERRORS.has(error.code as XAgentFactErrorCode)) {
      return new XAgentFactError(error.code as XAgentFactErrorCode)
    }
    return new XAgentFactError('service-unavailable')
  }

  private remoteCall<T>(
    scope: XAgentAuthenticatedSessionRequestScope & {
      readonly requestSignal: AbortSignal
      readonly connectionSignal: AbortSignal
    },
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.call([signal, scope.requestSignal, scope.connectionSignal], operation, factRemoteFailure)
  }

  private async call<T>(
    signals: readonly (AbortSignal | undefined)[],
    operation: (signal: AbortSignal) => Promise<T>,
    mapError: (error: unknown) => unknown,
  ): Promise<T> {
    const controller = new AbortController()
    const merged = AbortSignal.any([controller.signal, ...signals.filter((value): value is AbortSignal => value !== undefined)])
    const settled = Promise.withResolvers<void>()
    this.controllers.set(controller, settled.promise)
    try {
      merged.throwIfAborted()
      const result = await operation(merged)
      merged.throwIfAborted()
      return result
    } catch (error: unknown) {
      throw mapError(error)
    } finally {
      this.controllers.delete(controller)
      settled.resolve()
    }
  }

  private async deliverOutbox(
    session: Session,
    scope: XAgentAuthenticatedSessionRequestScope & {
      readonly visibility: 'project'
      readonly projectId: string
      readonly requestSignal: AbortSignal
      readonly connectionSignal: AbortSignal
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const sessionId = String(session.id)
    for (;;) {
      const current = this.outboxOwners.get(sessionId)
      if (current === undefined) break
      if (current.active && samePhysicalScope(current.scope, scope)) return current.settlement
      current.active = false
      current.controller.abort()
      await Promise.allSettled([current.settlement])
      if (!this.accepting) throw new XAgentFactError('service-unavailable')
    }
    const controller = new AbortController()
    const externalSignals = [scope.requestSignal, scope.connectionSignal, signal]
      .filter((value): value is AbortSignal => value !== undefined)
    function close(): void {
      owner.active = false
      controller.abort()
    }
    function closeSignals(): void {
      for (const external of externalSignals) external.removeEventListener('abort', close)
    }
    for (const external of externalSignals) external.addEventListener('abort', close, { once: true })
    const deferred = Promise.withResolvers<void>()
    const owner: OutboxOwner = {
      session,
      scope,
      controller,
      settlement: deferred.promise,
      closeSignals,
      active: true,
    }
    this.outboxOwners.set(sessionId, owner)
    void this.pullOutbox(owner).then(deferred.resolve, deferred.reject).finally(() => {
      owner.active = false
      owner.closeSignals()
      if (this.outboxOwners.get(sessionId) === owner) this.outboxOwners.delete(sessionId)
    })
    return owner.settlement
  }

  private async pullOutbox(owner: OutboxOwner): Promise<void> {
    const result = await this.call(
      [owner.controller.signal, owner.scope.requestSignal, owner.scope.connectionSignal],
      signal => this.backend.pullOutbox(owner.scope.userToken, owner.scope.sessionId, { limit: 32 }, signal),
      error => this.factError(error),
    )
    if (!this.isLiveOutboxOwner(owner)) return
    const ids = new Set<string>()
    for (const item of result.items) {
      if (ids.has(item.outboxId) || item.event.data.projectId !== owner.scope.projectId) {
        throw new XAgentFactError('service-unavailable')
      }
      ids.add(item.outboxId)
    }
    for (const item of result.items) {
      const sessionId = String(owner.session.id)
      if (!this.isLiveOutboxOwner(owner)) return
      if (this.outbox.has(sessionId, item.outboxId)) continue
      const eventSequence = owner.session.seq
      let registered = false
      try {
        registered = this.outbox.register({
          sessionId,
          eventSequence,
          outboxId: item.outboxId,
          payloadHash: item.payloadHash,
        })
        /* v8 ignore next -- `has` and `register` run synchronously on the same registry with no intervening mutation. */
        if (!registered) continue
        if (!this.isLiveOutboxOwner(owner)) {
          this.outbox.discard(sessionId, item.outboxId, eventSequence)
          return
        }
        const event = owner.session.append(item.event.type, item.event.data)
        /* v8 ignore next -- Session append reserves and returns its current sequence synchronously. */
        if (event.seq !== eventSequence) throw new Error('xagent Fact Outbox event sequence changed')
        // Let observer-triggered Session disposal detach before considering the next row.
        await Promise.resolve()
      } catch (error: unknown) {
        if (registered) this.outbox.discard(sessionId, item.outboxId, eventSequence)
        throw this.factError(error)
      }
    }
  }

  private isLiveOutboxOwner(owner: OutboxOwner): boolean {
    const sessionId = String(owner.session.id)
    return this.accepting
      && owner.active
      && !owner.controller.signal.aborted
      && !owner.scope.requestSignal.aborted
      && !owner.scope.connectionSignal.aborted
      && this.outboxOwners.get(sessionId) === owner
      && this.ctx.sessions.get(owner.session.id) === owner.session
  }

  private closeOutboxOwner(sessionId: string): void {
    const owner = this.outboxOwners.get(sessionId)
    if (owner === undefined) return
    owner.active = false
    owner.controller.abort()
  }

  private deleteMessageScope(messageId: string): void {
    const binding = this.messageScopes.get(messageId)
    binding?.close?.()
    this.messageScopes.delete(messageId)
  }

  private invalidateMessageScope(messageId: string): void {
    const binding = this.messageScopes.get(messageId) as MessageScopeBinding
    binding.close?.()
    this.messageScopes.set(messageId, { agent: binding.agent })
  }

  private clearAgent(agent: Agent): void {
    this.activeScopes.delete(agent)
    this.closeOutboxOwner(String(agent.session.id))
    for (const [messageId, binding] of this.messageScopes) {
      if (binding.agent === agent) this.deleteMessageScope(messageId)
    }
  }
}

/** Install the strict FastAPI Fact provider. */
export function apply(ctx: Context, config: Config): void {
  const backend = new XAgentBackendClient({ origin: config.backendOrigin, serviceToken: config.serviceToken }).facts
  new XAgentFactService(ctx, backend, new XAgentFactReceiptRegistry(), new XAgentFactOutboxRegistry(), {
    issuer: config.delegationIssuer,
    audience: config.delegationAudience,
    privateKey: createPrivateKey(config.delegationPrivateKey),
  })
}
