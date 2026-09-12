/** Host-private identity relationships shared by admission and bundle diagnostics. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'

/** Exact mounted run declaration; neither public Skill metadata nor matching IDs establish ownership. */
export interface BusinessSkillTestOwner {
  readonly definition: SkillDefinition
  readonly runNumber: number
  readonly tools: readonly string[]
  readonly claimed: () => boolean
}

interface PolicyOwner {
  readonly definition: SkillDefinition
  readonly tools: readonly string[]
  readonly denied: () => boolean
  readonly test: BusinessSkillTestOwner | undefined
}
const tests = new WeakMap<Agent, BusinessSkillTestOwner>()
const policies = new WeakMap<Agent, PolicyOwner>()

/** Immutable selected tools and the current runtime latch for an owned definition. */
export interface BusinessSkillRelationship {
  readonly kind: 'production' | 'test'
  readonly tools: readonly string[]
  readonly activated: boolean
  readonly denied: boolean
}

/**
 * Declare the exact run allocated and mounted by the TestRunner until Agent disposal.
 * @param agent - Run's factory-created Agent.
 * @param definition - Exact draft definition supplied by its provider.
 * @param runNumber - Backend-owned public run number.
 * @param tools - Immutable backend test policy, excluding production writes.
 * @param claimed - Whether this factory won the backend mount.
 * @returns Private identity token passed to the same run's runtime policy.
 */
export function registerTestRelationship(agent: Agent, definition: SkillDefinition, runNumber: number,
  tools: readonly string[], claimed: () => boolean): BusinessSkillTestOwner {
  const owner = Object.freeze({ definition, runNumber, tools: Object.freeze([...tools]), claimed })
  agent.ctx.effect(() => {
    tests.set(agent, owner)
    return () => { if (tests.get(agent) === owner) tests.delete(agent) }
  }, 'business skill test relationship')
  return owner
}

/**
 * Publish one actual policy admission without copying or modifying its denial latch.
 * @param agent - Agent owning the activated policy.
 * @param definition - Exact admitted definition.
 * @param tools - Tools retained by the runtime pin.
 * @param denied - Read the existing runtime policy's latched denial.
 * @param test - Exact TestRunner token for an isolated run, absent for production.
 * @returns Disposer expiring this admission at turn end or Agent disposal.
 */
export function registerPolicyRelationship(agent: Agent, definition: SkillDefinition, tools: readonly string[],
  denied: () => boolean, test: BusinessSkillTestOwner | undefined): () => void {
  const owner: PolicyOwner = { definition, tools: Object.freeze([...tools]), denied, test }
  const close = agent.ctx.effect(() => {
    policies.set(agent, owner)
    return () => { if (policies.get(agent) === owner) policies.delete(agent) }
  }, 'business skill policy relationship')
  return () => { void close() }
}

/**
 * Observe exact provider/run ownership and current policy state for diagnostics only.
 * @param agent - Actual receiving Agent; another Agent with the same IDs has no ownership.
 * @param definition - Exact loaded object; copies and earlier run definitions are rejected.
 * @returns Selected tools and live denial state, or undefined for unowned, unclaimed or mismatched admissions.
 */
export function businessSkillRelationship(agent: Agent, definition: SkillDefinition): BusinessSkillRelationship | undefined {
  const policy = policies.get(agent)
  if (definition.provider === 'xagent-draft') {
    const run = tests.get(agent)
    if (run === undefined || run.definition !== definition || !run.claimed()
      || (policy !== undefined && (policy.definition !== definition || policy.test !== run))) return undefined
    return { kind: 'test', tools: run.tools, activated: policy !== undefined, denied: policy?.denied() ?? false }
  }
  if (policy === undefined || policy.definition !== definition || policy.test !== undefined) return undefined
  return { kind: 'production', tools: policy.tools, activated: true, denied: policy.denied() }
}
