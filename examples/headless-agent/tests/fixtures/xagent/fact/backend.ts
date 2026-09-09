import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

const PROJECT = '00000000-0000-0000-0000-000000000401'
const PROPOSAL = '00000000-0000-0000-0000-000000000901'
const REVISION = '00000000-0000-0000-0000-000000000902'
const OUTBOX = '00000000-0000-0000-0000-000000000903'
const CITATION = {
  id: '[资料1]',
  artifact_id: '00000000-0000-0000-0000-000000000501',
  version_id: '00000000-0000-0000-0000-000000000601',
  chunk_id: '00000000-0000-0000-0000-000000000801',
  display_name: 'brief.md',
  version_number: 1,
  line_start: 1,
  line_end: 2,
  text: 'verified evidence',
  scope: 'project',
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

export const name = 'xagent-fact-snapshot-backend'

/** Install deterministic HTTP responses for the real Retrieval and Fact providers. */
export function apply(ctx: Context): void {
  const previous = globalThis.fetch
  let proposals = 0
  let delivered = false
  const mockFetch: typeof globalThis.fetch = (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname
    if (path === '/internal/xagent/retrieval/token-count') {
      return Promise.resolve(json({
        model: 'BAAI/bge-m3',
        revision: '5617a9f61b028005a4858fdac845db406aefb181',
        token_count: 2,
      }))
    }
    if (path === '/internal/xagent/retrieval/search') {
      const payload = { schema_version: 1, citations: [CITATION] }
      return Promise.resolve(json({ ...payload, receipt: 'snapshot_search_receipt', payload_sha256: payloadHash(payload) }))
    }
    if (path === '/internal/xagent/retrieval/citations/authorize') {
      return Promise.resolve(json({ schema_version: 1, authorized: true }))
    }
    if (path === '/internal/xagent/facts/proposals/prepare') {
      proposals += 1
      const result = { proposalId: proposals === 1 ? PROPOSAL : '00000000-0000-0000-0000-000000000904', status: 'pending' }
      return Promise.resolve(json({
        schema_version: 1,
        result,
        receipt: `snapshot_fact_receipt_${String(proposals)}`,
        payload_sha256: payloadHash(result),
      }))
    }
    if (path.endsWith('/outbox/pull')) {
      const event = {
        type: 'fact/proposal-decided',
        data: {
          proposal_id: PROPOSAL,
          project_id: PROJECT,
          field_key: 'launch.date',
          label: 'Launch date',
          status: 'confirmed',
          fact_revision_id: REVISION,
          content_revision: 1,
          decision_reason: 'Manager approved verified evidence.',
        },
      }
      const items = proposals >= 2 && !delivered
        ? [{ outbox_id: OUTBOX, payload_sha256: payloadHash(event), event }]
        : []
      if (items.length > 0) delivered = true
      return Promise.resolve(json({ schema_version: 1, items, next_cursor: null }))
    }
    return Promise.reject(new Error(`unexpected XAgent Fact snapshot endpoint: ${path}`))
  }
  globalThis.fetch = mockFetch
  ctx.effect(() => () => { globalThis.fetch = previous })
}
