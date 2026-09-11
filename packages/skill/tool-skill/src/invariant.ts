/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-skill`.
 * @module @deepseek-ai/dsh-tool-skill/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-skill'

/** Cordis companion plugin name. */
export const name = 'tool-skill-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

interface UserAdmissionTrace {
  readonly names: Set<string>
}

interface ModelAdmissionTrace {
  observed: boolean
}

/** Install load-resolution and one-observation-per-admission checks. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const userAdmissions = new WeakMap<Agent, UserAdmissionTrace>()
  const modelAdmissions = new WeakMap<Agent, Map<string, ModelAdmissionTrace>>()

  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const trace: UserAdmissionTrace = { names: new Set() }
    userAdmissions.set(agent, trace)
    try {
      return await next()
    } finally {
      userAdmissions.delete(agent)
    }
  }, { global: true, prepend: true })

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const agent = exec.agent
    if (exec.name !== 'skill' || agent === undefined) return await next()
    let calls = modelAdmissions.get(agent)
    if (calls === undefined) {
      calls = new Map()
      modelAdmissions.set(agent, calls)
    }
    const callId = String(exec.callId)
    if (calls.has(callId)) fail(`model-tool skill admission overlapped for callId ${callId}`)
    const trace: ModelAdmissionTrace = { observed: false }
    calls.set(callId, trace)
    try {
      return await next()
    } finally {
      calls.delete(callId)
      if (calls.size === 0) modelAdmissions.delete(agent)
    }
  }, { global: true, prepend: true })

  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'skill/loaded') return
    const payload = args[0] as {
      agent: Agent
      definition: { name?: unknown; content?: unknown }
      invocation: 'model-tool' | 'user-explicit'
      callId?: string
    }
    if (typeof payload.definition.name !== 'string'
      || typeof payload.definition.content !== 'string') {
      fail('skill/loaded must carry a resolved definition with instruction content')
    }
    if (payload.invocation === 'model-tool') {
      const callId = payload.callId
      if (callId === undefined) fail('model-tool skill/loaded must carry callId')
      const trace = modelAdmissions.get(payload.agent)?.get(callId)
      if (trace === undefined) fail('model-tool skill/loaded must follow resolution inside its skill execution')
      if (trace.observed) fail('skill/loaded repeated for one admission')
      trace.observed = true
      return
    }
    if (payload.callId !== undefined) fail('user-explicit skill/loaded must not carry callId')
    const trace = userAdmissions.get(payload.agent)
    if (trace === undefined) fail('user-explicit skill/loaded must follow resolution inside pre-step admission')
    if (trace.names.has(payload.definition.name)) fail('skill/loaded repeated for one admission')
    trace.names.add(payload.definition.name)
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
