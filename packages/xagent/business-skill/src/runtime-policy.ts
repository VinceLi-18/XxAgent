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
import { bindBusinessSkillDiscovery, CITED_ANSWER_TOOL, XAgentRetrievalService } from '@xagent/dsh-retrieval'
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
  private closeDiscovery: (() => void) | undefined
  private readonly closeListeners: (() => void)[]
  private permitted = new WeakSet<object>()
  private readonly executing = new Set<Promise<void>>()
  private closing: Promise<void> | undefined
  private readonly closeOwner: () => Promise<void>

  constructor(
    private readonly agent: Agent,
    private readonly runtime: ToolRuntime,
    private readonly authorize: (version: XAgentBusinessSkillLoad, tool: string, signal?: AbortSignal) => Promise<void>,
    lifetime: AbortSignal,
  ) {
    this.closeListeners = [
      agent.ctx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'turn/end' && event.data.turn === this.turn) this.releaseCatalog()
      }),
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const result = await next()
        this.finishTurn()
        if (this.closing !== undefined) {
          const pin = this.pin
          return pin === undefined ? result : { ...result, tools: result.tools.filter(tool => pin.binding.completeTools.has(tool.name)) }
        }
        this.schemas = result.tools
        this.filterSchemas(result.tools)
        return result
      }),
      agent.ctx.on('tools/pre-execute', async (exec, next) => {
        this.finishTurn()
        if (this.pin === undefined) return await next()
        return await this.runOwned(async () => {
          if (!await this.allowed(exec.name, exec.signal)) return { kind: 'deny', reason: DENIED } as const
          this.permitted.add(exec)
          const decision = await next()
          return lifetime.aborted ? { kind: 'deny', reason: DENIED } as const : decision
        })
      }),
      agent.ctx.on('approval/request', async (_request, next) => {
        this.finishTurn()
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
        this.finishTurn()
        if (this.pin === undefined) return undefined
        if (!lifetime.aborted && !this.denied && this.permitted.has(exec)) return undefined
        this.denied = true
        return DENIED
      }),
      agent.ctx.on('tools/result', (exec, result) => {
        if (this.pin !== undefined && (exec.signal.aborted || (exec.name !== 'skill' && result.isError))) this.denied = true
      }),
      agent.ctx.on('tools/execute', async (exec, next) => this.runOwned(async () => {
        this.finishTurn()
        if (this.pin !== undefined && (this.denied || lifetime.aborted || exec.signal.aborted)) {
          this.denied = true
          throw failure('business-skill-tool-denied')
        }
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
    this.closeOwner = agent.ctx.effect(() => async () => {
      this.denied = true
      this.schemas = undefined
      await Promise.allSettled(this.executing)
      for (const close of this.closeListeners) close()
      this.clear()
    }, 'business skill turn security')
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
   * @param test - Isolated run identity; excludes production writes while checking the production digest.
   */
  activate(definition: SkillDefinition, version: XAgentBusinessSkillLoad, invocation: 'model-tool' | 'user-explicit', test?: { readonly runNumber: number }): void {
    if (this.turn === undefined || this.denied) throw failure('business-skill-not-authorized')
    if (this.pin !== undefined) {
      if (this.pin.version.versionKey !== version.versionKey) throw failure('business-skill-conflict')
      return
    }
    const tools = new Set(version.completeTools)
    const digest = createHash('sha256').update(JSON.stringify({ complete_tools: [...tools].sort(), version: 1 })).digest('hex')
    if (test !== undefined) tools.delete('propose_fact')
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
    const pin = new TurnBinding(definition, { ...version, completeTools: [...tools] }, this.turn)
    const lift = runtime.restrict({ deny: runtime.schemas().map(tool => tool.name).filter(name => !tools.has(name)) })
    try {
      this.agent.session.append('business-skill/activated', { slug: version.slug, version: version.versionNumber,
        invocation, turn: this.turn, toolPolicyDigest: version.toolPolicyDigest }, { ignorable: true })
    } catch (error) { lift(); throw error }
    this.pin = pin
    this.lift = lift
    if (tools.has('list_accessible_projects')) {
      this.closeDiscovery = bindBusinessSkillDiscovery(this.agent, test === undefined
        ? { kind: 'published', slug: version.slug, versionKey: version.versionKey, toolPolicyDigest: version.toolPolicyDigest }
        : { kind: 'test', slug: version.slug, runNumber: test.runNumber, toolPolicyDigest: version.toolPolicyDigest },
      () => this.isLivePin(pin))
      if (invocation === 'user-explicit') {
        const schema = runtime.schemas(this.agent).find(tool => tool.name === 'list_accessible_projects')
        if (schema !== undefined && this.schemas !== undefined && !this.schemas.some(tool => tool.name === schema.name)) {
          this.schemas.unshift(schema)
        }
      }
    }
    if (invocation === 'user-explicit') this.filterSchemas(this.schemas)
    else this.schemas = undefined
  }

  /**
   * Expire request authority while retaining bound-turn dispatch protection until final turn end.
   * @returns settlement of callbacks already active; future approval and dispatch are not awaited.
   */
  closeRequest(): Promise<void> {
    this.denied = true
    this.schemas = undefined
    this.closing ??= Promise.allSettled(this.executing).then(async () => {
      this.finishTurn()
      if (this.pin === undefined) await this.closeOwner()
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

  private filterSchemas(schemas: ToolSchema[] | undefined): void {
    if (this.pin === undefined || schemas === undefined) return
    const allowed = schemas.filter(tool => this.pin?.binding.completeTools.has(tool.name))
    schemas.splice(0, schemas.length, ...allowed)
  }

  private clear(): void {
    replaceCompletedInstructions(this.agent.session)
    this.releaseCatalog()
    this.closeDiscovery?.()
    this.closeDiscovery = undefined
    this.pin = undefined
    this.turn = undefined
    this.denied = false
    this.permitted = new WeakSet()
  }

  /** Catalog-only cleanup is synchronous and does not append Session events. */
  private releaseCatalog(): void {
    this.lift?.()
    this.lift = undefined
    this.schemas = undefined
  }

  private finishTurn(): void {
    if (this.turn !== undefined && this.agent.session.events.some(event => event.type === 'turn/end' && event.data.turn === this.turn)) {
      this.clear()
      if (this.closing !== undefined) void this.closeOwner()
    }
  }
}
