import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

const PROJECT = '00000000-0000-0000-0000-000000000401'
const SESSION = '00000000-0000-0000-0000-000000000701'
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

interface PersistenceAppend {
  readonly expectedSequence: number
  readonly acknowledgedThrough: number
  readonly retrievalReceipts: readonly unknown[]
  readonly factProposalReceipts: readonly unknown[]
  readonly factOutboxEvents: readonly unknown[]
}

interface XAgentFactSnapshotBackendProbe {
  persistenceAdmissions(): readonly PersistenceAppend[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    xagentFactSnapshotBackend: XAgentFactSnapshotBackendProbe
  }
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

async function requestJson(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const request = input instanceof Request ? input : new Request(input, init)
  const value = await request.clone().text()
  return value.length === 0 ? undefined : JSON.parse(value) as unknown
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('expected object request')
  return value as Record<string, unknown>
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`expected ${field} array`)
  return value
}

export const name = 'xagent-fact-snapshot-backend'

/** Install deterministic HTTP responses for the real Retrieval and Fact providers. */
export function apply(ctx: Context): void {
  const previous = globalThis.fetch
  let proposals = 0
  let delivered = false
  let persistedThrough = -1
  const persistenceAdmissions: PersistenceAppend[] = []
  ctx.provide('xagentFactSnapshotBackend', {
    persistenceAdmissions: () => structuredClone(persistenceAdmissions),
  })
  const mockFetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname
    const body = await requestJson(input, init)
    if (path === '/internal/xagent/sessions') {
      const request = record(body)
      if (request.session_id !== SESSION) throw new Error('unexpected snapshot Session create identity')
      const events = array(request.events ?? [], 'events')
      persistedThrough = events.length - 1
      return json({
        schema_version: 1,
        session: { id: SESSION, visibility: 'project', project_id: PROJECT },
      })
    }
    const append = /^\/internal\/xagent\/sessions\/([^/]+)\/append$/u.exec(path)
    if (append?.[1] !== undefined) {
      if (append[1] !== SESSION) throw new Error('unexpected snapshot Session append identity')
      const request = record(body)
      const expectedSequence = request.expected_sequence
      const events = array(request.events, 'events')
      if (expectedSequence !== persistedThrough || !Number.isSafeInteger(expectedSequence)) {
        throw new Error('non-contiguous snapshot Session append')
      }
      const acknowledgedThrough = expectedSequence + events.length
      for (const [index, event] of events.entries()) {
        const payload = record(record(event).payload)
        if (payload.seq !== expectedSequence + index + 1) {
          throw new Error('snapshot Session append payload sequence mismatch')
        }
      }
      const retrievalReceipts = array(request.retrieval_receipts, 'retrieval_receipts')
      const factProposalReceipts = array(request.fact_proposal_receipts, 'fact_proposal_receipts')
      const factOutboxEvents = array(request.fact_outbox_events, 'fact_outbox_events')
      const sidecars = [...retrievalReceipts, ...factProposalReceipts, ...factOutboxEvents]
      for (const sidecar of sidecars) {
        const eventSequence = record(sidecar).event_sequence
        if (typeof eventSequence !== 'number'
          || !Number.isSafeInteger(eventSequence)
          || eventSequence <= expectedSequence
          || eventSequence > acknowledgedThrough) {
          throw new Error('snapshot persistence sidecar lies outside its acknowledged append')
        }
      }
      if (sidecars.length > 0) {
        persistenceAdmissions.push({
          expectedSequence,
          acknowledgedThrough,
          retrievalReceipts: structuredClone(retrievalReceipts),
          factProposalReceipts: structuredClone(factProposalReceipts),
          factOutboxEvents: structuredClone(factOutboxEvents),
        })
      }
      persistedThrough = acknowledgedThrough
      return json({ schema_version: 1, last_event_sequence: acknowledgedThrough, version: 1 })
    }
    if (path === '/internal/xagent/retrieval/token-count') {
      return json({
        model: 'BAAI/bge-m3',
        revision: '5617a9f61b028005a4858fdac845db406aefb181',
        token_count: 2,
      })
    }
    if (path === '/internal/xagent/retrieval/search') {
      const payload = { schema_version: 1, citations: [CITATION] }
      return json({ ...payload, receipt: 'snapshot_search_receipt', payload_sha256: payloadHash(payload) })
    }
    if (path === '/internal/xagent/retrieval/citations/authorize') {
      return json({ schema_version: 1, authorized: true })
    }
    if (path === '/internal/xagent/facts/proposals/prepare') {
      proposals += 1
      const result = { proposalId: proposals === 1 ? PROPOSAL : '00000000-0000-0000-0000-000000000904', status: 'pending' }
      return json({
        schema_version: 1,
        result,
        receipt: `snapshot_fact_receipt_${String(proposals)}`,
        payload_sha256: payloadHash(result),
      })
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
      return json({ schema_version: 1, items, next_cursor: null })
    }
    throw new Error(`unexpected XAgent Fact snapshot endpoint: ${path}`)
  }
  globalThis.fetch = mockFetch
  ctx.effect(() => () => { globalThis.fetch = previous })
}
