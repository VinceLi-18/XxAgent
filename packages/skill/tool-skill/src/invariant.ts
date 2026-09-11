/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-skill`.
 * @module @deepseek-ai/dsh-tool-skill/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { renderSkillContent, type SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-skill'

/** Cordis companion plugin name. */
export const name = 'tool-skill-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

interface UserAdmissionTrace {
  readonly definitions: Map<string, SkillDefinition>
}

interface ModelAdmissionTrace {
  readonly requestedName: string | undefined
  definition?: SkillDefinition
}

/** Return one model-visible text body, or undefined for any other projection. */
function singleTextBody(content: ToolExecutionResult['content']): string | undefined {
  const block = content.length === 1 ? content[0] : undefined
  return block?.type === 'text' ? block.text : undefined
}

/** Install skill request, load observation, and admitted-body agreement checks. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  const userAdmissions = new WeakMap<Agent, UserAdmissionTrace>()
  const modelAdmissions = new WeakMap<Agent, Map<string, ModelAdmissionTrace>>()

  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const trace: UserAdmissionTrace = { definitions: new Map() }
    userAdmissions.set(agent, trace)
    try {
      const decision = await next()
      const admitted = new Map<string, string>()
      if (decision.kind === 'enter') {
        for (const message of decision.messages) {
          if (message.source.kind !== 'skill-invocation') continue
          const body = singleTextBody(message.content)
          if (body === undefined) fail(`user-explicit skill ${message.source.name} admitted without one text body`)
          if (admitted.has(message.source.name)) {
            fail(`user-explicit skill ${message.source.name} admitted more than once`)
          }
          admitted.set(message.source.name, body)
        }
      }
      for (const [skillName, definition] of trace.definitions) {
        if (admitted.get(skillName) !== renderSkillContent(definition)) {
          fail(`user-explicit skill/loaded for ${skillName} has no matching admitted body`)
        }
      }
      for (const skillName of admitted.keys()) {
        if (!trace.definitions.has(skillName)) {
          fail(`user-explicit skill ${skillName} admitted without a skill/loaded observation`)
        }
      }
      return decision
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
    const args = exec.arguments as { name?: unknown }
    const trace: ModelAdmissionTrace = {
      requestedName: typeof args.name === 'string' ? args.name : undefined,
    }
    calls.set(callId, trace)
    try {
      const result = await next()
      if (trace.definition !== undefined && !result.isError
        && singleTextBody(result.content) !== renderSkillContent(trace.definition)) {
        fail(`model-tool skill/loaded for ${trace.definition.name} has no matching admitted body`)
      }
      return result
    } finally {
      calls.delete(callId)
      if (calls.size === 0) modelAdmissions.delete(agent)
    }
  }, { global: true, prepend: true })

  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'skill/loaded') return
    const payload = args[0] as {
      agent: Agent
      definition: SkillDefinition
      invocation: 'model-tool' | 'user-explicit'
      callId?: string
    }
    const definition = payload.definition as { name?: unknown; content?: unknown }
    if (typeof definition.name !== 'string'
      || typeof definition.content !== 'string') {
      fail('skill/loaded must carry a resolved definition with instruction content')
    }
    if (payload.invocation === 'model-tool') {
      const callId = payload.callId
      if (callId === undefined) fail('model-tool skill/loaded must carry callId')
      const trace = modelAdmissions.get(payload.agent)?.get(callId)
      if (trace === undefined) fail('model-tool skill/loaded must follow resolution inside its skill execution')
      if (payload.definition.name !== trace.requestedName) {
        fail(`model-tool skill/loaded definition ${payload.definition.name} does not match requested skill`)
      }
      if (trace.definition !== undefined) fail('skill/loaded repeated for one admission')
      trace.definition = payload.definition
      return
    }
    if (payload.callId !== undefined) fail('user-explicit skill/loaded must not carry callId')
    const trace = userAdmissions.get(payload.agent)
    if (trace === undefined) fail('user-explicit skill/loaded must follow resolution inside pre-step admission')
    if (trace.definitions.has(payload.definition.name)) fail('skill/loaded repeated for one admission')
    trace.definitions.set(payload.definition.name, payload.definition)
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
