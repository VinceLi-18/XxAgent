import { agentEvents } from '@deepseek-ai/dsh-agent'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { renderSkillContent, type SkillProviderObservation } from '@deepseek-ai/dsh-skill'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { XAgentAuthenticatedSessionRequestScope } from '@xagent/dsh-principal'
import { describe, expect, test } from 'vitest'
import { setup, request, entry, loaded, projectId, sessionId, versionKey, version2, signal, testRecord, claimTurn } from './fixtures.ts'

describe('governed Business Skill provider', () => {
  test('concurrent registry loads retain their own authoritative observation', async () => {
    const { ctx, service, agent, state, calls } = await setup()
    state.catalog = [entry()]
    await service.withRequest(request(), async () => {
      service.attach(agent)
      const results = await Promise.allSettled([ctx.skills.get('review', { scope: agent }), ctx.skills.get('review', { scope: agent })])
      expect(results).toMatchObject([
        { status: 'fulfilled', value: { name: 'review', content: 'Read the project evidence before answering.' } },
        { status: 'fulfilled', value: { name: 'review', content: 'Read the project evidence before answering.' } },
      ])
      expect(calls.filter(call => call.path.endsWith('/runtime/load'))).toHaveLength(2)
    })
    await ctx.fiber.dispose()
  })

  test('concurrent skill tools both load through independently authorized observations', async () => {
    const { ctx, service, agent, state } = await setup()
    state.catalog = [entry()]
    await service.withRequest(request(), async () => {
      claimTurn(ctx, agent)
      service.attach(agent)
      const results = await Promise.all(['one', 'two'].map(id => ctx.tools.execute({
        name: 'skill', arguments: { name: 'review' }, agent, signal, callId: CallId(id),
      })))
      expect(results.map(result => result.isError)).toEqual([false, false])
      expect(results[0]?.content).toEqual(results[1]?.content)
    })
    await ctx.fiber.dispose()
  })

  test('refresh leaves an in-flight exact-version load owned by its original observation', async () => {
    const { ctx, service, agent, state } = await setup()
    state.catalog = [entry()]
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    state.beforeResponse = async (path) => {
      if (path.endsWith('/runtime/load')) { entered.resolve(undefined); await release.promise }
    }
    await service.withRequest(request(), async () => {
      const provider = service.attach(agent)!
      const pending = ctx.skills.get('review', { scope: agent })
      const result = expect(pending).resolves.toMatchObject({ content: 'Read the project evidence before answering.' })
      await entered.promise
      state.catalog = [entry('review', 2, version2)]
      try { expect((await provider.list({}) as SkillProviderObservation).candidates).toHaveLength(1) }
      finally { release.resolve(undefined) }
      await result
    })
    await ctx.fiber.dispose()
  })

  test.each(['catalog', 'load'])('Agent disposal aborts and waits for its in-flight %s transport', async (endpoint) => {
    const { ctx, service, agent, state, scope } = await setup()
    state.catalog = [entry()]
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    state.beforeResponse = async (path, transportSignal) => {
      if (!path.endsWith(`/runtime/${endpoint}`)) return
      entered.resolve(transportSignal!)
      await release.promise
    }
    await service.withRequest(request(), async () => {
      service.attach(agent)
      const pending = ctx.skills.get('review', { scope: agent }).then(value => ({ value }), (error: unknown) => ({ error }))
      const transportSignal = await entered.promise
      let disposed = false
      const closing = Promise.resolve(scope.dispose()).then(() => { disposed = true })
      try {
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(transportSignal.aborted).toBe(true)
        expect(disposed).toBe(false)
      } finally { release.resolve(undefined); await closing }
      expect(await pending).not.toHaveProperty('value.name')
      if (endpoint === 'load') expect(await pending).toHaveProperty('error')
      expect(service.attach(agent)).toBeUndefined()
    })
    await ctx.fiber.dispose()
  })

  test('strict backend version-change conflicts retain their stable public error code', async () => {
    const { ctx, service, agent, state } = await setup()
    state.catalog = [entry()]
    await service.withRequest(request(), async () => {
      const provider = service.attach(agent)!
      const [candidate] = (await provider.list({}) as SkillProviderObservation).candidates
      state.failure = 'business-skill-version-changed'
      await expect(provider.get(candidate!, {})).rejects.toMatchObject({ failure: { code: 'business-skill-version-changed' } })
    })
    await ctx.fiber.dispose()
  })

  test('the Gateway discovers the explicit binding and invokes only request-authorized Remotes', async () => {
    const { ctx, service, calls } = await setup()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGateway)
    const invoke = () => ctx.typertGateway.invoke({ namespace: 'xagentBusinessSkill', method: 'list', args: { input: { limit: 3 } } })
    await expect(invoke()).rejects.toThrow()
    expect(calls).toEqual([])
    await expect(service.withRequest(request(), invoke)).resolves.toEqual({ items: [] })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.token).toBe('alice-token')
    expect(calls[0]?.body).toEqual({ schema_version: 1, limit: 3 })
    await expect(ctx.typertGateway.invoke({ namespace: 'xagentBusinessSkill', method: 'withRequest', args: {} })).rejects.toThrow()
    await ctx.fiber.dispose()
  })
  test('a duplicate provider cannot replace the registered owner', async () => {
    const { ctx, agent, service } = await setup()
    const registry = agent.ctx.get('skills')!
    const remove = registry.registerProvider(() => ({ name: 'xagent-project', list: async () => [], get: async () => undefined }))
    await expect(service.withRequest(request(), async () => service.attach(agent))).rejects.toThrow(/already registered/)
    remove()
    await service.withRequest(request(), async () => {
      const provider = service.attach(agent)
      expect(service.attach(agent)).toBe(provider)
      expect(await ctx.skills.list({ scope: agent })).toHaveLength(2)
    })
    await ctx.fiber.dispose()
  })

  test('repeat loads reject changed content for the same immutable version', async () => {
    const { ctx, service, agent, state } = await setup()
    state.catalog = [entry()]
    await service.withRequest(request(), async () => {
      service.attach(agent)
      const definition = (await ctx.skills.get('review', { scope: agent }))!
      expect(service.loadedVersion(agent, { ...definition })).toBeUndefined()
      expect(Object.isFrozen(service.loadedVersion(agent, definition)?.completeTools)).toBe(true)
      state.load = { ...loaded(), instructions: 'Changed immutable body' }
      await expect(ctx.skills.get('review', { scope: agent })).rejects.toThrow()
    })
    await ctx.fiber.dispose()
  })

  test('disposed Agent scopes cannot be attached again', async () => {
    const { ctx, agent, scope, service } = await setup()
    await service.withRequest(request(), async () => {
      service.attach(agent)
      await scope.dispose()
      expect(service.attach(agent)).toBeUndefined()
    })
    await ctx.fiber.dispose()
  })

  test('service disposal waits for an in-flight backend read and discards its result', async () => {
    const { ctx, service, state } = await setup()
    const release = Promise.withResolvers<undefined>()
    state.wait = release.promise
    const pending = service.withRequest(request(), () => service.list({}))
    const rejection = expect(pending).rejects.toThrow()
    let disposed = false
    const closing = Promise.resolve(ctx.fiber.dispose()).then(() => { disposed = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(disposed).toBe(false)
    } finally {
      release.resolve(undefined)
      await closing
      await rejection
    }
  })

  test('a concurrent read outside the physical request cannot reuse its Agent catalog', async () => {
    const { ctx, service, agent } = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const pending = service.withRequest(request(), async () => {
      service.attach(agent)
      expect(await ctx.skills.list({ scope: agent })).toHaveLength(2)
      entered.resolve(undefined)
      await release.promise
    })
    await entered.promise
    try {
      expect(await ctx.skills.list({ scope: agent })).toEqual([])
    } finally { release.resolve(undefined); await pending; await ctx.fiber.dispose() }
  })
  test('only an active authenticated conversation request exposes an Agent catalog', async () => {
    const { ctx, service, agent } = await setup()
    expect(service.attach(agent)).toBeUndefined()
    expect(await ctx.skills.list({ scope: agent })).toEqual([])
    await service.withRequest(request(), async () => {
      expect(service.attach(agent)).toBeDefined()
      expect((await ctx.skills.list({ scope: agent })).map(row => row.name)).toEqual(['a-review', 'z-review'])
      expect(await ctx.skills.list()).toEqual([])
    })
    expect(await ctx.skills.list({ scope: agent })).toEqual([])
    await ctx.fiber.dispose()
  })

  test.each([
    { visibility: 'private', projectId: null }, { purpose: 'business_skill_test' },
    { requestSignal: undefined }, { connectionSignal: undefined },
    { requestSignal: AbortSignal.abort() }, { connectionSignal: AbortSignal.abort() },
  ] as Partial<XAgentAuthenticatedSessionRequestScope>[])('denies ineligible physical scope %#', async (overrides) => {
    const { ctx, service, agent, calls } = await setup()
    await expect(service.withRequest(request(overrides), async () => service.attach(agent))).rejects.toThrow()
    expect(await ctx.skills.list({ scope: agent })).toEqual([])
    expect(calls).toEqual([])
    await ctx.fiber.dispose()
  })

  test('rejects a different Session and removes registration at cancellation and disposal', async () => {
    const { ctx, service, agent, scope } = await setup()
    const controller = new AbortController()
    await service.withRequest(request({ sessionId: '00000000-0000-0000-0000-000000000999' }), async () => {
      expect(service.attach(agent)).toBeUndefined()
    })
    await expect(service.withRequest(request({ requestSignal: controller.signal }), async () => {
      service.attach(agent)
      expect(await ctx.skills.list({ scope: agent })).toHaveLength(2)
      controller.abort()
      expect(await ctx.skills.list({ scope: agent })).toEqual([])
    })).rejects.toThrow()
    await service.withRequest(request(), async () => {
      service.attach(agent)
      await scope.dispose()
      expect(await ctx.skills.list({ scope: agent })).toEqual([])
    })
    await ctx.fiber.dispose()
    await expect(service.withRequest(request(), async () => undefined)).rejects.toThrow()
  })

  test('catalog is deterministic, bounded and public while exact locators remain owner-bound', async () => {
    const { ctx, service, agent, state } = await setup(2)
    state.catalog = [entry()]
    await service.withRequest(request(), async () => {
      const provider = service.attach(agent)!
      const rows = (await provider.list({}) as SkillProviderObservation).candidates
      const candidate = rows[0]!
      expect(await provider.get({ ...candidate, locator: { ...candidate.locator as object } }, {})).toBeUndefined()
      expect(await provider.get({ ...candidate, name: 'other' }, {})).toBeUndefined()
      const definition = await provider.get(candidate, {})
      expect(definition?.content).toBe('Read the project evidence before answering.')
      expect(JSON.stringify(definition)).not.toContain(versionKey)
      expect(renderSkillContent(definition!)).not.toContain(versionKey)
      expect(service.loadedVersion(agent, definition!)).toMatchObject({ slug: 'review', versionNumber: 1, versionKey })
      expect(await ctx.skills.list({ scope: agent })).toEqual([{
        name: 'review', description: 'Review project evidence.', provider: 'xagent-project', source: 'xagent-project',
        invocation: { modelInvocable: true, userInvocable: true },
      }])
      expect(await provider.get(candidate, {})).toMatchObject({ content: 'Read the project evidence before answering.' })
    })
    state.catalog = [entry('a'), entry('b'), entry('c')]
    await service.withRequest(request(), async () => {
      const provider = service.attach(agent)!
      await expect(provider.list({})).rejects.toThrow()
    })
    await ctx.fiber.dispose()
  })

  test.each([
    [entry(), entry()], [{ ...entry(), internal_id: versionKey }], [{ ...entry(), slug: 'Bad Name' }],
  ])('rejects ambiguous or malformed backend catalogs %#', async (...rows) => {
    const { ctx, service, agent, state } = await setup()
    state.catalog = rows
    await service.withRequest(request(), async () => {
      const provider = service.attach(agent)!
      await expect(provider.list({})).rejects.toThrow()
    })
    await ctx.fiber.dispose()
  })

  test('refresh replaces current version and rejects mismatched or unavailable exact loads', async () => {
    const { ctx, service, agent, state, calls } = await setup()
    state.catalog = [entry()]
    await service.withRequest(request(), async () => {
      const provider = service.attach(agent)!
      const [first] = (await provider.list({}) as SkillProviderObservation).candidates
      state.load = { ...loaded(), version_number: 2, version_key: version2 }
      await expect(provider.get(first!, {})).rejects.toThrow()
      state.catalog = [entry('review', 2, version2)]
      const [second] = (await provider.list({}) as SkillProviderObservation).candidates
      await expect(provider.get(first!, {})).rejects.toThrow()
      expect(await provider.get(second!, {})).toMatchObject({ name: 'review' })
      expect(calls.at(-1)?.body).toMatchObject({ session_id: sessionId, slug: 'review', version_key: version2 })
      state.failure = 'business-skill-not-authorized'
      await expect(provider.get(second!, {})).rejects.toThrow()
      await expect(provider.list({})).rejects.toThrow()
    })
    await ctx.fiber.dispose()
  })

  test('the generic skill tool and slash gesture render the same owned definition', async () => {
    const { ctx, service, agent, state } = await setup()
    state.catalog = [entry()]
    await service.withRequest(request(), async () => {
      claimTurn(ctx, agent)
      service.attach(agent)
      const result = await ctx.tools.execute({ name: 'skill', arguments: { name: 'review' }, agent, signal, callId: CallId('load') })
      const message = createUserMessage({ content: [{ type: 'text', text: '/review' }], source: { kind: 'user' } })
      const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
        messages: [message], turn: 1, step: 1, signal,
      }, async () => ({ kind: 'enter' as const, messages: [message] }))
      expect(result.isError).toBe(false)
      expect(decision.kind).toBe('enter')
      if (decision.kind === 'enter') {
        const body = decision.messages.find(row => row.source.kind === 'skill-invocation')
        expect(body?.content).toEqual(result.content)
        expect(JSON.stringify(decision)).not.toContain(versionKey)
      }
    })
    await ctx.fiber.dispose()
  })
})

describe('Business Skill governance Remote', () => {
  test('the dedicated test runner receives public fields and unload disables further starts', async () => {
    const { ctx, service, calls } = await setup()
    const seen: unknown[] = []
    const dispose = service.registerTestRunner({ run: async (slug, input, signal) => {
      seen.push({ slug, scenario: input.scenario, cancelled: signal.aborted })
      return testRecord
    } })
    expect(() => service.registerTestRunner({ run: async () => testRecord })).toThrow(/already registered/)
    const input = { expectedDraftRevision: 1, toolPolicyDigest: 'b'.repeat(64), scenario: 'Read', idempotencyKey: 'test' }
    await service.withRequest(request(), async () => {
      expect(await service.test('review', input)).toEqual(testRecord)
      expect(await service.transcript('review', 1, { limit: 10, afterSequence: 0 })).toMatchObject({ test: testRecord, events: [], nextSequence: 0 })
      dispose()
      await expect(service.test('review', input)).rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
    })
    expect(seen).toEqual([{ slug: 'review', scenario: 'Read', cancelled: false }])
    expect(calls.map(call => call.path.split(`${projectId}/`)[1])).toEqual(['review/tests/1/transcript'])
    expect(calls[0]?.body).toEqual({ schema_version: 1, after_sequence: 0, limit: 10 })
    await ctx.fiber.dispose()
  })

  test('maps every governance method through only the physical token and project', async () => {
    const { ctx, service, calls } = await setup()
    await service.withRequest(request(), async () => {
      await service.list({})
      await service.detail('review', {})
      await service.create({ slug: 'review', displayName: 'Review', description: 'Review evidence', instructions: 'Read it', primaryTools: [], idempotencyKey: 'create' })
      await service.draft('review', { expectedDraftRevision: 1, instructions: 'Read again', idempotencyKey: 'draft' })
      await service.publish('review', 1, 'publish')
      await service.authorization('review', true, 'authorize')
      await service.version('review', 1, 'version')
      await service.verdict('review', 1, 'pass', 'verdict')
      await service.retire('review', 'retire')
      await expect(service.test('review', { expectedDraftRevision: 1, toolPolicyDigest: 'a'.repeat(64), scenario: 'Read', idempotencyKey: 'test' })).rejects.toMatchObject({ failure: { code: 'service-unavailable' } })
    })
    expect(calls.map(call => call.path.split(`${projectId}/`)[1])).toEqual([
      'list', 'review/detail', 'create', 'review/draft', 'review/publish', 'review/authorization',
      'review/current-version', 'review/tests/1/verdict', 'review/retire',
    ])
    expect(calls.every(call => call.token === 'alice-token')).toBe(true)
    expect(remoteMethods(service).map(method => method.method)).toEqual([
      'list', 'detail', 'create', 'draft', 'test', 'transcript', 'verdict', 'publish', 'authorization', 'version', 'retire',
    ])
    await ctx.fiber.dispose()
  })

  test('expired descendants cannot reuse the request and concurrent requests retain their tokens', async () => {
    const { ctx, service, calls } = await setup()
    const release = Promise.withResolvers<undefined>()
    let late!: Promise<unknown>
    await service.withRequest(request(), async () => { late = release.promise.then(() => service.list({})) })
    release.resolve(undefined)
    await expect(late).rejects.toThrow()
    await Promise.all([
      service.withRequest(request(), () => service.list({})),
      service.withRequest(request({ userToken: 'bob-token' }), () => service.list({})),
    ])
    expect(calls.map(call => call.token)).toEqual(['alice-token', 'bob-token'])
    await expect(service.list({})).rejects.toThrow()
    await expect(service.withRequest(request(), () => service.withRequest(request(), async () => undefined))).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  test('stable errors reveal no backend details and cancellation discards a late response', async () => {
    const { ctx, service, state } = await setup()
    state.failure = 'business-skill-retired'
    await expect(service.withRequest(request(), () => service.list({}))).rejects.toMatchObject({ failure: { code: 'business-skill-retired', details: {} } })
    state.failure = undefined
    const release = Promise.withResolvers<undefined>()
    state.wait = release.promise
    const controller = new AbortController()
    const pending = service.withRequest(request({ requestSignal: controller.signal }), () => service.list({}))
    controller.abort()
    release.resolve(undefined)
    await expect(pending).rejects.toThrow()
    await ctx.fiber.dispose()
  })
})
