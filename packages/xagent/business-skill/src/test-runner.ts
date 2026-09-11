/** Dedicated read-only execution of one governed draft scenario. @module @xagent/dsh-business-skill/test-runner */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { XAgentBackendError, type XAgentBusinessSkillBackend, type XAgentBusinessSkillTest,
  type XAgentBusinessSkillTestInput, type XAgentBusinessSkillTestStart, type XAgentBusinessSkillTerminationReason } from '@xagent/dsh-backend-client'
import { currentXAgentAuthenticatedRequestScope, isXAgentAuthenticatedSessionRequestScope,
  runWithXAgentAuthenticatedRequestScope, type XAgentAuthenticatedSessionRequestScope } from '@xagent/dsh-principal'
import type { XAgentSessionPersistence } from '@xagent/dsh-session-persistence-api'
import type { XAgentBusinessSkillTestRunner } from './types.ts'
import { BusinessSkillRuntimePolicy } from './runtime-policy.ts'

const DENIED = 'Business Skill tests permit only the selected read-only tools.'
const READ_TOOLS = new Set(['skill', 'list_accessible_projects', 'search_artifacts', 'submit_cited_answer'])

function unavailable(): TypertRemoteFailure {
  return new TypertRemoteFailure({ code: 'service-unavailable', message: 'Business Skill test is unavailable', details: {} })
}

class Unclaimed extends Error {
  constructor(readonly test: XAgentBusinessSkillTest) { super('Business Skill test already mounted') }
}

/** Owns isolated Agent execution and its terminal backend write. */
export class BusinessSkillTestRunner implements XAgentBusinessSkillTestRunner {
  private readonly lifetime = new AbortController()
  private readonly runs = new Map<string, Promise<XAgentBusinessSkillTest>>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly close: () => Promise<void>

  constructor(private readonly ctx: Context, private readonly backend: XAgentBusinessSkillBackend,
    private readonly persistence: XAgentSessionPersistence, private readonly options: AgentOptions) {
    this.close = ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled(this.pending)
    }, 'business skill test runner')
  }

  async run(slug: string, input: XAgentBusinessSkillTestInput, signal: AbortSignal): Promise<XAgentBusinessSkillTest> {
    const current = currentXAgentAuthenticatedRequestScope()
    if (current === undefined || !('sessionId' in current)) throw unavailable()
    const scope = current as XAgentAuthenticatedSessionRequestScope
    if (!isXAgentAuthenticatedSessionRequestScope(scope) || scope.visibility !== 'project'
      || scope.purpose !== 'conversation' || scope.requestSignal === undefined || scope.connectionSignal === undefined) throw unavailable()
    const combined = AbortSignal.any([signal, this.lifetime.signal, scope.requestSignal, scope.connectionSignal])
    combined.throwIfAborted()
    const operation = this.start(slug, input, scope, scope.projectId, combined)
    this.pending.add(operation)
    try { return await operation } finally { this.pending.delete(operation) }
  }

  /** Stop and drain every owned run. */
  async dispose(): Promise<void> { await this.close() }

  private async start(slug: string, input: XAgentBusinessSkillTestInput, scope: XAgentAuthenticatedSessionRequestScope,
    project: string, signal: AbortSignal): Promise<XAgentBusinessSkillTest> {
    // Allocation must finish so cancellation can identify and atomically close an empty run.
    const start = await this.backend.startTest(scope.userToken, project, slug, input)
    const existing = this.runs.get(start.sessionId)
    if (existing !== undefined) return await existing
    const operation = this.execute(slug, start, scope, project, signal)
    this.runs.set(start.sessionId, operation)
    try { return await operation } finally { this.runs.delete(start.sessionId) }
  }

  private async execute(slug: string, start: XAgentBusinessSkillTestStart, scope: XAgentAuthenticatedSessionRequestScope,
    project: string, signal: AbortSignal): Promise<XAgentBusinessSkillTest> {
    const read = async (caller?: AbortSignal) => this.backend.transcript(scope.userToken, project, slug,
      start.test.runNumber, { afterSequence: -1, limit: 1 }, caller)
    const testScope: XAgentAuthenticatedSessionRequestScope = { ...scope, sessionId: start.sessionId,
      purpose: 'business_skill_test', requestSignal: signal }
    const id = SessionId(`session-${start.sessionId}`)
    const mountKey = randomUUID()
    const state: { claimed: boolean; activated: boolean; reason: XAgentBusinessSkillTerminationReason } = {
      claimed: false, activated: false, reason: 'skill-not-loaded',
    }
    let handle: AgentHandle | undefined
    let agent: Agent | undefined
    const cancel = (): void => { state.reason = 'cancelled'; agent?.cancel({ kind: 'user' }) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      const previous = await read(signal)
      if (previous.test.status !== 'running' || previous.events.length !== 0) return previous.test
      handle = await runWithXAgentAuthenticatedRequestScope(testScope, () => this.ctx.agents.create({
        sessionId: id, agentOptions: this.options, signal,
        setup: (agentCtx) => {
          const owner = agentCtx.agent as Agent
          agent = owner
          agentCtx.effect(() => this.persistence.bindBusinessSkillTestPublication(owner.session, testScope, async (header, events) => {
            const result = await this.backend.mountTest(scope.userToken, project, slug, start.test.runNumber,
              { sessionId: start.sessionId, runtimeHeader: { ...header }, events, idempotencyKey: mountKey })
            if (!result.claimed) throw new Unclaimed(result.test)
            state.claimed = true
          }), 'business skill test publication')
          const permitted = new Set(start.testTools)
          const definition: SkillDefinition = Object.freeze({ name: slug, description: start.draft.description,
            content: start.draft.instructions, provider: 'xagent-draft', source: 'xagent-draft',
            invocation: Object.freeze({ userInvocable: true, modelInvocable: true }) })
          const skills = agentCtx.get('skills')
          const runtime = agentCtx.get('tools')
          if (skills === undefined || runtime === undefined) throw unavailable()
          skills.registerProvider(() => ({ name: 'xagent-draft', list: () => Promise.resolve([
            { ...definition, rank: 0, locator: definition },
          ]), get: () => Promise.resolve(definition) }))
          runtime.guard(exec => signal.aborted || !state.activated || !permitted.has(exec.name) ? DENIED : undefined)
          const policy = new BusinessSkillRuntimePolicy(owner, runtime, async (_version, _name, caller) => {
            const current = await read(caller)
            if (current.test.status !== 'running') { state.reason = 'authorization-denied'; throw unavailable() }
          }, signal)
          agentCtx.on('agent/inbox/claimed', ({ turn }) => { policy.claim(turn) })
          agentCtx.on('skill/loaded', ({ definition: loaded, invocation }) => {
            if (loaded !== definition || [...permitted].some(tool => !READ_TOOLS.has(tool))) throw unavailable()
            policy.activate(definition, { slug, description: start.draft.description, instructions: start.draft.instructions,
              versionNumber: start.draft.revision, versionKey: start.sessionId, contentDigest: start.draft.contentDigest,
              toolPolicyDigest: start.draft.toolPolicyDigest,
              completeTools: [...start.testTools, ...start.unexecutedWriteTools] }, invocation, true)
            state.activated = true
          })
          agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
            const assembly = await next()
            assembly.tools.splice(0, assembly.tools.length, ...assembly.tools.filter(tool => permitted.has(tool.name)))
            return assembly
          }, { prepend: true })
          agentCtx.on('tools/pre-execute', async (exec, next) => {
            if (signal.aborted || !state.activated || !permitted.has(exec.name)) {
              state.reason = signal.aborted ? 'cancelled' : 'tool-denied'
              return { kind: 'deny', reason: DENIED }
            }
            return await next()
          }, { prepend: true })
          agentCtx.on('tools/result', (_exec, result) => { if (result.isError) state.reason = 'tool-denied' })
          agentCtx.on('agent/pre-step', async ({ turn, step, messages }, next) => {
            if (turn !== 1) return { kind: 'reject' }
            const result = await next()
            if (result.kind === 'reject' || step !== 1) return result
            return { kind: 'enter', messages: [...result.messages.filter(message => !messages.some(input => input.id === message.id)),
              createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: start.scenario }] })] }
          }, { prepend: true })
        },
      }))
      signal.throwIfAborted()
      this.ctx.get('sessionTitle')?.rename(handle.agent.session, `${slug} test ${start.test.runNumber}`)
      const running = handle.agent
      runWithXAgentAuthenticatedRequestScope(testScope, () => { running.followup(createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: `/${slug}` }],
      })) })
      await running.whenIdle()
      const end = running.session.events.findLast(event => event.type === 'turn/end')
      if (signal.aborted || end?.data.reason.kind === 'aborted') state.reason = 'cancelled'
      else if (state.reason === 'skill-not-loaded' && state.activated) state.reason = end?.data.reason.kind === 'completed' ? 'completed' : 'failed'
    } catch (error) {
      if (error instanceof Unclaimed) return error.test
      if (!state.claimed) {
        if (signal.aborted) return await this.backend.cancelUnmountedTest(scope.userToken, project, slug,
          start.test.runNumber, start.sessionId, `cancel:${mountKey}`)
        if (error instanceof XAgentBackendError && error.code === 'business-skill-conflict') return (await read()).test
        throw error
      }
      state.reason = signal.aborted ? 'cancelled' : 'service-unavailable'
    } finally {
      signal.removeEventListener('abort', cancel)
      await handle?.dispose()
      await this.persistence.flushSession(id)
    }
    return await this.backend.settleTest(scope.userToken, project, slug, start.test.runNumber, start.sessionId, state.reason, `settle:${mountKey}`)
  }
}
