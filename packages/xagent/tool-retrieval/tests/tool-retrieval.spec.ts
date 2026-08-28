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

  test('fails closed when the service, owner, or backend operation is unavailable', async () => {
    const absent = await setup(false)
    const missing = await absent.ctx.tools.execute({
      signal: new AbortController().signal, callId: CallId('call-1'), name: 'list_accessible_projects', arguments: {}, agent: agent(),
    })
    expect(missing.isError).toBe(true)
    expect(JSON.stringify(missing)).toContain('service-unavailable')

    const present = await setup()
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
