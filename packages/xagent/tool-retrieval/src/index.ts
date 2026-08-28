/** Model-facing XAgent project discovery and read-only Artifact search. @module @xagent/dsh-tool-retrieval */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { XAgentRetrievalError, type XAgentArtifactSearch, type XAgentAccessibleProjects } from '@xagent/dsh-retrieval'

export const name = 'xagent-tool-retrieval'
export const inject = ['tools']

const PROJECT_DESCRIPTION = 'List up to 20 projects accessible to the current private session. '
  + 'Use the optional name query to narrow ambiguous names. Ask the user when names are ambiguous; never choose the first match automatically.'
const SEARCH_DESCRIPTION = 'Search authorized Artifact evidence for the current session. Private sessions require explicit project_ids and/or include_private=true; '
  + 'there is no implicit all-project scope. Ask the user when the intended projects or private scope are ambiguous.'

function unavailable(): XAgentRetrievalError {
  return new XAgentRetrievalError('service-unavailable')
}

function closeParameters(definition: ToolDefinition): ToolDefinition {
  definition.parameters.additionalProperties = false
  return definition
}

function projectPayload(value: XAgentAccessibleProjects): { projects: { project_id: string; name: string }[] } {
  return { projects: value.projects.map(project => ({ project_id: project.projectId, name: project.name })) }
}

function citationPayload(value: XAgentArtifactSearch): { citations: Record<string, string | number>[] } {
  return {
    citations: value.citations.map(citation => ({
      id: citation.id,
      artifact_id: citation.artifactId,
      version_id: citation.versionId,
      chunk_id: citation.chunkId,
      display_name: citation.displayName,
      version_number: citation.versionNumber,
      line_start: citation.lineStart,
      line_end: citation.lineEnd,
      text: citation.text,
      scope: citation.scope,
    })),
  }
}

const PROJECT_OUTPUT = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    projects: {
      type: 'array' as const, required: true,
      items: {
        type: 'object' as const, additionalProperties: false,
        properties: {
          projectId: { type: 'string' as const, required: true },
          name: { type: 'string' as const, required: true },
        },
      },
    },
    payloadHash: { type: 'string' as const, required: true },
  },
} as const

const CITATION_PROPERTIES = {
  id: { type: 'string' as const, required: true },
  artifactId: { type: 'string' as const, required: true },
  versionId: { type: 'string' as const, required: true },
  chunkId: { type: 'string' as const, required: true },
  displayName: { type: 'string' as const, required: true },
  versionNumber: { type: 'integer' as const, required: true },
  lineStart: { type: 'integer' as const, required: true },
  lineEnd: { type: 'integer' as const, required: true },
  text: { type: 'string' as const, required: true },
  scope: { type: 'string' as const, required: true, enum: ['private', 'project'] },
} as const

const SEARCH_OUTPUT = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    citations: {
      type: 'array' as const, required: true,
      items: { type: 'object' as const, additionalProperties: false, properties: CITATION_PROPERTIES },
    },
    payloadHash: { type: 'string' as const, required: true },
  },
} as const

/**
 * Register the two XAgent-only retrieval tools.
 * @param ctx - Cordis context with the tool runtime and optional retrieval service.
 * @returns Nothing; tool registrations follow the plugin fiber lifecycle.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(closeParameters(defineTool({
    name: 'list_accessible_projects',
    description: PROJECT_DESCRIPTION,
    parameters: {
      query: { type: 'string', description: 'Optional bounded project-name query.' },
    },
    output: {
      schema: PROJECT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(projectPayload(value)) }],
      presentationMeta: (_args, value) => ({ kind: 'xagent-retrieval', payloadHash: value.payloadHash, citations: [] }),
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw unavailable()
      const service = ctx.get('xagentRetrieval')
      if (service === undefined) throw unavailable()
      const value = await service.listAccessibleProjects({
        sessionId: exec.agent.session.id,
        toolCallId: String(exec.callId),
        ...args.query === undefined ? {} : { query: args.query },
        signal: exec.signal,
      })
      return { projects: value.projects.map(project => ({ ...project })), payloadHash: value.payloadHash }
    },
  })))

  ctx.tools.register(closeParameters(defineTool({
    name: 'search_artifacts',
    description: SEARCH_DESCRIPTION,
    parameters: {
      query: { type: 'string', required: true, description: 'Non-empty evidence query, at most 512 BGE tokens.' },
      project_ids: {
        type: 'array',
        description: 'Explicit Project UUIDs for a private session; at most 20 with no aliases or duplicates.',
        items: { type: 'string' },
      },
      include_private: { type: 'boolean', description: 'Explicitly include private Artifacts in a private session.' },
    },
    output: {
      schema: SEARCH_OUTPUT,
      render: (_args, value) => [{
        type: 'text',
        text: value.citations.length === 0
          ? '未找到符合当前明确范围的资料证据。'
          : JSON.stringify(citationPayload(value)),
      }],
      presentationMeta: (_args, value) => ({
        kind: 'xagent-retrieval',
        payloadHash: value.payloadHash,
        citations: value.citations.map(citation => citation.id),
      }),
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw unavailable()
      const service = ctx.get('xagentRetrieval')
      if (service === undefined) throw unavailable()
      const value = await service.searchArtifacts({
        sessionId: exec.agent.session.id,
        toolCallId: String(exec.callId),
        query: args.query,
        ...args.project_ids === undefined ? {} : { projectIds: args.project_ids },
        includePrivate: args.include_private ?? false,
        signal: exec.signal,
      })
      return { citations: value.citations.map(citation => ({ ...citation })), payloadHash: value.payloadHash }
    },
  })))
}
