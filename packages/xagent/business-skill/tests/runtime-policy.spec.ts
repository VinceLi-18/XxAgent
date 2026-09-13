import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, test, vi } from 'vitest'
import { setup, request, entry, loaded, signal, version2, versionKey } from './fixtures.ts'

const digest = '0467a4190459f1d238addecd96a8d71b30690ac22d74add2d46751f5e1dcdc25'
const body = '\r\n# Procedure\n\nRead **exactly** this body.  \n'

async function fixture() {
  const h = await setup()
  h.state.catalog = [entry()]
  h.state.load = { ...loaded(), instructions: body, tool_policy_digest: digest,
    complete_tools: ['search_artifacts', 'skill', 'submit_cited_answer'] }
  const effects: string[] = []
  const execution = { fail: false }
  for (const name of ['search_artifacts', 'submit_cited_answer', 'propose_fact', 'unrelated']) {
    const ctx = name === 'search_artifacts' ? h.ctx : h.agent.ctx
    ctx.get('tools')!.register(defineTool({ name, description: name, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: async () => { effects.push(name); if (execution.fail) throw new Error('Tool failed'); return 'done' },
    }))
  }
  return { ...h, effects, execution }
}

function claim(ctx: Awaited<ReturnType<typeof fixture>>['ctx'], agent: Agent, turn: number, text = 'Review') {
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  agent.session.append('turn/start', { turn })
  agentEvents(ctx, agent).emit('agent/inbox/inserted', { message })
  agentEvents(ctx, agent).emit('agent/inbox/claimed', { message, turn })
  return message
}

async function load(h: Awaited<ReturnType<typeof setup>>, name = 'review', id = 'load') {
  h.service.attach(h.agent)
  return h.ctx.tools.execute({ name: 'skill', arguments: { name }, agent: h.agent, signal, callId: CallId(id) })
}

describe('Business Skill turn policy', () => {
  test('request settlement retains dispatch security until final turn end without awaiting future dispatch', async () => {
    const h = await fixture()
    const physical = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const before = h.agent.ctx.on('tools/execute', async (exec, next) => {
      if (exec.name === 'search_artifacts') { entered.resolve(undefined); await release.promise }
      return await next()
    })
    let pending: Promise<unknown> | undefined
    try {
      await expect(h.service.withRequest(request({ requestSignal: physical.signal }), async () => {
        claim(h.ctx, h.agent, 1)
        await load(h)
        pending = h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent, signal, callId: CallId('delayed') })
          .then((result) => { expect(result.isError).toBe(true) })
        await entered.promise
        physical.abort()
      })).rejects.toThrow()
      release.resolve(undefined)
      await pending
      before()
      expect((await h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent, signal, callId: CallId('after-request') })).isError).toBe(true)
      expect(h.effects).toEqual([])
      h.agent.session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
      expect((await h.ctx.tools.execute({ name: 'unrelated', arguments: {}, agent: h.agent, signal, callId: CallId('after-end') })).isError).toBe(false)
      expect(h.effects).toEqual(['unrelated'])
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 2)
        expect((await load(h)).isError).toBe(false)
        expect((await h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent, signal, callId: CallId('next-turn') })).isError).toBe(false)
      })
    } finally { release.resolve(undefined); await pending; await h.ctx.fiber.dispose() }
  })
  test.each(['allow', 'reject', 'never'] as const)('request cancellation settles before a %s late approval without running the body', async (late) => {
    const h = await fixture()
    await h.ctx.plugin(ApprovalService)
    const physical = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<ApprovalOutcome>()
    const closeAnswerer = h.ctx.on('approval/request', async () => { entered.resolve(undefined); return await answer.promise })
    try {
      await expect(h.service.withRequest(request({ requestSignal: physical.signal }), async () => {
        claim(h.ctx, h.agent, 1)
        await load(h)
        h.agent.ctx.on('tools/pre-execute', async () => ({ kind: 'ask' }))
        let settled = false
        const pending = h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent, signal, callId: CallId('approval') })
          .then((result) => { settled = true; return result })
        await entered.promise
        physical.abort()
        await vi.waitFor(() => { expect(settled).toBe(true) }, { timeout: 500 })
        if (late === 'allow') answer.resolve('allowed-once')
        if (late === 'reject') answer.reject(new Error('Late answerer failure'))
        expect((await pending).isError).toBe(true)
      })).rejects.toThrow()
      expect(h.effects).toEqual([])
      await new Promise<undefined>(resolve => setImmediate(() => { resolve(undefined) }))
      expect(h.agent.session.events.filter(event => event.type === 'approval/decided').map(event => event.data.outcome)).toEqual(['cancelled'])
      closeAnswerer()
      h.ctx.on('approval/request', async () => 'allowed-once')
      h.agent.session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
      h.agent.session.append('turn/start', { turn: 2 })
      expect(await h.ctx.approval.request({ agent: h.agent, toolName: 'outside-request', signal })).toBe('allowed-once')
    } finally { await h.ctx.fiber.dispose() }
  })
  test('approval delegation observes cancellation that precedes its callback without changing readonly input', async () => {
    const h = await fixture()
    await h.ctx.plugin(ApprovalService)
    const physical = new AbortController()
    const answerer = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once')
    h.ctx.on('approval/request', answerer)
    try {
      await expect(h.service.withRequest(request({ requestSignal: physical.signal }), async () => {
        claim(h.ctx, h.agent, 1)
        await load(h)
        h.agent.ctx.on('approval/request', async (_req, next) => { physical.abort(); return await next() }, { prepend: true })
        const input = Object.freeze({ agent: h.agent, toolName: 'search_artifacts', signal })
        expect(await h.ctx.approval.request(input)).toBe('cancelled')
        expect(input.signal).toBe(signal)
        expect(answerer).toHaveBeenCalledOnce()
      })).rejects.toThrow()
    } finally { await h.ctx.fiber.dispose() }
  })
  test.each(['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const)('delegates normal approval outcome %s without changing it', async (outcome) => {
    const h = await fixture()
    await h.ctx.plugin(ApprovalService)
    const answerer = vi.fn(async (): Promise<ApprovalOutcome> => outcome)
    h.ctx.on('approval/request', answerer)
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        expect(await h.ctx.approval.request({ agent: h.agent, toolName: 'skill', signal })).toBe(outcome)
        await load(h)
        h.agent.ctx.on('tools/pre-execute', async () => ({ kind: 'ask' }))
        const result = await h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent, signal, callId: CallId('approval') })
        expect(result.isError).toBe(outcome !== 'allowed-once')
        expect(h.effects).toEqual(outcome === 'allowed-once' ? ['search_artifacts'] : [])
        expect(answerer).toHaveBeenCalledTimes(2)
      })
    } finally { await h.ctx.fiber.dispose() }
  })
  test.each(['scope', 'root'] as const)('%s disposal settles a running tool without its result listener', async (owner) => {
    const h = await setup()
    h.state.catalog = [entry()]
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    let bodySettled = false
    h.agent.ctx.get('tools')!.register(defineTool({ name: 'propose_fact', description: 'Deferred proposal', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: async (_args, exec) => {
        entered.resolve(exec.signal)
        try { await release.promise; return 'done' } finally { bodySettled = true }
      },
    }))
    h.state.load = { ...loaded(), complete_tools: ['propose_fact', 'skill'],
      tool_policy_digest: 'c586fd2330e52b02fbf91ffc847afbc2404f43c1a87685afbc59efa77834ef51' }
    let toolSettled = false
    let requestSettled = false
    const pending = h.service.withRequest(request(), async () => {
      claim(h.ctx, h.agent, 1)
      expect((await load(h)).isError).toBe(false)
      await h.ctx.tools.execute({ name: 'propose_fact', arguments: {}, agent: h.agent, signal, callId: CallId('deferred') })
      toolSettled = true
    }).catch((error: unknown) => { expect(error).toMatchObject({ failure: { code: 'unauthenticated' } }) })
      .finally(() => { requestSettled = true })
    const executionSignal = await entered.promise
    let disposed = false
    const closing = (owner === 'scope' ? h.scope.dispose() : Promise.resolve(h.ctx.fiber.dispose())).then(() => { disposed = true })
    await vi.waitFor(() => { expect(executionSignal.aborted).toBe(true) })
    release.resolve(undefined)
    await vi.waitFor(() => {
      expect({ bodySettled, toolSettled, requestSettled, disposed })
        .toEqual({ bodySettled: true, toolSettled: true, requestSettled: true, disposed: true })
    }, { timeout: 500 })
    await Promise.all([pending, closing])
    await h.ctx.fiber.dispose()
  })
  test('request closure during an unbound assembly leaves ordinary tools intact', async () => {
    const h = await fixture()
    const physical = new AbortController()
    try {
      await expect(h.service.withRequest(request({ requestSignal: physical.signal }), async () => {
        claim(h.ctx, h.agent, 1)
        h.agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
          const result = await next()
          physical.abort()
          return result
        })
        expect((await h.ctx.systemPrompt.assemble({ scope: h.agent })).tools.map(tool => tool.name)).toContain('unrelated')
      })).rejects.toMatchObject({ failure: { code: 'unauthenticated' } })
    } finally { await h.ctx.fiber.dispose() }
  })
  test('an in-flight assembly cannot mutate its tool array after physical request disposal begins', async () => {
    const h = await fixture()
    const physical = new AbortController()
    const authEntered = Promise.withResolvers<undefined>()
    const authRelease = Promise.withResolvers<undefined>()
    const assemblyEntered = Promise.withResolvers<undefined>()
    const assemblyRelease = Promise.withResolvers<undefined>()
    let originalTools: readonly { readonly name: string }[] | undefined
    try {
      await expect(h.service.withRequest(request({ requestSignal: physical.signal }), async () => {
        claim(h.ctx, h.agent, 1)
        await load(h)
        h.state.beforeResponse = async (path) => {
          if (path.endsWith('/authorize-tool')) { authEntered.resolve(undefined); await authRelease.promise }
        }
        const executing = h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent, signal, callId: CallId('pending') })
        await authEntered.promise
        h.agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
          const result = await next()
          originalTools = result.tools
          assemblyEntered.resolve(undefined)
          await assemblyRelease.promise
          return result
        })
        const assembling = h.ctx.systemPrompt.assemble({ scope: h.agent })
        await assemblyEntered.promise
        physical.abort()
        assemblyRelease.resolve(undefined)
        try {
          const result = await assembling
          expect(originalTools?.map(tool => tool.name)).toContain('unrelated')
          expect(result.tools).not.toBe(originalTools)
          expect(result.tools.map(tool => tool.name)).not.toContain('unrelated')
        }
        finally { authRelease.resolve(undefined); await executing }
      })).rejects.toMatchObject({ failure: { code: 'unauthenticated' } })
    } finally { assemblyRelease.resolve(undefined); authRelease.resolve(undefined); await h.ctx.fiber.dispose() }
  })

  test('same-turn steering and error notification preserve the pin until a durable turn end', async () => {
    const h = await fixture()
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        await load(h)
        agentEvents(h.ctx, h.agent).emit('agent/status', { status: 'running' })
        claim(h.ctx, h.agent, 1)
        await agentEvents(h.ctx, h.agent).serial('agent/turn-stopping', { turn: 0, signal })
        expect((await h.ctx.systemPrompt.assemble({ scope: h.agent })).tools.map(tool => tool.name)).not.toContain('unrelated')
        agentEvents(h.ctx, h.agent).emit('agent/error', { turn: 1, step: 1, error: new Error('Model failed') })
        expect((await h.ctx.systemPrompt.assemble({ scope: h.agent })).tools.map(tool => tool.name)).not.toContain('unrelated')
        h.agent.session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
        agentEvents(h.ctx, h.agent).emit('agent/status', { status: 'idle' })
        expect((await h.ctx.systemPrompt.assemble({ scope: h.agent })).tools.map(tool => tool.name)).toContain('unrelated')
        const definition = (await h.ctx.skills.get('review', { scope: h.agent }))!
        await expect(agentEvents(h.ctx, h.agent).serial('skill/loaded', { definition, invocation: 'user-explicit' })).rejects.toThrow()
      })
    } finally { await h.ctx.fiber.dispose() }
  })

  test('concurrently loaded different versions cannot replace the first admitted pin', async () => {
    const h = await fixture()
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        const first = (await h.ctx.skills.get('review', { scope: h.agent }))!
        h.state.catalog = [entry('review', 2, version2)]
        h.state.load = { ...h.state.load as object, version_number: 2, version_key: version2 }
        const second = (await h.ctx.skills.get('review', { scope: h.agent }))!
        await agentEvents(h.ctx, h.agent).serial('skill/loaded', { definition: first, invocation: 'user-explicit' })
        await expect(agentEvents(h.ctx, h.agent).serial('skill/loaded', { definition: second, invocation: 'user-explicit' })).rejects.toMatchObject({ failure: { code: 'business-skill-conflict' } })
        expect(h.agent.session.events.filter(event => event.type === 'business-skill/activated').map(event => event.data.version)).toEqual([1])
      })
    } finally { await h.ctx.fiber.dispose() }
  })

  test('failed activation append leaves both the pending catalog and inherited tools unchanged', async () => {
    const h = await fixture()
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        const assembly = await h.ctx.systemPrompt.assemble({ scope: h.agent })
        const original = [...assembly.tools]
        const append = vi.spyOn(h.agent.session, 'append').mockImplementationOnce(() => { throw new Error('Session append rejected') })
        expect((await load(h)).isError).toBe(true)
        append.mockRestore()
        expect(assembly.tools).toEqual(original)
        expect((await h.ctx.systemPrompt.assemble({ scope: h.agent })).tools).toEqual(original)
      })
    } finally { await h.ctx.fiber.dispose() }
  })

  test('a bound tool failure closes direct registry reloads and subsequent bodies', async () => {
    const h = await fixture()
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        await load(h)
        h.execution.fail = true
        expect((await h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent, signal, callId: CallId('broken') })).isError).toBe(true)
        h.execution.fail = false
        await expect(h.ctx.skills.get('review', { scope: h.agent })).rejects.toMatchObject({ failure: { code: 'business-skill-tool-denied' } })
        expect((await h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent, signal, callId: CallId('retry') })).isError).toBe(true)
        expect(h.effects).toEqual(['search_artifacts'])
      })
    } finally { await h.ctx.fiber.dispose() }
  })

  test('an unowned inbox message permanently closes the already bound turn', async () => {
    const h = await fixture()
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        await load(h)
        const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Unowned steering' }] })
        agentEvents(h.ctx, h.agent).emit('agent/inbox/claimed', { message, turn: 1 })
        claim(h.ctx, h.agent, 1)
        expect((await load(h)).isError).toBe(true)
        expect((await h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent, signal, callId: CallId('wrong-owner') })).isError).toBe(true)
        expect(h.effects).toEqual([])
      })
    } finally { await h.ctx.fiber.dispose() }
  })
  test.each(['tools/pre-execute', 'tools/execute', 'guard'] as const)('request cancellation during %s cannot remove execution protection', async (event) => {
    const h = await fixture()
    const physical = new AbortController()
    try {
      await expect(h.service.withRequest(request({ requestSignal: physical.signal }), async () => {
        claim(h.ctx, h.agent, 1)
        await load(h)
        if (event === 'tools/pre-execute') h.agent.ctx.on('tools/pre-execute', async (_exec, next) => {
          physical.abort()
          return await next()
        })
        else if (event === 'tools/execute') h.agent.ctx.on('tools/execute', async (_exec, next) => {
          physical.abort()
          return await next()
        })
        else h.agent.ctx.get('tools')!.guard(() => { physical.abort(); return undefined })
        const result = await h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent, signal, callId: CallId('race') })
        expect(result.isError).toBe(true)
      })).rejects.toThrow()
      expect(h.effects).toEqual([])
    } finally { await h.ctx.fiber.dispose() }
  })
  test('an earlier waterfall allow cannot bypass backend authorization', async () => {
    const h = await fixture()
    h.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'search_artifacts' ? { kind: 'allow' } : await next())
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        expect((await load(h)).isError).toBe(false)
        expect((await h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent, signal, callId: CallId('skip') })).isError).toBe(true)
        expect(h.effects).toEqual([])
      })
    } finally { await h.ctx.fiber.dispose() }
  })

  test('a cancelled call closes bound execution even when cancellation precedes pre-execute', async () => {
    const h = await fixture()
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        await load(h)
        const aborted = AbortSignal.abort()
        await h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent, signal: aborted, callId: CallId('abort') })
        expect((await h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent, signal, callId: CallId('again') })).isError).toBe(true)
        expect(h.effects).toEqual([])
      })
    } finally { await h.ctx.fiber.dispose() }
  })

  test('rejects missing mounted policy tools even when the backend digest matches', async () => {
    const h = await fixture()
    h.state.load = { ...loaded(), complete_tools: ['list_accessible_projects', 'skill'],
      tool_policy_digest: '07f913cc80331dbde45ca9a9084861ede75a7364c47bcffc433192d02700da31' }
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        expect((await load(h)).isError).toBe(true)
      })
    } finally { await h.ctx.fiber.dispose() }
  })

  test('awaits cancelled authorization settlement and rejects its late allow', async () => {
    const h = await fixture()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        await load(h)
        h.state.beforeResponse = async (path, authSignal) => {
          if (path.endsWith('/authorize-tool')) { entered.resolve(authSignal!); await release.promise }
        }
        const caller = new AbortController()
        let settled = false
        const pending = h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent,
          signal: caller.signal, callId: CallId('cancel') }).then((result) => { settled = true; return result })
        const transport = await entered.promise
        caller.abort()
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(transport.aborted).toBe(true)
        expect(settled).toBe(false)
        release.resolve(undefined)
        expect((await pending).isError).toBe(true)
        expect(h.effects).toEqual([])
      })
    } finally { release.resolve(undefined); await h.ctx.fiber.dispose() }
  })
  test.each(['model-tool', 'user-explicit'] as const)('%s activates public metadata and replaces only the admitted body after the turn', async (invocation) => {
    const h = await fixture()
    try {
      await h.service.withRequest(request(), async () => {
        const message = claim(h.ctx, h.agent, 1, invocation === 'user-explicit' ? '/review' : 'Review')
        const assembly = await h.ctx.systemPrompt.assemble({ scope: h.agent, signal })
        if (invocation === 'model-tool') {
          h.agent.session.append('tool/call', { turn: 1, step: 1, callId: CallId('load'), name: 'skill', arguments: JSON.stringify({ name: 'review' }) })
          const result = await load(h)
          expect(result.isError).toBe(false)
          h.agent.session.append('tool/result', { turn: 1, step: 1,
            message: createToolResultMessage({ callId: CallId('load'), content: result.content, isError: result.isError }) }, { surfaceOp: 'append' })
        } else {
          const decision = await agentEvents(h.ctx, h.agent).waterfall('agent/pre-step',
            { messages: [message], turn: 1, step: 1, signal }, async () => ({ kind: 'enter' as const, messages: [message] }))
          expect(decision.kind).toBe('enter')
          if (decision.kind === 'enter') for (const value of decision.messages) h.agent.session.append('user/message', value, { surfaceOp: 'append' })
        }
        const tools = invocation === 'user-explicit' ? assembly.tools : (await h.ctx.systemPrompt.assemble({ scope: h.agent })).tools
        expect(tools.map(tool => tool.name)).toEqual(['search_artifacts', 'skill', 'submit_cited_answer'])
        const activation = h.agent.session.events.find(event => event.type === 'business-skill/activated')
        expect(activation).toMatchObject({ ignorable: true, data: { slug: 'review', version: 1, invocation, turn: 1, toolPolicyDigest: digest } })
        expect(Object.keys(activation!.data).sort()).toEqual(['invocation', 'slug', 'toolPolicyDigest', 'turn', 'version'])
        const original = JSON.stringify(h.agent.session.events)
        expect(original).toContain(JSON.stringify(body).slice(1, -1))
        const unrelated = h.agent.session.append('user/message', createUserMessage({
          source: { kind: 'plugin', plugin: 'other' }, content: [{ type: 'text', text: 'Keep other instructions.' }],
        }), { surfaceOp: 'append' })
        await agentEvents(h.ctx, h.agent).serial('agent/turn-stopping', { turn: 1, signal })
        expect(JSON.stringify(h.agent.session.deriveMessages())).toContain('Read **exactly**')
        h.agent.session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
        agentEvents(h.ctx, h.agent).emit('agent/status', { status: 'idle' })
        const history = JSON.stringify(h.agent.session.deriveMessages())
        expect(history).not.toContain('Read **exactly**')
        expect(history).toContain('Business Skill review v1 was used in turn 1.')
        expect(history).toContain('Keep other instructions.')
        expect(h.agent.session.surface.nodes).toContain(unrelated.seq)
        expect(JSON.stringify(h.agent.session.events)).toContain(JSON.stringify(body).slice(1, -1))
        expect((await h.ctx.systemPrompt.assemble({ scope: h.agent })).tools.map(tool => tool.name)).toContain('propose_fact')
      })
    } finally { await h.ctx.fiber.dispose() }
  })

  test('same Skill reload pins the old body through publication and rollback, and a later turn repins', async () => {
    const h = await fixture()
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        const first = await load(h)
        h.state.catalog = [entry('review', 2, version2), entry('other', 3, version2)]
        h.state.load = { ...loaded(), version_number: 2, version_key: version2, instructions: 'New instructions',
          tool_policy_digest: digest, complete_tools: ['search_artifacts', 'skill', 'submit_cited_answer'] }
        expect((await load(h, 'review', 'reload')).content).toEqual(first.content)
        expect(await load(h, 'other', 'conflict')).toMatchObject({ isError: true, error: { message: 'business-skill-conflict' } })
        const authorizedBefore = h.calls.filter(call => call.path.endsWith('/authorize-tool')).length
        expect((await h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent,
          signal, callId: CallId('after-conflict') })).isError).toBe(false)
        expect(h.calls.filter(call => call.path.endsWith('/authorize-tool'))).toHaveLength(authorizedBefore + 1)
        expect(h.calls.at(-1)?.body.version_key).toBe(versionKey)
        expect(h.calls.filter(call => call.path.endsWith('/runtime/load'))).toHaveLength(1)
        await agentEvents(h.ctx, h.agent).serial('agent/turn-stopping', { turn: 1, signal })
        claim(h.ctx, h.agent, 2)
        expect(JSON.stringify((await load(h, 'review', 'later')).content)).toContain('New instructions')
        h.state.catalog = [entry()]
        h.state.load = loaded()
        expect(JSON.stringify((await load(h, 'review', 'after-rollback')).content)).toContain('New instructions')
        expect(h.calls.at(-1)?.body.version_key).toBe(version2)
        expect(h.agent.session.events.filter(event => event.type === 'business-skill/activated').map(event => event.data.version)).toEqual([1, 2])
      })
    } finally { await h.ctx.fiber.dispose() }
  })

  test('every allowed call reauthorizes the pinned version and delegates to the real body', async () => {
    const h = await fixture()
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        await load(h)
        h.state.catalog = [entry('review', 2, version2)]
        for (const id of ['a', 'b']) expect((await h.ctx.tools.execute({
          name: 'search_artifacts', arguments: {}, agent: h.agent, signal, callId: CallId(id),
        })).isError).toBe(false)
        expect(h.effects).toEqual(['search_artifacts', 'search_artifacts'])
        expect(h.calls.filter(call => call.path.endsWith('/authorize-tool')).map(call => call.body)).toEqual([0, 1].map(() => ({
          schema_version: 1, session_id: request().sessionId, slug: 'review', version_key: versionKey,
          tool_policy_digest: digest, tool_name: 'search_artifacts', cancelled: false,
        })))
      })
    } finally { await h.ctx.fiber.dispose() }
  })

  test.each(['business-skill-not-authorized', 'business-skill-retired', 'stale-permission', 'service-unavailable'])('backend %s closes this turn even after recovery', async (failure) => {
    const h = await fixture()
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        await load(h)
        h.state.failure = failure
        const execute = () => h.ctx.tools.execute({ name: 'search_artifacts', arguments: {}, agent: h.agent, signal, callId: CallId('deny') })
        expect(await execute()).toMatchObject({ isError: true })
        h.state.failure = undefined
        expect(await execute()).toMatchObject({ isError: true })
        expect(h.effects).toEqual([])
      })
    } finally { await h.ctx.fiber.dispose() }
  })

  test('Agent-local tools omitted from the policy are hidden and cannot execute directly', async () => {
    const h = await fixture()
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        await load(h)
        const names = (await h.ctx.systemPrompt.assemble({ scope: h.agent })).tools.map(tool => tool.name)
        expect(names).toEqual(['search_artifacts', 'skill', 'submit_cited_answer'])
        expect((await h.ctx.tools.execute({ name: 'propose_fact', arguments: {}, agent: h.agent, signal, callId: CallId('write') })).isError).toBe(true)
        expect(h.effects).toEqual([])
      })
    } finally { await h.ctx.fiber.dispose() }
  })

  test.each([
    { complete_tools: ['skill', 'unknown'] },
    { complete_tools: ['search_artifacts', 'skill'] },
    { complete_tools: ['skill', 'submit_cited_answer'] },
    { complete_tools: ['search_artifacts', 'submit_cited_answer'] },
    { tool_policy_digest: 'a'.repeat(64) },
  ])('rejects inconsistent backend policy %j before the body is admitted', async (policy) => {
    const h = await fixture()
    h.state.load = { ...h.state.load as object, ...policy }
    try {
      await h.service.withRequest(request(), async () => {
        claim(h.ctx, h.agent, 1)
        expect((await load(h)).isError).toBe(true)
        expect(h.agent.session.events.some(event => event.type === 'business-skill/activated')).toBe(false)
      })
    } finally { await h.ctx.fiber.dispose() }
  })
})
