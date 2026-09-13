import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

export const SESSION = '00000000-0000-0000-0000-000000000701'
export const PROJECT = '00000000-0000-0000-0000-000000000401'
export const BODY = 'Review only this turn: inspect the project and read its evidence before answering.'
export const TEST_SESSION = '00000000-0000-0000-0000-000000000702'
const VERSION = '00000000-0000-0000-0000-000000000901'
const PROPOSAL = '00000000-0000-0000-0000-000000000902'
const PRIMARY_TOOLS = ['propose_fact']
const TOOLS = process.env.XAGENT_SKILL_SCENARIO === 'write-and-test'
  ? ['list_accessible_projects', 'propose_fact', 'search_artifacts', 'skill', 'submit_cited_answer']
  : ['list_accessible_projects', 'search_artifacts', 'skill', 'submit_cited_answer']
export const POLICY_DIGEST = createHash('sha256').update(JSON.stringify({ complete_tools: TOOLS, version: 1 })).digest('hex')
export const TEST_POLICY_DIGEST = createHash('sha256')
  .update(JSON.stringify({ complete_tools: ['propose_fact', 'skill'], version: 1 })).digest('hex')
const TEST_TOOLS = ['skill']
interface StoredEvent { sequence: number; event_type: string; payload: Record<string, unknown> }
interface Probe {
  unauthorize(): void
  result(): {
    discoveryBodies: number
    searchBodies: number
    proposalCount: number
    testWriteDenied: boolean
    authorizations: { tool: string; allowed: boolean }[] }
}
declare module '@deepseek-ai/cordis' { interface Context { xagentBusinessSkillSnapshot: Probe } }

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Expected object')
  return value as Record<string, unknown>
}
function events(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TypeError('Expected events')
  return value.map(record)
}
function payloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
export const name = 'xagent-business-skill-snapshot-backend'

/** Replace only HTTP responses; the real clients, providers and Session codec remain mounted. */
export function apply(ctx: Context): void {
  const previous = globalThis.fetch
  let authorized = true
  let header: unknown
  let testMounted = false
  let testStatus: 'running' | 'completed' | 'failed' | 'cancelled' = 'running'
  let testReason: string | null = null
  let testSettledAt: string | null = null
  let proposals = 0
  const stored: StoredEvent[] = []
  const testStored: StoredEvent[] = []
  const report = { discoveryBodies: 0, searchBodies: 0, authorizations: [] as { tool: string; allowed: boolean }[] }
  const test = () => ({ run_number: 1, draft_revision: 2, content_digest: 'a'.repeat(64), tool_policy_digest: TEST_POLICY_DIGEST,
    unexecuted_write_tools: ['propose_fact'], status: testStatus, termination_reason: testReason, verdict: null,
    started_at: '2026-09-12T00:00:00Z', settled_at: testSettledAt, verdict_at: null })
  ctx.provide('xagentBusinessSkillSnapshot', {
    unauthorize: () => { authorized = false }, result: () => ({ ...structuredClone(report), proposalCount: proposals,
      testWriteDenied: testStored.some(row => row.event_type === 'tool/call' && JSON.stringify(row.payload).includes('propose_fact'))
        && testStored.some(row => row.event_type === 'tool/result' && JSON.stringify(row.payload).includes('"isError":true')) }),
  })
  const entry = (slug: string) => ({ schema_version: 1, slug, description: `Review ${slug} project evidence.`, version_number: 1, version_key: VERSION })
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const path = new URL(request.url).pathname
    const body = record(await request.json())
    if (request.headers.get('x-xagent-service-token') !== 'snapshot-service-token') throw new Error('Missing Host identity')
    if (path === '/internal/xagent/retrieval/token-count') return Response.json({
      model: 'BAAI/bge-m3', revision: '5617a9f61b028005a4858fdac845db406aefb181', token_count: 2,
    })
    if (request.headers.get('authorization') !== 'Bearer snapshot-user-token') throw new Error('Missing physical request identity')
    if (path === '/internal/xagent/sessions') {
      if (body.session_id !== SESSION) throw new Error('Wrong Session create')
      header = body.runtime_header
      for (const row of events(body.events)) {
        stored.push({ sequence: stored.length, event_type: String(row.event_type), payload: record(row.payload) })
      }
      return Response.json({ schema_version: 1, session: { id: SESSION, visibility: 'project', project_id: PROJECT, purpose: 'conversation' } })
    }
    if (path === `/internal/xagent/sessions/${SESSION}/append`) {
      if (body.expected_sequence !== stored.length - 1) throw new Error('Non-contiguous persistence append')
      for (const row of events(body.events)) {
        const payload = record(row.payload)
        if (payload.seq !== stored.length) throw new Error('Wrong persisted sequence')
        if (row.event_type === 'business-skill/activated') {
          const data = record(payload.data)
          if (data.tool_policy_digest !== POLICY_DIGEST || 'toolPolicyDigest' in data || payload.ignorable !== true) throw new Error('Activation codec was bypassed')
        }
        stored.push({ sequence: stored.length, event_type: String(row.event_type), payload })
      }
      return Response.json({ schema_version: 1, last_event_sequence: stored.length - 1, version: 1 })
    }
    if (path === `/internal/xagent/sessions/${TEST_SESSION}/append`) {
      if (body.expected_sequence !== testStored.length - 1) throw new Error('Non-contiguous test persistence append')
      for (const row of events(body.events)) {
        const payload = record(row.payload)
        if (payload.seq !== testStored.length) throw new Error('Wrong test persisted sequence')
        testStored.push({ sequence: testStored.length, event_type: String(row.event_type), payload })
      }
      return Response.json({ schema_version: 1, last_event_sequence: testStored.length - 1, version: 1 })
    }
    if (path === `/internal/xagent/sessions/${SESSION}/open`) return Response.json({ schema_version: 1,
      session: { id: SESSION, runtime_header: header, purpose: 'conversation' }, events: stored })
    if (path.endsWith('/tests/start')) return Response.json({ schema_version: 1, test: test(), session_id: TEST_SESSION,
      purpose: 'business_skill_test', draft: { revision: 2, description: 'Review project evidence.', instructions: BODY,
        primary_tools: PRIMARY_TOOLS, content_digest: 'a'.repeat(64), tool_policy_digest: TEST_POLICY_DIGEST },
      scenario: 'Attempt to propose a Fact from the reviewed project.', test_tools: TEST_TOOLS,
      unexecuted_write_tools: ['propose_fact'] })
    if (path.endsWith('/tests/1/transcript')) {
      const after = Number(body.after_sequence ?? -1)
      const selected = testStored.filter(row => row.sequence > after).slice(0, Number(body.limit ?? 500))
      return Response.json({ schema_version: 1, test: test(), events: selected.map(row => ({ schema_version: 1,
        sequence: row.sequence, event_type: row.event_type, payload: row.payload, created_at: '2026-09-12T00:00:00Z' })),
      next_sequence: selected.at(-1)?.sequence ?? after })
    }
    if (path.endsWith('/tests/1/mount')) {
      if (testMounted) return Response.json({ schema_version: 1, claimed: false, test: test() })
      testMounted = true
      for (const row of events(body.events)) {
        const payload = record(row.payload)
        testStored.push({ sequence: testStored.length, event_type: String(row.event_type), payload })
      }
      return Response.json({ schema_version: 1, claimed: true, test: test() })
    }
    if (path.endsWith('/tests/1/authorize-tool')) return Response.json({ schema_version: 1, allowed: true })
    if (path.endsWith('/tests/1/settle')) {
      testReason = String(body.termination_reason)
      testStatus = testReason === 'completed' ? 'completed' : testReason === 'cancelled' ? 'cancelled' : 'failed'
      testSettledAt = '2026-09-12T00:01:00Z'
      return Response.json({ schema_version: 1, test: test() })
    }
    if (path.endsWith('/runtime/catalog')) return Response.json({ schema_version: 1, items: authorized ? [entry('review'), entry('second-review')] : [] })
    if (path.endsWith('/runtime/load')) {
      if (!authorized || body.version_key !== VERSION) return Response.json({ detail: { code: 'not-found' } }, { status: 404 })
      return Response.json({ ...entry(String(body.slug)), instructions: BODY, content_digest: 'a'.repeat(64), tool_policy_digest: POLICY_DIGEST, complete_tools: TOOLS })
    }
    if (path.endsWith('/runtime/authorize-tool')) {
      if (body.version_key !== VERSION || body.tool_policy_digest !== POLICY_DIGEST) throw new Error('Lost immutable Skill pin')
      report.authorizations.push({ tool: String(body.tool_name), allowed: authorized })
      return authorized ? Response.json({ schema_version: 1, allowed: true })
        : Response.json({ detail: { code: 'not-found' } }, { status: 404 })
    }
    if (path === '/internal/xagent/retrieval/projects') {
      if (!authorized || record(body.business_skill).version_key !== VERSION) throw new Error('Unbound discovery body executed')
      report.discoveryBodies++
      const payload = { projects: [{ name: 'Launch', project_id: PROJECT }], schema_version: 1 }
      return Response.json({ ...payload, receipt: 'snapshot-discovery-receipt', payload_sha256: payloadHash(payload) })
    }
    if (path === '/internal/xagent/retrieval/search') {
      if (!authorized) throw new Error('Unauthorized search body executed')
      report.searchBodies++
      const payload = { citations: [], schema_version: 1 }
      return Response.json({ ...payload, receipt: 'snapshot-search-receipt', payload_sha256: payloadHash(payload) })
    }
    if (path === '/internal/xagent/facts/proposals/prepare') {
      proposals++
      const result = { proposalId: PROPOSAL, status: 'pending' }
      return Response.json({ schema_version: 1, result, receipt: 'snapshot-fact-receipt', payload_sha256: payloadHash(result) })
    }
    if (path.endsWith('/outbox/pull')) return Response.json({ schema_version: 1, items: [], next_cursor: null })
    throw new Error(`Unexpected Business Skill snapshot endpoint: ${path}`)
  }
  ctx.effect(() => () => { globalThis.fetch = previous })
}
