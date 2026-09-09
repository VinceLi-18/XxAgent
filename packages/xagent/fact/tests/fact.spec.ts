import { generateKeyPairSync } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { remoteMethods, TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import {
  XAgentBackendError,
  type XAgentFactBackend,
  type XAgentFactOutboxItem,
} from '@xagent/dsh-backend-client'
import { verifyDelegationToken } from '@xagent/dsh-delegation-token'
import {
  currentXAgentAuthenticatedRequestScope,
  runWithXAgentAuthenticatedRequestScope,
  type XAgentAuthenticatedSessionRequestScope,
} from '@xagent/dsh-principal'
import { describe, expect, test, vi } from 'vitest'
import {
  apply,
  XAgentFactError,
  XAgentFactService,
} from '../src/index.ts'
import {
  XAgentFactOutboxRegistry,
  XAgentFactReceiptRegistry,
} from '../src/receipt-registry.ts'

/* oxlint-disable typescript/unbound-method -- assertions inspect Vitest backend spies without invoking them. */

const ACTOR = '00000000-0000-0000-0000-000000000101'
const AUTH_SESSION = '00000000-0000-0000-0000-000000000102'
const SESSION = '00000000-0000-0000-0000-000000000201'
const RUNTIME_SESSION = `session-${SESSION}`
const PROJECT = '00000000-0000-0000-0000-000000000301'
const PROPOSAL = '00000000-0000-0000-0000-000000000401'
const REVISION = '00000000-0000-0000-0000-000000000501'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')

function scope(overrides: Partial<XAgentAuthenticatedSessionRequestScope> = {}): XAgentAuthenticatedSessionRequestScope {
  const request = new AbortController()
  const connection = new AbortController()
  return Object.freeze({
    principal: Object.freeze({
      actorId: ACTOR,
      role: 'specialist' as const,
      permissionRevision: 7,
      authSessionId: AUTH_SESSION,
      connectionId: 'connection-1',
    }),
    userToken: 'user-token',
    connectionId: 'connection-1',
    requestSignal: request.signal,
    connectionSignal: connection.signal,
    sessionId: SESSION,
    visibility: 'project' as const,
    projectId: PROJECT,
    ...overrides,
  }) as XAgentAuthenticatedSessionRequestScope
}

interface BackendProbe extends XAgentFactBackend {
  readonly prepareCalls: Parameters<XAgentFactBackend['prepare']>[]
  readonly outboxCalls: Parameters<XAgentFactBackend['pullOutbox']>[]
}

type PrepareArgs = Parameters<XAgentFactBackend['prepare']>
type PullOutboxArgs = Parameters<XAgentFactBackend['pullOutbox']>

function backend(): BackendProbe {
  const prepareCalls: Parameters<XAgentFactBackend['prepare']>[] = []
  const outboxCalls: Parameters<XAgentFactBackend['pullOutbox']>[] = []
  return {
    prepareCalls,
    outboxCalls,
    prepare: vi.fn(async (...args: Parameters<XAgentFactBackend['prepare']>) => {
      prepareCalls.push(args)
      return {
        result: { proposalId: PROPOSAL, status: 'pending' as const },
        receipt: 'opaque-fact-receipt',
        payloadHash: 'a'.repeat(64),
      }
    }),
    listHeads: vi.fn(async () => ({ items: [] })),
    listProposals: vi.fn(async () => ({ items: [] })),
    revision: vi.fn(async () => ({
      revision: {
        id: REVISION,
        projectId: PROJECT,
        fieldKey: 'customer.name',
        label: '客户名称',
        value: { type: 'text' as const, value: 'Alpha' },
        contentRevision: 1,
        proposalId: PROPOSAL,
        proposerId: ACTOR,
        confirmedById: ACTOR,
        evidence: [],
        createdAt: '2026-09-08T00:00:00+00:00',
      },
      history: [],
    })),
    proposal: vi.fn(async () => ({
      id: PROPOSAL,
      projectId: PROJECT,
      fieldKey: 'customer.name',
      label: '客户名称',
      value: { type: 'text' as const, value: 'Alpha' },
      proposerId: ACTOR,
      baseRevision: 0,
      status: 'pending' as const,
      evidence: [],
      createdAt: '2026-09-08T00:00:00+00:00',
      admittedAt: '2026-09-08T00:00:01+00:00',
    })),
    approve: vi.fn(async () => ({
      proposalId: PROPOSAL,
      status: 'confirmed' as const,
      factRevisionId: REVISION,
      contentRevision: 1,
    })),
    reject: vi.fn(async () => ({ proposalId: PROPOSAL, status: 'rejected' as const })),
    withdraw: vi.fn(async () => ({ proposalId: PROPOSAL, status: 'withdrawn' as const })),
    pullOutbox: vi.fn(async (...args: Parameters<XAgentFactBackend['pullOutbox']>) => {
      outboxCalls.push(args)
      return { items: [] }
    }),
  }
}

function service(value = backend()): {
  readonly ctx: Context
  readonly backend: BackendProbe
  readonly receipts: XAgentFactReceiptRegistry
  readonly outbox: XAgentFactOutboxRegistry
  readonly fact: XAgentFactService
} {
  const ctx = new Context()
  const receipts = new XAgentFactReceiptRegistry()
  const outbox = new XAgentFactOutboxRegistry()
  const fact = new XAgentFactService(ctx, value, receipts, outbox, {
    issuer: 'xagent-host',
    audience: 'xagent-api',
    privateKey,
    now: () => 1_800_000_000,
  })
  return { ctx, backend: value, receipts, outbox, fact }
}

function proposalInput(toolCallId = 'call-1') {
  return {
    sessionId: RUNTIME_SESSION,
    toolCallId,
    fieldKey: 'customer.name',
    label: 'Customer',
    value: { type: 'text' as const, value: 'Alpha' },
    evidenceIds: [] as string[],
    assertionReason: 'manual assertion',
  }
}

function agentFor(session: Session): Agent {
  return { session, send: vi.fn(), cancel: vi.fn() } as unknown as Agent
}

function decision(index: number): XAgentFactOutboxItem {
  const suffix = String(index).padStart(12, '0')
  return {
    outboxId: `00000000-0000-0000-0001-${suffix}`,
    payloadHash: index.toString(16).padStart(64, '0'),
    event: {
      type: 'fact/proposal-decided',
      data: {
        proposalId: `00000000-0000-0000-0002-${suffix}`,
        projectId: PROJECT,
        fieldKey: `field.${String(index)}`,
        label: `字段 ${String(index)}`,
        status: 'rejected',
        decisionReason: 'not accepted',
      },
    },
  }
}

async function pluginSession(
  ctx: Context,
  requestScope: XAgentAuthenticatedSessionRequestScope | undefined,
): Promise<{ readonly session: Session; readonly owner: Context['fiber'] }> {
  let session: Session | undefined
  const install = async (): Promise<Context['fiber']> => {
    const plugin = Object.assign((child: Context) => {
      session = child.sessions.create(SessionId(RUNTIME_SESSION))
    }, { inject: ['sessions'] })
    const owner = ctx.plugin(plugin)
    await owner
    return owner
  }
  const owner = requestScope === undefined ? await install() : await runWithXAgentAuthenticatedRequestScope(requestScope, install)
  if (session === undefined) throw new Error('session did not start')
  return { session, owner }
}

function factEvents(session: Session): SessionEvent[] {
  return session.events.filter(event => (event as { readonly type: string }).type === 'fact/proposal-decided')
}

describe('XAgent Fact provider', () => {
  test('registers one Service, fixed Remote methods, and no receipt-bearing Remote', async () => {
    const created = service()
    expect(created.fact.typertRemote).toMatchObject({
      serviceKey: 'xagentFact',
      namespace: 'xagentFact',
    })
    expect(created.fact.typertRemote.service).toBe(created.fact)
    expect(remoteMethods(created.fact)).toEqual([
      { method: 'listHeads', exportName: 'list-heads', invocation: { kind: 'direct' } },
      { method: 'listProposals', exportName: 'list-proposals', invocation: { kind: 'direct' } },
      { method: 'revision', invocation: { kind: 'direct' } },
      { method: 'proposal', invocation: { kind: 'direct' } },
      { method: 'approve', invocation: { kind: 'direct' } },
      { method: 'reject', invocation: { kind: 'direct' } },
      { method: 'withdraw', invocation: { kind: 'direct' } },
    ])
    expect(created.fact.receipts).not.toBe(created.fact.outbox)

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    apply(ctx, {
      backendOrigin: 'https://api.example.test',
      serviceToken: 'service-token',
      delegationPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      delegationIssuer: 'xagent-host',
      delegationAudience: 'xagent-api',
    })
    expect(ctx.get('xagentFact')).toBeInstanceOf(XAgentFactService)
    await ctx.fiber.dispose()
  })

  test('derives exact proposal authority and a sixty-second one-use delegation from the physical Project scope', async () => {
    const created = service()
    const callerInput = {
      sessionId: RUNTIME_SESSION,
      toolCallId: 'call-propose-1',
      fieldKey: 'customer.name',
      label: '客户名称',
      value: { type: 'text' as const, value: 'Alpha' },
      evidenceIds: ['[资料1]'],
      assertionReason: 'confirmed by operator',
      actorId: 'caller-supplied-actor',
      projectId: 'caller-supplied-project',
      permissionRevision: 999,
      userToken: 'caller-supplied-token',
    }

    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => created.fact.proposeFact(callerInput)))
      .resolves.toEqual({ proposalId: PROPOSAL, status: 'pending' })
    expect(created.backend.prepareCalls).toHaveLength(1)
    const [userToken, delegation, input, signal] = created.backend.prepareCalls[0]!
    expect(userToken).toBe('user-token')
    expect(input).toEqual({
      sessionId: SESSION,
      toolCallId: 'call-propose-1',
      permissionRevision: 7,
      idempotencyKey: input.idempotencyKey,
      fieldKey: 'customer.name',
      label: '客户名称',
      value: { type: 'text', value: 'Alpha' },
      evidenceIds: ['[资料1]'],
      assertionReason: 'confirmed by operator',
    })
    expect(input.idempotencyKey).toMatch(/^propose_fact:[0-9a-f]{64}$/u)
    expect(signal).toBeInstanceOf(AbortSignal)
    const claims = await verifyDelegationToken(delegation, {
      publicKey,
      issuer: 'xagent-host',
      audience: 'xagent-api',
      now: 1_800_000_000,
      expected: {
        actorId: ACTOR,
        projectId: PROJECT,
        sessionId: SESSION,
        toolCallId: 'call-propose-1',
        toolName: 'propose_fact',
        permissionRevision: 7,
      },
      currentPermissionRevision: 7,
      consumeNonce: async nonce => nonce.length > 0,
    })
    expect(claims.expiresAt - claims.issuedAt).toBe(60)
    expect(claims.nonce).not.toHaveLength(0)
    expect(JSON.stringify(input)).not.toContain('caller-supplied')
  })

  test('keeps the receipt private until the matching public tool result binds its event sequence', async () => {
    const created = service()
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    await runWithXAgentAuthenticatedRequestScope(scope(), () => created.fact.proposeFact({
      sessionId: RUNTIME_SESSION,
      toolCallId: 'call-propose-1',
      fieldKey: 'customer.name',
      label: '客户名称',
      value: { type: 'text', value: 'Alpha' },
      evidenceIds: [],
      assertionReason: 'operator assertion',
    }))
    expect(created.receipts.attachments(RUNTIME_SESSION, 0, 100)).toEqual([])

    const call = session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-propose-1' as never,
      name: 'propose_fact',
      arguments: '{}',
    })
    const result = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'fact-result' as never,
        role: 'user',
        source: { kind: 'tool', callId: 'call-propose-1' as never },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-propose-1' as never,
          isError: false,
          content: [{ type: 'text', text: JSON.stringify({ proposalId: PROPOSAL, status: 'pending' }) }],
        }],
      },
      meta: { kind: 'xagent-fact', proposalId: PROPOSAL, status: 'pending' },
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })

    expect(created.receipts.attachments(RUNTIME_SESSION, result.seq, result.seq)).toEqual([{
      eventSequence: result.seq,
      toolCallId: 'call-propose-1',
      proposalId: PROPOSAL,
      receipt: 'opaque-fact-receipt',
      payloadHash: 'a'.repeat(64),
    }])
    expect(JSON.stringify(result)).not.toContain('opaque-fact-receipt')
  })

  test('denies anonymous, Private, mismatched, and missing-project scopes before backend access', async () => {
    const created = service()
    const input = proposalInput()
    await expect(created.fact.proposeFact(input)).rejects.toEqual(new XAgentFactError('unauthenticated'))
    await expect(runWithXAgentAuthenticatedRequestScope(scope({
      visibility: 'private',
      projectId: null,
    }), () => created.fact.proposeFact(input)))
      .rejects.toEqual(new XAgentFactError('fact-session-invalid'))
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => created.fact.proposeFact({
      ...input,
      sessionId: 'session-00000000-0000-0000-0000-000000000299',
    }))).rejects.toEqual(new XAgentFactError('unauthenticated'))
    await expect(created.fact.withRequest(scope({
      visibility: 'private',
      projectId: null,
    }), async () => undefined))
      .rejects.toThrow('project request scope')
    expect(created.backend.prepare).not.toHaveBeenCalled()
  })

  test('rejects every malformed, stale, or nested physical request scope', async () => {
    const created = service()
    const valid = scope()
    const uppercaseSession = 'AAAAAAAA-0000-0000-0000-000000000201'
    const uppercaseProject = 'AAAAAAAA-0000-0000-0000-000000000301'
    const abortedRequest = new AbortController()
    abortedRequest.abort()
    const abortedConnection = new AbortController()
    abortedConnection.abort()
    const candidates: unknown[] = [
      undefined,
      null,
      { ...valid, principal: { ...valid.principal, actorId: 'bad' } },
      { ...valid, visibility: 'other' },
      { ...valid, sessionId: 'bad' },
      { ...valid, sessionId: uppercaseSession },
      { ...valid, projectId: null },
      { ...valid, projectId: 'bad' },
      { ...valid, projectId: uppercaseProject },
      { ...valid, requestSignal: undefined },
      { ...valid, connectionSignal: undefined },
      { ...valid, requestSignal: abortedRequest.signal },
      { ...valid, connectionSignal: abortedConnection.signal },
    ]
    for (const candidate of candidates) {
      await expect(created.fact.withRequest(candidate as never, async () => undefined)).rejects.toThrow()
    }
    await created.fact.withRequest(scope(), async () => {
      await expect(created.fact.withRequest(scope(), async () => undefined)).rejects.toThrow('nested')
      expect(() => {
        void created.fact.approve(
          'session-00000000-0000-0000-0000-000000000299',
          PROPOSAL,
          { idempotencyKey: 'mismatch' },
        )
      }).toThrow(TypertRemoteFailure)
    })
    expect(() => { void created.fact.approve(RUNTIME_SESSION, PROPOSAL, { idempotencyKey: 'no-scope' }) })
      .toThrow('request scope is required')
    await created.fact.dispose()
    await expect(created.fact.withRequest(scope(), async () => undefined)).rejects.toThrow('disposed')
  })

  test('maps proposal failures, omits absent assertion reason, and refuses unusable signing state', async () => {
    const stableBackend = backend()
    stableBackend.prepare = vi.fn(async () => { throw new XAgentBackendError('stale-permission') })
    const stable = service(stableBackend)
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => stable.fact.proposeFact(proposalInput())))
      .rejects.toEqual(new XAgentFactError('stale-permission'))

    const unavailableBackend = backend()
    unavailableBackend.prepare = vi.fn(async () => { throw new Error('upstream secret') })
    const unavailable = service(unavailableBackend)
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => unavailable.fact.proposeFact(proposalInput())))
      .rejects.toEqual(new XAgentFactError('service-unavailable'))

    const malformedBackend = backend()
    malformedBackend.prepare = vi.fn(async () => ({
      result: { proposalId: PROPOSAL, status: 'pending' as const },
      receipt: 'contains spaces',
      payloadHash: 'a'.repeat(64),
    }))
    const malformed = service(malformedBackend)
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => malformed.fact.proposeFact(proposalInput())))
      .rejects.toEqual(new XAgentFactError('service-unavailable'))

    const noAssertion = backend()
    const currentTime = new XAgentFactService(
      new Context(),
      noAssertion,
      new XAgentFactReceiptRegistry(),
      new XAgentFactOutboxRegistry(),
      { issuer: 'xagent-host', audience: 'xagent-api', privateKey },
    )
    const withoutReason = proposalInput('call-no-reason')
    delete (withoutReason as { assertionReason?: string }).assertionReason
    await runWithXAgentAuthenticatedRequestScope(scope(), () => currentTime.proposeFact(withoutReason))
    expect(noAssertion.prepareCalls[0]?.[2]).not.toHaveProperty('assertionReason')

    const unsigned = new XAgentFactService(
      new Context(),
      backend(),
      new XAgentFactReceiptRegistry(),
      new XAgentFactOutboxRegistry(),
      { issuer: 'xagent-host', audience: 'xagent-api' },
    )
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => unsigned.proposeFact(proposalInput())))
      .rejects.toEqual(new XAgentFactError('service-unavailable'))
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => currentTime.proposeFact(proposalInput(''))))
      .rejects.toEqual(new XAgentFactError('service-unavailable'))

    const invalidIssuer = new XAgentFactService(
      new Context(),
      backend(),
      new XAgentFactReceiptRegistry(),
      new XAgentFactOutboxRegistry(),
      { issuer: '', audience: 'xagent-api', privateKey },
    )
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => invalidIssuer.proposeFact(proposalInput())))
      .rejects.toEqual(new XAgentFactError('service-unavailable'))
  })

  test('all Remote calls use the current physical token and fixed Session project', async () => {
    const created = service()
    const signal = new AbortController().signal
    await created.fact.withRequest(scope(), async () => {
      await created.fact.listHeads(RUNTIME_SESSION, { limit: 100 }, signal)
      await created.fact.listProposals(RUNTIME_SESSION, { limit: 50, cursor: 'cursor' }, signal)
      await created.fact.revision(RUNTIME_SESSION, REVISION, signal)
      await created.fact.proposal(RUNTIME_SESSION, PROPOSAL, signal)
      await created.fact.approve(RUNTIME_SESSION, PROPOSAL, { idempotencyKey: 'approve-1', decisionNote: 'ok' }, signal)
      await created.fact.reject(RUNTIME_SESSION, PROPOSAL, { idempotencyKey: 'reject-1', reason: 'bad' }, signal)
      await created.fact.withdraw(RUNTIME_SESSION, PROPOSAL, { idempotencyKey: 'withdraw-1' }, signal)
    })

    expect(created.backend.listHeads).toHaveBeenCalledWith('user-token', PROJECT, { limit: 100 }, expect.any(AbortSignal))
    expect(created.backend.listProposals).toHaveBeenCalledWith(
      'user-token', PROJECT, { limit: 50, cursor: 'cursor' }, expect.any(AbortSignal),
    )
    expect(created.backend.revision).toHaveBeenCalledWith('user-token', REVISION, expect.any(AbortSignal))
    expect(created.backend.proposal).toHaveBeenCalledWith('user-token', PROPOSAL, expect.any(AbortSignal))
    expect(created.backend.approve).toHaveBeenCalledWith(
      'user-token', PROPOSAL, { idempotencyKey: 'approve-1', decisionNote: 'ok' }, expect.any(AbortSignal),
    )
    expect(created.backend.reject).toHaveBeenCalledWith(
      'user-token', PROPOSAL, { idempotencyKey: 'reject-1', reason: 'bad' }, expect.any(AbortSignal),
    )
    expect(created.backend.withdraw).toHaveBeenCalledWith(
      'user-token', PROPOSAL, { idempotencyKey: 'withdraw-1' }, expect.any(AbortSignal),
    )
  })

  test('Remote errors preserve only the stable Fact code set', async () => {
    const value = backend()
    value.approve = vi.fn(async () => { throw new XAgentBackendError('fact-revision-conflict') })
    const created = service(value)
    await expect(created.fact.withRequest(scope(), () => created.fact.approve(
      RUNTIME_SESSION,
      PROPOSAL,
      { idempotencyKey: 'approve-1' },
    ))).rejects.toEqual(new TypertRemoteFailure({
      code: 'fact-revision-conflict',
      message: 'XAgent Fact request failed',
      details: {},
    }))
    value.approve = vi.fn(async () => { throw new XAgentBackendError('sequence-conflict') })
    await expect(created.fact.withRequest(scope(), () => created.fact.approve(
      RUNTIME_SESSION,
      PROPOSAL,
      { idempotencyKey: 'approve-2' },
    ))).rejects.toMatchObject({ failure: { code: 'service-unavailable', details: {} } })
  })

  test('Session open pulls one bounded Outbox page, appends decisions, and never starts a Turn', async () => {
    const value = backend()
    value.pullOutbox = vi.fn(async (...args: Parameters<XAgentFactBackend['pullOutbox']>) => {
      value.outboxCalls.push(args)
      return { items: [decision(1)] }
    })
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, scope())

    await vi.waitFor(() => { expect(factEvents(session)).toHaveLength(1) })
    expect(value.pullOutbox).toHaveBeenCalledWith('user-token', SESSION, { limit: 32 }, expect.any(AbortSignal))
    expect(created.outbox.attachments(RUNTIME_SESSION, 0, 10)).toEqual([{
      eventSequence: 0,
      outboxId: decision(1).outboxId,
      payloadHash: decision(1).payloadHash,
    }])
    expect(session.events.some(event => event.type === 'turn/start')).toBe(false)
  })

  test('Session-open and pre-step triggers coalesce one 32-row pull without driving the Agent', async () => {
    const release = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
    const value = backend()
    value.pullOutbox = vi.fn(async (...args: Parameters<XAgentFactBackend['pullOutbox']>) => {
      value.outboxCalls.push(args)
      return release.promise
    })
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, scope())
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    const message = createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } })
    const send = vi.fn()
    const agent = { session, send, cancel: vi.fn() } as unknown as Agent
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message })
    })
    const preStep = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
    )
    expect(value.pullOutbox).toHaveBeenCalledOnce()
    release.resolve({ items: Array.from({ length: 32 }, (_, index) => decision(index + 1)) })
    await expect(preStep).resolves.toMatchObject({ kind: 'enter' })

    expect(value.pullOutbox).toHaveBeenCalledOnce()
    expect(factEvents(session)).toHaveLength(32)
    expect(created.outbox.attachments(RUNTIME_SESSION, 0, 31)).toHaveLength(32)
    expect(send).not.toHaveBeenCalled()
    expect(session.events.some(event => event.type === 'turn/start')).toBe(false)
  })

  test('Session cancellation clears its Outbox owner synchronously and discards a late result', async () => {
    const release = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
    const value = backend()
    let operationSignal: AbortSignal | undefined
    value.pullOutbox = vi.fn(async (...args: PullOutboxArgs) => {
      operationSignal = args[3]
      return release.promise
    })
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session, owner } = await pluginSession(created.ctx, scope())
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })

    await owner.dispose()
    expect(operationSignal?.aborted).toBe(true)
    release.resolve({ items: [decision(1)] })
    await new Promise<undefined>((resolve) => { setImmediate(resolve, undefined) })
    expect(factEvents(session)).toEqual([])
    expect(created.outbox.attachments(RUNTIME_SESSION, 0, 10)).toEqual([])
  })

  test.each(['request-abort', 'session-dispose'] as const)(
    'stops a multi-row Outbox page after the first synchronous observer %s',
    async (stop) => {
      const release = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
      const value = backend()
      value.pullOutbox = vi.fn(async () => release.promise)
      const created = service(value)
      await created.ctx.plugin(SessionStore)
      const request = new AbortController()
      const opened = await pluginSession(created.ctx, scope({ requestSignal: request.signal }))
      const sessionOwner = opened.owner
      created.ctx.on('session/event', (_session, event) => {
        if (event.type !== 'fact/proposal-decided') return
        if (stop === 'request-abort') request.abort(new Error('request closed'))
        else void sessionOwner.dispose()
      })
      await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })

      release.resolve({ items: [decision(1), decision(2)] })
      await vi.waitFor(() => { expect(factEvents(opened.session)).toHaveLength(1) })
      await new Promise<undefined>((resolve) => { setImmediate(resolve, undefined) })

      expect(factEvents(opened.session)).toHaveLength(1)
      expect(created.outbox.attachments(RUNTIME_SESSION, 0, 10)).toHaveLength(1)
    },
  )

  test('discards an Outbox reservation when its request is cancelled before append', async () => {
    const value = backend()
    value.pullOutbox = vi.fn(async () => ({ items: [decision(1)] }))
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const request = new AbortController()
    const register = created.outbox.register.bind(created.outbox)
    vi.spyOn(created.outbox, 'register').mockImplementation((input) => {
      const inserted = register(input)
      request.abort(new Error('request closed'))
      return inserted
    })

    const { session } = await pluginSession(created.ctx, scope({ requestSignal: request.signal }))
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    await new Promise<undefined>((resolve) => { setImmediate(resolve, undefined) })

    expect(factEvents(session)).toEqual([])
    expect(created.outbox.attachments(RUNTIME_SESSION, 0, 10)).toEqual([])
  })

  test('service disposal rejects new work before abort and waits for in-flight settlement without publishing late receipts', async () => {
    const release = Promise.withResolvers<Awaited<ReturnType<XAgentFactBackend['prepare']>>>()
    const value = backend()
    let operationSignal: AbortSignal | undefined
    value.prepare = vi.fn(async (...args: PrepareArgs) => {
      operationSignal = args[3]
      return release.promise
    })
    const created = service(value)
    const input = {
      sessionId: RUNTIME_SESSION,
      toolCallId: 'call-1',
      fieldKey: 'customer.name',
      label: 'Customer',
      value: { type: 'text' as const, value: 'Alpha' },
      evidenceIds: [],
      assertionReason: 'manual assertion',
    }
    const pending = runWithXAgentAuthenticatedRequestScope(scope(), () => created.fact.proposeFact(input))
    await vi.waitFor(() => { expect(value.prepare).toHaveBeenCalledOnce() })
    let disposed = false
    const disposal = created.fact.dispose().then(() => { disposed = true })

    expect(operationSignal?.aborted).toBe(true)
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => created.fact.proposeFact(input)))
      .rejects.toEqual(new XAgentFactError('service-unavailable'))
    expect(created.receipts.attachments(RUNTIME_SESSION, 0, 100)).toEqual([])
    expect(disposed).toBe(false)
    release.resolve({
      result: { proposalId: PROPOSAL, status: 'pending' },
      receipt: 'late-receipt',
      payloadHash: 'a'.repeat(64),
    })
    await expect(pending).rejects.toEqual(new XAgentFactError('service-unavailable'))
    await disposal
    expect(created.receipts.attachments(RUNTIME_SESSION, 0, 100)).toEqual([])
  })

  test('request cancellation aborts a prepare call and discards its late backend result', async () => {
    const release = Promise.withResolvers<Awaited<ReturnType<XAgentFactBackend['prepare']>>>()
    const value = backend()
    value.prepare = vi.fn(async () => release.promise)
    const created = service(value)
    const request = new AbortController()
    const pending = runWithXAgentAuthenticatedRequestScope(scope({ requestSignal: request.signal }), () =>
      created.fact.proposeFact({
        sessionId: RUNTIME_SESSION,
        toolCallId: 'call-1',
        fieldKey: 'customer.name',
        label: 'Customer',
        value: { type: 'text', value: 'Alpha' },
        evidenceIds: [],
        assertionReason: 'manual assertion',
      }))
    await vi.waitFor(() => { expect(value.prepare).toHaveBeenCalledOnce() })
    request.abort()
    release.resolve({
      result: { proposalId: PROPOSAL, status: 'pending' },
      receipt: 'late-receipt',
      payloadHash: 'a'.repeat(64),
    })
    await expect(pending).rejects.toEqual(new XAgentFactError('service-unavailable'))
    expect(created.receipts.attachments(RUNTIME_SESSION, 0, 100)).toEqual([])
  })

  test('message scope observers invalidate, discard, reject, and clear Agent ownership', async () => {
    const created = service()
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const invalidAgent = agentFor({ id: 'local-session' } as Session)
    const ignored = createUserMessage({ content: [{ type: 'text', text: 'ignored' }], source: { kind: 'user' } })
    agentEvents(created.ctx, invalidAgent).emit('agent/inbox/inserted', { message: ignored })

    const missing = createUserMessage({ content: [{ type: 'text', text: 'missing' }], source: { kind: 'user' } })
    agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: missing })
    agentEvents(created.ctx, agent).emit('agent/inbox/discarded', { message: missing })

    const request = new AbortController()
    const connection = new AbortController()
    const admitted = scope({ requestSignal: request.signal, connectionSignal: connection.signal })
    const cancelled = createUserMessage({ content: [{ type: 'text', text: 'cancelled' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(admitted, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: cancelled })
    })
    request.abort()
    await expect(agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [cancelled], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'reject' as const, reason: 'cancelled' }),
    )).resolves.toEqual({ kind: 'reject', reason: 'cancelled' })

    const connectionCancelled = createUserMessage({
      content: [{ type: 'text', text: 'connection cancelled' }], source: { kind: 'user' },
    })
    runWithXAgentAuthenticatedRequestScope(scope({ connectionSignal: connection.signal }), () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: connectionCancelled })
    })
    connection.abort()

    created.receipts.register({
      sessionId: RUNTIME_SESSION,
      toolCallId: 'unbound-error',
      proposalId: PROPOSAL,
      receipt: 'unbound-error',
      payloadHash: 'a'.repeat(64),
    })
    agentEvents(created.ctx, agent).emit('agent/error', { turn: 1, step: 1, error: new Error('failed') })
    expect(created.receipts.discard(RUNTIME_SESSION, 'unbound-error')).toBe(false)

    created.receipts.register({
      sessionId: RUNTIME_SESSION,
      toolCallId: 'unbound-dispose',
      proposalId: PROPOSAL,
      receipt: 'unbound-dispose',
      payloadHash: 'a'.repeat(64),
    })
    agentEvents(created.ctx, agent).emit('agent/disposed', {})
    expect(created.receipts.discard(RUNTIME_SESSION, 'unbound-dispose')).toBe(false)
  })

  test('pre-step scope propagation is exact for Fact execution and delegates unrelated tools', async () => {
    const created = service()
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const first = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    const second = createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } })
    const admitted = scope()
    runWithXAgentAuthenticatedRequestScope(admitted, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: first })
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: second })
    })
    await agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [first, second], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [first, second] }),
    )

    const success = { isError: false as const, value: null, content: [] }
    const execution = {
      callId: 'call-1',
      rootCallId: 'call-1',
      name: 'propose_fact',
      arguments: {},
      agent,
      signal: new AbortController().signal,
      token: Symbol('execution'),
    }
    await expect(created.ctx.waterfall(
      'tools/execute', execution as never,
      async () => {
        expect(currentXAgentAuthenticatedRequestScope()).toBe(admitted)
        return success
      },
    )).resolves.toBe(success)
    await expect(created.ctx.waterfall(
      'tools/execute', { ...execution, name: 'other' } as never,
      async () => {
        expect(currentXAgentAuthenticatedRequestScope()).toBeUndefined()
        return success
      },
    )).resolves.toBe(success)
    await expect(created.ctx.waterfall(
      'tools/execute', { ...execution, agent: undefined } as never,
      async () => {
        expect(currentXAgentAuthenticatedRequestScope()).toBeUndefined()
        return success
      },
    )).resolves.toBe(success)

    const third = createUserMessage({ content: [{ type: 'text', text: 'third' }], source: { kind: 'user' } })
    const otherActor = scope({
      principal: Object.freeze({ ...admitted.principal, actorId: '00000000-0000-0000-0000-000000000199' }),
    })
    runWithXAgentAuthenticatedRequestScope(otherActor, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: third })
    })
    await agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [first, third], turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [first, third] }),
    )
    await agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 3, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'reject' as const, reason: 'stop' }),
    )
  })

  test('Session event observer accepts only the closed public Fact result and clears completed Turns', async () => {
    const created = service()
    await created.ctx.plugin(SessionStore)
    const { session, owner } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const otherAgent = agentFor({ id: 'session-00000000-0000-0000-0000-000000000299' } as Session)
    const activeScopes = (created.fact as unknown as {
      activeScopes: Map<Agent, XAgentAuthenticatedSessionRequestScope>
    }).activeScopes
    activeScopes.set(agent, scope())
    activeScopes.set(otherAgent, scope({ sessionId: '00000000-0000-0000-0000-000000000299' }))

    const resultEvent = (meta: unknown, content: unknown[] = [{
      type: 'tool-result', toolCallId: 'call-event', isError: false, content: [],
    }]): SessionEvent => ({
      type: 'tool/result',
      seq: 10,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'result-event' as never,
          role: 'user',
          source: { kind: 'tool', callId: 'call-event' as never },
          content: content as never,
        },
        meta: meta as never,
      },
      surfaceOp: 'append',
      sourceEventSeqs: [9],
    })
    const invalidEvents: SessionEvent[] = [
      { type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } },
      resultEvent(null),
      resultEvent([]),
      resultEvent('invalid'),
      resultEvent({ kind: 'other', status: 'pending', proposalId: PROPOSAL }),
      resultEvent({ kind: 'xagent-fact', status: 'confirmed', proposalId: PROPOSAL }),
      resultEvent({ kind: 'xagent-fact', status: 'pending', proposalId: 1 }),
      resultEvent({ kind: 'xagent-fact', status: 'pending', proposalId: 'bad' }),
      resultEvent({ kind: 'xagent-fact', status: 'pending', proposalId: PROPOSAL }, [{
        type: 'tool-result', toolCallId: 'call-event', isError: true, content: [],
      }]),
    ]
    for (const event of invalidEvents) created.ctx.emit('session/event', session, event)

    const warnings: unknown[] = []
    created.ctx.logger.warn = ((message: unknown) => { warnings.push(message) }) as typeof created.ctx.logger.warn
    created.ctx.emit('session/event', session, resultEvent({
      kind: 'xagent-fact', status: 'pending', proposalId: PROPOSAL,
    }))
    const bind = vi.spyOn(created.receipts, 'bindEvent').mockImplementation(() => { throw 'opaque failure' })
    created.ctx.emit('session/event', session, resultEvent({
      kind: 'xagent-fact', status: 'pending', proposalId: PROPOSAL,
    }))
    bind.mockRestore()
    expect(warnings).toEqual([
      expect.stringContaining('identity mismatch'),
      expect.stringContaining('unknown error'),
    ])

    created.ctx.emit('session/event', session, {
      type: 'turn/end', seq: 11, time: 0, data: { turn: 1, reason: { kind: 'completed' } },
    })
    expect(activeScopes.has(agent)).toBe(false)
    expect(activeScopes.has(otherAgent)).toBe(true)

    activeScopes.set(agent, scope())
    const pending = createUserMessage({ content: [{ type: 'text', text: 'pending' }], source: { kind: 'user' } })
    const otherPending = createUserMessage({ content: [{ type: 'text', text: 'other pending' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: pending })
    })
    runWithXAgentAuthenticatedRequestScope(scope({ sessionId: '00000000-0000-0000-0000-000000000299' }), () => {
      agentEvents(created.ctx, otherAgent).emit('agent/inbox/inserted', { message: otherPending })
    })
    await owner.dispose()
    expect(activeScopes.has(agent)).toBe(false)
    expect(activeScopes.has(otherAgent)).toBe(true)
  })

  test('Session-open delivery fails closed for mismatched scopes, backend errors, and malformed Outbox rows', async () => {
    const value = backend()
    value.pullOutbox = vi.fn(async () => { throw new XAgentBackendError('service-unavailable') })
    const created = service(value)
    const warnings: unknown[] = []
    created.ctx.logger.warn = ((message: unknown) => { warnings.push(message) }) as typeof created.ctx.logger.warn
    await created.ctx.plugin(SessionStore)

    const mismatched = await pluginSession(created.ctx, scope({ sessionId: '00000000-0000-0000-0000-000000000299' }))
    expect(value.pullOutbox).not.toHaveBeenCalled()
    await mismatched.owner.dispose()
    const matching = await pluginSession(created.ctx, scope())
    await vi.waitFor(() => { expect(warnings).toHaveLength(1) })
    expect(factEvents(matching.session)).toEqual([])

    const malformedBackend = backend()
    malformedBackend.pullOutbox = vi.fn(async () => ({ items: [
      decision(1),
      { ...decision(1), payloadHash: 'b'.repeat(64) },
    ] }))
    const malformed = service(malformedBackend)
    const malformedWarnings: unknown[] = []
    malformed.ctx.logger.warn = ((message: unknown) => { malformedWarnings.push(message) }) as typeof malformed.ctx.logger.warn
    await malformed.ctx.plugin(SessionStore)
    const duplicate = await pluginSession(malformed.ctx, scope())
    await vi.waitFor(() => { expect(malformedWarnings).toHaveLength(1) })
    expect(factEvents(duplicate.session)).toEqual([])

    const wrongProjectBackend = backend()
    wrongProjectBackend.pullOutbox = vi.fn(async () => ({ items: [{
      ...decision(2),
      event: { ...decision(2).event, data: { ...decision(2).event.data, projectId: '00000000-0000-0000-0000-000000000399' } },
    }] }))
    const wrongProject = service(wrongProjectBackend)
    const projectWarnings: unknown[] = []
    wrongProject.ctx.logger.warn = ((message: unknown) => { projectWarnings.push(message) }) as typeof wrongProject.ctx.logger.warn
    await wrongProject.ctx.plugin(SessionStore)
    await pluginSession(wrongProject.ctx, scope())
    await vi.waitFor(() => { expect(projectWarnings).toHaveLength(1) })
  })

  test('Outbox append rollback retains no sidecar and exact pending replay is not duplicated', async () => {
    const value = backend()
    value.pullOutbox = vi.fn(async () => ({ items: [decision(1)] }))
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const admitted = scope()
    const message = createUserMessage({ content: [{ type: 'text', text: 'deliver' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(admitted, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message })
    })
    const originalAppend = session.append.bind(session)
    const append = vi.spyOn(session, 'append').mockImplementation(() => { throw new Error('append failed') })
    await expect(agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
    )).rejects.toEqual(new XAgentFactError('service-unavailable'))
    expect(created.outbox.attachments(RUNTIME_SESSION, 0, 10)).toEqual([])
    append.mockRestore()

    created.outbox.register({
      sessionId: RUNTIME_SESSION,
      eventSequence: session.seq,
      outboxId: decision(1).outboxId,
      payloadHash: decision(1).payloadHash,
    })
    const replay = createUserMessage({ content: [{ type: 'text', text: 'replay' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(admitted, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: replay })
    })
    await agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [replay], turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [replay] }),
    )
    expect(factEvents(session)).toEqual([])
    expect(originalAppend).toBeTypeOf('function')

    const rejectedRegistryBackend = backend()
    rejectedRegistryBackend.pullOutbox = vi.fn(async () => ({ items: [decision(2)] }))
    const rejectedRegistry = service(rejectedRegistryBackend)
    await rejectedRegistry.ctx.plugin(SessionStore)
    const rejectedSession = await pluginSession(rejectedRegistry.ctx, undefined)
    const rejectedAgent = agentFor(rejectedSession.session)
    const rejectedMessage = createUserMessage({
      content: [{ type: 'text', text: 'registry failure' }], source: { kind: 'user' },
    })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      agentEvents(rejectedRegistry.ctx, rejectedAgent).emit('agent/inbox/inserted', { message: rejectedMessage })
    })
    vi.spyOn(rejectedRegistry.outbox, 'register').mockImplementation(() => { throw new Error('registry rejected') })
    await expect(agentEvents(rejectedRegistry.ctx, rejectedAgent).waterfall(
      'agent/pre-step',
      { messages: [rejectedMessage], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [rejectedMessage] }),
    )).rejects.toEqual(new XAgentFactError('service-unavailable'))
    expect(rejectedRegistry.outbox.attachments(RUNTIME_SESSION, 0, 10)).toEqual([])
  })

  test('Outbox owner replacement aborts and drains the prior physical scope', async () => {
    const firstRelease = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
    const value = backend()
    let calls = 0
    const signals: AbortSignal[] = []
    value.pullOutbox = vi.fn(async (_token, _sessionId, _input, signal) => {
      signals.push(signal as AbortSignal)
      calls += 1
      return calls === 1 ? firstRelease.promise : { items: [] }
    })
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const first = createUserMessage({ content: [{ type: 'text', text: 'first scope' }], source: { kind: 'user' } })
    const second = createUserMessage({ content: [{ type: 'text', text: 'second scope' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: first })
    })
    const firstStep = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [first], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [first] }),
    )
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    const replacementScope = scope({
      userToken: 'replacement-token',
      principal: Object.freeze({ ...scope().principal, actorId: '00000000-0000-0000-0000-000000000199' }),
    })
    runWithXAgentAuthenticatedRequestScope(replacementScope, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: second })
    })
    const secondStep = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [second], turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [second] }),
    )
    expect(signals[0]?.aborted).toBe(true)
    firstRelease.resolve({ items: [] })
    await expect(firstStep).rejects.toEqual(new XAgentFactError('service-unavailable'))
    await expect(secondStep).resolves.toMatchObject({ kind: 'enter' })
    expect(value.pullOutbox).toHaveBeenCalledTimes(2)
    expect(value.pullOutbox).toHaveBeenLastCalledWith(
      'replacement-token', SESSION, { limit: 32 }, expect.any(AbortSignal),
    )
  })

  test('concurrent physical-scope replacements serialize behind one Outbox owner', async () => {
    const releases = Array.from({ length: 3 }, () =>
      Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>())
    const signals: AbortSignal[] = []
    const value = backend()
    value.pullOutbox = vi.fn(async (_token, _sessionId, _input, signal) => {
      signals.push(signal as AbortSignal)
      return (releases[signals.length - 1] as (typeof releases)[number]).promise
    })
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const deliver = (requestScope: XAgentAuthenticatedSessionRequestScope): Promise<void> =>
      (created.fact as unknown as {
        deliverOutbox(session: Session, scope: XAgentAuthenticatedSessionRequestScope): Promise<void>
      }).deliverOutbox(session, requestScope)

    const first = deliver(scope())
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    const second = deliver(scope({ userToken: 'second-token' }))
    const third = deliver(scope({ userToken: 'third-token' }))
    releases[0]?.resolve({ items: [] })
    await expect(first).rejects.toEqual(new XAgentFactError('service-unavailable'))
    await Promise.resolve()
    const callsBeforeSecondSettlement = signals.length
    const secondWasAborted = signals[1]?.aborted
    releases[1]?.resolve({ items: [] })
    releases[2]?.resolve({ items: [] })
    await Promise.allSettled([second, third])

    expect(callsBeforeSecondSettlement).toBe(2)
    expect(secondWasAborted).toBe(true)
    expect(value.pullOutbox).toHaveBeenCalledTimes(3)
  })

  test('service disposal prevents a waiting Outbox scope replacement from taking ownership', async () => {
    const release = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
    const value = backend()
    value.pullOutbox = vi.fn(async () => release.promise)
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const first = createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    const second = createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: first })
    })
    const firstStep = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [first], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [first] }),
    )
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    runWithXAgentAuthenticatedRequestScope(scope({ userToken: 'replacement-token' }), () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: second })
    })
    const secondStep = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [second], turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [second] }),
    )
    const firstFailure = expect(firstStep).rejects.toEqual(new XAgentFactError('service-unavailable'))
    const secondFailure = expect(secondStep).rejects.toEqual(new XAgentFactError('service-unavailable'))
    const disposal = created.fact.dispose()
    release.resolve({ items: [] })
    await Promise.all([firstFailure, secondFailure, disposal])
    expect(value.pullOutbox).toHaveBeenCalledOnce()
  })

  test('a superseded Outbox owner discards a successful late page before append', async () => {
    const release = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
    const value = backend()
    value.pullOutbox = vi.fn(async () => release.promise)
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const message = createUserMessage({ content: [{ type: 'text', text: 'supersede' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message })
    })
    const step = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
    )
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    const owners = (created.fact as unknown as { outboxOwners: Map<string, { active: boolean }> }).outboxOwners
    const liveOwner = owners.get(RUNTIME_SESSION)
    if (liveOwner === undefined) throw new Error('Outbox owner missing')
    liveOwner.active = false
    release.resolve({ items: [decision(1)] })
    await expect(step).resolves.toMatchObject({ kind: 'enter' })
    expect(factEvents(session)).toEqual([])
  })

  test('live owner invariant detects mismatched Agent and Outbox ownership fields', async () => {
    type Internals = {
      activeScopes: Map<Agent, XAgentAuthenticatedSessionRequestScope>
      outboxOwners: Map<string, {
        session: Session
        scope: XAgentAuthenticatedSessionRequestScope
        controller: AbortController
        settlement: Promise<void>
        closeSignals: () => void
        active: boolean
      }>
    }
    const created = service()
    await created.ctx.plugin(SessionStore)
    const { session: validSession } = await pluginSession(created.ctx, undefined)
    const internals = created.fact as unknown as Internals
    const validAgent = agentFor(validSession)
    internals.activeScopes.set(validAgent, scope())
    expect(created.fact.relationshipIssue()).toBeUndefined()
    internals.activeScopes.set(validAgent, scope({ sessionId: '00000000-0000-0000-0000-000000000299' }))
    expect(created.fact.relationshipIssue()).toContain('active Fact scope')
    internals.activeScopes.set(validAgent, scope({ visibility: 'private', projectId: null } as never))
    expect(created.fact.relationshipIssue()).toContain('active Fact scope')
    internals.activeScopes.clear()

    const owner = (overrides: Partial<Internals['outboxOwners'] extends Map<string, infer T> ? T : never> = {}) => ({
      session: validSession,
      scope: scope(),
      controller: new AbortController(),
      settlement: Promise.resolve(),
      closeSignals: () => undefined,
      active: true,
      ...overrides,
    })
    const check = (key: string, candidate: ReturnType<typeof owner>): string | undefined => {
      internals.outboxOwners.clear()
      internals.outboxOwners.set(key, candidate)
      return created.fact.relationshipIssue()
    }
    expect(check(RUNTIME_SESSION, owner())).toBeUndefined()
    expect(check('wrong', owner())).toContain('Fact Outbox owner')
    expect(check(RUNTIME_SESSION, owner({ session: { id: 'wrong' } as Session }))).toContain('Fact Outbox owner')
    expect(check(RUNTIME_SESSION, owner({ scope: scope({ sessionId: '00000000-0000-0000-0000-000000000299' }) })))
      .toContain('Fact Outbox owner')
    expect(check(RUNTIME_SESSION, owner({ scope: scope({ visibility: 'private', projectId: null } as never) })))
      .toContain('Fact Outbox owner')
    expect(check(RUNTIME_SESSION, owner({ active: false }))).toContain('Fact Outbox owner')
    const aborted = new AbortController()
    aborted.abort()
    expect(check(RUNTIME_SESSION, owner({ controller: aborted }))).toContain('Fact Outbox owner')
    await created.ctx.fiber.dispose()
  })

  test('request cancellation closes an Outbox owner before a late backend result', async () => {
    const release = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
    const value = backend()
    let operationSignal: AbortSignal | undefined
    value.pullOutbox = vi.fn(async (...args: PullOutboxArgs) => {
      operationSignal = args[3]
      return release.promise
    })
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const request = new AbortController()
    const admitted = scope({ requestSignal: request.signal })
    const message = createUserMessage({ content: [{ type: 'text', text: 'cancel Outbox' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(admitted, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message })
    })
    const step = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
    )
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    request.abort()
    expect(operationSignal?.aborted).toBe(true)
    release.resolve({ items: [decision(1)] })
    await expect(step).rejects.toEqual(new XAgentFactError('service-unavailable'))
    expect(factEvents(session)).toEqual([])
  })

  test('service disposal synchronously clears message and Outbox owners, then drains the pull', async () => {
    const release = Promise.withResolvers<{ items: readonly XAgentFactOutboxItem[] }>()
    const value = backend()
    let operationSignal: AbortSignal | undefined
    value.pullOutbox = vi.fn(async (...args: PullOutboxArgs) => {
      operationSignal = args[3]
      return release.promise
    })
    const created = service(value)
    await created.ctx.plugin(SessionStore)
    const { session } = await pluginSession(created.ctx, undefined)
    const agent = agentFor(session)
    const admitted = scope()
    const active = createUserMessage({ content: [{ type: 'text', text: 'active' }], source: { kind: 'user' } })
    const queued = createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(admitted, () => {
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: active })
      agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message: queued })
    })
    const step = agentEvents(created.ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [active], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [active] }),
    )
    await vi.waitFor(() => { expect(value.pullOutbox).toHaveBeenCalledOnce() })
    let settled = false
    const disposal = created.fact.dispose().then(() => { settled = true })
    expect(operationSignal?.aborted).toBe(true)
    expect((created.fact as unknown as { messageScopes: Map<string, unknown> }).messageScopes.size).toBe(0)
    expect((created.fact as unknown as { outboxOwners: Map<string, unknown> }).outboxOwners.size).toBe(0)
    expect(settled).toBe(false)
    expect(() => { void created.fact.approve(RUNTIME_SESSION, PROPOSAL, { idempotencyKey: 'late' }) }).toThrow('disposed')
    release.resolve({ items: [decision(1)] })
    await expect(step).rejects.toEqual(new XAgentFactError('service-unavailable'))
    await disposal
    expect(factEvents(session)).toEqual([])
  })
})
