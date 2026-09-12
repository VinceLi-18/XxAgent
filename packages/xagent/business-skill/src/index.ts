/** Governed Business Skill Service Definition, FastAPI Provider and scoped registry Consumer. @module @xagent/dsh-business-skill */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-session'
import type SkillRegistry from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { bindTypertRemote, Remote, TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import {
  XAgentBackendClient, XAgentBackendError,
  type XAgentBusinessSkillBackend, type XAgentBusinessSkillCatalogEntry, type XAgentBusinessSkillLoad,
  type XAgentBusinessSkillCreateInput, type XAgentBusinessSkillDraftInput, type XAgentBusinessSkillTestInput,
  type XAgentBusinessSkillVerdict, type XAgentBusinessSkillPage, type XAgentBusinessSkillDetail,
  type XAgentBusinessSkillTest,
} from '@xagent/dsh-backend-client'
import {
  isXAgentAuthenticatedSessionRequestScope, runWithXAgentAuthenticatedRequestScope,
  type XAgentAuthenticatedSessionRequestScope,
} from '@xagent/dsh-principal'
import type { BusinessSkillLocator, BusinessSkillRemoteTranscript, XAgentBusinessSkillRemote, XAgentBusinessSkillScopeRunner, XAgentBusinessSkillTestRunner } from './types.ts'
import { BusinessSkillRuntimePolicy } from './runtime-policy.ts'
import { replaceCompletedInstructions } from './turn-binding.ts'
import { XAgentSessionPersistence } from '@xagent/dsh-session-persistence-api'
import { BusinessSkillTestRunner } from './test-runner.ts'

export type * from './types.ts'
export { businessSkillRelationship, type BusinessSkillRelationship } from './relationships.ts'

/** FastAPI transport and catalog resource limits for the Host plugin. */
export interface Config {
  /** Absolute FastAPI origin. */
  backendOrigin: string
  /** Host service credential; never sent to Browser or model. */
  serviceToken: string
  /** Maximum complete catalog entries; oversized responses fail closed. */
  maxCatalogEntries: number
  /** Registered provider used for real draft-test model calls. */
  testProvider: string
  /** Provider model used for real draft-test model calls. */
  testModel: string
}
/** Required deployment settings; catalog bounds have no implicit fallback. */
export const Config: z<Config> = z.object({
  backendOrigin: z.string().required(), serviceToken: z.string().required(), maxCatalogEntries: z.number().required(),
  testProvider: z.string().pattern(/\S/).required(), testModel: z.string().pattern(/\S/).required(),
})
/** Cordis function plugin name. */
export const name = 'xagent-business-skill'
/** Registry, Session and Agent lifecycle consumed by the provider. */
export const inject = ['agents', 'sessions', 'skills', 'tools', 'systemPrompt']

const PROVIDER = 'xagent-project'
const REMOTE_ERRORS = new Set([
  'unauthenticated', 'forbidden', 'not-found', 'stale-permission', 'idempotency-conflict', 'service-unavailable',
  'business-skill-input-invalid', 'business-skill-revision-conflict', 'business-skill-test-required',
  'business-skill-policy-changed', 'business-skill-not-authorized', 'business-skill-retired',
  'business-skill-conflict', 'business-skill-tool-denied', 'business-skill-test-read-only', 'business-skill-version-changed',
])
type ProjectScope = XAgentAuthenticatedSessionRequestScope & {
  readonly visibility: 'project'
  readonly projectId: string
  readonly requestSignal: AbortSignal
  readonly connectionSignal: AbortSignal
}
interface RequestState {
  readonly scope: ProjectScope
  readonly lifetime: AbortController
  readonly registrations: Set<Registration>
  readonly pending: Set<Promise<unknown>>
  readonly prompt: boolean
  readonly cleanups: Set<() => void>
  closing: Promise<void> | undefined
}
interface Registration {
  readonly agent: Agent
  readonly state: RequestState
  readonly provider: SkillProvider
  readonly control: SkillProviderControl
  readonly close: () => Promise<void>
  readonly policy: BusinessSkillRuntimePolicy
}
interface LoadedOwner { readonly registration: Registration; readonly version: XAgentBusinessSkillLoad }

function failure(code = 'service-unavailable'): TypertRemoteFailure {
  return new TypertRemoteFailure({ code, message: 'XAgent Business Skill request failed', details: {} })
}
function eligible(scope: XAgentAuthenticatedSessionRequestScope): scope is ProjectScope {
  return isXAgentAuthenticatedSessionRequestScope(scope)
    && scope.visibility === 'project' && scope.purpose === 'conversation'
    && scope.requestSignal instanceof AbortSignal && !scope.requestSignal.aborted
    && scope.connectionSignal instanceof AbortSignal && !scope.connectionSignal.aborted
}
declare module '@deepseek-ai/cordis' {
  interface Context { xagentBusinessSkill: XAgentBusinessSkillService }
}

/** Service Definition for authenticated discovery and exact-version runtime Consumers. */
export abstract class XAgentBusinessSkillService extends Service
  implements XAgentBusinessSkillScopeRunner, XAgentBusinessSkillRemote {
  constructor(ctx: Context) { super(ctx, 'xagentBusinessSkill') }
  /**
   * Bind all provider and Remote work to one physical request.
   * @param scope - backend-derived conversation Project Session authority.
   * @param operation - operation whose settlement expires the request.
   * @returns result or stable failure after owned backend work settles, without retaining request authority.
   */
  abstract withRequest<T>(scope: XAgentAuthenticatedSessionRequestScope, operation: () => Promise<T>): Promise<T>
  /**
   * Admit one prompt without delaying its RPC receipt while retaining authority for its accepted turn.
   * @param scope - backend-derived conversation Project Session authority.
   * @param operation - prompt admission operation that inserts the exact owned message.
   * @returns prompt admission result; accepted Agent work continues under the captured scope.
   */
  abstract withPrompt<T>(scope: XAgentAuthenticatedSessionRequestScope, operation: () => Promise<T>): Promise<T>
  /**
   * Install this request's provider in the exact Agent scope; repeated attachment is idempotent.
   * @param agent - Agent whose Session must match the current request.
   * @returns provider or undefined outside eligible requests or after Agent disposal.
   */
  abstract attach(agent: Agent): SkillProvider | undefined
  /**
   * Recover private version information for an owned immutable loaded definition.
   * @param agent - exact receiving Agent.
   * @param definition - exact returned definition, never reconstructed metadata.
   * @returns Host-private version while its registration is live, otherwise undefined.
   */
  abstract loadedVersion(agent: Agent, definition: SkillDefinition): XAgentBusinessSkillLoad | undefined
  /**
   * Register the isolated executor before the test Remote may create a backend run.
   * @param runner - Host-only executor owning admission and settlement.
   * @returns effect disposer; duplicate registration fails and disposal disables testing.
   */
  abstract registerTestRunner(runner: XAgentBusinessSkillTestRunner): () => void
  /**
   * List the current project's bounded public catalog.
   * @param projectId - Selected project ID, checked against backend-derived request scope.
   * @param sessionId - Ordinary runtime Session ID belonging to the selected project.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract list(projectId: string, sessionId: string,
    input: { readonly limit?: number; readonly cursor?: string }, signal?: AbortSignal): Promise<XAgentBusinessSkillPage>
  /**
   * Read the Skill's bounded draft, version, test and audit records.
   * @param projectId - Selected project ID, checked against backend-derived request scope.
   * @param sessionId - Ordinary runtime Session ID belonging to the selected project.
   * @param slug - Project-local public Skill name.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract detail(
    projectId: string, sessionId: string,
    slug: string,
    input: { readonly limit?: number; readonly versionCursor?: number; readonly runCursor?: number },
    signal?: AbortSignal,
  ): Promise<XAgentBusinessSkillDetail>
  /**
   * Create a draft under current backend authorization.
   * @param projectId - Selected project ID, checked against backend-derived request scope.
   * @param sessionId - Ordinary runtime Session ID belonging to the selected project.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract create(projectId: string, sessionId: string,
    input: XAgentBusinessSkillCreateInput, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
  /**
   * Update only the expected mutable draft revision.
   * @param projectId - Selected project ID, checked against backend-derived request scope.
   * @param sessionId - Ordinary runtime Session ID belonging to the selected project.
   * @param slug - Project-local public Skill name.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract draft(projectId: string, sessionId: string,
    slug: string, input: XAgentBusinessSkillDraftInput, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
  /**
   * Execute one isolated test; unavailable without a dedicated runner.
   * @param projectId - Selected project ID, checked against backend-derived request scope.
   * @param sessionId - Ordinary runtime Session ID belonging to the selected project.
   * @param slug - Project-local public Skill name.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract test(projectId: string, sessionId: string,
    slug: string, input: XAgentBusinessSkillTestInput, signal?: AbortSignal): Promise<XAgentBusinessSkillTest>
  /**
   * Read a dedicated test transcript through its public run number.
   * @param projectId - Selected project ID, checked against backend-derived request scope.
   * @param sessionId - Ordinary runtime Session ID belonging to the selected project.
   * @param slug - Project-local public Skill name.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param runNumber - Positive public test-run number.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract transcript(
    projectId: string, sessionId: string,
    slug: string,
    runNumber: number,
    input: { readonly afterSequence?: number; readonly limit?: number },
    signal?: AbortSignal,
  ): Promise<BusinessSkillRemoteTranscript>
  /**
   * Record a human verdict for an exact public test run.
   * @param projectId - Selected project ID, checked against backend-derived request scope.
   * @param sessionId - Ordinary runtime Session ID belonging to the selected project.
   * @param slug - Project-local public Skill name.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param runNumber - Positive public test-run number.
   * @param verdict - Human pass or reject verdict.
   * @param idempotencyKey - Key identifying this mutation intent.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract verdict(
    projectId: string, sessionId: string,
    slug: string,
    runNumber: number,
    verdict: XAgentBusinessSkillVerdict,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<XAgentBusinessSkillDetail>
  /**
   * Publish only an exact qualifying draft revision.
   * @param projectId - Selected project ID, checked against backend-derived request scope.
   * @param sessionId - Ordinary runtime Session ID belonging to the selected project.
   * @param slug - Project-local public Skill name.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param idempotencyKey - Key identifying this mutation intent.
   * @param expectedDraftRevision - Exact positive draft revision read by the caller.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract publish(
    projectId: string, sessionId: string,
    slug: string,
    expectedDraftRevision: number,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<XAgentBusinessSkillDetail>
  /**
   * Change stable-Skill authorization through backend Manager checks.
   * @param projectId - Selected project ID, checked against backend-derived request scope.
   * @param sessionId - Ordinary runtime Session ID belonging to the selected project.
   * @param slug - Project-local public Skill name.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param idempotencyKey - Key identifying this mutation intent.
   * @param authorized - Whether production invocation is authorized.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract authorization(
    projectId: string, sessionId: string,
    slug: string,
    authorized: boolean,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<XAgentBusinessSkillDetail>
  /**
   * Select an immutable historical public version as current.
   * @param projectId - Selected project ID, checked against backend-derived request scope.
   * @param sessionId - Ordinary runtime Session ID belonging to the selected project.
   * @param slug - Project-local public Skill name.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param idempotencyKey - Key identifying this mutation intent.
   * @param versionNumber - Positive immutable public version number.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract version(projectId: string, sessionId: string,
    slug: string, versionNumber: number, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
  /**
   * Retire the stable Skill permanently while preserving its history.
   * @param projectId - Selected project ID, checked against backend-derived request scope.
   * @param sessionId - Ordinary runtime Session ID belonging to the selected project.
   * @param slug - Project-local public Skill name.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param idempotencyKey - Key identifying this mutation intent.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract retire(projectId: string, sessionId: string,
    slug: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
}

/** FastAPI Provider with a generic Skill registry Consumer scoped to authenticated requests. */
export class FastApiBusinessSkillService extends XAgentBusinessSkillService {
  /** Explicit binding shared by source discovery and generated Remote clients. */
  readonly typertRemote = bindTypertRemote(this, 'xagentBusinessSkill')
  private readonly requests = new AsyncLocalStorage<RequestState>()
  private readonly lifetime = new AbortController()
  private readonly requestStates = new Set<RequestState>()
  private readonly registrations = new Map<Agent, Registration>()
  private readonly definitions = new WeakMap<SkillDefinition, LoadedOwner>()
  private readonly disposedAgents = new WeakSet<Agent>()
  private readonly pending = new Set<Promise<unknown>>()
  private testRunner: XAgentBusinessSkillTestRunner | undefined
  private readonly messages = new Map<string, { readonly agent: Agent; readonly state: RequestState }>()
  private readonly claimed = new Map<Agent, { readonly state: RequestState; readonly turn: number }>()
  private readonly invalidTurns = new WeakMap<Agent, number>()

  constructor(ctx: Context, private readonly backend: XAgentBusinessSkillBackend, private readonly limits: Pick<Config,
    'maxCatalogEntries'>) {
    super(ctx)
    if (!Number.isSafeInteger(limits.maxCatalogEntries) || limits.maxCatalogEntries < 1) throw new Error('maxCatalogEntries must be a positive safe integer')
    ctx.on('agent/session-start', ({ agent }) => { replaceCompletedInstructions(agent.session) })
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      const state = this.requests.getStore()
      if (state !== undefined && !state.lifetime.signal.aborted && String(agent.session.id) === `session-${state.scope.sessionId}`) {
        this.messages.set(String(message.id), { agent, state })
      }
    })
    ctx.on('agent/inbox/discarded', ({ message }) => {
      const owner = this.messages.get(String(message.id))
      this.messages.delete(String(message.id))
      if (owner?.state.prompt === true && !this.ownsPromptWork(owner.state)) void this.closeRequestState(owner.state)
    })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      const owner = this.messages.get(String(message.id))
      this.messages.delete(String(message.id))
      const previous = this.claimed.get(agent)
      if (this.invalidTurns.get(agent) === turn || owner?.agent !== agent || owner.state.lifetime.signal.aborted
        || (previous?.turn === turn && previous.state !== owner.state)) {
        this.invalidTurns.set(agent, turn)
        this.claimed.delete(agent)
        this.registrations.get(agent)?.policy.invalidate()
        return
      }
      this.claimed.set(agent, { state: owner.state, turn })
      this.requests.run(owner.state, () => this.attach(agent))
      this.registrations.get(agent)?.policy.claim(turn)
    })
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      this.registrations.get(agent)?.control.invalidate()
      return await next()
    })
    ctx.on('skill/loaded', ({ agent, definition, invocation }) => {
      if (definition.provider !== PROVIDER) return
      const owner = this.definitions.get(definition)
      const registration = this.registrations.get(agent)
      if (owner === undefined || owner.registration !== registration || this.claimed.get(agent)?.state !== registration.state) {
        throw failure('business-skill-not-authorized')
      }
      registration.policy.activate(definition, owner.version, invocation)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.disposedAgents.add(agent)
      const states = new Set<RequestState>()
      const claimed = this.claimed.get(agent)
      if (claimed !== undefined) states.add(claimed.state)
      this.claimed.delete(agent)
      for (const [id, owner] of this.messages) if (owner.agent === agent) {
        states.add(owner.state)
        this.messages.delete(id)
      }
      const registration = this.registrations.get(agent)
      if (registration !== undefined) states.add(registration.state)
      for (const state of states) {
        if (state.prompt) void this.closeRequestState(state)
      }
      if (registration !== undefined && !registration.state.prompt) void registration.close()
    })
    ctx.effect(() => async () => {
      this.lifetime.abort(failure('unauthenticated'))
      await Promise.allSettled([...this.requestStates].map(state => this.closeRequestState(state)))
      await Promise.allSettled(this.pending)
    }, 'business skill service lifetime')
  }

  async withRequest<T>(scope: XAgentAuthenticatedSessionRequestScope, operation: () => Promise<T>): Promise<T> {
    const state = this.createRequestState(scope, false)
    try {
      return await this.requests.run(state, () => runWithXAgentAuthenticatedRequestScope(scope, async () => {
        const result = await operation()
        state.lifetime.signal.throwIfAborted()
        return result
      }))
    } finally {
      await this.closeRequestState(state)
    }
  }

  async withPrompt<T>(scope: XAgentAuthenticatedSessionRequestScope, operation: () => Promise<T>): Promise<T> {
    const state = this.createRequestState(scope, true)
    const closeAtTurnEnd = this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      for (const [agent, owner] of this.claimed) {
        if (owner.state === state && owner.turn === event.data.turn && agent.session === session) {
          void this.closeRequestState(state)
          return
        }
      }
    })
    state.cleanups.add(closeAtTurnEnd)
    try {
      const result = await this.requests.run(state, async () => {
        const accepted = await operation()
        state.lifetime.signal.throwIfAborted()
        return accepted
      })
      if (!this.ownsPromptWork(state)) await this.closeRequestState(state)
      return result
    } catch (error) {
      await this.closeRequestState(state)
      throw error
    }
  }

  private createRequestState(scope: XAgentAuthenticatedSessionRequestScope, prompt: boolean): RequestState {
    if (this.lifetime.signal.aborted || !eligible(scope)) throw failure('unauthenticated')
    if (this.requests.getStore() !== undefined) throw failure('business-skill-conflict')
    const state: RequestState = {
      scope,
      lifetime: new AbortController(),
      registrations: new Set(),
      pending: new Set(),
      prompt,
      cleanups: new Set(),
      closing: undefined,
    }
    this.requestStates.add(state)
    const signals = [scope.requestSignal, scope.connectionSignal, this.lifetime.signal]
    const abort = (): void => { void this.closeRequestState(state) }
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true })
    state.cleanups.add(() => {
      for (const signal of signals) signal.removeEventListener('abort', abort)
    })
    return state
  }

  private ownsPromptWork(state: RequestState): boolean {
    return [...this.messages.values()].some(owner => owner.state === state)
      || [...this.claimed.values()].some(owner => owner.state === state)
  }

  private closeRequestState(state: RequestState): Promise<void> {
    if (state.closing !== undefined) return state.closing
    const settled = Promise.withResolvers<void>()
    state.closing = settled.promise
    state.lifetime.abort(failure('unauthenticated'))
    for (const cleanup of state.cleanups) cleanup()
    state.cleanups.clear()
    for (const [id, owner] of this.messages) if (owner.state === state) this.messages.delete(id)
    for (const [agent, owner] of this.claimed) if (owner.state === state) {
      this.invalidTurns.set(agent, owner.turn)
      this.claimed.delete(agent)
    }
    for (const registration of state.registrations) state.pending.add(registration.close())
    void Promise.allSettled([...state.pending]).then(() => {
      this.requestStates.delete(state)
      settled.resolve()
    })
    return state.closing
  }

  attach(agent: Agent): SkillProvider | undefined {
    const state = this.requests.getStore()
    if (state === undefined || state.lifetime.signal.aborted || this.lifetime.signal.aborted
      || this.disposedAgents.has(agent) || agent.ctx.fiber.state !== FiberState.ACTIVE || scopeOf(agent.ctx) !== agent
      || String(agent.session.id) !== `session-${state.scope.sessionId}`) return undefined
    const existing = this.registrations.get(agent)
    if (existing !== undefined) {
      if (existing.state !== state) throw failure('business-skill-conflict')
      return existing.provider
    }
    let candidates = new WeakMap<SkillCandidate, XAgentBusinessSkillCatalogEntry>()
    const versions = new Map<string, XAgentBusinessSkillLoad>()
    const pending = new Set<Promise<unknown>>()
    let control!: SkillProviderControl
    const invoke = async <T>(operation: (scope: ProjectScope, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> => {
      const combined = AbortSignal.any(signal === undefined ? [control.signal] : [control.signal, signal])
      const result = this.requests.run(state, () => this.call(operation, combined))
      pending.add(result)
      try { return await result } finally { pending.delete(result) }
    }
    const valid = (): boolean => !state.lifetime.signal.aborted && !control.signal.aborted
      && (this.requests.getStore() === state || this.claimed.get(agent)?.state === state) && this.registrations.get(agent) === registration
    // invoke() settles before the provider continuation; cancellation can occur between them.
    const assertPublishable = (signal?: AbortSignal): void => {
      signal?.throwIfAborted()
      if (!valid()) throw failure('business-skill-not-authorized')
    }
    const provider: SkillProvider = {
      name: PROVIDER,
      list: async (options) => {
        if (!valid()) return { candidates: [], complete: true, cacheable: false }
        const rows = await invoke((scope, signal) =>
          this.backend.catalog(scope.userToken, scope.projectId, scope.sessionId, signal), options.signal)
        assertPublishable(options.signal)
        if (rows.length > this.limits.maxCatalogEntries || new Set(rows.map(row => row.slug)).size !== rows.length) throw failure()
        const observation: SkillCandidate[] = []
        for (const entry of [...rows].sort((a, b) => a.slug < b.slug ? -1 : 1)) {
          const locator: BusinessSkillLocator = Object.freeze({ kind: 'xagent-business-skill', slug: entry.slug,
            version: entry.versionNumber, opaqueLoadKey: randomUUID() as Branded<'BusinessSkillLoadKey'> })
          const candidate: SkillCandidate = Object.freeze({ name: entry.slug, description: entry.description,
            provider: PROVIDER, source: PROVIDER, invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
            rank: 0, locator })
          candidates.set(candidate, entry)
          observation.push(candidate)
        }
        return { candidates: observation, complete: true, cacheable: false }
      },
      get: async (candidate, options) => {
        if (!valid()) return undefined
        const entry = candidates.get(candidate)
        if (entry === undefined) return undefined
        const pinned = await registration.policy.reload(entry.slug, options.signal)
        assertPublishable(options.signal)
        if (pinned !== undefined) return pinned
        const version = await invoke((scope, signal) => this.backend.load(scope.userToken, scope.projectId,
          scope.sessionId, entry.slug, entry.versionKey, signal), options.signal)
        assertPublishable(options.signal)
        if (version.slug !== entry.slug || version.versionNumber !== entry.versionNumber
          || version.versionKey !== entry.versionKey || version.description !== entry.description) throw failure()
        const previous = versions.get(version.versionKey)
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(version)) throw failure()
        const immutable = Object.freeze({ ...version, completeTools: Object.freeze([...version.completeTools]) })
        versions.set(version.versionKey, immutable)
        const definition: SkillDefinition = Object.freeze({ name: candidate.name, description: candidate.description,
          provider: PROVIDER, source: PROVIDER, invocation: candidate.invocation, content: immutable.instructions })
        this.definitions.set(definition, { registration, version: immutable })
        return definition
      },
    }
    const registry: SkillRegistry | undefined = agent.ctx.get('skills')
    if (registry === undefined) throw new Error('Business Skill provider requires the Skill registry')
    const runtime = agent.ctx.get('tools')
    if (runtime === undefined) throw new Error('Business Skill provider requires the Tool runtime')
    const dispose = registry.registerProvider((value) => { control = value; return provider })
    const policy = new BusinessSkillRuntimePolicy(agent, runtime, (version, tool, signal) => invoke((scope, signal) =>
      this.backend.authorizeTool(scope.userToken, scope.projectId, scope.sessionId, version.slug,
        version.versionKey, version.toolPolicyDigest, tool, signal.aborted, signal), signal),
    AbortSignal.any([state.lifetime.signal, control.signal]))
    const close = agent.ctx.effect(() => async () => {
      const closing = policy.closeRequest()
      dispose()
      await closing
      await Promise.allSettled(pending)
    }, 'business skill provider lifetime')
    const registration: Registration = { agent, state, provider, control, close, policy }
    this.registrations.set(agent, registration)
    state.registrations.add(registration)
    const removed = (): void => {
      candidates = new WeakMap()
      versions.clear()
      this.registrations.delete(agent)
      state.registrations.delete(registration)
    }
    control.signal.addEventListener('abort', removed, { once: true })
    return provider
  }

  loadedVersion(agent: Agent, definition: SkillDefinition): XAgentBusinessSkillLoad | undefined {
    const owner = this.definitions.get(definition)
    return owner?.registration.agent === agent
      && this.registrations.get(agent) === owner.registration
      && (this.requests.getStore() === owner.registration.state || this.claimed.get(agent)?.state === owner.registration.state)
      ? owner.version : undefined
  }

  registerTestRunner(runner: XAgentBusinessSkillTestRunner): () => void {
    if (this.testRunner !== undefined) throw new Error('Business Skill test runner already registered')
    const dispose = this.ctx.effect(() => {
      this.testRunner = runner
      return () => { this.testRunner = undefined }
    }, 'business skill test runner')
    return () => { void dispose() }
  }

  @Remote
  async list(projectId: string, sessionId: string,
    input: { readonly limit?: number; readonly cursor?: string }, signal?: AbortSignal): Promise<XAgentBusinessSkillPage> {
    return this.remoteCall(projectId, sessionId, (scope, signal) => this.backend.list(scope.userToken, scope.projectId,
      input, signal), signal)
  }
  @Remote
  async detail(
    projectId: string, sessionId: string,
    slug: string,
    input: { readonly limit?: number; readonly versionCursor?: number; readonly runCursor?: number },
    signal?: AbortSignal,
  ): Promise<XAgentBusinessSkillDetail> {
    return this.remoteCall(projectId, sessionId, (scope, signal) => this.backend.detail(scope.userToken, scope.projectId,
      slug, input, signal), signal)
  }
  @Remote
  async create(projectId: string, sessionId: string,
    input: XAgentBusinessSkillCreateInput, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail> {
    return this.remoteCall(projectId, sessionId, (scope, signal) => this.backend.create(scope.userToken, scope.projectId,
      input, signal), signal)
  }
  @Remote
  async draft(projectId: string, sessionId: string,
    slug: string, input: XAgentBusinessSkillDraftInput, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail> {
    return this.remoteCall(projectId, sessionId, (scope, signal) => this.backend.draft(scope.userToken, scope.projectId,
      slug, input, signal), signal)
  }
  @Remote
  async test(projectId: string, sessionId: string,
    slug: string, input: XAgentBusinessSkillTestInput, signal?: AbortSignal): Promise<XAgentBusinessSkillTest> {
    return this.remoteCall(projectId, sessionId, (_scope, signal) => {
      if (this.testRunner === undefined) throw failure()
      return this.testRunner.run(slug, input, signal)
    }, signal)
  }
  @Remote
  async transcript(
    projectId: string, sessionId: string,
    slug: string,
    runNumber: number,
    input: { readonly afterSequence?: number; readonly limit?: number },
    signal?: AbortSignal,
  ): Promise<BusinessSkillRemoteTranscript> {
    return this.remoteCall(projectId, sessionId, async (scope, signal) => {
      const page = await this.backend.transcript(scope.userToken, scope.projectId, slug, runNumber, input, signal)
      const events = page.events.map((event) => {
        if (!isJsonValue(event.payload)) throw failure()
        // The Session validator returns boolean rather than a narrowing predicate.
        return { ...event, payload: event.payload as JsonValue }
      })
      return { ...page, events }
    }, signal)
  }
  @Remote
  async verdict(
    projectId: string, sessionId: string,
    slug: string,
    runNumber: number,
    verdict: XAgentBusinessSkillVerdict,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<XAgentBusinessSkillDetail> {
    return this.remoteCall(projectId, sessionId, (scope, signal) =>
      this.backend.verdict(scope.userToken, scope.projectId, slug, runNumber, verdict, idempotencyKey, signal), signal)
  }
  @Remote
  async publish(
    projectId: string, sessionId: string,
    slug: string,
    expectedDraftRevision: number,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<XAgentBusinessSkillDetail> {
    return this.remoteCall(projectId, sessionId, (scope, signal) =>
      this.backend.publish(scope.userToken, scope.projectId, slug, expectedDraftRevision, idempotencyKey, signal), signal)
  }
  @Remote
  async authorization(projectId: string, sessionId: string,
    slug: string, authorized: boolean, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail> {
    return this.remoteCall(projectId, sessionId, (scope, signal) =>
      this.backend.authorization(scope.userToken, scope.projectId, slug, authorized, idempotencyKey, signal), signal)
  }
  @Remote
  async version(projectId: string, sessionId: string,
    slug: string, versionNumber: number, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail> {
    return this.remoteCall(projectId, sessionId, (scope, signal) =>
      this.backend.version(scope.userToken, scope.projectId, slug, versionNumber, idempotencyKey, signal), signal)
  }
  @Remote
  async retire(projectId: string, sessionId: string,
    slug: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail> {
    return this.remoteCall(projectId, sessionId, (scope, signal) => this.backend.retire(scope.userToken, scope.projectId,
      slug, idempotencyKey, signal), signal)
  }

  private remoteCall<T>(projectId: string, sessionId: string,
    operation: (scope: ProjectScope, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.call((scope, signal) => {
      if (projectId.toLowerCase() !== scope.projectId || sessionId.toLowerCase() !== `session-${scope.sessionId}`) throw failure('unauthenticated')
      return operation(scope, signal)
    }, signal)
  }

  private async call<T>(operation: (scope: ProjectScope, signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
    const state = this.requests.getStore()
    if (state === undefined || state.lifetime.signal.aborted || this.lifetime.signal.aborted) throw failure('unauthenticated')
    const signal = AbortSignal.any([state.lifetime.signal, this.lifetime.signal, ...(callerSignal === undefined ? [] : [callerSignal])])
    signal.throwIfAborted()
    const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(state.scope, signal) })
    this.pending.add(pending)
    state.pending.add(pending)
    try {
      const result = await pending
      signal.throwIfAborted()
      return result
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof TypertRemoteFailure) throw error
      throw failure(error instanceof XAgentBackendError && REMOTE_ERRORS.has(error.code) ? error.code : 'service-unavailable')
    } finally {
      this.pending.delete(pending)
      state.pending.delete(pending)
    }
  }
}

/** Install the capability with explicit transport and catalog limits. */
export function apply(ctx: Context, config: Config): void {
  const backend = new XAgentBackendClient({ origin: config.backendOrigin, serviceToken: config.serviceToken }).businessSkills
  const service = new FastApiBusinessSkillService(ctx, backend, config)
  ctx.inject(['sessionPersistence'], (child) => {
    if (!(child.sessionPersistence instanceof XAgentSessionPersistence)) return
    const runner = new BusinessSkillTestRunner(child, backend, child.sessionPersistence,
      { provider: config.testProvider, model: config.testModel })
    child.effect(() => service.registerTestRunner(runner), 'business skill test executor')
  })
}
