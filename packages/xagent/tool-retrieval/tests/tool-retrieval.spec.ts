import { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  XAgentRetrieval,
  XAgentRetrievalError,
  type XAgentAccessibleProjects,
  type XAgentArtifactSearch,
  type XAgentListAccessibleProjectsInput,
  type XAgentSearchArtifactsInput,
} from '@xagent/dsh-retrieval'
import { describe, expect, test, vi } from 'vitest'
import * as tool from '../src/index.ts'

class FakeRetrieval extends XAgentRetrieval {
  readonly receipts = undefined as never
  listAccessibleProjects = vi.fn(async (_input: XAgentListAccessibleProjectsInput): Promise<XAgentAccessibleProjects> => ({
    projects: [{ projectId: '00000000-0000-0000-0000-000000000401', name: 'Alpha' }], payloadHash: 'a'.repeat(64),
  }))
  searchArtifacts = vi.fn(async (_input: XAgentSearchArtifactsInput): Promise<XAgentArtifactSearch> => ({
    citations: [], payloadHash: 'b'.repeat(64),
  }))
}

function agent(): Agent {
  const session = Session.create(SessionId('session-00000000-0000-0000-0000-000000000701'))
  return { id: session.id, session } as unknown as Agent
}

async function setup(withService = true) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const service = withService ? new FakeRetrieval(ctx) : undefined
  const fiber = await ctx.plugin(tool)
  return { ctx, service, fiber }
}

describe('xagent retrieval tools', () => {
  test('registers exactly two closed schemas with ambiguity guidance and optional bounded project query', async () => {
    const { ctx } = await setup()
    const schemas = ctx.tools.schemas().filter(value => ['list_accessible_projects', 'search_artifacts'].includes(value.name))
    expect(schemas.map(value => value.name)).toEqual(['list_accessible_projects', 'search_artifacts'])
    expect(schemas[0]?.description).toMatch(/ask the user/i)
    expect(schemas[1]?.description).toMatch(/ask the user/i)
    expect(schemas[0]?.parameters).toMatchObject({ additionalProperties: false, properties: { query: { type: 'string' } } })
    expect(schemas[1]?.parameters).toMatchObject({
      additionalProperties: false,
      properties: { query: { type: 'string' }, project_ids: { type: 'array' }, include_private: { type: 'boolean' } },
    })
    expect(ctx.tools.get('list_accessible_projects')?.nativeOnly).toBe(true)
    expect(ctx.tools.get('search_artifacts')?.nativeOnly).toBe(true)
  })

  test('forwards the immutable agent Session and call identity and does not expose receipts', async () => {
    const { ctx, service } = await setup()
    const owner = agent()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('call-1'), name: 'list_accessible_projects', arguments: { query: 'alp' }, agent: owner,
    })
    expect(result.isError).toBe(false)
    expect(service?.listAccessibleProjects).toHaveBeenCalledOnce()
    const input = service?.listAccessibleProjects.mock.calls[0]?.[0]
    expect(input).toMatchObject({ sessionId: owner.session.id, toolCallId: 'call-1', query: 'alp' })
    expect(input?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.stringify(result)).not.toContain('receipt')
  })

  test('renders empty and populated citation results with closed public metadata', async () => {
    const { ctx, service } = await setup()
    const owner = agent()
    const discovery = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-discovery-default'),
      name: 'list_accessible_projects',
      arguments: {},
      agent: owner,
    })
    expect(discovery).toMatchObject({ isError: false })
    expect(service?.listAccessibleProjects.mock.calls[0]?.[0]).not.toHaveProperty('query')

    const empty = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-empty'),
      name: 'search_artifacts',
      arguments: { query: 'none' },
      agent: owner,
    })
    expect(empty).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: '未找到符合当前明确范围的资料证据。' }],
      meta: { kind: 'xagent-retrieval', payloadHash: 'b'.repeat(64), citations: [] },
    })
    expect(service?.searchArtifacts.mock.calls[0]?.[0]).toMatchObject({ includePrivate: false })
    expect(service?.searchArtifacts.mock.calls[0]?.[0]).not.toHaveProperty('projectIds')

    service?.searchArtifacts.mockResolvedValueOnce({
      citations: [{
        id: '[资料1]',
        artifactId: '00000000-0000-0000-0000-000000000501',
        versionId: '00000000-0000-0000-0000-000000000601',
        chunkId: '00000000-0000-0000-0000-000000000801',
        displayName: 'brief.md',
        versionNumber: 2,
        lineStart: 4,
        lineEnd: 7,
        text: 'evidence',
        scope: 'project',
      }],
      payloadHash: 'c'.repeat(64),
    })
    const populated = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-populated'),
      name: 'search_artifacts',
      arguments: { query: 'evidence', project_ids: ['00000000-0000-0000-0000-000000000401'], include_private: true },
      agent: owner,
    })
    expect(populated).toMatchObject({
      isError: false,
      meta: { kind: 'xagent-retrieval', payloadHash: 'c'.repeat(64), citations: ['[资料1]'] },
    })
    if (populated.isError || populated.content[0]?.type !== 'text') throw new Error('missing populated citation result')
    expect(JSON.parse(populated.content[0].text)).toEqual({
      citations: [{
        id: '[资料1]',
        artifact_id: '00000000-0000-0000-0000-000000000501',
        version_id: '00000000-0000-0000-0000-000000000601',
        chunk_id: '00000000-0000-0000-0000-000000000801',
        display_name: 'brief.md',
        version_number: 2,
        line_start: 4,
        line_end: 7,
        text: 'evidence',
        scope: 'project',
      }],
    })
  })

  test('fails closed when the service, owner, or backend operation is unavailable', async () => {
    const absent = await setup(false)
    const missing = await absent.ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('call-1'), name: 'list_accessible_projects', arguments: {}, agent: agent(),
    })
    expect(missing.isError).toBe(true)
    expect(JSON.stringify(missing)).toContain('service-unavailable')

    const missingSearch = await absent.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-missing-search'),
      name: 'search_artifacts',
      arguments: { query: 'q' },
      agent: agent(),
    })
    expect(JSON.stringify(missingSearch)).toContain('service-unavailable')

    const present = await setup()
    for (const name of ['list_accessible_projects', 'search_artifacts'] as const) {
      const agentless = await present.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId(`call-agentless-${name}`),
        name,
        arguments: name === 'search_artifacts' ? { query: 'q' } : {},
      })
      expect(JSON.stringify(agentless)).toContain('service-unavailable')
    }
    present.service?.searchArtifacts.mockRejectedValueOnce(new XAgentRetrievalError('retrieval-unavailable'))
    const failed = await present.ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('call-2'), name: 'search_artifacts', arguments: { query: 'q', project_ids: [], include_private: true }, agent: agent(),
    })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed)).toContain('retrieval-unavailable')
  })

  test('rejects undeclared scope fields at the runtime boundary', async () => {
    const { ctx, service } = await setup()
    const failed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-extra'),
      name: 'search_artifacts',
      arguments: { query: 'q', project_ids: [], include_private: true, project_id: 'alias' },
      agent: agent(),
    })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed)).toContain('INVALID_ARGS')
    expect(service?.searchArtifacts).not.toHaveBeenCalled()
  })

  test('unregisters both tools with its fiber', async () => {
    const { ctx, fiber } = await setup()
    await fiber.dispose()
    expect(ctx.tools.schemas().some(value => value.name === 'list_accessible_projects' || value.name === 'search_artifacts')).toBe(false)
  })
})
