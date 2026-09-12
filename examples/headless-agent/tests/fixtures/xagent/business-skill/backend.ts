import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

export const SESSION = '00000000-0000-0000-0000-000000000701'
export const PROJECT = '00000000-0000-0000-0000-000000000401'
export const BODY = 'Review only this turn: inspect the project and read its evidence before answering.'
const VERSION = '00000000-0000-0000-0000-000000000901'
const TOOLS = ['list_accessible_projects', 'search_artifacts', 'skill', 'submit_cited_answer']
const DIGEST = createHash('sha256').update(JSON.stringify({ complete_tools: TOOLS, version: 1 })).digest('hex')
interface StoredEvent { sequence: number; event_type: string; payload: Record<string, unknown> }
interface Probe {
  unauthorize(): void
  result(): { discoveryBodies: number; searchBodies: number; authorizations: { tool: string; allowed: boolean }[] }
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
  const stored: StoredEvent[] = []
  const report = { discoveryBodies: 0, searchBodies: 0, authorizations: [] as { tool: string; allowed: boolean }[] }
  ctx.provide('xagentBusinessSkillSnapshot', {
    unauthorize: () => { authorized = false }, result: () => structuredClone(report),
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
          if (data.tool_policy_digest !== DIGEST || 'toolPolicyDigest' in data || payload.ignorable !== true) throw new Error('Activation codec was bypassed')
        }
        stored.push({ sequence: stored.length, event_type: String(row.event_type), payload })
      }
      return Response.json({ schema_version: 1, last_event_sequence: stored.length - 1, version: 1 })
    }
    if (path === `/internal/xagent/sessions/${SESSION}/open`) return Response.json({ schema_version: 1,
      session: { id: SESSION, runtime_header: header, purpose: 'conversation' }, events: stored })
    if (path.endsWith('/runtime/catalog')) return Response.json({ schema_version: 1, items: authorized ? [entry('review'), entry('second-review')] : [] })
    if (path.endsWith('/runtime/load')) {
      if (!authorized || body.version_key !== VERSION) return Response.json({ detail: { code: 'not-found' } }, { status: 404 })
      return Response.json({ ...entry(String(body.slug)), instructions: BODY, content_digest: 'a'.repeat(64), tool_policy_digest: DIGEST, complete_tools: TOOLS })
    }
    if (path.endsWith('/runtime/authorize-tool')) {
      if (body.version_key !== VERSION || body.tool_policy_digest !== DIGEST) throw new Error('Lost immutable Skill pin')
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
    throw new Error(`Unexpected Business Skill snapshot endpoint: ${path}`)
  }
  ctx.effect(() => () => { globalThis.fetch = previous })
}
