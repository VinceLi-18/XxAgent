import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { XAgentBackendClient } from '@xagent/dsh-backend-client'
import { XAgentAuthorization } from '@xagent/dsh-authorization'
import { XAgentSessionPersistence } from '@xagent/dsh-session-persistence-api'
import { describe, expect, test } from 'vitest'
import { setup, request, projectId, sessionId, signal } from './fixtures.ts'

const governanceArgs: Record<string, object> = {
  list: { input: { limit: 3 } },
  detail: { slug: 'review', input: {} },
  create: { input: { slug: 'review', displayName: 'Review', description: 'Review', instructions: 'Review',
    primaryTools: [], idempotencyKey: 'key' } },
  draft: { slug: 'review', input: { expectedDraftRevision: 1, instructions: 'Review', idempotencyKey: 'key' } },
  test: { slug: 'review', input: { expectedDraftRevision: 1, toolPolicyDigest: 'a'.repeat(64),
    scenario: 'Review', idempotencyKey: 'key' } },
  transcript: { slug: 'review', runNumber: 1, input: {} },
  verdict: { slug: 'review', runNumber: 1, verdict: 'pass', idempotencyKey: 'key' },
  publish: { slug: 'review', expectedDraftRevision: 1, idempotencyKey: 'key' },
  authorization: { slug: 'review', authorized: true, idempotencyKey: 'key' },
  version: { slug: 'review', versionNumber: 1, idempotencyKey: 'key' },
  retire: { slug: 'review', idempotencyKey: 'key' },
}
const scopeCases = Object.keys(governanceArgs).flatMap(method => [
  'matching', 'missing', 'malformed', 'mismatch', 'missing-session', 'malformed-session', 'mismatched-session',
  'private', 'test', 'stale', 'no-request', 'cancelled', 'disconnected',
].map(variant => [method, variant] as const))

describe('Business Skill Remote physical scope', () => {
  test.each(['list', 'detail', 'create', 'draft', 'test', 'transcript', 'verdict', 'publish', 'authorization', 'version', 'retire'])('the generated %s descriptor rejects a mismatched scope before business work', async (method) => {
    const { ctx, service, calls } = await setup()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGateway)
    await service.withRequest(request(), async () => {
      await expect(ctx.typertGateway.invoke({ namespace: 'xagentBusinessSkill', method, args: { ...governanceArgs[method], projectId: 'different', sessionId: `session-${sessionId}` } })).rejects.toMatchObject({ failure: { code: 'unauthenticated' } })
    })
    expect(calls).toEqual([])
    await ctx.fiber.dispose()
  })
  test.each(['project', 'session'])('rejects a different %s before the Business backend executes', async (field) => {
    const { ctx, service, calls } = await setup()
    await service.withRequest(request(), async () => {
      await expect(service.list(field === 'project' ? 'other' : projectId, field === 'session' ? 'other' : `session-${sessionId}`, {})).rejects.toMatchObject({ failure: { code: 'unauthenticated' } })
    })
    expect(calls).toEqual([])
    await ctx.fiber.dispose()
  })

  test.each(scopeCases)('Gateway %s enforces %s scope through authorization and token persistence', async (method, variant) => {
    const { ctx, service, calls } = await setup()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGateway)
    service.registerTestRunner({ run: async () => (await service.transcript(projectId, `session-${sessionId}`, 'review', 1, {})).test })
    const tokens: string[] = []
    const backend = new XAgentBackendClient({ origin: 'https://backend.example', serviceToken: 'host-service', fetch: async (_url, init) => {
      tokens.push(new Headers(init?.headers).get('authorization')!)
      if (variant === 'stale') return Response.json({ detail: { code: 'stale-permission' } }, { status: 403 })
      return Response.json({ schema_version: 1, sessions: [{ id: sessionId, visibility: variant === 'private' ? 'private' : 'project', project_id: variant === 'private' ? null : projectId,
        purpose: variant === 'test' ? 'business_skill_test' : 'conversation', runtime_header: { id: `session-${sessionId}` } }] })
    } })
    const persistence = new XAgentSessionPersistence(ctx, backend)
    const authorizer = new XAgentAuthorization(backend, persistence, undefined, undefined, undefined, undefined, service)
    const scopeArgs = variant === 'missing' ? {} : { projectId: variant === 'malformed' ? 'bad' : variant === 'mismatch' ? '00000000-0000-0000-0000-000000000999' : projectId, sessionId: `session-${sessionId}` }
    const selectedSession = variant === 'missing-session' ? undefined : variant === 'malformed-session' ? 'bad'
      : variant === 'mismatched-session' ? 'session-00000000-0000-0000-0000-000000000999' : `session-${sessionId}`
    const args = { ...scopeArgs, sessionId: selectedSession, ...governanceArgs[method] }
    const cancelled = new AbortController()
    cancelled.abort()
    const physical = { ...request(), lifetime: variant === 'disconnected' ? cancelled.signal : signal }
    const result = await authorizer.run(`xagentBusinessSkill/${method}`, { args }, variant === 'no-request' ? { connectionId: 'anonymous' } : physical, variant === 'cancelled' ? cancelled.signal : signal,
      async () => ({ ok: true, value: await ctx.typertGateway.invoke({ namespace: 'xagentBusinessSkill', method, args }) }))
    if (variant === 'matching') {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
      expect(tokens).toEqual(['Bearer alice-token'])
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every(call => call.token === 'alice-token')).toBe(true)
    } else {
      expect(result.ok).toBe(false)
      expect(calls).toEqual([])
    }
    await ctx.fiber.dispose()
  })
})
