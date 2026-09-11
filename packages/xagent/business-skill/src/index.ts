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

export type * from './types.ts'

/** FastAPI transport and catalog resource limits for the Host plugin. */
export interface Config {
  /** Absolute FastAPI origin. */
  backendOrigin: string
  /** Host service credential; never sent to Browser or model. */
  serviceToken: string
  /** Maximum complete catalog entries; oversized responses fail closed. */
  maxCatalogEntries: number
}
/** Required deployment settings; catalog bounds have no implicit fallback. */
export const Config: z<Config> = z.object({
  backendOrigin: z.string().required(), serviceToken: z.string().required(), maxCatalogEntries: z.number().required(),
})
/** Cordis function plugin name. */
export const name = 'xagent-business-skill'
/** Registry and Agent lifecycle consumed by the provider. */
export const inject = ['agents', 'skills']

const PROVIDER = 'xagent-project'
const REMOTE_ERRORS = new Set([
  'unauthenticated', 'forbidden', 'not-found', 'stale-permission', 'idempotency-conflict', 'service-unavailable',
  'business-skill-input-invalid', 'business-skill-revision-conflict', 'business-skill-test-required',
  'business-skill-policy-changed', 'business-skill-not-authorized', 'business-skill-retired',
  'business-skill-conflict', 'business-skill-tool-denied', 'business-skill-test-read-only',
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
}
interface Registration {
  readonly agent: Agent
  readonly state: RequestState
  readonly provider: SkillProvider
  readonly control: SkillProviderControl
  readonly close: () => void
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
   * @returns result or stable failure without retaining request authority.
   */
  abstract withRequest<T>(scope: XAgentAuthenticatedSessionRequestScope, operation: () => Promise<T>): Promise<T>
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
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract list(input: { readonly limit?: number; readonly cursor?: string }, signal?: AbortSignal): Promise<XAgentBusinessSkillPage>
  /**
   * Read the Skill's bounded draft, version, test and audit records.
   * @param slug - Project-local public Skill name.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract detail(
    slug: string,
    input: { readonly limit?: number; readonly versionCursor?: number; readonly runCursor?: number },
    signal?: AbortSignal,
  ): Promise<XAgentBusinessSkillDetail>
  /**
   * Create a draft under current backend authorization.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract create(input: XAgentBusinessSkillCreateInput, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
  /**
   * Update only the expected mutable draft revision.
   * @param slug - Project-local public Skill name.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract draft(slug: string, input: XAgentBusinessSkillDraftInput, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
  /**
   * Execute one isolated test; unavailable without a dedicated runner.
   * @param slug - Project-local public Skill name.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract test(slug: string, input: XAgentBusinessSkillTestInput, signal?: AbortSignal): Promise<XAgentBusinessSkillTest>
  /**
   * Read a dedicated test transcript through its public run number.
   * @param slug - Project-local public Skill name.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param runNumber - Positive public test-run number.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract transcript(
    slug: string,
    runNumber: number,
    input: { readonly afterSequence?: number; readonly limit?: number },
    signal?: AbortSignal,
  ): Promise<BusinessSkillRemoteTranscript>
  /**
   * Record a human verdict for an exact public test run.
   * @param slug - Project-local public Skill name.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param runNumber - Positive public test-run number.
   * @param verdict - Human pass or reject verdict.
   * @param idempotencyKey - Key identifying this mutation intent.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract verdict(
    slug: string,
    runNumber: number,
    verdict: XAgentBusinessSkillVerdict,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<XAgentBusinessSkillDetail>
  /**
   * Publish only an exact qualifying draft revision.
   * @param slug - Project-local public Skill name.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param idempotencyKey - Key identifying this mutation intent.
   * @param expectedDraftRevision - Exact positive draft revision read by the caller.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract publish(
    slug: string,
    expectedDraftRevision: number,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<XAgentBusinessSkillDetail>
  /**
   * Change stable-Skill authorization through backend Manager checks.
   * @param slug - Project-local public Skill name.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param idempotencyKey - Key identifying this mutation intent.
   * @param authorized - Whether production invocation is authorized.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract authorization(
    slug: string,
    authorized: boolean,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<XAgentBusinessSkillDetail>
  /**
   * Select an immutable historical public version as current.
   * @param slug - Project-local public Skill name.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param idempotencyKey - Key identifying this mutation intent.
   * @param versionNumber - Positive immutable public version number.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract version(slug: string, versionNumber: number, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
  /**
   * Retire the stable Skill permanently while preserving its history.
   * @param slug - Project-local public Skill name.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param idempotencyKey - Key identifying this mutation intent.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  abstract retire(slug: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
}

/** FastAPI Provider with a generic Skill registry Consumer scoped to authenticated requests. */
export class FastApiBusinessSkillService extends XAgentBusinessSkillService {
  /** Explicit binding shared by source discovery and generated Remote clients. */
  readonly typertRemote = bindTypertRemote(this, 'xagentBusinessSkill')
  private readonly requests = new AsyncLocalStorage<RequestState>()
  private readonly lifetime = new AbortController()
  private readonly registrations = new Map<Agent, Registration>()
  private readonly definitions = new WeakMap<SkillDefinition, LoadedOwner>()
  private readonly disposedAgents = new WeakSet<Agent>()
  private readonly pending = new Set<Promise<unknown>>()
  private testRunner: XAgentBusinessSkillTestRunner | undefined

  constructor(ctx: Context, private readonly backend: XAgentBusinessSkillBackend, private readonly limits: Pick<Config, 'maxCatalogEntries'>) {
    super(ctx)
    if (!Number.isSafeInteger(limits.maxCatalogEntries) || limits.maxCatalogEntries < 1) throw new Error('maxCatalogEntries must be a positive safe integer')
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      this.attach(agent)
      this.registrations.get(agent)?.control.invalidate()
      return await next()
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.disposedAgents.add(agent)
      this.registrations.get(agent)?.close()
    })
    ctx.effect(() => async () => {
      this.lifetime.abort(failure('unauthenticated'))
      for (const registration of this.registrations.values()) registration.close()
      await Promise.allSettled(this.pending)
    }, 'business skill service lifetime')
  }

  async withRequest<T>(scope: XAgentAuthenticatedSessionRequestScope, operation: () => Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted || !eligible(scope)) throw failure('unauthenticated')
    if (this.requests.getStore() !== undefined) throw failure('business-skill-conflict')
    const state: RequestState = { scope, lifetime: new AbortController(), registrations: new Set() }
    const end = (): void => {
      state.lifetime.abort(failure('unauthenticated'))
      for (const registration of state.registrations) registration.close()
    }
    const signals = [scope.requestSignal, scope.connectionSignal, this.lifetime.signal]
    for (const signal of signals) signal.addEventListener('abort', end, { once: true })
    try {
      return await this.requests.run(state, () => runWithXAgentAuthenticatedRequestScope(scope, async () => {
        const result = await operation()
        state.lifetime.signal.throwIfAborted()
        return result
      }))
    } finally {
      end()
      for (const signal of signals) signal.removeEventListener('abort', end)
    }
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
    let candidates = new Map<BusinessSkillLocator, { candidate: SkillCandidate; entry: XAgentBusinessSkillCatalogEntry }>()
    const versions = new Map<string, XAgentBusinessSkillLoad>()
    let generation = 0
    let control!: SkillProviderControl
    const valid = (): boolean => !state.lifetime.signal.aborted && !control.signal.aborted
      && this.requests.getStore() === state && this.registrations.get(agent) === registration
    const provider: SkillProvider = {
      name: PROVIDER,
      list: async (options) => {
        if (!valid()) return { candidates: [], complete: true, cacheable: false }
        candidates.clear()
        const revision = ++generation
        const rows = await this.call((scope, signal) =>
          this.backend.catalog(scope.userToken, scope.projectId, scope.sessionId, signal), options.signal)
        if (!valid() || revision !== generation) throw failure('business-skill-not-authorized')
        if (rows.length > this.limits.maxCatalogEntries || new Set(rows.map(row => row.slug)).size !== rows.length) throw failure()
        const next = new Map<BusinessSkillLocator, { candidate: SkillCandidate; entry: XAgentBusinessSkillCatalogEntry }>()
        for (const entry of [...rows].sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)) {
          const locator: BusinessSkillLocator = Object.freeze({ kind: 'xagent-business-skill', slug: entry.slug,
            version: entry.versionNumber, opaqueLoadKey: randomUUID() as Branded<'BusinessSkillLoadKey'> })
          const candidate: SkillCandidate = Object.freeze({ name: entry.slug, description: entry.description,
            provider: PROVIDER, source: PROVIDER, invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
            rank: 0, locator })
          next.set(locator, { candidate, entry })
        }
        candidates = next
        return { candidates: [...next.values()].map(row => row.candidate), complete: true, cacheable: false }
      },
      get: async (candidate, options) => {
        if (!valid()) return undefined
        const owned = candidates.get(candidate.locator as BusinessSkillLocator)
        if (owned === undefined || owned.candidate !== candidate) return undefined
        const entry = owned.entry
        const version = await this.call((scope, signal) => this.backend.load(scope.userToken, scope.projectId,
          scope.sessionId, entry.slug, entry.versionKey, signal), options.signal)
        if (!valid() || candidates.get(candidate.locator as BusinessSkillLocator) !== owned) throw failure('business-skill-not-authorized')
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
    const dispose = registry.registerProvider((value) => { control = value; return provider })
    const close = (): void => { dispose() }
    const registration: Registration = { agent, state, provider, control, close }
    this.registrations.set(agent, registration)
    state.registrations.add(registration)
    const removed = (): void => {
      candidates.clear()
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
      && this.requests.getStore() === owner.registration.state
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
  async list(input: { readonly limit?: number; readonly cursor?: string }, signal?: AbortSignal): Promise<XAgentBusinessSkillPage> {
    return this.call((scope, signal) => this.backend.list(scope.userToken, scope.projectId, input, signal), signal)
  }
  @Remote
  async detail(
    slug: string,
    input: { readonly limit?: number; readonly versionCursor?: number; readonly runCursor?: number },
    signal?: AbortSignal,
  ): Promise<XAgentBusinessSkillDetail> {
    return this.call((scope, signal) => this.backend.detail(scope.userToken, scope.projectId, slug, input, signal), signal)
  }
  @Remote
  async create(input: XAgentBusinessSkillCreateInput, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail> {
    return this.call((scope, signal) => this.backend.create(scope.userToken, scope.projectId, input, signal), signal)
  }
  @Remote
  async draft(slug: string, input: XAgentBusinessSkillDraftInput, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail> {
    return this.call((scope, signal) => this.backend.draft(scope.userToken, scope.projectId, slug, input, signal), signal)
  }
  @Remote
  async test(slug: string, input: XAgentBusinessSkillTestInput, signal?: AbortSignal): Promise<XAgentBusinessSkillTest> {
    return this.call((_scope, signal) => {
      if (this.testRunner === undefined) throw failure()
      return this.testRunner.run(slug, input, signal)
    }, signal)
  }
  @Remote
  async transcript(
    slug: string,
    runNumber: number,
    input: { readonly afterSequence?: number; readonly limit?: number },
    signal?: AbortSignal,
  ): Promise<BusinessSkillRemoteTranscript> {
    return this.call(async (scope, signal) => {
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
    slug: string,
    runNumber: number,
    verdict: XAgentBusinessSkillVerdict,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<XAgentBusinessSkillDetail> {
    return this.call((scope, signal) =>
      this.backend.verdict(scope.userToken, scope.projectId, slug, runNumber, verdict, idempotencyKey, signal), signal)
  }
  @Remote
  async publish(
    slug: string,
    expectedDraftRevision: number,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<XAgentBusinessSkillDetail> {
    return this.call((scope, signal) =>
      this.backend.publish(scope.userToken, scope.projectId, slug, expectedDraftRevision, idempotencyKey, signal), signal)
  }
  @Remote
  async authorization(slug: string, authorized: boolean, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail> {
    return this.call((scope, signal) =>
      this.backend.authorization(scope.userToken, scope.projectId, slug, authorized, idempotencyKey, signal), signal)
  }
  @Remote
  async version(slug: string, versionNumber: number, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail> {
    return this.call((scope, signal) =>
      this.backend.version(scope.userToken, scope.projectId, slug, versionNumber, idempotencyKey, signal), signal)
  }
  @Remote
  async retire(slug: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail> {
    return this.call((scope, signal) => this.backend.retire(scope.userToken, scope.projectId, slug, idempotencyKey, signal), signal)
  }

  private async call<T>(operation: (scope: ProjectScope, signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
    const state = this.requests.getStore()
    if (state === undefined || state.lifetime.signal.aborted || this.lifetime.signal.aborted) throw failure('unauthenticated')
    const signal = AbortSignal.any([state.lifetime.signal, this.lifetime.signal, ...(callerSignal === undefined ? [] : [callerSignal])])
    signal.throwIfAborted()
    const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(state.scope, signal) })
    this.pending.add(pending)
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
    }
  }
}

/** Install the capability with explicit transport and catalog limits. */
export function apply(ctx: Context, config: Config): void {
  new FastApiBusinessSkillService(ctx,
    new XAgentBackendClient({ origin: config.backendOrigin, serviceToken: config.serviceToken }).businessSkills, config)
}
