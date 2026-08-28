import { generateKeyPairSync } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type {
  XAgentProjectDiscoveryInput,
  XAgentProjectDiscoveryResult,
  XAgentRetrievalBackend,
} from '@xagent/dsh-backend-client'
import { runWithXAgentAuthenticatedRequestScope } from '@xagent/dsh-principal'
import { describe, expect, test, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as retrievalTools from '../../tool-retrieval/src/index.ts'
import { XAgentReceiptRegistry } from '../src/receipt-registry.ts'
import { XAgentRetrievalError, XAgentRetrievalService } from '../src/index.ts'

/* oxlint-disable typescript/unbound-method -- Vitest reads backend mock functions as values for call assertions. */

const ACTOR = '00000000-0000-0000-0000-000000000001'
const SESSION = '00000000-0000-0000-0000-000000000701'
const PROJECT = '00000000-0000-0000-0000-000000000401'
const { privateKey } = generateKeyPairSync('ed25519')

function scope(visibility: 'private' | 'project' = 'private') {
  return Object.freeze({
    principal: Object.freeze({
      actorId: ACTOR, role: 'specialist' as const, permissionRevision: 3,
      authSessionId: '00000000-0000-0000-0000-000000000101', connectionId: 'connection-alice',
    }),
    userToken: 'alice-token', connectionId: 'connection-alice', sessionId: SESSION,
    visibility,
    ...visibility === 'project' ? { projectId: PROJECT } : { projectId: null },
  })
}

function backend(): XAgentRetrievalBackend {
  return {
    projects: vi.fn(async () => ({
      projects: [{ projectId: PROJECT, name: 'Alpha' }], receipt: 'opaque-project-receipt', payloadHash: 'a'.repeat(64),
    })),
    search: vi.fn(async () => ({
      citations: [{
        id: '[资料1]', artifactId: '00000000-0000-0000-0000-000000000501',
        versionId: '00000000-0000-0000-0000-000000000601', chunkId: '00000000-0000-0000-0000-000000000801',
        displayName: 'brief.md', versionNumber: 1, lineStart: 1, lineEnd: 2, text: 'evidence', scope: 'project' as const,
      }], receipt: 'opaque-search-receipt', payloadHash: 'b'.repeat(64),
    })),
    authorizeCitations: vi.fn(async () => {}), resolveCitation: vi.fn(),
  }
}

function service(value = backend(), registry = new XAgentReceiptRegistry()) {
  const ctx = new Context()
  return { backend: value, ctx, registry, value: new XAgentRetrievalService(ctx, value, registry, {
    issuer: 'xagent-host', audience: 'xagent-api', privateKey, now: () => 100,
    countQueryTokens: value => value.trim().split(/\s+/u).length,
  }) }
}

describe('XAgentRetrievalService', () => {
  test('claims each queued prompt scope in the real Agent loop instead of inheriting the first driver token', async () => {
    const firstBackend = Promise.withResolvers<XAgentProjectDiscoveryResult>()
    const value = backend()
    const projects = vi.fn(async (token: string, _delegation: string, _input: XAgentProjectDiscoveryInput) => {
      if (token === 'alice-token') return firstBackend.promise
      return {
        projects: [{ projectId: PROJECT, name: token }], receipt: 'opaque-bob-receipt', payloadHash: 'd'.repeat(64),
      }
    })
    value.projects = projects
    const adapter = new MockAdapter([
      toolCallResponse('call-alice', 'list_accessible_projects', {}),
      toolCallResponse('call-bob-steer', 'list_accessible_projects', {}), textResponse('steering done'),
      toolCallResponse('call-bob', 'list_accessible_projects', {}), textResponse('bob done'),
    ])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const registry = new XAgentReceiptRegistry()
    new XAgentRetrievalService(ctx, value, registry, {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, countQueryTokens: () => 1,
    })
    await ctx.plugin(retrievalTools)
    const owner = ctx.agentLoop.create(SessionId(`session-${SESSION}`), { provider: 'mock', model: 'mock' })
    const alice = createUserMessage({ content: [{ type: 'text', text: 'alice' }], source: { kind: 'user' } })
    const bobScope = Object.freeze({
      ...scope(), userToken: 'bob-token', connectionId: 'connection-bob',
      principal: Object.freeze({ ...scope().principal, permissionRevision: 4, connectionId: 'connection-bob' }),
    })
    runWithXAgentAuthenticatedRequestScope(scope(), () => { owner.followup(alice) })
    await vi.waitFor(() => { expect(projects).toHaveBeenCalledTimes(1) })
    runWithXAgentAuthenticatedRequestScope(bobScope, () => {
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'bob' }], source: { kind: 'user' } }))
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'bob queued twice' }], source: { kind: 'user' } }))
      owner.steer(createUserMessage({ content: [{ type: 'text', text: 'bob steering' }], source: { kind: 'user' } }))
    })
    firstBackend.resolve({
      projects: [{ projectId: PROJECT, name: 'alice' }], receipt: 'opaque-alice-receipt', payloadHash: 'a'.repeat(64),
    })
    await owner.whenIdle()
    expect(projects).toHaveBeenCalledTimes(3)
    expect(projects.mock.calls.map(call => call[0])).toEqual(['alice-token', 'bob-token', 'bob-token'])
    expect(projects.mock.calls.map(call => call[2].permissionRevision)).toEqual([3, 4, 4])
    expect(owner.session.events.filter(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text.startsWith('bob')))).toHaveLength(3)
    expect(registry.attachments(String(owner.session.id), 0, Number.MAX_SAFE_INTEGER)).toHaveLength(3)
  })

  test('rejects a claimed batch containing a queued prompt invalidated by an account revision change', async () => {
    const firstBackend = Promise.withResolvers<XAgentProjectDiscoveryResult>()
    const value = backend()
    const projects = vi.fn(async (_token: string, _delegation: string, _input: XAgentProjectDiscoveryInput) => firstBackend.promise)
    value.projects = projects
    const adapter = new MockAdapter([
      toolCallResponse('call-running', 'list_accessible_projects', {}),
      textResponse('running done'),
      toolCallResponse('call-ambiguous', 'list_accessible_projects', {}),
    ])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    new XAgentRetrievalService(ctx, value, new XAgentReceiptRegistry(), {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, countQueryTokens: () => 1,
    })
    await ctx.plugin(retrievalTools)
    const owner = ctx.agentLoop.create(SessionId(`session-${SESSION}`), { provider: 'mock', model: 'mock' })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'running' }], source: { kind: 'user' } }))
    })
    await vi.waitFor(() => { expect(projects).toHaveBeenCalledOnce() })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'stale queued' }], source: { kind: 'user' } }))
    })
    const changedScope = Object.freeze({
      ...scope(), userToken: 'bob-token', connectionId: 'connection-bob',
      principal: Object.freeze({ ...scope().principal, permissionRevision: 4, connectionId: 'connection-bob' }),
    })
    runWithXAgentAuthenticatedRequestScope(changedScope, () => {
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'new account queued' }], source: { kind: 'user' } }))
    })
    firstBackend.resolve({
      projects: [{ projectId: PROJECT, name: 'running' }], receipt: 'opaque-running-receipt', payloadHash: 'a'.repeat(64),
    })
    await owner.whenIdle()
    expect(projects).toHaveBeenCalledOnce()
  })

  test('keeps the running prompt scope immutable when another account queues a followup', async () => {
    const firstBackend = Promise.withResolvers<XAgentProjectDiscoveryResult>()
    const value = backend()
    const projects = vi.fn(async (token: string, _delegation: string, _input: XAgentProjectDiscoveryInput) =>
      token === 'alice-token' && projects.mock.calls.length === 1
        ? firstBackend.promise
        : {
          projects: [{ projectId: PROJECT, name: token }],
          receipt: `opaque-${token}-${String(projects.mock.calls.length)}`,
          payloadHash: (token === 'alice-token' ? 'a' : 'd').repeat(64),
        })
    value.projects = projects
    const adapter = new MockAdapter([
      toolCallResponse('call-a1', 'list_accessible_projects', {}),
      toolCallResponse('call-a2', 'list_accessible_projects', {}),
      textResponse('alice done'),
      toolCallResponse('call-b', 'list_accessible_projects', {}),
      textResponse('bob done'),
    ])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    new XAgentRetrievalService(ctx, value, new XAgentReceiptRegistry(), {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, countQueryTokens: () => 1,
    })
    await ctx.plugin(retrievalTools)
    const owner = ctx.agentLoop.create(SessionId(`session-${SESSION}`), { provider: 'mock', model: 'mock' })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'alice' }], source: { kind: 'user' } }))
    })
    await vi.waitFor(() => { expect(projects).toHaveBeenCalledOnce() })
    const changedScope = Object.freeze({
      ...scope(), userToken: 'bob-token', connectionId: 'connection-bob',
      principal: Object.freeze({ ...scope().principal, permissionRevision: 4, connectionId: 'connection-bob' }),
    })
    runWithXAgentAuthenticatedRequestScope(changedScope, () => {
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'bob' }], source: { kind: 'user' } }))
    })
    firstBackend.resolve({
      projects: [{ projectId: PROJECT, name: 'alice' }], receipt: 'opaque-a1', payloadHash: 'a'.repeat(64),
    })
    await owner.whenIdle()
    expect(projects.mock.calls.map(call => call[0])).toEqual(['alice-token', 'alice-token', 'bob-token'])
  })

  test('ignores authenticated prompt scope for a non-XAgent Session identifier', () => {
    const created = service()
    const agent = { session: { id: SessionId('local-session') } } as Agent
    const message = createUserMessage({ content: [{ type: 'text', text: 'local' }], source: { kind: 'user' } })
    expect(() => {
      runWithXAgentAuthenticatedRequestScope(scope(), () => {
        agentEvents(created.ctx, agent).emit('agent/inbox/inserted', { message })
      })
    }).not.toThrow()
  })

  test('uses one inherited physical scope, one delegation, and one backend call for project discovery', async () => {
    const created = service()
    const result = await runWithXAgentAuthenticatedRequestScope(scope(), () =>
      created.value.listAccessibleProjects({ sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-projects', query: 'alp' }))
    expect(result).toEqual({ projects: [{ projectId: PROJECT, name: 'Alpha' }], payloadHash: 'a'.repeat(64) })
    expect(created.backend.projects).toHaveBeenCalledTimes(1)
    expect(created.backend.projects).toHaveBeenCalledWith(
      'alice-token', expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/),
      { sessionId: SESSION, toolCallId: 'call-projects', permissionRevision: 3, query: 'alp' }, expect.any(AbortSignal),
    )
    expect(created.registry.attachments(`session-${SESSION}`, 0, 99)).toEqual([])
    created.registry.publish(`session-${SESSION}`, 'call-projects', 'a'.repeat(64))
    created.registry.bindEvent(`session-${SESSION}`, 'call-projects', 9)
    expect(created.registry.attachments(`session-${SESSION}`, 9, 9)[0]?.receipt).toBe('opaque-project-receipt')
  })

  test('canonicalizes explicit private scope and rejects aliases, duplicates, implicit all, and oversized queries before fetch', async () => {
    const created = service()
    const call = (projectIds: readonly string[], includePrivate: boolean, query = 'evidence') =>
      runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.searchArtifacts({
        sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-search', query, projectIds, includePrivate,
      }))
    await expect(call([PROJECT], true)).resolves.toMatchObject({ payloadHash: 'b'.repeat(64) })
    expect(created.backend.search).toHaveBeenCalledTimes(1)
    await expect(call([], false)).rejects.toMatchObject({ code: 'invalid-retrieval-scope' })
    await expect(call([PROJECT, PROJECT], false)).rejects.toMatchObject({ code: 'invalid-retrieval-scope' })
    await expect(call(['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'], false))
      .rejects.toMatchObject({ code: 'invalid-retrieval-scope' })
    await expect(call([PROJECT], false, Array.from({ length: 513 }, () => 'x').join(' ')))
      .rejects.toMatchObject({ code: 'invalid-retrieval-scope' })
    expect(created.backend.search).toHaveBeenCalledTimes(1)
  })

  test('uses the required exact query counter at 511, 512, and 513 tokens without byte-based CJK rejection', async () => {
    const value = backend()
    const ctx = new Context()
    const countQueryTokens = vi.fn((query: string) => Array.from(query).length)
    const retrieval = new XAgentRetrievalService(ctx, value, new XAgentReceiptRegistry(), {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, now: () => 100, countQueryTokens,
    })
    const call = (query: string, toolCallId: string) => runWithXAgentAuthenticatedRequestScope(scope(), () =>
      retrieval.searchArtifacts({
        sessionId: SessionId(`session-${SESSION}`), toolCallId, query, projectIds: [PROJECT], includePrivate: false,
      }))

    await expect(call('资'.repeat(511), 'call-511')).resolves.toBeDefined()
    await expect(call('a'.repeat(512), 'call-512')).resolves.toBeDefined()
    await expect(call('资'.repeat(512), 'call-cjk-512')).resolves.toBeDefined()
    await expect(call('a b 多字节', 'call-mixed')).resolves.toBeDefined()
    await expect(call('a'.repeat(513), 'call-513')).rejects.toMatchObject({ code: 'invalid-retrieval-scope' })
    expect(value.search).toHaveBeenCalledTimes(4)
    expect(countQueryTokens).toHaveBeenCalledTimes(5)
  })

  test('rejects service construction without an exact query token counter', () => {
    expect(() => new XAgentRetrievalService(new Context(), backend(), new XAgentReceiptRegistry(), {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, now: () => 100,
    })).toThrow(/token counter/i)
  })

  test.each([Number.NaN, -1, 1.5])('rejects an invalid exact token count of %s before fetch', async (count) => {
    const value = backend()
    const retrieval = new XAgentRetrievalService(new Context(), value, new XAgentReceiptRegistry(), {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, now: () => 100,
      countQueryTokens: () => count,
    })
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => retrieval.searchArtifacts({
      sessionId: SessionId(`session-${SESSION}`), toolCallId: `call-count-${String(count)}`,
      query: 'evidence', projectIds: [PROJECT], includePrivate: false,
    }))).rejects.toMatchObject({ code: 'service-unavailable' })
    expect(value.search).not.toHaveBeenCalled()
  })

  test('project sessions reject caller scope overrides and use only their fixed project', async () => {
    const created = service()
    const run = (projectIds: readonly string[] | undefined, includePrivate: boolean) =>
      runWithXAgentAuthenticatedRequestScope(scope('project'), () => created.value.searchArtifacts({
        sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-search', query: 'evidence',
        ...projectIds === undefined ? {} : { projectIds }, includePrivate,
      }))
    await expect(run(undefined, false)).resolves.toBeDefined()
    await expect(run([PROJECT], false)).rejects.toMatchObject({ code: 'invalid-retrieval-scope' })
    await expect(run(undefined, true)).rejects.toMatchObject({ code: 'invalid-retrieval-scope' })
  })

  test('fails closed for absent or mismatched async identity without touching the backend', async () => {
    const created = service()
    const input = { sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-1' }
    await expect(created.value.listAccessibleProjects(input)).rejects.toBeInstanceOf(XAgentRetrievalError)
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.listAccessibleProjects({
      ...input, sessionId: SessionId('session-00000000-0000-0000-0000-000000000999'),
    }))).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(created.backend.projects).not.toHaveBeenCalled()
  })

  test('fails closed for a missing signer or mismatched physical connection', async () => {
    const value = backend()
    const unsigned = new XAgentRetrievalService(new Context(), value, new XAgentReceiptRegistry(), {
      issuer: 'xagent-host', audience: 'xagent-api', now: () => 100, countQueryTokens: () => 1,
    })
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => unsigned.listAccessibleProjects({
      sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-unsigned',
    }))).rejects.toMatchObject({ code: 'service-unavailable' })
    const mismatched = Object.freeze({
      ...scope(),
      connectionId: 'connection-bob',
    })
    await expect(runWithXAgentAuthenticatedRequestScope(mismatched, () => unsigned.listAccessibleProjects({
      sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-mismatch',
    }))).rejects.toMatchObject({ code: 'unauthenticated' })
    expect(value.projects).not.toHaveBeenCalled()
  })

  test('keeps concurrent account, connection, Session, and tool identities isolated', async () => {
    const secondSession = '00000000-0000-0000-0000-000000000702'
    const secondScope = Object.freeze({
      principal: Object.freeze({
        actorId: '00000000-0000-0000-0000-000000000002', role: 'manager' as const,
        permissionRevision: 4, authSessionId: '00000000-0000-0000-0000-000000000102', connectionId: 'connection-bob',
      }),
      userToken: 'bob-token', connectionId: 'connection-bob', sessionId: secondSession,
      visibility: 'private' as const, projectId: null,
    })
    const created = service()
    await Promise.all([
      runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.listAccessibleProjects({
        sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-alice',
      })),
      runWithXAgentAuthenticatedRequestScope(secondScope, () => created.value.listAccessibleProjects({
        sessionId: SessionId(`session-${secondSession}`), toolCallId: 'call-bob',
      })),
    ])
    expect(created.backend.projects).toHaveBeenCalledWith(
      'alice-token', expect.any(String), expect.objectContaining({ sessionId: SESSION, toolCallId: 'call-alice' }), expect.any(AbortSignal),
    )
    expect(created.backend.projects).toHaveBeenCalledWith(
      'bob-token', expect.any(String), expect.objectContaining({ sessionId: secondSession, toolCallId: 'call-bob' }), expect.any(AbortSignal),
    )
    created.registry.publish(`session-${SESSION}`, 'call-alice', 'a'.repeat(64))
    created.registry.bindEvent(`session-${SESSION}`, 'call-alice', 1, 'a'.repeat(64))
    expect(() => { created.registry.bindEvent(`session-${SESSION}`, 'call-bob', 2, 'a'.repeat(64)) }).toThrow()
  })

  test('registers the receipt before returning and never exposes the secret', async () => {
    const registry = new XAgentReceiptRegistry()
    const register = vi.spyOn(registry, 'register').mockImplementation(() => { throw new Error('registration failed') })
    const created = service(backend(), registry)
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.listAccessibleProjects({
      sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-1',
    }))).rejects.toMatchObject({ code: 'service-unavailable' })
    expect(register).toHaveBeenCalledOnce()
  })

  test('keeps an already published receipt bindable while dispose waits for the Session append', async () => {
    const created = service()
    await runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.listAccessibleProjects({
      sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-dispose-append',
    }))
    created.registry.publish(`session-${SESSION}`, 'call-dispose-append', 'a'.repeat(64))
    let settled = false
    const disposal = created.value.dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    const session = Session.create(SessionId(`session-${SESSION}`))
    created.ctx.emit('session/event', session, {
      seq: 8, time: 100, type: 'tool/result',
      data: {
        turn: 1, step: 1,
        message: {
          id: 'message-dispose' as never, role: 'user', source: { kind: 'tool', callId: 'call-dispose-append' as never },
          content: [{ type: 'tool-result', toolCallId: 'call-dispose-append' as never, isError: false, content: [] }],
        },
        meta: { kind: 'xagent-retrieval', payloadHash: 'a'.repeat(64), citations: [] },
      },
    })
    await disposal
    expect(created.registry.attachments(String(session.id), 8, 8)[0]?.receipt).toBe('opaque-project-receipt')
  })

  test('prevents backend settlement from registering after synchronous disposal', async () => {
    const pending = Promise.withResolvers<XAgentProjectDiscoveryResult>()
    const value = backend()
    value.projects = vi.fn(() => pending.promise)
    const created = service(value)
    const operation = runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.listAccessibleProjects({
      sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-late-register',
    }))
    await vi.waitFor(() => { expect(value.projects).toHaveBeenCalledOnce() })
    pending.resolve({
      projects: [{ projectId: PROJECT, name: 'late' }], receipt: 'opaque-late-receipt', payloadHash: 'e'.repeat(64),
    })
    const disposal = created.value.dispose()
    await expect(operation).rejects.toMatchObject({ code: 'service-unavailable' })
    await disposal
    expect(created.registry.discard(`session-${SESSION}`, 'call-late-register')).toBe(false)
  })

  test('discards a receipt when post-execute or cancellation produces a final error result', async () => {
    const created = service()
    await runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.listAccessibleProjects({
      sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-blocked',
    }))
    const session = Session.create(SessionId(`session-${SESSION}`))
    created.ctx.emit('tools/result', {
      token: Symbol('test') as never,
      rootCallId: 'call-blocked' as never,
      callId: 'call-blocked' as never,
      name: 'list_accessible_projects', arguments: {}, signal: new AbortController().signal,
      agent: { session } as never,
    }, {
      isError: true, error: { message: 'blocked' }, content: [{ type: 'text', text: 'blocked' }],
    })
    expect(created.registry.discard(String(session.id), 'call-blocked')).toBe(false)
    await created.value.dispose()
  })

  test('binds only a matching public tool-result Session event', async () => {
    const created = service()
    await runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.listAccessibleProjects({
      sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-event',
    }))
    created.registry.publish(`session-${SESSION}`, 'call-event', 'a'.repeat(64))
    const session = Session.create(SessionId(`session-${SESSION}`))
    const resultEvent = (payloadHash: string): SessionEvent => ({
      seq: 7,
      time: 100,
      type: 'tool/result',
      data: {
        turn: 0,
        step: 0,
        message: {
          id: 'message-event' as never,
          role: 'user',
          source: { kind: 'tool', callId: 'call-event' as never },
          content: [{
            type: 'tool-result', toolCallId: 'call-event' as never,
            isError: false, content: [{ type: 'text', text: 'visible' }],
          }],
        },
        meta: { kind: 'xagent-retrieval', payloadHash, citations: [] },
      },
    })
    created.ctx.emit('session/event', session, resultEvent('f'.repeat(64)))
    expect(created.registry.attachments(String(session.id), 7, 7)).toEqual([])
    created.ctx.emit('session/event', session, resultEvent('a'.repeat(64)))
    expect(created.registry.attachments(String(session.id), 7, 7)).toMatchObject([{
      toolCallId: 'call-event', payloadHash: 'a'.repeat(64), receipt: 'opaque-project-receipt',
    }])
  })

  test('dispose closes admission, aborts active fetches, and waits for their settlement', async () => {
    let settle!: () => void
    const value = backend()
    value.projects = vi.fn((
      _token: string,
      _delegation: string,
      _input: XAgentProjectDiscoveryInput,
      signal?: AbortSignal,
    ): Promise<XAgentProjectDiscoveryResult> => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        settle = () => { reject(new DOMException('aborted', 'AbortError')) }
      }, { once: true })
    }))
    const created = service(value)
    const operation = runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.listAccessibleProjects({
      sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-1',
    }))
    await vi.waitFor(() => { expect(value.projects).toHaveBeenCalledOnce() })
    let disposed = false
    const disposal = created.value.dispose().then(() => { disposed = true })
    const reenteredDisposal = created.value.dispose()
    expect(disposed).toBe(false)
    settle()
    await expect(operation).rejects.toMatchObject({ code: 'service-unavailable' })
    await Promise.all([disposal, reenteredDisposal])
    await expect(runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.listAccessibleProjects({
      sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-2',
    }))).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('propagates caller cancellation to the only backend call', async () => {
    const controller = new AbortController()
    const value = backend()
    let resolveBackend!: () => void
    value.projects = vi.fn((): Promise<XAgentProjectDiscoveryResult> => new Promise((resolve) => {
      resolveBackend = () => {
        resolve({
          projects: [{ projectId: PROJECT, name: 'Alpha' }],
          receipt: 'opaque-cancelled-receipt', payloadHash: 'c'.repeat(64),
        })
      }
    }))
    const created = service(value)
    const operation = runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.listAccessibleProjects({
      sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-cancelled', signal: controller.signal,
    }))
    await vi.waitFor(() => { expect(value.projects).toHaveBeenCalledOnce() })
    controller.abort()
    resolveBackend()
    await expect(operation).rejects.toMatchObject({ code: 'service-unavailable' })
    expect(value.projects).toHaveBeenCalledTimes(1)
    expect(created.registry.attachments(`session-${SESSION}`, 0, 99)).toEqual([])
  })
})
