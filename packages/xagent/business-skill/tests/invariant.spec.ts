import { agentEvents } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { CallId } from '@deepseek-ai/dsh-llm'
import { describe, expect, test } from 'vitest'
import * as invariant from '../src/invariant.ts'
import { entry, request, setup } from './fixtures.ts'

describe('Business Skill loaded-definition relationship', () => {
  test('disposes the package reservation so the companion can reload', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const first = ctx.plugin(invariant)
    await first
    await first.dispose()
    const second = ctx.plugin(invariant)
    await second
    await second.dispose()
    expect(() => ctx.invariants.register('@xagent/dsh-business-skill', () => undefined)).not.toThrow()
    await ctx.fiber.dispose()
  })
  test('accepts only the exact authorized definition owned by the receiving Agent', async () => {
    const { ctx, agent, service, state } = await setup()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(invariant)
    state.catalog = [entry()]
    await service.withRequest(request(), async () => {
      service.attach(agent)
      const definition = (await ctx.skills.get('review', { scope: agent }))!
      await expect(agentEvents(ctx, agent).serial('skill/loaded', { definition: { ...definition, provider: 'other-provider' }, invocation: 'user-explicit' })).resolves.toBeUndefined()
      await expect(agentEvents(ctx, agent).serial('skill/loaded', { definition, invocation: 'model-tool', callId: CallId('valid') })).resolves.toBeUndefined()
      await expect(agentEvents(ctx, agent).serial('skill/loaded', {
        definition: { ...definition, content: 'Unapproved instructions' }, invocation: 'user-explicit',
      })).rejects.toThrow(/owned.*definition/)
    })
    await ctx.fiber.dispose()
  })

  test('rejects a stale definition after physical request settlement and detaches on unload', async () => {
    const { ctx, agent, service, state } = await setup()
    await ctx.plugin(InvariantRegistry)
    const fiber = ctx.plugin(invariant)
    await fiber
    state.catalog = [entry()]
    const definition = await service.withRequest(request(), async () => {
      service.attach(agent)
      return (await ctx.skills.get('review', { scope: agent }))!
    })
    await expect(agentEvents(ctx, agent).serial('skill/loaded', { definition, invocation: 'user-explicit' })).rejects.toThrow(/owned.*definition/)
    await fiber.dispose()
    while (fiber.inertia !== undefined) await fiber.inertia
    expect(() => ctx.invariants.register('@xagent/dsh-business-skill', () => undefined)).not.toThrow()
    await expect(agentEvents(ctx, agent).serial('skill/loaded', { definition, invocation: 'user-explicit' })).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })
})
