/** Public governance and Host-owned Business Skill capability types. @module @xagent/dsh-business-skill/types */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { XAgentAuthenticatedSessionRequestScope } from '@xagent/dsh-principal'
import type {
  XAgentBusinessSkillTest, XAgentBusinessSkillTestInput, XAgentBusinessSkillPage,
  XAgentBusinessSkillDetail, XAgentBusinessSkillCreateInput, XAgentBusinessSkillDraftInput,
  XAgentBusinessSkillVerdict,
} from '@xagent/dsh-backend-client'

/** Public, informational activation record; body reconstruction uses ordinary Session messages. */
export interface BusinessSkillActivatedEvent {
  readonly type: 'business-skill/activated'
  readonly data: {
    readonly slug: string
    readonly version: number
    readonly invocation: 'model-tool' | 'user-explicit'
    readonly turn: number
    readonly toolPolicyDigest: string
  }
}

/** Host-private immutable Skill choice for one Agent turn. */
export interface BusinessSkillTurnBinding {
  readonly slug: string
  readonly version: number
  readonly opaqueVersionKey: Branded<'BusinessSkillVersionKey'>
  readonly toolPolicyDigest: string
  readonly completeTools: ReadonlySet<string>
  readonly turn: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Informational activation; writers mark the envelope ignorable for older readers. */
    'business-skill/activated': BusinessSkillActivatedEvent['data']
  }
}

/** Browser transcript page with JSON-only event payloads and public run identity. */
export interface BusinessSkillRemoteTranscript {
  readonly test: XAgentBusinessSkillTest
  readonly events: readonly {
    readonly sequence: number
    readonly eventType: string
    readonly payload: JsonValue
    readonly createdAt: string
  }[]
  readonly nextSequence: number
}

/** An identity-comparable catalog handle owned by one Agent registration. */
export interface BusinessSkillLocator {
  readonly kind: 'xagent-business-skill'
  readonly slug: string
  readonly version: number
  readonly opaqueLoadKey: Branded<'BusinessSkillLoadKey'>
}

/** Host request authorizer; callers derive all Session facts from FastAPI. */
export interface XAgentBusinessSkillScopeRunner {
  /**
   * Run one physical request and dispose its providers on settlement.
   * @param scope - authenticated conversation Project Session with live cancellation signals.
   * @param operation - complete downstream operation; detached descendants lose authority on settlement.
   * @returns downstream result after owned backend work settles, rejecting invalid, nested, cancelled and disposed requests.
   */
  withRequest<T>(scope: XAgentAuthenticatedSessionRequestScope, operation: () => Promise<T>): Promise<T>
}

/** Dedicated test executor; owns test admission, execution and backend settlement. */
export interface XAgentBusinessSkillTestRunner {
  /**
   * Execute one isolated test in the current physical request.
   * @param slug - project-local public Skill name.
   * @param input - exact draft revision, policy digest, scenario and idempotency key.
   * @param signal - combined service, request, connection and caller cancellation.
   * @returns public test record after execution and settlement; internal Session identities remain private.
   */
  run(slug: string, input: XAgentBusinessSkillTestInput, signal: AbortSignal): Promise<XAgentBusinessSkillTest>
}

/** Browser governance operations bind selected Project/Session IDs to physical authority; Skill records use public names. */
export interface XAgentBusinessSkillRemote {
  /**
   * List the current project's bounded public catalog.
   * @param projectId - Selected project ID, checked against backend-derived request scope.
   * @param sessionId - Ordinary runtime Session ID belonging to the selected project.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  list(projectId: string, sessionId: string,
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
  detail(
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
  create(projectId: string, sessionId: string,
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
  draft(projectId: string, sessionId: string,
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
  test(projectId: string, sessionId: string,
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
  transcript(
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
  verdict(
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
  publish(projectId: string, sessionId: string,
    slug: string, expectedDraftRevision: number, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
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
  authorization(projectId: string, sessionId: string,
    slug: string, authorized: boolean, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
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
  version(projectId: string, sessionId: string,
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
  retire(projectId: string, sessionId: string,
    slug: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
}
