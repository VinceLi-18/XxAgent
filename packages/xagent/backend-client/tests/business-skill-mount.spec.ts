import { expect, test } from 'vitest'
import { XAgentBackendClient } from '../src/index.ts'

const project = '00000000-0000-0000-0000-000000000201'
const session = '00000000-0000-0000-0000-000000000301'
const testRow = { run_number: 1, draft_revision: 1, content_digest: 'a'.repeat(64), tool_policy_digest: 'b'.repeat(64),
  unexecuted_write_tools: ['propose_fact'],
  status: 'running', termination_reason: null, verdict: null, started_at: '2026-09-12T00:00:00Z', settled_at: null, verdict_at: null }
const input = { sessionId: session, runtimeHeader: { version: 0, id: `session-${session}`, createdAt: 1 }, events: [], idempotencyKey: 'mount-1' }

test('cancel-unmounted keeps cleanup authority private and parses the current report', async () => {
  const calls: unknown[] = []
  const client = new XAgentBackendClient({ origin: 'https://api.example', serviceToken: 'service', fetch: async (url, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected JSON request body')
    calls.push({ path: new URL(url instanceof Request ? url.url : url).pathname, body: JSON.parse(init.body) as unknown })
    return Response.json({ schema_version: 1, test: testRow })
  } })
  await expect(client.businessSkills.cancelUnmountedTest('actor', project, 'review', 1, session, 'cancel-1'))
    .resolves.toMatchObject({ status: 'running', unexecutedWriteTools: ['propose_fact'] })
  expect(calls).toEqual([{ path: `/internal/xagent/business-skills/projects/${project}/review/tests/1/cancel-unmounted`,
    body: { schema_version: 1, session_id: session, idempotency_key: 'cancel-1' } }])
})

test.each([true, false])('mount forwards exact publication and returns exclusive ownership: %s', async (claimed) => {
  const calls: { path: string; body: unknown; signal: AbortSignal | null | undefined }[] = []
  const client = new XAgentBackendClient({ origin: 'https://api.example', serviceToken: 'service', fetch: async (url, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected JSON request body')
    calls.push({
      path: new URL(url instanceof Request ? url.url : url).pathname,
      body: JSON.parse(init.body) as unknown,
      signal: init?.signal,
    })
    return Response.json({ schema_version: 1, claimed, test: testRow })
  } })
  const controller = new AbortController()
  const result = await client.businessSkills.mountTest('actor', project, 'review', 1, input, controller.signal)
  expect(result).toMatchObject({ claimed, test: { runNumber: 1, status: 'running' } })
  expect(result.test.unexecutedWriteTools).toEqual(['propose_fact'])
  expect(calls.map(({ path, body }) => ({ path, body }))).toEqual([{ path: `/internal/xagent/business-skills/projects/${project}/review/tests/1/mount`,
    body: { schema_version: 1, session_id: session, runtime_header: input.runtimeHeader, events: [], idempotency_key: 'mount-1' } }])
  controller.abort()
  expect(calls[0]?.signal?.aborted).toBe(true)
})

test.each([{ claimed: 'yes' }, { schema_version: 2 }, { token: 'private' }, { test: { ...testRow, status: 'invalid' } },
  ...[undefined, null, 'propose_fact', ['bash'], ['propose_fact', 'propose_fact']].map(value => ({ test: { ...testRow, unexecuted_write_tools: value } })),
])('mount rejects unverifiable ownership %#', async (override) => {
  const client = new XAgentBackendClient({ origin: 'https://api.example', serviceToken: 'service', fetch: async () =>
    Response.json({ schema_version: 1, claimed: true, test: testRow, ...override }) })
  await expect(client.businessSkills.mountTest('actor', project, 'review', 1, input)).rejects.toMatchObject({ code: 'service-unavailable' })
})
