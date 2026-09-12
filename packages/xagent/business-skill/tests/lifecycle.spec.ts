import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SkillRegistry, { type SkillProviderObservation } from '@deepseek-ai/dsh-skill'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, test, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { entry, request, setup, transcriptResponse, claimTurn , projectId, sessionId } from './fixtures.ts'

describe('Business Skill admission and transport lifetime', () => {
  test.each([{}, { testProvider: '', testModel: 'mock' }, { testProvider: 'mock', testModel: '' },
    { testProvider: ' ', testModel: 'mock' }])('test model configuration rejects missing and blank deployment values %#', (route) => {
    expect(() => Config({ backendOrigin: 'https://backend.example', serviceToken: 'host', maxCatalogEntries: 5, ...route } as Config)).toThrow()
  })
  test('an unrelated physical request ending leaves the current message and turn owners intact', async () => {
    const h = await setup()
    h.state.catalog = [entry()]
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const owner = h.service.withRequest(request(), async () => {
      claimTurn(h.ctx, h.agent)
      const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'steering' }] })
      agentEvents(h.ctx, h.agent).emit('agent/inbox/inserted', { message })
      entered.resolve(undefined)
      await release.promise
      agentEvents(h.ctx, h.agent).emit('agent/inbox/claimed', { message, turn: 1 })
      const definition = (await h.ctx.skills.get('review', { scope: h.agent }))!
      await expect(agentEvents(h.ctx, h.agent).serial('skill/loaded', { definition, invocation: 'user-explicit' })).resolves.toBeUndefined()
    })
    await entered.promise
    try { await h.service.withRequest(request(), () => h.service.list(projectId, `session-${sessionId}`, {})) }
    finally { release.resolve(undefined); await owner; await h.ctx.fiber.dispose() }
  })

  test('discarded and unowned messages cannot later authorize a claimed turn', async () => {
    const { ctx, service, agent } = await setup()
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'queued' }] })
    try {
      agentEvents(ctx, agent).emit('agent/inbox/inserted', { message })
      await service.withRequest(request(), async () => {
        agentEvents(ctx, agent).emit('agent/inbox/inserted', { message })
        agentEvents(ctx, agent).emit('agent/inbox/discarded', { message })
        agentEvents(ctx, agent).emit('agent/inbox/claimed', { message, turn: 1 })
        expect(await ctx.skills.list({ scope: agent })).toEqual([])
      })
    } finally { await ctx.fiber.dispose() }
  })

  test('queued ownership is removed on Agent disposal and physical request settlement', async () => {
    const h = await setup()
    const other = await setup()
    const message = () => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'queued' }] })
    const own = message()
    const foreign = message()
    const later = message()
    try {
      await h.service.withRequest(request(), async () => {
        agentEvents(h.ctx, h.agent).emit('agent/inbox/inserted', { message: own })
        agentEvents(h.ctx, other.agent).emit('agent/inbox/inserted', { message: foreign })
        agentEvents(h.ctx, h.agent).emit('agent/disposed', {})
        agentEvents(h.ctx, other.agent).emit('agent/inbox/inserted', { message: later })
      })
      await h.service.withRequest(request(), async () => {
        agentEvents(h.ctx, other.agent).emit('agent/inbox/claimed', { message: later, turn: 1 })
        expect(await other.ctx.skills.list({ scope: other.agent })).toEqual([])
      })
    } finally { await other.ctx.fiber.dispose(); await h.ctx.fiber.dispose() }
  })

  test('a different live physical request cannot authorize steering into an existing turn', async () => {
    const h = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    h.state.catalog = [entry()]
    const owner = h.service.withRequest(request(), async () => {
      claimTurn(h.ctx, h.agent)
      const definition = (await h.ctx.skills.get('review', { scope: h.agent }))!
      entered.resolve(undefined)
      await release.promise
      await expect(agentEvents(h.ctx, h.agent).serial('skill/loaded', { definition, invocation: 'user-explicit' })).rejects.toThrow()
    })
    await entered.promise
    try {
      await h.service.withRequest(request(), async () => { claimTurn(h.ctx, h.agent) })
    } finally { release.resolve(undefined); await owner; await h.ctx.fiber.dispose() }
  })

  test('a request without this Agent claim cannot recover a private loaded version', async () => {
    const h = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    h.state.catalog = [entry()]
    let definition: Awaited<ReturnType<typeof h.ctx.skills.get>>
    const owner = h.service.withRequest(request(), async () => {
      h.service.attach(h.agent)
      definition = await h.ctx.skills.get('review', { scope: h.agent })
      entered.resolve(undefined)
      await release.promise
    })
    await entered.promise
    try { expect(h.service.loadedVersion(h.agent, definition!)).toBeUndefined() }
    finally { release.resolve(undefined); await owner; await h.ctx.fiber.dispose() }
  })

  test('missing Tool runtime rejects before provider registration', async () => {
    const h = await setup()
    const isolated = new Context()
    await isolated.plugin(SkillRegistry)
    let scope!: Scope
    const agent: Agent = { ...h.agent, get ctx() { return scope.ctx } }
    await isolated.plugin({ inject: ['skills'], apply: (inner: Context) => { scope = createScope(inner, agent) } })
    try {
      await expect(h.service.withRequest(request(), async () => h.service.attach(agent))).rejects.toThrow('requires the Tool runtime')
      expect(await isolated.skills.list({ scope: agent })).toEqual([])
    } finally { await isolated.fiber.dispose(); await h.ctx.fiber.dispose() }
  })

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid catalog bound %s at installation', async (maxCatalogEntries) => {
    const ctx = new Context()
    try {
      expect(() => { apply(ctx, { backendOrigin: 'https://backend.example', serviceToken: 'host', maxCatalogEntries, testProvider: 'mock', testModel: 'mock' }) }).toThrow('positive safe integer')
    } finally { await ctx.fiber.dispose() }
  })

  test('configured plugin forwards only the physical request token to the configured backend', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const requests: { url: string; token: string | null }[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: input instanceof Request ? input.url : String(input), token: new Headers(init?.headers).get('authorization') })
      return Response.json({ schema_version: 1, items: [], next_cursor: null })
    })
    try {
      apply(ctx, { backendOrigin: 'https://configured.example', serviceToken: 'host', maxCatalogEntries: 5, testProvider: 'mock', testModel: 'mock' })
      expect(await ctx.xagentBusinessSkill.withRequest(request(), () => ctx.xagentBusinessSkill.list(projectId, `session-${sessionId}`, {}))).toEqual({ items: [] })
      expect(requests).toEqual([{ url: 'https://configured.example/internal/xagent/business-skills/projects/00000000-0000-0000-0000-000000000201/list', token: 'Bearer alice-token' }])
    } finally { fetch.mockRestore(); await ctx.fiber.dispose() }
  })

  test('a different persistence provider does not install the isolated backend executor', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    try {
      ctx.provide('sessionPersistence', {})
      apply(ctx, { backendOrigin: 'https://configured.example', serviceToken: 'host', maxCatalogEntries: 5,
        testProvider: 'mock', testModel: 'mock' })
      await ctx.plugin({ apply: () => {} })
      await expect(ctx.xagentBusinessSkill.withRequest(request(), () => ctx.xagentBusinessSkill.test(projectId, `session-${sessionId}`, 'review', {
        expectedDraftRevision: 1, toolPolicyDigest: 'a'.repeat(64), scenario: 'Read', idempotencyKey: 'test',
      }))).rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
    } finally { await ctx.fiber.dispose() }
  })

  test('rejects a second live physical request attempting to replace the same Agent owner', async () => {
    const { ctx, service, agent } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const owner = service.withRequest(request(), async () => { service.attach(agent); entered.resolve(undefined); await release.promise })
    await entered.promise
    try {
      await expect(service.withRequest(request(), async () => service.attach(agent))).rejects.toMatchObject({ failure: { code: 'business-skill-conflict' } })
    } finally { release.resolve(undefined); await owner; await ctx.fiber.dispose() }
  })

  test('an Agent disposal event removes observation ownership before further loads', async () => {
    const { ctx, service, agent, state } = await setup()
    state.catalog = [entry()]
    await service.withRequest(request(), async () => {
      const provider = service.attach(agent)!
      const candidate = (await provider.list({}) as SkillProviderObservation).candidates[0]!
      agentEvents(ctx, agent).emit('agent/disposed', {})
      expect(await provider.get(candidate, {})).toBeUndefined()
      expect(await ctx.skills.list({ scope: agent })).toEqual([])
      expect(service.attach(agent)).toBeUndefined()
    })
    await ctx.fiber.dispose()
  })

  test('missing Agent-local registry is reported before installing a provider', async () => {
    const { ctx, service, agent } = await setup()
    const isolated = new Context()
    let scope!: Scope
    const other: Agent = { ...agent, get ctx() { return scope.ctx } }
    await isolated.plugin({ apply: (inner: Context) => { scope = createScope(inner, other) } })
    try {
      await expect(service.withRequest(request(), async () => service.attach(other))).rejects.toThrow('requires the Skill registry')
    } finally { await isolated.fiber.dispose(); await ctx.fiber.dispose() }
  })

  test('sorted observations retain only public fields when the backend orders slugs ascending', async () => {
    const { ctx, service, agent, state } = await setup()
    state.catalog = [entry('a-review'), entry('z-review')]
    await service.withRequest(request(), async () => {
      service.attach(agent)
      expect((await ctx.skills.list({ scope: agent })).map(row => row.name)).toEqual(['a-review', 'z-review'])
    })
    await ctx.fiber.dispose()
  })

  test('transcript projects nested JSON and rejects a wire number that overflows JSON storage', async () => {
    const { ctx, service, state } = await setup()
    await service.withRequest(request(), async () => {
      state.response = transcriptResponse('{"text":"Approved body","meta":[1,true,null]}')
      expect((await service.transcript(projectId, `session-${sessionId}`, 'review', 1, {})).events).toEqual([{
        sequence: 0, eventType: 'message', payload: { text: 'Approved body', meta: [1, true, null] }, createdAt: '2026-09-12T00:00:00Z',
      }])
      state.response = transcriptResponse('{"overflow":1e400}')
      await expect(service.transcript(projectId, `session-${sessionId}`, 'review', 1, {})).rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
    })
    await ctx.fiber.dispose()
  })

  test('unexpected transport failure returns a stable error without its private message', async () => {
    const { ctx, service, state } = await setup()
    state.beforeResponse = async () => { throw new Error('private host endpoint') }
    await expect(service.withRequest(request(), () => service.list(projectId, `session-${sessionId}`, {}))).rejects.toMatchObject({ failure: { code: 'service-unavailable', details: {} } })
    await ctx.fiber.dispose()
  })

  test('request teardown waits for detached transport and discards its late rejection', async () => {
    const { ctx, service, agent, state } = await setup()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    state.beforeResponse = async (_path, signal) => {
      entered.resolve(signal!)
      await release.promise
      throw new Error('late private transport error')
    }
    let result!: Promise<unknown>
    let settled = false
    const owner = service.withRequest(request(), async () => {
      const provider = service.attach(agent)!
      result = provider.list({}).catch((error: unknown) => error)
      await entered.promise
    }).then(() => { settled = true })
    const signal = await entered.promise
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(signal.aborted).toBe(true)
      expect(settled).toBe(false)
    } finally { release.resolve(undefined); await owner }
    expect(await result).toBe(signal.reason)
    await ctx.fiber.dispose()
  })

  test('unexposed backend codes and executor exceptions do not expose internal failures', async () => {
    const { ctx, service, state } = await setup()
    state.response = Response.json({ detail: { code: 'business-skill-cancelled' } }, { status: 409 })
    await service.withRequest(request(), async () => {
      await expect(service.list(projectId, `session-${sessionId}`, {})).rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
      service.registerTestRunner({ run: async () => { throw new Error('private runner credentials') } })
      await expect(service.test(projectId, `session-${sessionId}`, 'review', { expectedDraftRevision: 1, toolPolicyDigest: 'b'.repeat(64), scenario: 'Read', idempotencyKey: 'failure' }))
        .rejects.toMatchObject({ failure: { code: 'service-unavailable', details: {} } })
    })
    await ctx.fiber.dispose()
  })
})
