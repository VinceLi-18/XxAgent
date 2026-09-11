/** Turn-scoped catalog restriction and awaited FastAPI execution authorization. @module @xagent/dsh-business-skill/runtime-policy */
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tool-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { XAgentBusinessSkillLoad } from '@xagent/dsh-backend-client'
import { CITED_ANSWER_TOOL, XAgentRetrievalService } from '@xagent/dsh-retrieval'
import { isArtifactSearchTool, SEARCH_ARTIFACTS_TOOL } from '@xagent/dsh-tool-retrieval'
import { replaceCompletedInstructions, TurnBinding } from './turn-binding.ts'

const SAFE_TOOLS = new Set(['skill', 'list_accessible_projects', 'search_artifacts', 'submit_cited_answer', 'propose_fact'])
const DENIED = 'Business Skill tool execution is unavailable for this turn.'

function failure(code: string): TypertRemoteFailure {
  const error = new TypertRemoteFailure({ code, message: 'Business Skill activation failed', details: {} })
  error.message = code
  return error
}

/** One Agent's current turn; backend work remains owned by its physical request. */
export class BusinessSkillRuntimePolicy {
  private turn: number | undefined
  private pin: TurnBinding | undefined
  private denied = false
  private schemas: ToolSchema[] | undefined
  private lift: (() => void) | undefined
  private readonly closeListeners: (() => void)[]
  private permitted = new WeakSet<object>()
  private readonly executing = new Set<Promise<void>>()
  private closing: Promise<void> | undefined

  constructor(
    private readonly agent: Agent,
    private readonly runtime: ToolRuntime,
    private readonly authorize: (version: XAgentBusinessSkillLoad, tool: string, signal?: AbortSignal) => Promise<void>,
    lifetime: AbortSignal,
  ) {
    this.closeListeners = [
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const result = await next()
        if (this.closing !== undefined) return result
        this.finishTurn()
        this.schemas = result.tools
        this.filterSchemas()
        return result
      }),
      agent.ctx.on('tools/pre-execute', async (exec, next) => {
        if (this.pin === undefined) return await next()
        return await this.runOwned(async () => {
          if (!await this.allowed(exec.name, exec.signal)) return { kind: 'deny', reason: DENIED } as const
          this.permitted.add(exec)
          const decision = await next()
          return lifetime.aborted ? { kind: 'deny', reason: DENIED } as const : decision
        })
      }),
      agent.ctx.on('approval/request', async (_request, next) => {
        if (this.pin === undefined) return await next()
        return await this.runOwned(async () => {
          const cancelled = Promise.withResolvers<ApprovalOutcome>()
          const abort = (): void => { cancelled.resolve('cancelled') }
          lifetime.addEventListener('abort', abort, { once: true })
          if (lifetime.aborted) abort()
          try {
            // Promise.race consumes late answerer rejection after request cancellation.
            const outcome = await Promise.race([next(), cancelled.promise])
            return lifetime.aborted ? 'cancelled' : outcome
          } finally { lifetime.removeEventListener('abort', abort) }
        })
      }, { prepend: true }),
      runtime.guard((exec) => {
        if (this.pin === undefined) return undefined
        if (!this.denied && this.permitted.has(exec)) return undefined
        this.denied = true
        return DENIED
      }),
      agent.ctx.on('tools/result', (exec, result) => {
        if (this.pin !== undefined && (exec.signal.aborted || (exec.name !== 'skill' && result.isError))) this.denied = true
      }),
      agent.ctx.on('tools/execute', async (exec, next) => this.runOwned(async () => {
        const original = exec.signal
        exec.signal = AbortSignal.any([original, lifetime])
        try { return await next() } finally {
          exec.signal = original
        }
      })),
      agent.ctx.on('agent/status', ({ status }) => {
        if (status === 'idle') this.finishTurn()
      }),
    ]
  }

  /**
   * Start the exact claimed turn without changing an existing same-turn pin.
   * @param turn - turn reported by the inbox claim event.
   */
  claim(turn: number): void {
    if (this.turn === turn) return
    this.clear()
    this.turn = turn
  }

  /** Deny the rest of this turn after an inbox claim loses physical-request ownership. */
  invalidate(): void { this.denied = true }

  /**
   * Reauthorize same-Skill reloads against the pinned historical version.
   * @param slug - requested public name.
   * @param signal - caller cancellation.
   * @returns immutable admitted definition or undefined before activation.
   */
  async reload(slug: string, signal?: AbortSignal): Promise<SkillDefinition | undefined> {
    const pin = this.pin
    if (pin === undefined) return undefined
    if (pin.binding.slug !== slug) throw failure('business-skill-conflict')
    if (!await this.allowed('skill', signal)) throw failure('business-skill-tool-denied')
    return pin.definition
  }

  /**
   * Validate and commit one activation before generic Skill admission returns.
   * @param definition - exact provider-owned definition.
   * @param version - private immutable backend response.
   * @param invocation - invocation form recorded for the first activation.
   */
  activate(definition: SkillDefinition, version: XAgentBusinessSkillLoad, invocation: 'model-tool' | 'user-explicit'): void {
    if (this.turn === undefined || this.denied) throw failure('business-skill-not-authorized')
    if (this.pin !== undefined) {
      if (this.pin.version.versionKey !== version.versionKey) throw failure('business-skill-conflict')
      return
    }
    const tools = new Set(version.completeTools)
    const digest = createHash('sha256').update(JSON.stringify({ complete_tools: [...tools].sort(), version: 1 })).digest('hex')
    const runtime = this.runtime
    const search = runtime.get(SEARCH_ARTIFACTS_TOOL, this.agent)
    const deferredCompanion = tools.has(SEARCH_ARTIFACTS_TOOL) && search !== undefined && isArtifactSearchTool(search)
      && this.agent.ctx.get('xagentRetrieval') instanceof XAgentRetrievalService
    if (!tools.has('skill') || tools.has(SEARCH_ARTIFACTS_TOOL) !== tools.has(CITED_ANSWER_TOOL)
      || digest !== version.toolPolicyDigest
      || [...tools].some(name => !SAFE_TOOLS.has(name)
        || (runtime.get(name, this.agent) === undefined && !(name === CITED_ANSWER_TOOL && deferredCompanion)))) {
      throw failure('business-skill-policy-changed')
    }
    const pin = new TurnBinding(definition, version, this.turn)
    const lift = runtime.restrict({ deny: runtime.schemas().map(tool => tool.name).filter(name => !tools.has(name)) })
    try {
      this.agent.session.append('business-skill/activated', { slug: version.slug, version: version.versionNumber,
        invocation, turn: this.turn, toolPolicyDigest: version.toolPolicyDigest }, { ignorable: true })
    } catch (error) { lift(); throw error }
    this.pin = pin
    this.lift = lift
    if (invocation === 'user-explicit') this.filterSchemas()
    else this.schemas = undefined
  }

  /**
   * Close execution immediately and retain its guard until admitted calls settle.
   * @returns quiescence after active dispatch callbacks settle, followed by listener cleanup.
   */
  dispose(): Promise<void> {
    this.denied = true
    this.schemas = undefined
    this.closing ??= Promise.allSettled(this.executing).then(() => {
      for (const close of this.closeListeners) close()
      this.clear()
    })
    return this.closing
  }

  private async allowed(name: string, signal?: AbortSignal): Promise<boolean> {
    const pin = this.pin
    if (pin === undefined || this.denied) return false
    try {
      await this.authorize(pin.version, name, signal)
      signal?.throwIfAborted()
      if (!this.isLivePin(pin) || !pin.binding.completeTools.has(name)) throw failure('business-skill-tool-denied')
      return true
    } catch {
      // Authorization failures include cancellation; none grants cached execution permission.
      this.denied = true
      return false
    }
  }

  private async runOwned<T>(operation: () => Promise<T>): Promise<T> {
    const settled = Promise.withResolvers<void>()
    this.executing.add(settled.promise)
    try { return await operation() } finally {
      this.executing.delete(settled.promise)
      settled.resolve()
    }
  }

  private isLivePin(pin: TurnBinding): boolean { return this.pin === pin && !this.denied }

  private filterSchemas(): void {
    if (this.pin === undefined || this.schemas === undefined) return
    const allowed = this.schemas.filter(tool => this.pin?.binding.completeTools.has(tool.name))
    this.schemas.splice(0, this.schemas.length, ...allowed)
  }

  private clear(): void {
    replaceCompletedInstructions(this.agent.session)
    this.lift?.()
    this.pin = undefined
    this.turn = undefined
    this.schemas = undefined
    this.lift = undefined
    this.denied = false
    this.permitted = new WeakSet()
  }

  private finishTurn(): void {
    if (this.turn !== undefined && this.agent.session.events.some(event => event.type === 'turn/end' && event.data.turn === this.turn)) this.clear()
  }
}
