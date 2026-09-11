import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as ToolSkillInvariant from '../src/invariant.ts'

const signal = new AbortController().signal

function agentFixture(name: string): Agent {
  const id = SessionId(name)
  const session = Session.create(id)
  return {
    ctx: new Context(),
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

const definition: SkillDefinition = {
  name: 'invariant-skill',
  description: 'Invariant skill',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'test',
  provider: 'test',
  content: 'Resolved instructions.',
}

function execution(agent: Agent, callId = 'invariant-call'): ToolExecution {
  return {
    token: Symbol('skill') as ToolExecutionToken,
    callId: CallId(callId),
    rootCallId: CallId(callId),
    name: 'skill',
    arguments: { name: definition.name },
    agent,
    signal,
  }
}

const outcome = (): ToolExecutionResult => ({ content: [], isError: false, value: null })

function preStep(
  ctx: Context,
  agent: Agent,
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal },
    next,
  )
}

async function duringModelAdmission(
  ctx: Context,
  exec: ToolExecution,
  next: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  if (exec.agent === undefined) throw new Error('model admission fixture requires an agent')
  return await agentEvents(ctx, exec.agent).waterfall('tools/execute', exec, next)
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ToolSkillInvariant)
  return ctx
}

describe('tool-skill load invariant', () => {
  it('accepts one resolved user-explicit observation in one pre-step admission', async () => {
    const ctx = await setup()
    const agent = agentFixture('skill-invariant-valid')
    ctx.on('agent/pre-step', async (_payload, next) => {
      await agentEvents(ctx, agent).serial('skill/loaded', {
        definition,
        invocation: 'user-explicit',
      })
      return await next()
    })

    await expect(preStep(
      ctx,
      agent,
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )).resolves.toEqual({ kind: 'enter', messages: [] })
  })

  it.each([
    { ...definition, content: undefined },
    { ...definition, name: undefined },
  ])('requires user-explicit observations to carry a complete resolved definition', async (unresolved) => {
    const ctx = await setup()
    const agent = agentFixture('skill-invariant-resolution')
    ctx.on('agent/pre-step', async (_payload, next) => {
      await agentEvents(ctx, agent).serial('skill/loaded', {
        definition: unresolved as never,
        invocation: 'user-explicit',
      })
      return await next()
    })

    await expect(preStep(
      ctx,
      agent,
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )).rejects.toThrow(/resolved definition/)
  })

  it('rejects a duplicate user-explicit observation within one admission', async () => {
    const ctx = await setup()
    const agent = agentFixture('skill-invariant-duplicate')
    ctx.on('agent/pre-step', async (_payload, next) => {
      await agentEvents(ctx, agent).serial('skill/loaded', {
        definition,
        invocation: 'user-explicit',
      })
      await agentEvents(ctx, agent).serial('skill/loaded', {
        definition,
        invocation: 'user-explicit',
      })
      return await next()
    })

    await expect(preStep(
      ctx,
      agent,
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )).rejects.toThrow(/repeated.*one admission/)
  })

  it('accepts one resolved model-tool observation inside its tool admission', async () => {
    const ctx = await setup()
    const agent = agentFixture('skill-invariant-model-valid')
    const exec = execution(agent)

    await expect(duringModelAdmission(ctx, exec, async () => {
      await agentEvents(ctx, agent).serial('skill/loaded', {
        definition,
        invocation: 'model-tool',
        callId: exec.callId,
      })
      return outcome()
    })).resolves.toEqual(outcome())
  })

  it('requires a model-tool observation to identify its active admission', async () => {
    const ctx = await setup()
    const agent = agentFixture('skill-invariant-model-identity')
    const exec = execution(agent)

    await expect(duringModelAdmission(ctx, exec, async () => {
      await agentEvents(ctx, agent).serial('skill/loaded', {
        definition,
        invocation: 'model-tool',
      })
      return outcome()
    })).rejects.toThrow(/carry callId/)

    await expect(agentEvents(ctx, agent).serial('skill/loaded', {
      definition,
      invocation: 'model-tool',
      callId: CallId('outside-admission'),
    })).rejects.toThrow(/follow resolution/)
  })

  it('rejects a duplicate model-tool observation within one admission', async () => {
    const ctx = await setup()
    const agent = agentFixture('skill-invariant-model-duplicate')
    const exec = execution(agent)

    await expect(duringModelAdmission(ctx, exec, async () => {
      for (let count = 0; count < 2; count += 1) {
        await agentEvents(ctx, agent).serial('skill/loaded', {
          definition,
          invocation: 'model-tool',
          callId: exec.callId,
        })
      }
      return outcome()
    })).rejects.toThrow(/repeated.*one admission/)
  })

  it('rejects user-explicit observations outside their admission or carrying a call ID', async () => {
    const ctx = await setup()
    const agent = agentFixture('skill-invariant-user-identity')
    ctx.on('agent/pre-step', async (_payload, next) => {
      await agentEvents(ctx, agent).serial('skill/loaded', {
        definition,
        invocation: 'user-explicit',
        callId: CallId('forbidden'),
      })
      return await next()
    })

    await expect(preStep(
      ctx,
      agent,
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )).rejects.toThrow(/must not carry callId/)

    await expect(agentEvents(ctx, agent).serial('skill/loaded', {
      definition,
      invocation: 'user-explicit',
    })).rejects.toThrow(/follow resolution/)
  })

  it('tracks concurrent model admissions independently and rejects a repeated call ID', async () => {
    const ctx = await setup()
    const agent = agentFixture('skill-invariant-model-overlap')
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const firstExec = execution(agent, 'shared-call')
    const first = duringModelAdmission(ctx, firstExec, async () => {
      entered()
      await gate
      return outcome()
    })
    await started

    await expect(duringModelAdmission(
      ctx,
      execution(agent, 'other-call'),
      () => Promise.resolve(outcome()),
    )).resolves.toEqual(outcome())
    await expect(duringModelAdmission(
      ctx,
      execution(agent, 'shared-call'),
      () => Promise.resolve(outcome()),
    )).rejects.toThrow(/overlapped.*shared-call/)
    release()
    await expect(first).resolves.toEqual(outcome())
  })

  it('releases its package registration for companion reload', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const first = ctx.plugin(ToolSkillInvariant)
    await first
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-tool-skill', () => undefined))
      .toThrow('already registered')
    await first.dispose()
    const second = ctx.plugin(ToolSkillInvariant)
    await second
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-tool-skill', () => undefined))
      .toThrow('already registered')
    await second.dispose()
  })
})
