import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { SkillProviderObservation } from '@deepseek-ai/dsh-skill'
import { describe, expect, test, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { entry, request, setup, transcriptResponse } from './fixtures.ts'

describe('Business Skill admission and transport lifetime', () => {
  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid catalog bound %s at installation', async (maxCatalogEntries) => {
    const ctx = new Context()
    try {
      expect(() => { apply(ctx, { backendOrigin: 'https://backend.example', serviceToken: 'host', maxCatalogEntries }) }).toThrow('positive safe integer')
    } finally { await ctx.fiber.dispose() }
  })

  test('configured plugin forwards only the physical request token to the configured backend', async () => {
    const ctx = new Context()
    const requests: { url: string; token: string | null }[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: input instanceof Request ? input.url : String(input), token: new Headers(init?.headers).get('authorization') })
      return Response.json({ schema_version: 1, items: [], next_cursor: null })
    })
    try {
      apply(ctx, { backendOrigin: 'https://configured.example', serviceToken: 'host', maxCatalogEntries: 5 })
      expect(await ctx.xagentBusinessSkill.withRequest(request(), () => ctx.xagentBusinessSkill.list({}))).toEqual({ items: [] })
      expect(requests).toEqual([{ url: 'https://configured.example/internal/xagent/business-skills/projects/00000000-0000-0000-0000-000000000201/list', token: 'Bearer alice-token' }])
    } finally { fetch.mockRestore(); await ctx.fiber.dispose() }
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
      expect((await service.transcript('review', 1, {})).events).toEqual([{
        sequence: 0, eventType: 'message', payload: { text: 'Approved body', meta: [1, true, null] }, createdAt: '2026-09-12T00:00:00Z',
      }])
      state.response = transcriptResponse('{"overflow":1e400}')
      await expect(service.transcript('review', 1, {})).rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
    })
    await ctx.fiber.dispose()
  })

  test('unexpected transport failure returns a stable error without its private message', async () => {
    const { ctx, service, state } = await setup()
    state.beforeResponse = async () => { throw new Error('private host endpoint') }
    await expect(service.withRequest(request(), () => service.list({}))).rejects.toMatchObject({ failure: { code: 'service-unavailable', details: {} } })
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
      await expect(service.list({})).rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
      service.registerTestRunner({ run: async () => { throw new Error('private runner credentials') } })
      await expect(service.test('review', { expectedDraftRevision: 1, toolPolicyDigest: 'b'.repeat(64), scenario: 'Read', idempotencyKey: 'failure' }))
        .rejects.toMatchObject({ failure: { code: 'service-unavailable', details: {} } })
    })
    await ctx.fiber.dispose()
  })
})
