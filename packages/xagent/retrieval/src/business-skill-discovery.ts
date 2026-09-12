/** Host-only project discovery pins scoped to one active Skill tool execution. @module @xagent/dsh-retrieval/business-skill-discovery */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { XAgentBusinessSkillDiscovery } from '@xagent/dsh-backend-client'

interface DiscoveryOwner {
  readonly agent: Agent
  readonly proof: XAgentBusinessSkillDiscovery
  readonly live: () => boolean
}
const owners = new WeakMap<Agent, DiscoveryOwner>()
const execution = new AsyncLocalStorage<DiscoveryOwner>()

/**
 * Bind fixed-project discovery to an admitted production version or isolated test run.
 * @param agent - Agent whose bound turn owns this permission.
 * @param proof - Backend-owned version or run identity, never model arguments.
 * @param live - Current binding and physical-request validity, rechecked during dispatch.
 * @returns Disposer removing discovery visibility and dispatch authority.
 */
export function bindBusinessSkillDiscovery(agent: Agent, proof: XAgentBusinessSkillDiscovery, live: () => boolean): () => void {
  const owner: DiscoveryOwner = { agent, proof: Object.freeze({ ...proof }), live }
  owners.set(agent, owner)
  const close = agent.ctx.on('tools/execute', (exec, next) => exec.name === 'list_accessible_projects'
    ? execution.run(owner, next) : next())
  return () => { close(); if (owners.get(agent) === owner) owners.delete(agent) }
}

/**
 * Check catalog eligibility without exposing the private execution proof.
 * @param agent - Exact Agent being assembled.
 * @returns Whether its current Skill binding permits fixed-project discovery.
 */
export function hasBusinessSkillDiscovery(agent: Agent): boolean {
  return owners.get(agent)?.live() === true
}

/**
 * Read a proof only inside its bound tool body and before its request expires.
 * @param sessionId - Exact runtime Session being read by the provider.
 * @returns Current Host proof or undefined outside an owned discovery execution.
 */
export function currentBusinessSkillDiscovery(sessionId: string): XAgentBusinessSkillDiscovery | undefined {
  const owner = execution.getStore()
  return owner !== undefined && String(owner.agent.session.id) === sessionId
    && owners.get(owner.agent) === owner && owner.live() ? owner.proof : undefined
}
