import { generateKeyPairSync } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  XAgentProjectDiscoveryInput,
  XAgentProjectDiscoveryResult,
  XAgentRetrievalBackend,
} from '@xagent/dsh-backend-client'
import { runWithXAgentAuthenticatedRequestScope } from '@xagent/dsh-principal'
import { describe, expect, test, vi } from 'vitest'
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
      issuer: 'xagent-host', audience: 'xagent-api', now: () => 100,
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

  test('binds only a matching public tool-result Session event', async () => {
    const created = service()
    await runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.listAccessibleProjects({
      sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-event',
    }))
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
