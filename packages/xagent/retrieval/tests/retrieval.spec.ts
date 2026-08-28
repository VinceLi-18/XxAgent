import { generateKeyPairSync } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
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
import { BGE_M3_TOKEN_VECTORS } from './bge-m3-token-vectors.ts'
import { XAgentReceiptRegistry } from '../src/receipt-registry.ts'
import {
  BGE_M3_MODEL_ID,
  BGE_M3_REVISION,
  XAgentBgeM3HttpTokenizer,
  XAgentRetrievalError,
  XAgentRetrievalService,
  type XAgentBgeM3Tokenizer,
} from '../src/index.ts'

/* oxlint-disable typescript/unbound-method -- Vitest reads backend mock functions as values for call assertions. */

const ACTOR = '00000000-0000-0000-0000-000000000001'
const SESSION = '00000000-0000-0000-0000-000000000701'
const PROJECT = '00000000-0000-0000-0000-000000000401'
const { privateKey } = generateKeyPairSync('ed25519')
const LIVE_REQUEST_SIGNAL = new AbortController().signal
const LIVE_CONNECTION_SIGNAL = new AbortController().signal

function tokenizer(count: (value: string) => number = value => value.trim().split(/\s+/u).length): XAgentBgeM3Tokenizer {
  return Object.freeze({
    modelId: BGE_M3_MODEL_ID,
    revision: BGE_M3_REVISION,
    count: async (value: string) => count(value),
  })
}

function scope(visibility: 'private' | 'project' = 'private') {
  return Object.freeze({
    principal: Object.freeze({
      actorId: ACTOR, role: 'specialist' as const, permissionRevision: 3,
      authSessionId: '00000000-0000-0000-0000-000000000101', connectionId: 'connection-alice',
    }),
    userToken: 'alice-token', connectionId: 'connection-alice', sessionId: SESSION,
    requestSignal: LIVE_REQUEST_SIGNAL, connectionSignal: LIVE_CONNECTION_SIGNAL,
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
    tokenizer: tokenizer(),
  }) }
}

class DeferredAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly responses: Array<readonly StreamChunk[] | ((options: GenerateOptions) => AsyncIterable<StreamChunk>)>) {
    super()
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('DeferredAdapter: script exhausted')
    if (typeof response === 'function') yield* response(options)
    else yield* response
  }
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

async function settlesWithin(operation: Promise<unknown>, milliseconds = 30): Promise<boolean> {
  return Promise.race([
    operation.then(() => true, () => true),
    new Promise<false>((resolve) => { setTimeout(() => { resolve(false) }, milliseconds) }),
  ])
}

async function* source(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* chunks
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('XAgentRetrievalService', () => {
  test('reauthorizes admitted citations in the real Agent loop before answer publication', async () => {
    const value = backend()
    const adapter = new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      textResponse('结论[资料1]'),
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
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await owner.whenIdle()
    expect(value.authorizeCitations).toHaveBeenCalledOnce()
    expect(value.authorizeCitations).toHaveBeenCalledWith(
      'alice-token', expect.any(String), expect.objectContaining({
        sessionId: SESSION,
        permissionRevision: 3,
        citations: [expect.objectContaining({ id: '[资料1]' })],
      }), expect.any(AbortSignal),
    )
    expect(owner.session.events.filter(event => event.type === 'assistant/message').at(-1)).toMatchObject({
      data: { message: { content: [{ type: 'text', text: '结论[资料1]' }] } },
    })
  })

  test('suppresses an uncited draft and retries exactly once through the real Agent loop', async () => {
    const value = backend()
    const adapter = new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      textResponse('unverified draft'),
      textResponse('verified[资料1]'),
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
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await owner.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect(owner.session.events.filter(event => event.type === 'xagent/citation-correction')).toHaveLength(1)
    expect(owner.session.events.filter(event => event.type === 'xagent/citation-failure')).toHaveLength(0)
    expect(owner.session.events.filter(event => event.type === 'assistant/message').at(-1)).toMatchObject({
      data: { message: { content: [{ type: 'text', text: 'verified[资料1]' }] } },
    })
    expect(JSON.stringify(owner.session.events.filter(event => event.type === 'assistant/chunk'
      || event.type === 'assistant/message'))).not.toContain('unverified draft')
    expect(value.authorizeCitations).toHaveBeenCalledOnce()
  })

  test('ends after the second invalid draft without recording an assistant answer', async () => {
    const value = backend()
    const adapter = new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      textResponse('first invalid'),
      textResponse('second invalid'),
      textResponse('next turn'),
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
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await owner.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect(owner.session.events.filter(event => event.type === 'xagent/citation-correction')).toHaveLength(1)
    expect(owner.session.events.filter(event => event.type === 'xagent/citation-failure')).toHaveLength(1)
    expect(owner.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(JSON.stringify(owner.session.deriveMessages())).not.toContain('引用校验失败，无法提供经过验证的回答。')
    expect(owner.session.events.findLast(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error', error: { code: 'CITATION_FAILED', message: '引用校验失败，无法提供经过验证的回答。' } } },
    })
    expect(JSON.stringify(owner.session.events.filter(event => event.type === 'assistant/chunk'
      || event.type === 'assistant/message'))).not.toContain('first invalid')
    expect(JSON.stringify(owner.session.events)).not.toContain('second invalid')
    expect(value.authorizeCitations).not.toHaveBeenCalled()
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'new turn' }], source: { kind: 'user' } }))
    })
    await owner.whenIdle()
    expect(adapter.requests).toHaveLength(5)
    expect(JSON.stringify(adapter.requests.at(-1)?.messages)).not.toContain('引用校验失败，无法提供经过验证的回答。')
  })

  test('isolates concurrent retry lineages through the production retrieval service', async () => {
    const releaseOwner = Promise.withResolvers<undefined>()
    async function* blockedOwner(): AsyncIterable<StreamChunk> {
      await releaseOwner.promise
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'done' } } }
    }
    const adapter = new DeferredAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      blockedOwner,
    ])
    const created = await agentHarness(adapter)
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const protectedOptions = adapter.requests[1]
    if (protectedOptions === undefined) throw new Error('missing protected request')
    const invalid = (text: string) => collect(created.ctx.waterfall(created.ctx.llm, 'llm/stream', protectedOptions, () => source([
      { type: 'text-delta', index: 0, text },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    const [draftA, draftB] = await Promise.all([invalid('concurrent-a'), invalid('concurrent-b')])
    const failureA = draftA[0]?.type === 'finish' && draftA[0].reason.kind === 'error'
      ? draftA[0].reason.failure : undefined
    const failureB = draftB[0]?.type === 'finish' && draftB[0].reason.kind === 'error'
      ? draftB[0].reason.failure : undefined
    if (failureA === undefined || failureB === undefined) throw new Error('missing production citation failures')
    const messagesByDraft = new Map<string, GenerateOptions['messages'][number]>()
    for (const correction of created.owner.session.events.filter(event => event.type === 'xagent/citation-correction')) {
      const message = created.owner.session.events.find(event => event.seq === correction.seq + 1)
      if (message?.type === 'user/message') messagesByDraft.set(correction.data.invalidDraft, message.data)
    }
    const correctionA = messagesByDraft.get('concurrent-a')
    const correctionB = messagesByDraft.get('concurrent-b')
    if (correctionA === undefined || correctionB === undefined) throw new Error('missing production correction identities')
    const requestError = (failure: typeof failureA) => created.ctx.waterfall(created.owner as never, 'agent/request-error', {
      agent: created.owner, turn: 1, step: 2, provider: 'mock', failure,
      retryPolicy: undefined, signal: new AbortController().signal,
    }, () => Promise.resolve(undefined))
    await expect(requestError(failureA)).resolves.toEqual({ kind: 'retry' })
    await expect(requestError(failureB)).resolves.toEqual({ kind: 'retry' })

    const retryOptions = (correction: GenerateOptions['messages'][number]): GenerateOptions => ({
      ...protectedOptions, messages: [...protectedOptions.messages, correction],
    })
    const retryA = await collect(created.ctx.waterfall(created.ctx.llm, 'llm/stream', retryOptions(correctionA), () => source([
      { type: 'text-delta', index: 0, text: 'verified-a[资料1]' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    expect(retryA.some(chunk => chunk.type === 'text-delta')).toBe(true)
    const retryB = await collect(created.ctx.waterfall(created.ctx.llm, 'llm/stream', retryOptions(correctionB), () => source([
      { type: 'text-delta', index: 0, text: 'invalid-b-again' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])))
    expect(retryB).toMatchObject([{
      type: 'finish', reason: { kind: 'error', failure: { code: 'CITATION_FAILED' } },
    }])
    const terminalB = retryB[0]?.type === 'finish' && retryB[0].reason.kind === 'error'
      ? retryB[0].reason.failure : undefined
    if (terminalB === undefined) throw new Error('missing production terminal failure')
    await expect(requestError(terminalB)).resolves.toBeUndefined()
    expect(created.value.authorizeCitations).toHaveBeenCalledOnce()

    created.owner.cancel({ kind: 'user' })
    releaseOwner.resolve(undefined)
    await created.owner.whenIdle()
    await created.retrieval.dispose()
  })

  test('disposal aborts in-flight answer authorization and releases no answer chunks', async () => {
    const value = backend()
    value.authorizeCitations = vi.fn(async (
      _token: string,
      _delegation: string,
      _input: Parameters<XAgentRetrievalBackend['authorizeCitations']>[2],
      signal?: AbortSignal,
    ) => {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true })
      })
    })
    const adapter = new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      textResponse('must stay hidden[资料1]'),
    ])
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
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await vi.waitFor(() => { expect(value.authorizeCitations).toHaveBeenCalledOnce() })
    await retrieval.dispose()
    await owner.whenIdle()
    expect(JSON.stringify(owner.session.events.filter(event => event.type === 'assistant/chunk'
      || event.type === 'assistant/message'))).not.toContain('must stay hidden')
    expect(owner.session.events.filter(event => event.type === 'xagent/citation-correction')).toHaveLength(0)
  })

  test.each(['request', 'connection'] as const)('aborts protected generation when the %s lifetime ends', async (ownerKind) => {
    const requestController = new AbortController()
    const connectionController = new AbortController()
    const adapter = new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      'hang',
    ])
    const created = await agentHarness(adapter)
    const ownedScope = Object.freeze({
      ...scope(), requestSignal: requestController.signal, connectionSignal: connectionController.signal,
    })
    runWithXAgentAuthenticatedRequestScope(ownedScope, () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    ;(ownerKind === 'request' ? requestController : connectionController).abort(new Error(`${ownerKind} ended`))
    const idle = await settlesWithin(created.owner.whenIdle())
    if (!idle) created.owner.cancel({ kind: 'user' })
    expect(idle).toBe(true)
    expect(JSON.stringify(created.owner.session.events)).not.toContain('partial')
    expect(created.owner.session.events.filter(event => event.type === 'xagent/citation-correction')).toHaveLength(0)
  })

  test('connection abort during authorization cancels the backend and publishes no answer', async () => {
    const connectionController = new AbortController()
    const value = backend()
    let authorizationSignal: AbortSignal | undefined
    value.authorizeCitations = vi.fn(async (_token, _delegation, _input, signal?: AbortSignal) => {
      authorizationSignal = signal
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      })
    })
    const adapter = new MockAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      textResponse('hidden[资料1]'),
    ])
    const created = await agentHarness(adapter, value)
    runWithXAgentAuthenticatedRequestScope(Object.freeze({
      ...scope(), connectionSignal: connectionController.signal,
    }), () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await vi.waitFor(() => { expect(value.authorizeCitations).toHaveBeenCalledOnce() })
    connectionController.abort(new Error('connection ended'))
    const idle = await settlesWithin(created.owner.whenIdle())
    if (!idle) created.owner.cancel({ kind: 'user' })
    expect(idle).toBe(true)
    expect(authorizationSignal?.aborted).toBe(true)
    expect(JSON.stringify(created.owner.session.events)).not.toContain('hidden')
  })

  test.each(['tool-only', 'invalid-draft'] as const)('service disposal quiesces a protected %s stream', async (kind) => {
    const release = Promise.withResolvers<undefined>()
    let finalized = false
    async function* delayed(): AsyncIterable<StreamChunk> {
      try {
        if (kind === 'tool-only') {
          yield { type: 'tool-call-delta', index: 0, id: CallId('follow-up'), name: 'search_artifacts', argumentsDelta: '{}' }
        } else {
          yield { type: 'text-delta', index: 0, text: 'late invalid draft' }
        }
        await release.promise
        yield { type: 'finish', reason: { kind: kind === 'tool-only' ? 'tool-calls' : 'stop' } }
      } finally {
        finalized = true
      }
    }
    const adapter = new DeferredAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      delayed,
    ])
    const created = await agentHarness(adapter)
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const disposal = created.retrieval.dispose()
    const reentered = created.retrieval.dispose()
    const settled = await settlesWithin(disposal)
    const reenteredSettled = await settlesWithin(reentered)
    expect(settled).toBe(false)
    expect(reenteredSettled).toBe(false)
    expect(finalized).toBe(false)
    release.resolve(undefined)
    await Promise.all([disposal, reentered])
    await created.owner.whenIdle()
    expect(finalized).toBe(true)
    expect(JSON.stringify(created.owner.session.events)).not.toContain('late invalid draft')
    expect(JSON.stringify(created.owner.session.events)).not.toContain('follow-up')
    expect(created.owner.session.events.filter(event => event.type === 'xagent/citation-correction')).toHaveLength(0)
  })

  test('settles service ownership when a protected source throws', async () => {
    let finalized = false
    async function* throwing(): AsyncIterable<StreamChunk> {
      try {
        yield { type: 'text-delta', index: 0, text: 'must stay hidden' }
        throw new Error('source failed')
      } finally {
        finalized = true
      }
    }
    const adapter = new DeferredAdapter([
      toolCallResponse('call-search', 'search_artifacts', { query: 'evidence', project_ids: [PROJECT] }),
      throwing,
    ])
    const created = await agentHarness(adapter)
    runWithXAgentAuthenticatedRequestScope(scope(), () => {
      created.owner.followup(createUserMessage({ content: [{ type: 'text', text: 'search' }], source: { kind: 'user' } }))
    })
    await created.owner.whenIdle()
    await expect(created.retrieval.dispose()).resolves.toBeUndefined()
    expect(finalized).toBe(true)
    expect(JSON.stringify(created.owner.session.events)).not.toContain('must stay hidden')
    expect(created.owner.session.events.filter(event => event.type === 'xagent/citation-correction')).toHaveLength(0)
  })

  test('requires the pinned BGE-M3 tokenizer identity and validates the production HTTP response', async () => {
    expect(() => new XAgentRetrievalService(new Context(), backend(), new XAgentReceiptRegistry(), {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey,
    })).toThrow(/BGE-M3 tokenizer/i)
    expect(() => new XAgentRetrievalService(new Context(), backend(), new XAgentReceiptRegistry(), {
      issuer: 'xagent-host', audience: 'xagent-api', privateKey,
      tokenizer: Object.freeze({ ...tokenizer(), revision: 'wrong', count: tokenizer().count }),
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
