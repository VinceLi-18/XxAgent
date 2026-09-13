import { expect, test } from 'vitest'
import { XAgentBackendClient, type XAgentBusinessSkillTerminationReason } from '../src/index.ts'

const id = '00000000-0000-0000-0000-000000000001'
const digest = 'a'.repeat(64)
const date = '2026-09-12T00:00:00Z'
const report = { run_number: 1, draft_revision: 1, content_digest: digest, tool_policy_digest: digest,
  unexecuted_write_tools: [], status: 'running', termination_reason: null, verdict: null,
  started_at: date, settled_at: null, verdict_at: null }
const summary = { slug: 'review', display_name: 'Review', status: 'active', authorized: false, current_version: null,
  draft_revision: 1, latest_test: report, updated_at: date }
const draft = { revision: 1, description: 'Review', instructions: 'Read evidence', primary_tools: [],
  content_digest: digest, tool_policy_digest: digest }
const detail = { schema_version: 1, ...summary, draft, versions: [], tests: [report],
  next_version_cursor: null, next_run_cursor: null, audit_summary: [] }
const catalog = { schema_version: 1, slug: 'review', description: 'Review', version_number: 1, version_key: id }
const start = { schema_version: 1, test: report, session_id: id, purpose: 'business_skill_test', draft,
  scenario: 'Read evidence', test_tools: ['skill'], unexecuted_write_tools: [] }
const input = { expectedDraftRevision: 1, toolPolicyDigest: digest, scenario: 'Read', idempotencyKey: 'test-1' }

function client(payload: unknown) {
  return new XAgentBackendClient({ origin: 'https://backend.example', serviceToken: 'host', fetch: async () => Response.json(payload) }).businessSkills
}

test.each([{ termination_reason: 'unexpected' }, { verdict: 'approved' }, { content_digest: 'bad' },
  { unexecuted_write_tools: ['unknown'] }])('reports reject unknown states and invalid permission evidence %#', async (change) => {
  await expect(client({ schema_version: 1, test: { ...report, ...change } }).cancelUnmountedTest('actor', id, 'review', 1, id, 'cleanup'))
    .rejects.toMatchObject({ code: 'service-unavailable' })
})

test.each([{ status: 'paused' }, { status: 'retired', authorized: 'yes' }, { display_name: ' ' }])('list rejects malformed summary fields %#', async (change) => {
  await expect(client({ schema_version: 1, items: [{ ...summary, ...change }], next_cursor: null }).list('actor', id, {}))
    .rejects.toMatchObject({ code: 'service-unavailable' })
})

test.each([
  { schema_version: 2 },
  { versions: [{ version_number: 1, description: 'Review', instructions: 'Read', primary_tools: ['search_artifacts'],
    complete_tools: ['skill'], content_digest: digest, tool_policy_digest: digest, source_draft_revision: 1, published_at: date }] },
])('detail refuses unknown formats and broken companion closures %#', async (change) => {
  await expect(client({ ...detail, ...change }).detail('actor', id, 'review', {})).rejects.toMatchObject({ code: 'service-unavailable' })
})

test('detail preserves public cursors and audit version numbers', async () => {
  await expect(client({ ...detail, next_version_cursor: 2, next_run_cursor: 3,
    audit_summary: [{ action: 'business_skill.publish', result: 'published', version_number: 2, created_at: date },
      { action: 'business_skill.create', result: 'created', version_number: null, created_at: date }],
  }).detail('actor', id, 'review', {})).resolves.toMatchObject({ nextVersionCursor: 2, nextRunCursor: 3,
    auditSummary: [{ versionNumber: 2 }, { action: 'business_skill.create' }] })
  await expect(client({ schema_version: 1, items: [], next_cursor: 'review' }).list('actor', id, {}))
    .resolves.toEqual({ items: [], nextCursor: 'review' })
})

test.each([
  { schema_version: 2 }, { purpose: 'conversation' },
  { unexecuted_write_tools: ['propose_fact'], draft: { ...draft, primary_tools: ['propose_fact'] } },
])('start rejects mismatched execution identity and persisted permission history %#', async (change) => {
  await expect(client({ ...start, ...change }).startTest('actor', id, 'review', input)).rejects.toMatchObject({ code: 'service-unavailable' })
})

test.each([{ schema_version: 2 }, { events: [{ schema_version: 2, sequence: 0, event_type: 'config', payload: {}, created_at: date }] }])(
  'transcript rejects unsupported format envelopes %#', async (change) => {
    await expect(client({ schema_version: 1, test: report, events: [], next_sequence: -1, ...change })
      .transcript('actor', id, 'review', 1, {})).rejects.toMatchObject({ code: 'service-unavailable' })
  },
)

test.each(['page', 'catalog', 'catalog-entry', 'cancel', 'settle'] as const)('%s rejects unsupported protocol versions', async (operation) => {
  const backend = client(operation === 'page' ? { schema_version: 2, items: [], next_cursor: null }
    : operation === 'catalog' ? { schema_version: 2, items: [] }
      : operation === 'catalog-entry' ? { schema_version: 1, items: [{ ...catalog, schema_version: 2 }] }
        : { schema_version: 2, test: report })
  const request = operation === 'page' ? backend.list('actor', id, {})
    : operation.startsWith('catalog') ? backend.catalog('actor', id, id)
      : operation === 'cancel' ? backend.cancelUnmountedTest('actor', id, 'review', 1, id, 'cleanup')
        : backend.settleTest('actor', id, 'review', 1, id, 'completed', 'settle')
  await expect(request).rejects.toMatchObject({ code: 'service-unavailable' })
})

test('omitted optional fields and content-only draft edits preserve the public detail', async () => {
  const backend = client(detail)
  await expect(backend.draft('actor', id, 'review', { expectedDraftRevision: 1, displayName: 'New name', instructions: 'New body', idempotencyKey: 'edit' }))
    .resolves.toMatchObject({ slug: 'review' })
  await expect(backend.draft('actor', id, 'review', { expectedDraftRevision: 1, primaryTools: [], idempotencyKey: 'tools' }))
    .resolves.toMatchObject({ slug: 'review' })
})

test('request validation bounds pages and rejects invalid mutation selectors', async () => {
  const backend = client(detail)
  await expect(backend.list('actor', id, { limit: 101 })).rejects.toMatchObject({ code: 'service-unavailable' })
  await expect(backend.transcript('actor', id, 'review', 1, { afterSequence: -2 })).rejects.toMatchObject({ code: 'service-unavailable' })
  await expect(backend.authorization('actor', id, 'review', 'yes' as unknown as boolean, 'key')).rejects.toMatchObject({ code: 'service-unavailable' })
  await expect(backend.authorizeTool('actor', id, id, 'review', id, digest, 'skill', 'no' as unknown as boolean))
    .rejects.toMatchObject({ code: 'service-unavailable' })
  await expect(backend.settleTest('actor', id, 'review', 1, id, 'bad' as XAgentBusinessSkillTerminationReason, 'key'))
    .rejects.toMatchObject({ code: 'service-unavailable' })
})
