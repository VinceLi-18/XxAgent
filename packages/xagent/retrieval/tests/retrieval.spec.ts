import { generateKeyPairSync } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { remoteMethods, TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type {
  XAgentProjectDiscoveryInput,
  XAgentProjectDiscoveryResult,
  XAgentRetrievalBackend,
} from '@xagent/dsh-backend-client'
import { runWithXAgentAuthenticatedRequestScope, type XAgentAuthenticatedSessionRequestScope } from '@xagent/dsh-principal'
import { describe, expect, test, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as retrievalTools from '../../tool-retrieval/src/index.ts'
import { BGE_M3_TOKEN_VECTORS } from './bge-m3-token-vectors.ts'
import { XAgentReceiptRegistry } from '../src/receipt-registry.ts'
import {
  BGE_M3_MODEL_ID,
  BGE_M3_REVISION,
  CITED_ANSWER_INSTRUCTION,
  CITED_ANSWER_TOOL,
  XAgentBgeM3HttpTokenizer,
  XAgentCitationRemoteService,
  XAgentRetrievalError,
  XAgentRetrievalService,
  inject as pluginInject,
  type XAgentBgeM3Tokenizer,
} from '../src/index.ts'

const ACTOR = '00000000-0000-0000-0000-000000000001'
const SESSION = '00000000-0000-0000-0000-000000000701'
const PROJECT = '00000000-0000-0000-0000-000000000401'
const { privateKey } = generateKeyPairSync('ed25519')
const LIVE_REQUEST_SIGNAL = new AbortController().signal
const LIVE_CONNECTION_SIGNAL = new AbortController().signal

describe('retrieval plugin composition', () => {
  test('declares the exact Session service consumed by Loader-mounted citation reads', () => {
    expect(pluginInject).toEqual(['sessions'])
  })
})

function tokenizer(count: (value: string) => number = value => value.trim().split(/\s+/u).length): XAgentBgeM3Tokenizer {
  return Object.freeze({
    modelId: BGE_M3_MODEL_ID,
    revision: BGE_M3_REVISION,
    count: async (value: string) => count(value),
  })
}

function scope(visibility: 'private' | 'project' = 'private'): XAgentAuthenticatedSessionRequestScope {
  const base = {
    principal: Object.freeze({
      actorId: ACTOR, role: 'specialist' as const, permissionRevision: 3,
      authSessionId: '00000000-0000-0000-0000-000000000101', connectionId: 'connection-alice',
    }),
    userToken: 'alice-token', connectionId: 'connection-alice', sessionId: SESSION,
    requestSignal: LIVE_REQUEST_SIGNAL, connectionSignal: LIVE_CONNECTION_SIGNAL,
  }
  return visibility === 'project'
    ? Object.freeze({ ...base, visibility, projectId: PROJECT })
    : Object.freeze({ ...base, visibility, projectId: null })
}

function backend() {
  return {
    projects: vi.fn<XAgentRetrievalBackend['projects']>(async () => ({
      projects: [{ projectId: PROJECT, name: 'Alpha' }], receipt: 'opaque-project-receipt', payloadHash: 'a'.repeat(64),
    })),
    search: vi.fn<XAgentRetrievalBackend['search']>(async () => ({
      citations: [{
        id: '[资料1]', artifactId: '00000000-0000-0000-0000-000000000501',
        versionId: '00000000-0000-0000-0000-000000000601', chunkId: '00000000-0000-0000-0000-000000000801',
        displayName: 'brief.md', versionNumber: 1, lineStart: 1, lineEnd: 2, text: 'evidence', scope: 'project' as const,
      }], receipt: 'opaque-search-receipt', payloadHash: 'b'.repeat(64),
    })),
    authorizeCitations: vi.fn<XAgentRetrievalBackend['authorizeCitations']>(async () => {}),
    resolveCitation: vi.fn<XAgentRetrievalBackend['resolveCitation']>(),
  } satisfies XAgentRetrievalBackend
}

function service(value = backend(), registry = new XAgentReceiptRegistry()) {
  const ctx = new Context()
  return { backend: value, ctx, registry, value: new XAgentRetrievalService(ctx, value, registry, {
    issuer: 'xagent-host', audience: 'xagent-api', privateKey, now: () => 100,
    tokenizer: tokenizer(),
  }) }
}

function appendPersistedCitation(session: Session, id = '[资料1]'): void {
  session.append('turn/start', { turn: 0 })
  session.append('step/start', { turn: 0, step: 0 })
  const call = session.append('tool/call', {
    turn: 0, step: 0, callId: 'call-search' as never, name: 'search_artifacts',
    arguments: JSON.stringify({ artifactId: 'browser-forged', versionId: 'browser-forged' }),
  })
  session.append('tool/result', {
    turn: 0,
    step: 0,
    message: {
      id: 'message-search' as never,
      role: 'user',
      source: { kind: 'tool', callId: 'call-search' as never },
      content: [{
        type: 'tool-result', toolCallId: 'call-search' as never, isError: false,
        content: [{
          type: 'text',
          text: JSON.stringify({
            schema_version: 1,
            citations: [{
              id,
              artifact_id: '00000000-0000-0000-0000-000000000501',
              version_id: '00000000-0000-0000-0000-000000000601',
              chunk_id: '00000000-0000-0000-0000-000000000801',
              display_name: 'brief.md', version_number: 1, line_start: 4, line_end: 7,
              text: 'evidence', scope: 'project',
            }],
          }),
        }],
      }],
    },
    meta: { kind: 'xagent-retrieval', payloadHash: 'b'.repeat(64), citations: [id] },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}

async function citationService(value = backend()) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId(`session-${SESSION}`))
  appendPersistedCitation(session)
  const remote = new XAgentCitationRemoteService(ctx, value, {
    issuer: 'xagent-host', audience: 'xagent-api', privateKey, now: () => 100,
  })
  return { ctx, session, backend: value, remote }
}

async function agentHarness(adapter: LlmAdapter, value = backend()) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const retrieval = new XAgentRetrievalService(ctx, value, new XAgentReceiptRegistry(), {
    issuer: 'xagent-host', audience: 'xagent-api', privateKey, tokenizer: tokenizer(() => 1),
  })
  await ctx.plugin(retrievalTools)
  const owner = ctx.agentLoop.create(SessionId(`session-${SESSION}`), { provider: 'mock', model: 'mock' })
  return { ctx, owner, retrieval, value }
}

function terminalThenToolResponse(): StreamChunk[] {
  const answer = JSON.stringify({
    blocks: [{ type: 'markdown', text: 'final' }, { type: 'citation', id: '[资料1]' }],
  })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: CallId('call-answer'), name: CITED_ANSWER_TOOL, argumentsDelta: answer },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('call-answer'), name: CITED_ANSWER_TOOL, arguments: answer } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: CallId('call-after-answer'), name: 'list_accessible_projects', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: CallId('call-after-answer'), name: 'list_accessible_projects', arguments: '{}' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}


describe('XAgentRetrievalService', () => {
  test('publishes one canonical cited-answer result through the real Agent loop', async () => {
    const value = backend()
    const adapter = new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      toolCallResponse('call-answer', CITED_ANSWER_TOOL, {
        blocks: [{ type: 'markdown', text: '结论' }, { type: 'citation', id: '[资料1]' }],
      }),
    ])
    const created = await agentHarness(adapter, value)
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await created.owner.whenIdle()
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).not.toContain(CITED_ANSWER_TOOL)
    expect(adapter.requests[1]?.tools?.map(tool => tool.name)).toContain(CITED_ANSWER_TOOL)
    expect(adapter.requests[1]?.system).toContain(CITED_ANSWER_INSTRUCTION)
    expect(value.authorizeCitations).toHaveBeenCalledOnce()
    expect(created.owner.session.events.findLast(event => event.type === 'tool/result')).toMatchObject({
      data: {
        message: { source: { callId: 'call-answer' }, content: [{ type: 'tool-result', isError: false }] },
        meta: {
          kind: 'xagent-cited-answer', schemaVersion: 1,
          blocks: [{ type: 'markdown', text: '结论' }, { type: 'citation', id: '[资料1]' }],
          citationIds: ['[资料1]'],
        },
      },
    })
    expect(created.owner.session.events.findLast(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'completed' } },
    })
    await created.retrieval.dispose()
  })

  test('denies an ordinary tool after the terminal answer in the same model response', async () => {
    const value = backend()
    const adapter = new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      terminalThenToolResponse(),
    ])
    const created = await agentHarness(adapter, value)
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await created.owner.whenIdle()
    expect(value.projects).not.toHaveBeenCalled()
    expect(created.owner.session.events.find(event => event.type === 'tool/result'
      && event.data.message.source.callId === 'call-after-answer')).toMatchObject({
      data: { message: { content: [{ type: 'tool-result', isError: true }] } },
    })
    await created.retrieval.dispose()
  })

  test('allows one invalid terminal attempt before a successful retry in the same request owner', async () => {
    const value = backend()
    const adapter = new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      toolCallResponse('call-invalid', CITED_ANSWER_TOOL, {
        blocks: [{ type: 'markdown', text: 'rejected-secret' }, { type: 'citation', id: '[资料9]' }],
      }),
      toolCallResponse('call-answer', CITED_ANSWER_TOOL, {
        blocks: [{ type: 'markdown', text: 'verified' }, { type: 'citation', id: '[资料1]' }],
      }),
    ])
    const created = await agentHarness(adapter, value)
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await created.owner.whenIdle()
    const answers = created.owner.session.events.filter(event =>
      event.type === 'tool/result' && event.data.message.source.callId !== 'call-search')
    expect(answers).toHaveLength(2)
    expect(answers[0]).toMatchObject({
      data: { message: { content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'Error: invalid cited answer' }] }] } },
    })
    expect(JSON.stringify(answers[0])).not.toContain('rejected-secret')
    expect(answers[1]).toMatchObject({
      data: { message: { content: [{ type: 'tool-result', isError: false }] }, meta: { kind: 'xagent-cited-answer' } },
    })
    expect(value.authorizeCitations).toHaveBeenCalledOnce()
    await created.retrieval.dispose()
  })

  test('ends with CITATION_FAILED after a second invalid terminal attempt', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      toolCallResponse('call-invalid-1', CITED_ANSWER_TOOL, {
        blocks: [{ type: 'markdown', text: 'first-secret' }, { type: 'citation', id: '[资料9]' }],
      }),
      toolCallResponse('call-invalid-2', CITED_ANSWER_TOOL, {
        blocks: [{ type: 'markdown', text: 'second-secret' }, { type: 'citation', id: '[资料9]' }],
      }),
    ])
    const created = await agentHarness(adapter)
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await created.owner.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect(created.owner.session.events.findLast(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error', error: { code: 'CITATION_FAILED', message: 'cited answer was not submitted' } } },
    })
    expect(JSON.stringify(created.owner.session.events.filter(event => event.type === 'tool/result'))).not.toContain('first-secret')
    expect(JSON.stringify(created.owner.session.events.filter(event => event.type === 'tool/result'))).not.toContain('second-secret')
    await created.retrieval.dispose()
  })

  test('fails a protected response that finishes without the terminal tool and persists no prose', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      textResponse('rejected-secret'),
    ])
    const created = await agentHarness(adapter)
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await created.owner.whenIdle()
    expect(created.owner.session.events.findLast(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error', error: { code: 'CITATION_FAILED' } } },
    })
    expect(JSON.stringify(created.owner.session.events)).not.toContain('rejected-secret')
    await created.retrieval.dispose()
  })

  test('service disposal aborts terminal authorization and waits without publishing an answer', async () => {
    const value = backend()
    value.authorizeCitations = vi.fn(async (
      _token: string,
      _delegation: string,
      _input: Parameters<XAgentRetrievalBackend['authorizeCitations']>[2],
      signal?: AbortSignal,
    ) => {
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => { reject(new DOMException('aborted', 'AbortError')) }
        if (signal?.aborted === true) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    })
    const adapter = new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      toolCallResponse('call-answer', CITED_ANSWER_TOOL, {
        blocks: [{ type: 'markdown', text: 'must-not-publish' }, { type: 'citation', id: '[资料1]' }],
      }),
    ])
    const created = await agentHarness(adapter, value)
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await vi.waitFor(() => { expect(value.authorizeCitations).toHaveBeenCalledOnce() })
    await created.retrieval.dispose()
    await created.owner.whenIdle()
    expect(created.owner.session.events.filter(event => event.type === 'tool/result'
      && typeof event.data.meta === 'object' && event.data.meta !== null && !Array.isArray(event.data.meta)
      && event.data.meta.kind === 'xagent-cited-answer')).toHaveLength(0)
    expect(JSON.stringify(created.owner.session.events.filter(event => event.type === 'tool/result'))).not.toContain('must-not-publish')
  })

  test('a cited-answer Session append failure publishes no terminal result', async () => {
    const value = backend()
    const authorization = Promise.withResolvers<undefined>()
    value.authorizeCitations = vi.fn(() => authorization.promise)
    const created = await agentHarness(new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      toolCallResponse('call-answer', CITED_ANSWER_TOOL, {
        blocks: [{ type: 'markdown', text: 'must not publish' }, { type: 'citation', id: '[资料1]' }],
      }),
    ]), value)
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await vi.waitFor(() => { expect(value.authorizeCitations).toHaveBeenCalledOnce() })
    const append = created.owner.session.append.bind(created.owner.session)
    let appendAttempted = false
    vi.spyOn(created.owner.session, 'append').mockImplementation((
      type: string,
      data: unknown,
      ...options: unknown[]
    ) => {
      const row = typeof data === 'object' && data !== null ? data as Record<string, unknown> : undefined
      const message = typeof row?.message === 'object' && row.message !== null
        ? row.message as Record<string, unknown>
        : undefined
      const source = typeof message?.source === 'object' && message.source !== null
        ? message.source as Record<string, unknown>
        : undefined
      if (type === 'tool/result' && source?.callId === 'call-answer') {
        appendAttempted = true
        throw new Error('append failed')
      }
      return Reflect.apply(append, undefined, [type, data, ...options]) as never
    })
    authorization.resolve(undefined)
    await created.owner.whenIdle()
    expect(appendAttempted).toBe(true)
    expect(created.owner.session.events.filter(event => event.type === 'tool/result'
      && typeof event.data.meta === 'object' && event.data.meta !== null && !Array.isArray(event.data.meta)
      && event.data.meta.kind === 'xagent-cited-answer')).toHaveLength(0)
    await created.retrieval.dispose()
  })

  test.each(['requestSignal', 'connectionSignal'] as const)(
    '%s cancellation aborts terminal authorization without publishing an answer',
    async (signalName) => {
      const value = backend()
      value.authorizeCitations = vi.fn(async (
        _token: string,
        _delegation: string,
        _input: Parameters<XAgentRetrievalBackend['authorizeCitations']>[2],
        signal?: AbortSignal,
      ) => {
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => { reject(new DOMException('aborted', 'AbortError')) }
          if (signal?.aborted === true) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      })
      const adapter = new MockAdapter([
        toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
        toolCallResponse('call-answer', CITED_ANSWER_TOOL, {
          blocks: [{ type: 'markdown', text: 'must-not-publish' }, { type: 'citation', id: '[资料1]' }],
        }),
      ])
      const created = await agentHarness(adapter, value)
      const cancellation = new AbortController()
      runWithXAgentAuthenticatedRequestScope(Object.freeze({ ...scope(), [signalName]: cancellation.signal }), () => {
        created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
      })
      await vi.waitFor(() => { expect(value.authorizeCitations).toHaveBeenCalledOnce() })
      cancellation.abort()
      await created.owner.whenIdle()
      expect(created.owner.session.events.filter(event => event.type === 'tool/result'
        && typeof event.data.meta === 'object' && event.data.meta !== null && !Array.isArray(event.data.meta)
        && event.data.meta.kind === 'xagent-cited-answer')).toHaveLength(0)
      expect(JSON.stringify(created.owner.session.events.filter(event => event.type === 'tool/result'))).not.toContain('must-not-publish')
      await created.retrieval.dispose()
    },
  )

  test('account revision replacement cancels the cited owner before a replacement answer can publish', async () => {
    const value = backend()
    const authorization = Promise.withResolvers<undefined>()
    let firstAuthorizationAborted = false
    const authorizeCitations = vi.fn(async (
      _token: string,
      _delegation: string,
      _input: Parameters<XAgentRetrievalBackend['authorizeCitations']>[2],
      signal?: AbortSignal,
    ) => {
      if (authorizeCitations.mock.calls.length > 1) return
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          firstAuthorizationAborted = true
          reject(new DOMException('aborted', 'AbortError'))
        }
        if (signal?.aborted === true) abort()
        else {
          signal?.addEventListener('abort', abort, { once: true })
          void authorization.promise.then(resolve)
        }
      })
    })
    value.authorizeCitations = authorizeCitations
    const adapter = new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      toolCallResponse('call-alice-answer', CITED_ANSWER_TOOL, {
        blocks: [{ type: 'markdown', text: 'alice answer' }, { type: 'citation', id: '[资料1]' }],
      }),
      toolCallResponse('call-bob-answer', CITED_ANSWER_TOOL, {
        blocks: [{ type: 'markdown', text: 'bob answer' }, { type: 'citation', id: '[资料1]' }],
      }),
    ])
    const created = await agentHarness(adapter, value)
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'alice' }], source: { kind: 'user' } }))
    })
    await vi.waitFor(() => { expect(value.authorizeCitations).toHaveBeenCalledOnce() })
    const changedScope = Object.freeze({
      ...scope(), userToken: 'bob-token', connectionId: 'connection-bob',
      principal: Object.freeze({ ...scope().principal, permissionRevision: 4, connectionId: 'connection-bob' }),
    })
    runWithXAgentAuthenticatedRequestScope(changedScope, () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'bob' }], source: { kind: 'user' } }))
    })
    await new Promise<undefined>((resolve) => { setImmediate(resolve, undefined) })
    const observedAbort = firstAuthorizationAborted
    authorization.resolve(undefined)
    await created.owner.whenIdle()
    expect(observedAbort).toBe(true)
    expect(authorizeCitations.mock.calls.map(call => call[0])).toEqual(['alice-token'])
    expect(created.owner.session.events.find(event => event.type === 'tool/result'
      && event.data.message.source.callId === 'call-alice-answer')).toMatchObject({
      data: { message: { content: [{ type: 'tool-result', isError: true }] } },
    })
    expect(created.owner.session.events.filter(event => event.type === 'tool/result'
      && typeof event.data.meta === 'object' && event.data.meta !== null && !Array.isArray(event.data.meta)
      && event.data.meta.kind === 'xagent-cited-answer')).toHaveLength(0)
    await created.retrieval.dispose()
  })

  test('Session disposal aborts a cited owner and publishes no answer', async () => {
    const value = backend()
    let authorizationAborted = false
    value.authorizeCitations = vi.fn(async (
      _token: string,
      _delegation: string,
      _input: Parameters<XAgentRetrievalBackend['authorizeCitations']>[2],
      signal?: AbortSignal,
    ) => {
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => {
          authorizationAborted = true
          reject(new DOMException('aborted', 'AbortError'))
        }
        if (signal?.aborted === true) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    })
    const created = await agentHarness(new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      toolCallResponse('call-answer', CITED_ANSWER_TOOL, {
        blocks: [{ type: 'markdown', text: 'must not publish' }, { type: 'citation', id: '[资料1]' }],
      }),
    ]), value)
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await vi.waitFor(() => { expect(value.authorizeCitations).toHaveBeenCalledOnce() })
    created.ctx.emit('session/disposed', created.owner.session)
    await created.owner.whenIdle()
    expect(authorizationAborted).toBe(true)
    expect(created.owner.session.events.filter(event => event.type === 'tool/result'
      && typeof event.data.meta === 'object' && event.data.meta !== null && !Array.isArray(event.data.meta)
      && event.data.meta.kind === 'xagent-cited-answer')).toHaveLength(0)
    await created.retrieval.dispose()
  })

  test('retrieval disposal waits for a request-cancelled protected source to return', async () => {
    const protectedStarted = Promise.withResolvers<undefined>()
    const releaseSource = Promise.withResolvers<undefined>()
    let sourceReturned = false
    const adapter = new class extends MockAdapter {
      private calls = 0

      constructor() { super([]) }

      override async * stream(): AsyncIterable<StreamChunk> {
        this.calls += 1
        if (this.calls === 1) {
          yield* toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] })
          return
        }
        try {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          protectedStarted.resolve(undefined)
          await releaseSource.promise
          yield { type: 'finish', reason: { kind: 'stop' } }
        } finally {
          sourceReturned = true
        }
      }
    }()
    const created = await agentHarness(adapter)
    const request = new AbortController()
    runWithXAgentAuthenticatedRequestScope(Object.freeze({ ...scope(), requestSignal: request.signal }), () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await protectedStarted.promise
    request.abort()
    let disposalSettled = false
    const disposal = created.retrieval.dispose().then(() => { disposalSettled = true })
    await new Promise<undefined>((resolve) => { setImmediate(resolve, undefined) })
    const settledBeforeSource = disposalSettled
    releaseSource.resolve(undefined)
    await disposal
    await created.owner.whenIdle()
    expect(settledBeforeSource).toBe(false)
    expect(sourceReturned).toBe(true)
  })

  test('requires the pinned BGE-M3 tokenizer identity and validates the production HTTP response', async () => {
    expect(() => new XAgentRetrievalService(new Context(), backend(), new XAgentReceiptRegistry(), {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey,
    })).toThrow(/BGE-M3 tokenizer/i)
    const validTokenizer = tokenizer()
    expect(() => new XAgentRetrievalService(new Context(), backend(), new XAgentReceiptRegistry(), {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey,
      tokenizer: Object.freeze({ ...validTokenizer, revision: 'wrong', count: (value: string) => validTokenizer.count(value) }),
    })).toThrow(/BGE-M3 tokenizer/i)

    const fetch = vi.fn(async (_input: string, _init: RequestInit) => new Response(JSON.stringify({
      model: BGE_M3_MODEL_ID,
      revision: BGE_M3_REVISION,
      token_count: 17,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const production = new XAgentBgeM3HttpTokenizer('http://api.internal', 'service-secret', fetch)
    await expect(production.count('资料 with whitespace', new AbortController().signal)).resolves.toBe(17)
    expect(fetch.mock.calls[0]?.[0]).toBe('http://api.internal/internal/xagent/retrieval/token-count')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-xagent-service-token': 'service-secret',
      },
    })
    expect(fetch.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
  })
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
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, tokenizer: tokenizer(() => 1),
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
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, tokenizer: tokenizer(() => 1),
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
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, tokenizer: tokenizer(() => 1),
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

  test('rejects unbound steering instead of reusing the running authenticated scope', async () => {
    const firstBackend = Promise.withResolvers<XAgentProjectDiscoveryResult>()
    const value = backend()
    const projects = vi.fn(async () => firstBackend.promise)
    value.projects = projects
    const adapter = new MockAdapter([
      toolCallResponse('call-running-unbound', 'list_accessible_projects', {}),
      toolCallResponse('call-unbound-steer', 'list_accessible_projects', {}),
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
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, tokenizer: tokenizer(() => 1),
    })
    await ctx.plugin(retrievalTools)
    const owner = ctx.agentLoop.create(SessionId(`session-${SESSION}`), { provider: 'mock', model: 'mock' })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'running' }], source: { kind: 'user' } }))
    })
    await vi.waitFor(() => { expect(projects).toHaveBeenCalledOnce() })
    owner.steer(createUserMessage({ content: [{ type: 'text', text: 'unbound' }], source: { kind: 'user' } }))
    firstBackend.resolve({
      projects: [{ projectId: PROJECT, name: 'running' }], receipt: 'opaque-running-unbound', payloadHash: 'a'.repeat(64),
    })
    await owner.whenIdle()
    expect(projects).toHaveBeenCalledOnce()
  })

  test.each(['requestSignal', 'connectionSignal'] as const)(
    'rejects queued work after its %s aborts before claim',
    async (signalName) => {
      const firstBackend = Promise.withResolvers<XAgentProjectDiscoveryResult>()
      const value = backend()
      const projects = vi.fn(async () => firstBackend.promise)
      value.projects = projects
      const adapter = new MockAdapter([
        toolCallResponse(`call-running-${signalName}`, 'list_accessible_projects', {}),
        textResponse('running done'),
        toolCallResponse(`call-stale-${signalName}`, 'list_accessible_projects', {}),
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
        issuer: 'xagent-host', audience: 'xagent-api', privateKey, tokenizer: tokenizer(() => 1),
      })
      await ctx.plugin(retrievalTools)
      const owner = ctx.agentLoop.create(SessionId(`session-${SESSION}`), { provider: 'mock', model: 'mock' })
      runWithXAgentAuthenticatedRequestScope(scope(), () => {
        owner.followup(createUserMessage({ content: [{ type: 'text', text: 'running' }], source: { kind: 'user' } }))
      })
      await vi.waitFor(() => { expect(projects).toHaveBeenCalledOnce() })
      const abort = new AbortController()
      runWithXAgentAuthenticatedRequestScope(Object.freeze({ ...scope(), [signalName]: abort.signal }), () => {
        owner.followup(createUserMessage({ content: [{ type: 'text', text: 'cancelled queued' }], source: { kind: 'user' } }))
      })
      abort.abort()
      firstBackend.resolve({
        projects: [{ projectId: PROJECT, name: 'running' }], receipt: `opaque-running-${signalName}`, payloadHash: 'a'.repeat(64),
      })
      await owner.whenIdle()
      expect(projects).toHaveBeenCalledOnce()
    },
  )

  test('does not reuse bindings after real inbox discard and replacement', async () => {
    const firstBackend = Promise.withResolvers<XAgentProjectDiscoveryResult>()
    const value = backend()
    const projects = vi.fn(async () => firstBackend.promise)
    value.projects = projects
    const adapter = new MockAdapter([
      toolCallResponse('call-running-mutation', 'list_accessible_projects', {}),
      textResponse('running done'),
      toolCallResponse('call-replaced', 'list_accessible_projects', {}),
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
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, tokenizer: tokenizer(() => 1),
    })
    await ctx.plugin(retrievalTools)
    const owner = ctx.agentLoop.create(SessionId(`session-${SESSION}`), { provider: 'mock', model: 'mock' })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'running' }], source: { kind: 'user' } }))
    })
    await vi.waitFor(() => { expect(projects).toHaveBeenCalledOnce() })
    const discarded = createUserMessage({ content: [{ type: 'text', text: 'discarded' }], source: { kind: 'user' } })
    const replaced = createUserMessage({ content: [{ type: 'text', text: 'bound before replacement' }], source: { kind: 'user' } })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      owner.followup(discarded)
      owner.followup(replaced)
    })
    owner.inbox.remove(discarded.id)
    owner.inbox.replace(replaced.id, createUserMessage({
      content: [{ type: 'text', text: 'unbound replacement' }], source: { kind: 'user' },
    }))
    firstBackend.resolve({
      projects: [{ projectId: PROJECT, name: 'running' }], receipt: 'opaque-running-mutation', payloadHash: 'a'.repeat(64),
    })
    await owner.whenIdle()
    expect(projects).toHaveBeenCalledOnce()
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
    const counts = new Map(BGE_M3_TOKEN_VECTORS.map(vector => [vector.query, vector.tokens]))
    const countQueryTokens = vi.fn((query: string) => counts.get(query) ?? Number.NaN)
    const retrieval = new XAgentRetrievalService(ctx, value, new XAgentReceiptRegistry(), {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, now: () => 100,
      tokenizer: tokenizer(countQueryTokens),
    })
    const call = (query: string, toolCallId: string) => runWithXAgentAuthenticatedRequestScope(scope(), () =>
      retrieval.searchArtifacts({
        sessionId: SessionId(`session-${SESSION}`), toolCallId, query, projectIds: [PROJECT], includePrivate: false,
      }))

    for (const vector of BGE_M3_TOKEN_VECTORS.filter(value => value.tokens <= 512)) {
      await expect(call(vector.query, `call-${vector.name}`)).resolves.toBeDefined()
    }
    const overLimit = BGE_M3_TOKEN_VECTORS.find(value => value.tokens === 513)
    expect(overLimit).toBeDefined()
    await expect(call(overLimit!.query, 'call-513')).rejects.toMatchObject({ code: 'invalid-retrieval-scope' })
    expect(value.search).toHaveBeenCalledTimes(4)
    expect(countQueryTokens).toHaveBeenCalledTimes(5)
  })

  test('rejects service construction without the pinned tokenizer provider', () => {
    expect(() => new XAgentRetrievalService(new Context(), backend(), new XAgentReceiptRegistry(), {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, now: () => 100,
    })).toThrow(/tokenizer/i)
  })

  test.each([Number.NaN, -1, 1.5])('rejects an invalid exact token count of %s before fetch', async (count) => {
    const value = backend()
    const retrieval = new XAgentRetrievalService(new Context(), value, new XAgentReceiptRegistry(), {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, now: () => 100,
      tokenizer: tokenizer(() => count),
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
      issuer: 'xagent-host', audience: 'xagent-api', now: () => 100, tokenizer: tokenizer(() => 1),
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

  test('preserves a published receipt for the synchronous Session append continuation during disposal', async () => {
    const created = service()
    await runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.listAccessibleProjects({
      sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-dispose-append',
    }))
    created.registry.publish(`session-${SESSION}`, 'call-dispose-append', 'a'.repeat(64))
    const disposal = created.value.dispose()
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

  test('settles disposal without a permanent wait when a published append never arrives', async () => {
    const created = service()
    await runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.listAccessibleProjects({
      sessionId: SessionId(`session-${SESSION}`), toolCallId: 'call-dispose-no-append',
    }))
    created.registry.publish(`session-${SESSION}`, 'call-dispose-no-append', 'a'.repeat(64))
    const outcome = await Promise.race([
      created.value.dispose().then(() => 'disposed'),
      new Promise<string>((resolve) => { setTimeout(() => { resolve('timed-out') }, 50) }),
    ])
    expect(outcome).toBe('disposed')
    expect(created.registry.discard(`session-${SESSION}`, 'call-dispose-no-append')).toBe(false)
  })

  test('settles reentrant disposal awaited from the real post-execute waterfall', async () => {
    const value = backend()
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('call-reentrant-dispose', 'list_accessible_projects', {}),
      textResponse('done'),
    ]))
    const registry = new XAgentReceiptRegistry()
    const retrieval = new XAgentRetrievalService(ctx, value, registry, {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey, tokenizer: tokenizer(() => 1),
    })
    await ctx.plugin(retrievalTools)
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      if (exec.name === 'list_accessible_projects') await retrieval.dispose()
      return decision
    })
    const owner = ctx.agentLoop.create(SessionId(`session-${SESSION}`), { provider: 'mock', model: 'mock' })
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'dispose' }], source: { kind: 'user' } }))
    })
    await expect(Promise.race([
      owner.whenIdle().then(() => 'idle'),
      new Promise<string>((resolve) => { setTimeout(() => { resolve('timed-out') }, 100) }),
    ])).resolves.toBe('idle')
    expect(registry.discard(`session-${SESSION}`, 'call-reentrant-dispose')).toBe(false)
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

  test.each(['agent/error', 'agent/disposed', 'session/disposed'] as const)(
    'discards a published receipt when %s ends the append continuation',
    async (eventName) => {
      const created = service()
      await runWithXAgentAuthenticatedRequestScope(scope(), () => created.value.listAccessibleProjects({
        sessionId: SessionId(`session-${SESSION}`), toolCallId: `call-terminal-${eventName}`,
      }))
      created.registry.publish(`session-${SESSION}`, `call-terminal-${eventName}`, 'a'.repeat(64))
      const session = Session.create(SessionId(`session-${SESSION}`))
      const agent = { session } as Agent
      if (eventName === 'agent/error') {
        agentEvents(created.ctx, agent).emit(eventName, { turn: 1, step: 1, error: new Error('append failed') })
      } else if (eventName === 'agent/disposed') {
        agentEvents(created.ctx, agent).emit(eventName, {})
      } else {
        created.ctx.emit(eventName, session)
      }
      expect(created.registry.discard(String(session.id), `call-terminal-${eventName}`)).toBe(false)
    },
  )

  test('binds only a matching public tool-result and discards a conflicting append', async () => {
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
    expect(created.registry.attachments(String(session.id), 7, 7)).toEqual([])
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

describe('XAgentCitationRemoteService', () => {
  test('publishes only resolve and derives every backend identity from persisted citation evidence', async () => {
    const created = await citationService()
    created.backend.resolveCitation = vi.fn<XAgentRetrievalBackend['resolveCitation']>(async (_token, _delegation, input) => ({
      ...input.citation, lineStart: 4, lineEnd: 7,
    }))

    expect(remoteMethods(created.remote)).toEqual([
      { method: 'resolve', invocation: { kind: 'direct' } },
    ])
    await expect(created.remote.withRequest(scope(), () => created.remote.resolve(
      `session-${SESSION}`,
      '[资料1]',
    ))).resolves.toEqual({
      artifactId: '00000000-0000-0000-0000-000000000501',
      versionId: '00000000-0000-0000-0000-000000000601',
      chunkId: '00000000-0000-0000-0000-000000000801',
      lineStart: 4,
      lineEnd: 7,
    })
    const call = vi.mocked(created.backend.resolveCitation).mock.calls[0]!
    expect(call[0]).toBe('alice-token')
    expect(call[1]).toMatch(/^[^.]+\.[^.]+\.[^.]+$/)
    expect(call[2]).toEqual({
      sessionId: SESSION,
      toolCallId: call[2].toolCallId,
      permissionRevision: 3,
      citation: {
        id: '[资料1]',
        artifactId: '00000000-0000-0000-0000-000000000501',
        versionId: '00000000-0000-0000-0000-000000000601',
        chunkId: '00000000-0000-0000-0000-000000000801',
      },
    })
    expect(call[2].toolCallId).toEqual(expect.any(String))
    expect(call[3]).toBeInstanceOf(AbortSignal)
  })

  test('mints a fresh delegation and resolves again instead of caching a locator or URL', async () => {
    const created = await citationService()
    created.backend.resolveCitation = vi.fn<XAgentRetrievalBackend['resolveCitation']>(async (_token, _delegation, input) => ({
      ...input.citation, lineStart: 4, lineEnd: 7,
    }))
    await created.remote.withRequest(scope(), async () => {
      await created.remote.resolve(`session-${SESSION}`, '[资料1]')
      await created.remote.resolve(`session-${SESSION}`, '[资料1]')
    })
    const calls = vi.mocked(created.backend.resolveCitation).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[1]).not.toBe(calls[1]?.[1])
    expect(JSON.stringify(await created.remote.withRequest(scope(), () =>
      created.remote.resolve(`session-${SESSION}`, '[资料1]')))).not.toContain('url')
  })

  test('fails closed for missing evidence, Session mismatch, nested scope, cancellation, and disposal', async () => {
    const pending = Promise.withResolvers<never>()
    const value = backend()
    value.resolveCitation = vi.fn<XAgentRetrievalBackend['resolveCitation']>(async (_token, _delegation, _input, signal) => {
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => { reject(new DOMException('aborted', 'AbortError')) }
        if (signal?.aborted === true) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
      return pending.promise
    })
    const created = await citationService(value)
    await expect(created.remote.resolve(`session-${SESSION}`, '[资料1]')).rejects.toThrow('request scope')
    await expect(created.remote.withRequest(scope(), () => created.remote.resolve(
      'session-00000000-0000-0000-0000-000000000999', '[资料1]',
    ))).rejects.toMatchObject({ failure: { code: 'unauthenticated' } })
    await expect(created.remote.withRequest(scope(), () => created.remote.resolve(
      `session-${SESSION}`, '[资料9]',
    ))).rejects.toMatchObject({ failure: { code: 'citation-invalid' } })
    await expect(created.remote.withRequest(scope(), () => created.remote.withRequest(scope(), async () => undefined)))
      .rejects.toThrow('nested')

    const operation = created.remote.withRequest(scope(), () => created.remote.resolve(`session-${SESSION}`, '[资料1]'))
    await vi.waitFor(() => { expect(value.resolveCitation).toHaveBeenCalledOnce() })
    const disposal = created.remote.dispose()
    await expect(operation).rejects.toBeInstanceOf(TypertRemoteFailure)
    await disposal
    await expect(created.remote.withRequest(scope(), async () => undefined)).rejects.toThrow('disposed')
  })
})
