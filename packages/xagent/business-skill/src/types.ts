/** Public governance and Host-owned Business Skill capability types. @module @xagent/dsh-business-skill/types */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { XAgentAuthenticatedSessionRequestScope } from '@xagent/dsh-principal'
import type {
  XAgentBusinessSkillTest, XAgentBusinessSkillTestInput, XAgentBusinessSkillPage,
  XAgentBusinessSkillDetail, XAgentBusinessSkillCreateInput, XAgentBusinessSkillDraftInput,
  XAgentBusinessSkillVerdict,
} from '@xagent/dsh-backend-client'

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
   * @returns downstream result, rejecting invalid, nested, cancelled and disposed requests.
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

/** Browser governance operations; no Principal, project, Session or database identifier arguments. */
export interface XAgentBusinessSkillRemote {
  /**
   * List the current project's bounded public catalog.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  list(input: { readonly limit?: number; readonly cursor?: string }, signal?: AbortSignal): Promise<XAgentBusinessSkillPage>
  /**
   * Read the Skill's bounded draft, version, test and audit records.
   * @param slug - Project-local public Skill name.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  detail(
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
  create(input: XAgentBusinessSkillCreateInput, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
  /**
   * Update only the expected mutable draft revision.
   * @param slug - Project-local public Skill name.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  draft(slug: string, input: XAgentBusinessSkillDraftInput, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
  /**
   * Execute one isolated test; unavailable without a dedicated runner.
   * @param slug - Project-local public Skill name.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  test(slug: string, input: XAgentBusinessSkillTestInput, signal?: AbortSignal): Promise<XAgentBusinessSkillTest>
  /**
   * Read a dedicated test transcript through its public run number.
   * @param slug - Project-local public Skill name.
   * @param input - Public pagination or mutation fields.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param runNumber - Positive public test-run number.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  transcript(
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
  verdict(
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
  publish(slug: string, expectedDraftRevision: number, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
  /**
   * Change stable-Skill authorization through backend Manager checks.
   * @param slug - Project-local public Skill name.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param idempotencyKey - Key identifying this mutation intent.
   * @param authorized - Whether production invocation is authorized.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  authorization(slug: string, authorized: boolean, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
  /**
   * Select an immutable historical public version as current.
   * @param slug - Project-local public Skill name.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param idempotencyKey - Key identifying this mutation intent.
   * @param versionNumber - Positive immutable public version number.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  version(slug: string, versionNumber: number, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
  /**
   * Retire the stable Skill permanently while preserving its history.
   * @param slug - Project-local public Skill name.
   * @param signal - Optional caller cancellation, combined with the physical request.
   * @param idempotencyKey - Key identifying this mutation intent.
   * @returns Public backend records or a stable authorization, input or availability failure.
   */
  retire(slug: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentBusinessSkillDetail>
}
