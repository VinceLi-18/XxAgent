/**
 * Package-owned invariant companion for `@xagent/dsh-business`.
 * @module @xagent/dsh-business/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from '@deepseek-ai/dsh-tool-skill'
import type {} from '@xagent/dsh-business-skill'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CITED_ANSWER_TOOL, XAgentRetrievalService } from '@xagent/dsh-retrieval'
import { isArtifactSearchTool } from '@xagent/dsh-tool-retrieval'

const PACKAGE_NAME = '@xagent/dsh-business'

/** Cordis companion plugin name. */
export const name = 'xagent-business-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/** Correlate admitted backend policies with the actual composed tool registry. */
const install: InvariantInstaller = (ctx, fail) => {
  const bindings = new Map<string, { agent: Agent; tools: readonly string[]; test: boolean; failed: boolean }>()
  ctx.on('skill/loaded', ({ agent, definition }) => {
    if (definition.provider !== 'xagent-project' && definition.provider !== 'xagent-draft') return
    const version = ctx.get('xagentBusinessSkill')?.loadedVersion(agent, definition)
    const permitted = definition.provider === 'xagent-draft'
      ? ['skill', 'list_accessible_projects', 'search_artifacts', CITED_ANSWER_TOOL]
      : version?.completeTools
    if (permitted === undefined) {
      return fail('assembled Business Skill requires its exact owned backend policy')
    }
    bindings.set(String(agent.session.id), { agent, tools: permitted, test: definition.provider === 'xagent-draft', failed: false })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') bindings.delete(String(session.id))
    if (event.type === 'tool/result' && event.data.message.content[0].isError) {
      const binding = bindings.get(String(session.id))
      if (binding !== undefined) binding.failed = true
    }
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => { bindings.delete(String(agent.session.id)) }, { global: true })
  ctx.on('llm/stream', (options, next) => {
    const binding = options.sessionId === undefined ? undefined : bindings.get(String(options.sessionId))
    if (binding === undefined) return next()
    const { agent, tools: permitted } = binding
    const mounted = (options.tools ?? []).map(tool => tool.name)
    if (!mounted.includes('skill') || mounted.some(tool => !permitted.includes(tool))) {
      fail('assembled Business Skill tools must belong to the admitted production or read-only test policy')
    }
    const runtime = agent.ctx.get('tools', true) as Agent['ctx']['tools']
    const search = runtime.get('search_artifacts', agent)
    const deferred = search !== undefined && isArtifactSearchTool(search)
      && agent.ctx.get('xagentRetrieval') instanceof XAgentRetrievalService
    if (!binding.test && !binding.failed && permitted.some(tool => !mounted.includes(tool)
      && !(tool === CITED_ANSWER_TOOL && deferred))) {
      fail('assembled Business Skill policy requires every mounted primary tool and its retrieval companion')
    }
    if (mounted.includes(CITED_ANSWER_TOOL) && !mounted.includes('search_artifacts')) {
      fail('assembled Business Skill cited-answer companion requires artifact search')
    }
    return next()
  }, { global: true, prepend: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
