import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionForkOperationId } from '@deepseek-ai/dsh-session-persistence'
import {
  XAgentBackendClient,
  XAgentBackendError,
  type XAgentBackend,
  type XAgentFactPersistenceSidecars,
} from '@xagent/dsh-backend-client'
import type { XAgentReceiptRegistryContract } from '@xagent/dsh-retrieval'
import { describe, expect, test, vi } from 'vitest'
import * as persistenceModule from '../src/index.ts'
import { decodeFactSessionEvent, encodeFactSessionEvent } from '../src/fact-event-codec.ts'
import {
  XAgentSessionPersistence,
} from '../src/index.ts'

const id = SessionId('session-00000000-0000-0000-0000-000000000701')
const header: SessionHeader = {
  version: 0,
  id,
  createdAt: 1_787_587_200_000,
  cwd: '/workspace/alice',
}
const event: SessionEvent = {
  seq: 0,
  time: 1_787_587_200_001,
  type: 'turn/start',
  data: { turn: 0 },
}
const factDecisionData = {
  proposalId: '00000000-0000-0000-0000-000000000721',
  projectId: '00000000-0000-0000-0000-000000000722',
  fieldKey: 'delivery.date',
  label: '交付日期',
  status: 'rejected',
  decisionReason: '已有新版本',
} as const

function factDecisionEvent(seq: number, time: number): SessionEvent {
  return {
    seq,
    time,
    type: 'fact/proposal-decided',
    data: factDecisionData,
  } as unknown as SessionEvent
}

const forkOperationId = SessionForkOperationId('fork-request-000000000701')

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function backend(): XAgentBackend & { calls: { name: string; args: unknown[] }[] } {
  const calls: { name: string; args: unknown[] }[] = []
  return {
    calls,
    login: vi.fn(),
    introspect: vi.fn(),
    revoke: vi.fn(),
    sessions: {
      list: async (...args) => {
        calls.push({ name: 'list', args })
        return { schema_version: 1, sessions: [{ runtime_header: header, version: 2, last_event_sequence: 0 }] }
      },
      create: async (...args) => {
        calls.push({ name: 'create', args })
        return {
          schema_version: 1,
          session: {
            id: '00000000-0000-0000-0000-000000000701',
            visibility: 'private',
            project_id: null,
            runtime_header: header,
            version: 1,
            last_event_sequence: -1,
          },
        }
      },
      open: async (...args) => {
        calls.push({ name: 'open', args })
        return {
          schema_version: 1,
          session: { runtime_header: header, version: 2, last_event_sequence: 0 },
          events: [{ sequence: 0, payload: event }],
        }
      },
      events: async (...args) => {
        calls.push({ name: 'events', args })
        return { schema_version: 1, events: [{ sequence: 0, payload: event }] }
      },
      append: async (...args) => {
        calls.push({ name: 'append', args })
        const body = args[2] as { expected_sequence: number; events: readonly unknown[] }
        return {
          schema_version: 1,
          version: 2,
          last_event_sequence: body.expected_sequence + body.events.length,
        }
      },
      fork: vi.fn(),
      archive: vi.fn(),
      authorize: vi.fn(),
    },
  }
}

describe('XAgent FastAPI Session Persistence', () => {
  test('Fact codec rejects a wrong event type with an otherwise exact log-only payload', () => {
    const wrongType = { ...factDecisionEvent(0, event.time), type: 'turn/start' }

    expect(() => encodeFactSessionEvent(wrongType)).toThrow('invalid XAgent Fact session event')
    expect(() => decodeFactSessionEvent(wrongType)).toThrow('invalid XAgent Fact session event')
  })

  test('fork uses the source-derived backend transaction and binds its returned child identity', async () => {
    const value = backend()
    const childId = SessionId('session-00000000-0000-0000-0000-000000000702')
    const childHeader: SessionHeader = {
      version: 0,
      id: childId,
      createdAt: 1_787_587_200_010,
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      parentSession: id,
      seedLength: 1,
    }
    value.sessions.fork = async (...args) => {
      value.calls.push({ name: 'fork', args })
      return {
        schema_version: 1,
        session: {
          id: '00000000-0000-0000-0000-000000000702',
          visibility: 'project',
          project_id: '00000000-0000-0000-0000-000000000401',
          runtime_header: childHeader,
          last_event_sequence: 0,
        },
      }
    }
    const persistence = new XAgentSessionPersistence(new Context(), value)

    const forked = await persistence.withUserToken(
      'alice-token',
      () => persistence.fork(id, 0, forkOperationId),
    )

    expect(forked).toEqual(childHeader)
    const forkCall = value.calls.find(call => call.name === 'fork')
    expect(forkCall?.args.slice(0, 2)).toEqual([
      'alice-token',
      '00000000-0000-0000-0000-000000000701',
    ])
    expect(forkCall?.args[3]).toBeUndefined()
    expect(forkCall?.args[2]).toMatchObject({ schema_version: 1, through_sequence: 0 })
    const forkBody = forkCall?.args[2] as Record<string, unknown>
    expect(typeof forkBody.idempotency_key).toBe('string')
    expect(forkBody).toEqual({
      schema_version: 1,
      through_sequence: 0,
      idempotency_key: 'fork:fork-request-000000000701',
    })
    expect(forkBody).not.toHaveProperty('visibility')
    value.sessions.open = async (...args) => {
      value.calls.push({ name: 'open-child', args })
      return {
        schema_version: 1,
        session: { runtime_header: childHeader, version: 1, last_event_sequence: 0 },
        events: [{ sequence: 0, payload: event }],
      }
    }
    await expect(persistence.inspect(childId)).resolves.toMatchObject({ meta: childHeader })
    expect(value.calls.find(call => call.name === 'open-child')?.args).toEqual([
      'alice-token',
      '00000000-0000-0000-0000-000000000702',
      undefined,
    ])
  })

  test('fork recovery admits only backend service unavailability', () => {
    const persistence = new XAgentSessionPersistence(new Context(), backend())

    expect(persistence.isForkRetryable(new XAgentBackendError('service-unavailable'))).toBe(true)
    expect(persistence.isForkRetryable(new XAgentBackendError('not-found'))).toBe(false)
    expect(persistence.isForkRetryable(new XAgentBackendError('idempotency-conflict'))).toBe(false)
    expect(persistence.isForkRetryable(new Error('setup invalid'))).toBe(false)
  })

  test.each([
    { target_scope: { visibility: 'project' } },
    { runtime_header_private: 'secret' },
  ])('fork rejects caller-invented or private response fields %#', async (extra) => {
    const value = backend()
    const childHeader: SessionHeader & Record<string, unknown> = {
      version: 0,
      id: SessionId('session-00000000-0000-0000-0000-000000000702'),
      createdAt: 1_787_587_200_010,
      parentSession: id,
      seedLength: 1,
      ...('runtime_header_private' in extra ? extra : {}),
    }
    value.sessions.fork = vi.fn(async () => ({
      schema_version: 1,
      session: {
        id: '00000000-0000-0000-0000-000000000702',
        visibility: 'project',
        project_id: '00000000-0000-0000-0000-000000000401',
        runtime_header: childHeader,
        last_event_sequence: 0,
        ...('target_scope' in extra ? extra : {}),
      },
    }))
    const persistence = new XAgentSessionPersistence(new Context(), value)

    await expect(persistence.withUserToken(
      'alice-token',
      () => persistence.fork(id, 0, forkOperationId),
    )).rejects.toThrow('invalid XAgent session fork response')
  })

  test('fork accepts a private child and rejects invalid server scope or runtime lineage', async () => {
    const value = backend()
    const childHeader: SessionHeader = {
      version: 0,
      id: SessionId('session-00000000-0000-0000-0000-000000000702'),
      createdAt: 1_787_587_200_010,
      parentSession: id,
      seedLength: 1,
    }
    const response = (visibility: unknown, projectId: unknown, runtimeHeader: unknown = childHeader) => ({
      schema_version: 1,
      session: {
        id: '00000000-0000-0000-0000-000000000702',
        visibility,
        project_id: projectId,
        runtime_header: runtimeHeader,
        last_event_sequence: 0,
      },
    })
    value.sessions.fork = vi.fn(async () => response('private', null))
    const persistence = new XAgentSessionPersistence(new Context(), value)
    await expect(persistence.withUserToken('alice-token', () => persistence.fork(id, 0, forkOperationId)))
      .resolves.toEqual(childHeader)

    for (const invalid of [
      response('private', '00000000-0000-0000-0000-000000000401'),
      response('project', null),
      response('project', 'not-a-uuid'),
      response('unknown', null),
      response('private', null, { ...childHeader, parentSession: SessionId('other') }),
    ]) {
      value.sessions.fork = vi.fn(async () => invalid)
      await expect(persistence.withUserToken('alice-token', () => persistence.fork(id, 0, forkOperationId)))
        .rejects.toThrow('invalid XAgent session fork response')
    }
  })

  test.each([
    [Number.NaN, forkOperationId],
    [-2, forkOperationId],
    [0.5, forkOperationId],
    [0, '' as SessionForkOperationId],
    [0, 'x'.repeat(251) as SessionForkOperationId],
  ])('fork rejects invalid source coordinates %#', async (throughSequence, operationId) => {
    const persistence = new XAgentSessionPersistence(new Context(), backend())
    await expect(persistence.withUserToken(
      'alice-token',
      () => persistence.fork(id, throughSequence, operationId),
    )).rejects.toBeInstanceOf(TypeError)
  })

  test('flush sends only the exact receipt sidecars for its event window and commits after success', async () => {
    const ctx = new Context()
    const value = backend()
    const attachments = vi.fn(() => [{
      eventSequence: 0,
      toolCallId: 'call-retrieval',
      receipt: 'opaque-secret',
      payloadHash: 'a'.repeat(64),
    }])
    const commit = vi.fn()
    ctx.provide('xagentRetrieval', { receipts: {
      attachments,
      commit,
    } as unknown as XAgentReceiptRegistryContract } as never)
    const persistence = new XAgentSessionPersistence(ctx, value)
    persistence.authorizeRequest(id, undefined, 'alice-token')

    await persistence.append(id, [event])

    expect(attachments).toHaveBeenCalledWith(String(id), 0, 0)
    expect(value.calls.find(call => call.name === 'append')?.args[2]).toMatchObject({
      retrieval_receipts: [{
        event_sequence: 0,
        tool_call_id: 'call-retrieval',
        receipt: 'opaque-secret',
        payload_hash: 'a'.repeat(64),
      }],
    })
    expect(commit).toHaveBeenCalledWith(String(id), 0)
  })

  test('retrieval, Fact receipt, and Fact Outbox sidecars share one append and commit independently through its acknowledgement', async () => {
    const ctx = new Context()
    const value = backend()
    const retrievalAttachments = vi.fn(() => [{
      eventSequence: 0,
      toolCallId: 'call-retrieval',
      receipt: 'opaque-retrieval',
      payloadHash: 'a'.repeat(64),
    }])
    const retrievalCommit = vi.fn()
    ctx.provide('xagentRetrieval', { receipts: {
      attachments: retrievalAttachments,
      commit: retrievalCommit,
    } as unknown as XAgentReceiptRegistryContract } as never)
    const factReceiptAttachments = vi.fn(() => [{
      eventSequence: 1,
      toolCallId: 'call-fact',
      proposalId: '00000000-0000-0000-0000-000000000721',
      receipt: 'opaque-fact',
      payloadHash: 'b'.repeat(64),
    }])
    const factReceiptCommit = vi.fn()
    const factOutboxAttachments = vi.fn(() => [{
      eventSequence: 2,
      outboxId: '00000000-0000-0000-0000-000000000722',
      payloadHash: 'c'.repeat(64),
    }])
    const factOutboxCommit = vi.fn()
    ctx.provide('xagentFact', {
      receipts: { attachments: factReceiptAttachments, commit: factReceiptCommit },
      outbox: { attachments: factOutboxAttachments, commit: factOutboxCommit },
    } satisfies XAgentFactPersistenceSidecars as never)
    const persistence = new XAgentSessionPersistence(ctx, value)
    persistence.authorizeRequest(id, undefined, 'alice-token')
    const events = [
      event,
      { seq: 1, time: event.time + 1, type: 'tool/result', data: {} } as SessionEvent,
      factDecisionEvent(2, event.time + 2),
    ]

    await persistence.append(id, events)

    expect(retrievalAttachments).toHaveBeenCalledWith(String(id), 0, 2)
    expect(factReceiptAttachments).toHaveBeenCalledWith(String(id), 0, 2)
    expect(factOutboxAttachments).toHaveBeenCalledWith(String(id), 0, 2)
    expect(value.calls.find(call => call.name === 'append')?.args[2]).toEqual({
      schema_version: 1,
      expected_sequence: -1,
      idempotency_key: `append:${id}:0:2`,
      events: [
        { event_type: event.type, schema_version: 1, payload: event },
        { event_type: 'tool/result', schema_version: 1, payload: events[1] },
        {
          event_type: 'fact/proposal-decided',
          schema_version: 1,
          payload: {
            seq: 2,
            time: event.time + 2,
            type: 'fact/proposal-decided',
            data: {
              proposal_id: factDecisionData.proposalId,
              project_id: factDecisionData.projectId,
              field_key: factDecisionData.fieldKey,
              label: factDecisionData.label,
              status: factDecisionData.status,
              decision_reason: factDecisionData.decisionReason,
            },
          },
        },
      ],
      retrieval_receipts: [{
        event_sequence: 0,
        tool_call_id: 'call-retrieval',
        receipt: 'opaque-retrieval',
        payload_hash: 'a'.repeat(64),
      }],
      fact_proposal_receipts: [{
        event_sequence: 1,
        tool_call_id: 'call-fact',
        proposal_id: '00000000-0000-0000-0000-000000000721',
        receipt: 'opaque-fact',
        payload_hash: 'b'.repeat(64),
      }],
      fact_outbox_events: [{
        event_sequence: 2,
        outbox_id: '00000000-0000-0000-0000-000000000722',
        payload_hash: 'c'.repeat(64),
      }],
    })
    expect(retrievalCommit).toHaveBeenCalledWith(String(id), 2)
    expect(factReceiptCommit).toHaveBeenCalledWith(String(id), 2)
    expect(factOutboxCommit).toHaveBeenCalledWith(String(id), 2)
  })

  test('an Outbox event round-trips through the real client as snake_case wire and camelCase DSH data', async () => {
    const wireEvent = {
      type: 'fact/proposal-decided',
      data: {
        proposal_id: '00000000-0000-0000-0000-000000000721',
        project_id: '00000000-0000-0000-0000-000000000722',
        field_key: 'delivery.date',
        label: '交付日期',
        status: 'confirmed',
        fact_revision_id: '00000000-0000-0000-0000-000000000723',
        content_revision: 2,
      },
    }
    let storedPayload: unknown
    let appendBody: string | undefined
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async (input, init) => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
        if (path.endsWith('/outbox/pull')) {
          return Response.json({
            schema_version: 1,
            items: [{
              outbox_id: '00000000-0000-0000-0000-000000000724',
              payload_sha256: payloadHash(wireEvent),
              event: wireEvent,
            }],
            next_cursor: null,
          })
        }
        if (path.endsWith('/append')) {
          if (typeof init?.body !== 'string') throw new TypeError('expected JSON append body')
          appendBody = init.body
          const body = JSON.parse(init.body) as { events: Array<{ payload: unknown }> }
          storedPayload = body.events[0]?.payload
          return Response.json({ schema_version: 1, version: 2, last_event_sequence: 0 })
        }
        if (path.endsWith('/list')) {
          return Response.json({
            schema_version: 1,
            sessions: [{ runtime_header: header, version: 2, last_event_sequence: 0 }],
          })
        }
        if (path.endsWith('/events')) {
          return Response.json({
            schema_version: 1,
            events: [{
              session_id: '00000000-0000-0000-0000-000000000701',
              sequence: 0,
              event_type: 'fact/proposal-decided',
              schema_version: 1,
              payload: storedPayload,
              actor_id: '00000000-0000-0000-0000-000000000725',
              tool_call_id: null,
              audit_id: '00000000-0000-0000-0000-000000000726',
              created_at: '2026-09-08T08:00:00+00:00',
            }],
          })
        }
        return Response.json({ detail: { code: 'not-found' } }, { status: 404 })
      },
    })
    const page = await client.facts.pullOutbox(
      'alice-token',
      '00000000-0000-0000-0000-000000000701',
      { limit: 1 },
    )
    const pulled = page.items[0]
    if (pulled === undefined) throw new TypeError('expected one Outbox event')
    const factEvent = {
      seq: 0,
      time: 1_787_587_200_001,
      ...pulled.event,
    } as unknown as SessionEvent
    const ctx = new Context()
    ctx.provide('xagentFact', {
      receipts: { attachments: () => [], commit: vi.fn() },
      outbox: {
        attachments: () => [{
          eventSequence: 0,
          outboxId: pulled.outboxId,
          payloadHash: pulled.payloadHash,
        }],
        commit: vi.fn(),
      },
    } satisfies XAgentFactPersistenceSidecars as never)
    const persistence = new XAgentSessionPersistence(ctx, client)
    persistence.authorizeRequest(id, undefined, 'alice-token')

    await persistence.append(id, [factEvent])
    const replay = await persistence.readFrom(id, 0)

    expect(storedPayload).toEqual({
      seq: 0,
      time: 1_787_587_200_001,
      type: 'fact/proposal-decided',
      data: wireEvent.data,
    })
    expect(appendBody).not.toContain('proposalId')
    expect(appendBody).not.toContain('factRevisionId')
    expect(replay.events).toEqual([factEvent])
  })

  test.each([
    ['unknown event field', { ...factDecisionEvent(0, event.time), private: 'secret' }],
    ['unknown data field', {
      ...factDecisionEvent(0, event.time),
      data: { ...factDecisionData, receipt: 'secret' },
    }],
    ['non-object data', { ...factDecisionEvent(0, event.time), data: 1 }],
    ['array data', { ...factDecisionEvent(0, event.time), data: [] }],
    ['missing label', {
      ...factDecisionEvent(0, event.time),
      data: {
        proposalId: factDecisionData.proposalId,
        projectId: factDecisionData.projectId,
        fieldKey: factDecisionData.fieldKey,
        status: factDecisionData.status,
        decisionReason: factDecisionData.decisionReason,
      },
    }],
    ['boolean sequence', { ...factDecisionEvent(0, event.time), seq: true }],
    ['boolean time', { ...factDecisionEvent(0, event.time), time: true }],
    ['negative time', { ...factDecisionEvent(0, event.time), time: -1 }],
    ['append surface', { ...factDecisionEvent(0, event.time), surfaceOp: 'append' }],
    ['replacement surface', {
      ...factDecisionEvent(0, event.time),
      surfaceOp: { op: 'replace', start: 0, end: 0 },
    }],
    ['non-string proposal id', {
      ...factDecisionEvent(0, event.time),
      data: { ...factDecisionData, proposalId: 1 },
    }],
    ['malformed project id', {
      ...factDecisionEvent(0, event.time),
      data: { ...factDecisionData, projectId: 'not-a-uuid' },
    }],
    ['non-string field key', {
      ...factDecisionEvent(0, event.time),
      data: { ...factDecisionData, fieldKey: 1 },
    }],
    ['invalid field key', {
      ...factDecisionEvent(0, event.time),
      data: { ...factDecisionData, fieldKey: 'Delivery Date' },
    }],
    ['empty label', {
      ...factDecisionEvent(0, event.time),
      data: { ...factDecisionData, label: '' },
    }],
    ['overlong label', {
      ...factDecisionEvent(0, event.time),
      data: { ...factDecisionData, label: '界'.repeat(86) },
    }],
    ['blank reason', {
      ...factDecisionEvent(0, event.time),
      data: { ...factDecisionData, decisionReason: '  ' },
    }],
    ['non-string status', {
      ...factDecisionEvent(0, event.time),
      data: { ...factDecisionData, status: 1 },
    }],
    ['unknown status', {
      ...factDecisionEvent(0, event.time),
      data: { ...factDecisionData, status: 'pending' },
    }],
    ['incomplete confirmed revision', {
      ...factDecisionEvent(0, event.time),
      data: { ...factDecisionData, status: 'confirmed', factRevisionId: '00000000-0000-0000-0000-000000000723' },
    }],
    ['rejected without reason', {
      ...factDecisionEvent(0, event.time),
      data: {
        proposalId: factDecisionData.proposalId,
        projectId: factDecisionData.projectId,
        fieldKey: factDecisionData.fieldKey,
        label: factDecisionData.label,
        status: 'rejected',
      },
    }],
    ['non-confirmed revision', {
      ...factDecisionEvent(0, event.time),
      data: {
        ...factDecisionData,
        factRevisionId: '00000000-0000-0000-0000-000000000723',
        contentRevision: 1,
      },
    }],
    ['boolean content revision', {
      ...factDecisionEvent(0, event.time),
      data: {
        ...factDecisionData,
        status: 'confirmed',
        factRevisionId: '00000000-0000-0000-0000-000000000723',
        contentRevision: true,
      },
    }],
  ])('Fact append codec rejects camelCase %s', async (_case, invalid) => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)
    persistence.authorizeRequest(id, undefined, 'alice-token')

    await expect(persistence.append(id, [invalid as never]))
      .rejects.toThrow(_case === 'boolean sequence'
        ? 'non-contiguous XAgent session append'
        : 'invalid XAgent Fact session event')
    expect(value.calls.find(call => call.name === 'append')).toBeUndefined()
  })

  test.each([
    ['unknown event field', { private: 'secret' }],
    ['unknown data field', { data: { private_receipt: 'secret' } }],
    ['boolean sequence', { seq: true }],
    ['boolean time', { time: true }],
    ['append surface', { surfaceOp: 'append' }],
    ['replacement surface', { surfaceOp: { op: 'replace', start: 0, end: 0 } }],
    ['incomplete confirmed revision', {
      data: {
        status: 'confirmed',
        fact_revision_id: '00000000-0000-0000-0000-000000000723',
        decision_reason: undefined,
      },
    }],
    ['rejected without reason', { data: { status: 'rejected', decision_reason: undefined } }],
    ['non-confirmed revision', {
      data: {
        fact_revision_id: '00000000-0000-0000-0000-000000000723',
        content_revision: 1,
      },
    }],
    ['boolean content revision', {
      data: {
        status: 'confirmed',
        fact_revision_id: '00000000-0000-0000-0000-000000000723',
        content_revision: true,
        decision_reason: undefined,
      },
    }],
  ])('Fact read codec rejects snake_case %s', async (_case, override) => {
    const valid = {
      seq: 0,
      time: event.time,
      type: 'fact/proposal-decided',
      data: {
        proposal_id: factDecisionData.proposalId,
        project_id: factDecisionData.projectId,
        field_key: factDecisionData.fieldKey,
        label: factDecisionData.label,
        status: factDecisionData.status,
        decision_reason: factDecisionData.decisionReason,
      },
    }
    const payload = {
      ...valid,
      ...override,
      ...('data' in override ? { data: { ...valid.data, ...override.data } } : {}),
    }
    const value = backend()
    value.sessions.events = vi.fn(async () => ({
      schema_version: 1,
      events: [{ sequence: 0, event_type: 'fact/proposal-decided', payload }],
    }))
    const persistence = new XAgentSessionPersistence(new Context(), value)

    await expect(persistence.withUserToken('alice-token', () => persistence.readFrom(id, 0)))
      .rejects.toThrow('invalid XAgent Fact session event')
  })

  test('Fact read codec rejects a missing event envelope type', async () => {
    const value = backend()
    value.sessions.events = vi.fn(async () => ({
      schema_version: 1,
      events: [{
        sequence: 0,
        payload: {
          seq: 0,
          time: event.time,
          type: 'fact/proposal-decided',
          data: {
            proposal_id: factDecisionData.proposalId,
            project_id: factDecisionData.projectId,
            field_key: factDecisionData.fieldKey,
            label: factDecisionData.label,
            status: factDecisionData.status,
            decision_reason: factDecisionData.decisionReason,
          },
        },
      }],
    }))
    const persistence = new XAgentSessionPersistence(new Context(), value)

    await expect(persistence.withUserToken('alice-token', () => persistence.readFrom(id, 0)))
      .rejects.toThrow('invalid XAgent Fact session event')
  })

  test('partial or failed mixed append acknowledgement retains every sidecar for the exact retry', async () => {
    const ctx = new Context()
    const value = backend()
    const retrievalAttachment = {
      eventSequence: 0,
      toolCallId: 'call-retrieval-retry',
      receipt: 'opaque-retrieval-retry',
      payloadHash: 'd'.repeat(64),
    }
    const factReceiptAttachment = {
      eventSequence: 1,
      toolCallId: 'call-fact-retry',
      proposalId: '00000000-0000-0000-0000-000000000723',
      receipt: 'opaque-fact-retry',
      payloadHash: 'e'.repeat(64),
    }
    const factOutboxAttachment = {
      eventSequence: 2,
      outboxId: '00000000-0000-0000-0000-000000000724',
      payloadHash: 'f'.repeat(64),
    }
    const retrievalAttachments = vi.fn(() => [retrievalAttachment])
    const retrievalCommit = vi.fn()
    const factReceiptAttachments = vi.fn(() => [factReceiptAttachment])
    const factReceiptCommit = vi.fn()
    const factOutboxAttachments = vi.fn(() => [factOutboxAttachment])
    const factOutboxCommit = vi.fn()
    ctx.provide('xagentRetrieval', { receipts: {
      attachments: retrievalAttachments,
      commit: retrievalCommit,
    } as unknown as XAgentReceiptRegistryContract } as never)
    ctx.provide('xagentFact', {
      receipts: { attachments: factReceiptAttachments, commit: factReceiptCommit },
      outbox: { attachments: factOutboxAttachments, commit: factOutboxCommit },
    } satisfies XAgentFactPersistenceSidecars as never)
    const append = vi.fn()
      .mockResolvedValueOnce({ schema_version: 1, version: 2, last_event_sequence: 1 })
      .mockRejectedValueOnce(new Error('append unavailable'))
      .mockResolvedValueOnce({ schema_version: 1, version: 2, last_event_sequence: 2 })
    value.sessions.append = append
    const persistence = new XAgentSessionPersistence(ctx, value)
    persistence.authorizeRequest(id, undefined, 'alice-token')
    const events = [
      event,
      { seq: 1, time: event.time + 1, type: 'tool/result', data: {} } as SessionEvent,
      factDecisionEvent(2, event.time + 2),
    ]

    await expect(persistence.append(id, events)).rejects.toThrow('invalid XAgent session append response')
    await expect(persistence.append(id, events)).rejects.toThrow('append unavailable')
    expect(retrievalCommit).not.toHaveBeenCalled()
    expect(factReceiptCommit).not.toHaveBeenCalled()
    expect(factOutboxCommit).not.toHaveBeenCalled()
    await expect(persistence.append(id, events)).resolves.toBeUndefined()

    expect(append.mock.calls[0]?.[2]).toEqual(append.mock.calls[1]?.[2])
    expect(append.mock.calls[1]?.[2]).toEqual(append.mock.calls[2]?.[2])
    expect(retrievalAttachments).toHaveBeenCalledTimes(3)
    expect(factReceiptAttachments).toHaveBeenCalledTimes(3)
    expect(factOutboxAttachments).toHaveBeenCalledTimes(3)
    expect(retrievalCommit).toHaveBeenCalledExactlyOnceWith(String(id), 2)
    expect(factReceiptCommit).toHaveBeenCalledExactlyOnceWith(String(id), 2)
    expect(factOutboxCommit).toHaveBeenCalledExactlyOnceWith(String(id), 2)
  })

  test('append bytes remain identical when the optional Fact service is absent', async () => {
    let encodedBody: string | undefined
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async (_input, init) => {
        if (typeof init?.body !== 'string') throw new TypeError('expected a JSON request body')
        encodedBody = init.body
        return Response.json({ schema_version: 1, version: 2, last_event_sequence: 0 })
      },
    })
    const persistence = new XAgentSessionPersistence(new Context(), client)
    persistence.authorizeRequest(id, undefined, 'alice-token')

    await persistence.append(id, [event])

    expect(encodedBody).toBe(
      '{"schema_version":1,"expected_sequence":-1,'
      + `"idempotency_key":"append:${id}:0:0",`
      + '"events":[{"event_type":"turn/start","schema_version":1,'
      + `"payload":{"seq":0,"time":${String(event.time)},"type":"turn/start","data":{"turn":0}}}],`
      + '"retrieval_receipts":[]}',
    )
    expect(encodedBody).not.toContain('fact_proposal_receipts')
    expect(encodedBody).not.toContain('fact_outbox_events')
  })

  test('failed append retains the same owned receipt attachment for an exact retry', async () => {
    const ctx = new Context()
    const value = backend()
    const attachment = {
      eventSequence: 0,
      toolCallId: 'call-retry',
      receipt: 'opaque-retry',
      payloadHash: 'b'.repeat(64),
    }
    const attachments = vi.fn(() => [attachment])
    const commit = vi.fn()
    ctx.provide('xagentRetrieval', { receipts: {
      attachments,
      commit,
    } as unknown as XAgentReceiptRegistryContract } as never)
    const append = vi.fn()
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValueOnce({ schema_version: 1, version: 2, last_event_sequence: 0 })
    value.sessions.append = append
    const persistence = new XAgentSessionPersistence(ctx, value)
    persistence.authorizeRequest(id, undefined, 'alice-token')

    await expect(persistence.append(id, [event])).rejects.toThrow('network failed')
    expect(commit).not.toHaveBeenCalled()
    await expect(persistence.append(id, [event])).resolves.toBeUndefined()

    expect(append.mock.calls[0]?.[2]).toEqual(append.mock.calls[1]?.[2])
    expect(attachments).toHaveBeenCalledTimes(2)
    expect(commit).toHaveBeenCalledOnce()
  })

  test.each([
    {},
    { schema_version: 1, version: 2, last_event_sequence: 0, receipt: 'private' },
  ])('malformed append success retains the receipt and blocks checkpoint %#', async (invalid) => {
    const ctx = new Context()
    const value = backend()
    const attachments = vi.fn(() => [{
      eventSequence: 0,
      toolCallId: 'call-invalid-success',
      receipt: 'opaque-invalid-success',
      payloadHash: 'c'.repeat(64),
    }])
    const commit = vi.fn()
    ctx.provide('xagentRetrieval', { receipts: {
      attachments,
      commit,
    } as unknown as XAgentReceiptRegistryContract } as never)
    value.sessions.append = vi.fn()
      .mockResolvedValueOnce(invalid)
      .mockResolvedValueOnce({ schema_version: 1, version: 2, last_event_sequence: 0 })
    const persistence = new XAgentSessionPersistence(ctx, value)
    persistence.authorizeRequest(id, undefined, 'alice-token')

    await expect(persistence.append(id, [event])).rejects.toThrow('invalid XAgent session append response')
    expect(commit).not.toHaveBeenCalled()
    await expect(persistence.append(id, [event])).resolves.toBeUndefined()
    expect(commit).toHaveBeenCalledOnce()
  })
  test('模块插件入口只暴露带配置的安装函数', () => {
    expect('default' in persistenceModule).toBe(false)
    expect(typeof persistenceModule.apply).toBe('function')
  })

  test('进程启动索引不枚举任何用户会话', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)

    await expect(persistence.listForBootstrap()).resolves.toEqual([])
    expect(value.calls).toEqual([])
  })

  test('首次发布把 Header 和 seed 作为一个远端创建请求提交', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)
    const session = Session.create(id, [], header)

    await persistence.withUserToken('alice-token', () => persistence.preparePublication(session))

    const call = value.calls.find(candidate => candidate.name === 'create')
    expect(call?.args[0]).toBe('alice-token')
    expect(call?.args[1]).toMatchObject({
      session_id: '00000000-0000-0000-0000-000000000701',
      runtime_header: header,
      events: [{
        event_type: 'session/end-seed',
        payload: { seq: 0, type: 'session/end-seed' },
      }],
    })
    expect(call?.args[2]).toBeUndefined()
    expect(call?.args[1]).not.toHaveProperty('visibility')
    expect(call?.args[1]).not.toHaveProperty('project_id')
  })

  test('创建与追加只把 tool/call 的权威 callId 写入远端事件列', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)
    const toolCall: SessionEvent = {
      seq: 0,
      time: event.time,
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'call-persisted',
        name: 'propose_fact',
        arguments: '{}',
      },
    } as SessionEvent
    const ordinary = { ...event, seq: 1, data: { ...event.data, callId: 'must-not-project' } } as SessionEvent
    const publication = {
      id,
      header,
      events: [toolCall, ordinary],
    } as unknown as Session

    await persistence.withUserToken('alice-token', () => persistence.preparePublication(publication))
    persistence.authorizeRequest(id, undefined, 'alice-token')
    await persistence.append(id, [toolCall, ordinary])

    const createBody = value.calls.find(call => call.name === 'create')?.args[1] as {
      events: Array<Record<string, unknown>>
    }
    const appendBody = value.calls.find(call => call.name === 'append')?.args[2] as {
      events: Array<Record<string, unknown>>
    }
    expect(createBody).toMatchObject({
      events: [
        { event_type: 'tool/call', tool_call_id: 'call-persisted' },
        { event_type: 'turn/start' },
      ],
    })
    expect(createBody.events[1]).not.toHaveProperty('tool_call_id')
    expect(appendBody).toMatchObject({
      events: [
        { event_type: 'tool/call', tool_call_id: 'call-persisted' },
        { event_type: 'turn/start' },
      ],
    })
    expect(appendBody.events[1]).not.toHaveProperty('tool_call_id')
  })

  test('创建与追加只从成功的 pending Fact 工具结果剥离 Host 展示元数据', async () => {
    const proposalId = '00000000-0000-0000-0000-000000000721'
    const callId = 'call-fact-presentation'
    const value = backend()
    const ctx = new Context()
    const attachments = vi.fn(() => [{
      eventSequence: 1,
      toolCallId: callId,
      proposalId,
      receipt: 'opaque-fact',
      payloadHash: 'b'.repeat(64),
    }])
    ctx.provide('xagentFact', {
      receipts: { attachments, commit: vi.fn() },
      outbox: { attachments: vi.fn(() => []), commit: vi.fn() },
    } satisfies XAgentFactPersistenceSidecars as never)
    const persistence = new XAgentSessionPersistence(ctx, value)
    const call = {
      seq: 0,
      time: event.time,
      type: 'tool/call',
      data: { turn: 1, step: 1, callId, name: 'propose_fact', arguments: '{}' },
    } as SessionEvent
    const result = {
      seq: 1,
      time: event.time + 1,
      type: 'tool/result',
      surfaceOp: 'append',
      sourceEventSeqs: [0],
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'fact-result',
          role: 'user',
          source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            isError: false,
            content: [{ type: 'text', text: JSON.stringify({ proposalId, status: 'pending' }) }],
          }],
        },
        meta: { kind: 'xagent-fact', status: 'pending', proposalId },
      },
    } as unknown as SessionEvent
    const other = {
      ...result,
      seq: 2,
      data: { ...result.data, meta: { kind: 'other-tool', marker: 'preserved' } },
    } as unknown as SessionEvent
    const publication = { id, header, events: [call, result, other] } as unknown as Session

    await persistence.withUserToken('alice-token', () => persistence.preparePublication(publication))
    persistence.authorizeRequest(id, undefined, 'alice-token')
    await persistence.append(id, [call, result, other])

    const createEvents = (value.calls.find(candidate => candidate.name === 'create')?.args[1] as {
      events: Array<{ payload: SessionEvent }>
    }).events
    const appendCall = value.calls.find(candidate => candidate.name === 'append')
    const appendBody = appendCall?.args[2] as {
      events: Array<{ payload: SessionEvent }>
      fact_proposal_receipts: readonly unknown[]
    }
    for (const projected of [createEvents, appendBody.events]) {
      expect(projected[1]?.payload.data).not.toHaveProperty('meta')
      expect(projected[2]?.payload.data).toHaveProperty('meta', { kind: 'other-tool', marker: 'preserved' })
    }
    expect(appendBody.fact_proposal_receipts).toEqual([{
      event_sequence: 1,
      tool_call_id: callId,
      proposal_id: proposalId,
      receipt: 'opaque-fact',
      payload_hash: 'b'.repeat(64),
    }])
    expect(attachments).toHaveBeenCalledWith(String(id), 0, 2)
  })

  test.each([
    { kind: 'xagent-fact', status: 'pending', proposalId: 'not-a-uuid' },
    { kind: 'xagent-fact', status: 'confirmed', proposalId: '00000000-0000-0000-0000-000000000721' },
    { kind: 'xagent-fact', status: 'pending', proposalId: '00000000-0000-0000-0000-000000000721', extra: true },
  ])('拒绝不闭合或身份无效的 Fact 工具结果展示元数据 %#', async (meta) => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)
    persistence.authorizeRequest(id, undefined, 'alice-token')
    const result = {
      seq: 0,
      time: event.time,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'fact-result',
          role: 'user',
          source: { kind: 'tool', callId: 'call-fact-invalid' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call-fact-invalid',
            isError: false,
            content: [{ type: 'text', text: '{}' }],
          }],
        },
        meta,
      },
    } as unknown as SessionEvent

    await expect(persistence.append(id, [result])).rejects.toThrow('invalid XAgent Fact tool result metadata')
    expect(value.calls).toEqual([])
  })

  test('拒绝错误结果携带 pending Fact 展示元数据且不发送远端请求', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)
    persistence.authorizeRequest(id, undefined, 'alice-token')
    const result = {
      seq: 0,
      time: event.time,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'fact-result',
          role: 'user',
          source: { kind: 'tool', callId: 'call-fact-error' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call-fact-error',
            isError: true,
            content: [{ type: 'text', text: 'Error: unavailable' }],
          }],
        },
        meta: {
          kind: 'xagent-fact',
          status: 'pending',
          proposalId: '00000000-0000-0000-0000-000000000721',
        },
      },
    } as unknown as SessionEvent

    await expect(persistence.append(id, [result])).rejects.toThrow('invalid XAgent Fact tool result metadata')
    expect(value.calls).toEqual([])
  })

  test('创建与追加使用当前请求令牌，后续写入使用按 Session 固定的租约', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)

    await persistence.withUserToken('alice-token', async () => {
      await persistence.create(header)
    })
    await persistence.append(id, [event])

    expect(value.calls.find(call => call.name === 'create')?.args).toEqual([
      'alice-token',
      expect.objectContaining({
        schema_version: 1,
        session_id: '00000000-0000-0000-0000-000000000701',
        runtime_header: header,
      }),
      undefined,
    ])
    expect(value.calls.find(call => call.name === 'create')?.args[1]).not.toHaveProperty('visibility')
    expect(value.calls.find(call => call.name === 'create')?.args[1]).not.toHaveProperty('project_id')
    expect(value.calls.find(call => call.name === 'append')?.args).toEqual([
      'alice-token',
      '00000000-0000-0000-0000-000000000701',
      expect.objectContaining({
        expected_sequence: -1,
        events: [{ event_type: 'turn/start', schema_version: 1, payload: event }],
      }),
      undefined,
    ])
  })

  test('读取严格还原 Header 和事件，且远端后端没有本地 artifact', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)

    const loaded = await persistence.withUserToken('alice-token', () => persistence.load(id))
    const ranged = await persistence.withUserToken('alice-token', () => persistence.readFrom(id, 0))

    expect(loaded).toEqual({
      meta: header,
      events: [event, expect.objectContaining({ seq: 1, type: 'turn/end' })],
    })
    expect(ranged).toEqual({ meta: header, events: [event] })
    expect(value.calls.filter(call => call.name === 'events')).toEqual([{
      name: 'events',
      args: [
        'alice-token',
        '00000000-0000-0000-0000-000000000701',
        { schema_version: 1, after_sequence: -1, limit: 500 },
        undefined,
      ],
    }])
    expect(value.calls.filter(call => call.name === 'open')).toHaveLength(1)
    expect(persistence.locate(header)).toBeUndefined()
    expect(persistence.supportsRawArtifacts).toBe(false)
    await expect(persistence.readRaw(id)).rejects.toThrow('does not expose raw artifacts')
  })

  test('重开 Session 时保留 FastAPI 重建的严格 pending Fact 展示元数据', async () => {
    const value = backend()
    const proposalId = '00000000-0000-0000-0000-000000000721'
    const result = {
      seq: 0,
      time: event.time,
      type: 'tool/result',
      surfaceOp: 'append',
      data: {
        turn: 0,
        step: 0,
        message: {
          id: 'fact-result',
          role: 'user',
          source: { kind: 'tool', callId: 'call-fact' },
          content: [{
            type: 'tool-result',
            toolCallId: 'call-fact',
            isError: false,
            content: [{ type: 'text', text: JSON.stringify({ proposalId, status: 'pending' }) }],
          }],
        },
        meta: { kind: 'xagent-fact', status: 'pending', proposalId },
      },
    } as unknown as SessionEvent
    value.sessions.open = async (...args) => {
      value.calls.push({ name: 'open', args })
      return {
        schema_version: 1,
        session: { runtime_header: header, version: 2, last_event_sequence: 0 },
        events: [{ sequence: 0, payload: result }],
      }
    }
    const persistence = new XAgentSessionPersistence(new Context(), value)

    const inspected = await persistence.withUserToken('alice-token', () => persistence.inspect(id))

    expect(inspected.events).toEqual([result])
    expect(inspected.events[0]?.data.meta).toEqual({
      kind: 'xagent-fact',
      status: 'pending',
      proposalId,
    })
  })

  test('冷加载会把中断回合的关闭事件持久化后再返回平衡日志', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)

    const loaded = await persistence.withUserToken('alice-token', () => persistence.load(id))

    expect(loaded.events.map(entry => entry.type)).toEqual(['turn/start', 'turn/end'])
    expect(value.calls.find(call => call.name === 'append')?.args).toEqual([
      'alice-token',
      '00000000-0000-0000-0000-000000000701',
      expect.objectContaining({
        expected_sequence: 0,
        events: [expect.objectContaining({ event_type: 'turn/end' })],
      }),
      undefined,
    ])
  })

  test('检查会在内存中平衡中断回合，但不会改写远端日志', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)

    const inspected = await persistence.withUserToken('alice-token', () => persistence.inspect(id))

    expect(inspected.events.map(entry => entry.type)).toEqual(['turn/start', 'turn/end'])
    expect(value.calls.filter(call => call.name === 'append')).toEqual([])
  })

  test('列表与 revision 只在显式请求作用域内工作', async () => {
    const persistence = new XAgentSessionPersistence(new Context(), backend())

    await expect(persistence.list()).rejects.toThrow('unauthenticated')
    await expect(persistence.withUserToken('alice-token', () => persistence.list())).resolves.toEqual([header])
    await expect(persistence.withUserToken('alice-token', () => persistence.listSnapshots())).resolves.toEqual([
      { header, revision: 'xagent-api:2:0' },
    ])
  })

  test('FastAPI 失败时不创建本地回退状态', async () => {
    const value = backend()
    value.sessions.create = vi.fn(async () => { throw new Error('service unavailable') })
    const persistence = new XAgentSessionPersistence(new Context(), value)

    await expect(persistence.withUserToken('alice-token', () => persistence.create(header)))
      .rejects.toThrow('service unavailable')
    await expect(persistence.append(id, [event])).rejects.toThrow('unauthenticated')
  })

  test.each([
    [{ session: { id: '00000000-0000-0000-0000-000000000702', visibility: 'private', project_id: null } }],
    [{ session: { id: '00000000-0000-0000-0000-000000000701', visibility: 'private', project_id: '00000000-0000-0000-0000-000000000401' } }],
    [{ session: { id: '00000000-0000-0000-0000-000000000701', visibility: 'project', project_id: null } }],
    [{ session: { id: '00000000-0000-0000-0000-000000000701', visibility: 'project', project_id: 'not-a-uuid' } }],
  ])('创建响应身份或服务端范围畸形时不建立写入租约 %#', async (response) => {
    const value = backend()
    value.sessions.create = vi.fn(async () => ({ schema_version: 1, ...response }))
    const persistence = new XAgentSessionPersistence(new Context(), value)

    await expect(persistence.withUserToken('alice-token', () => persistence.create(header)))
      .rejects.toThrow('invalid XAgent session create response')
    await expect(persistence.append(id, [event])).rejects.toThrow('unauthenticated')
  })

  test('接受服务端确认的项目 Session 范围并建立写入租约', async () => {
    const value = backend()
    value.sessions.create = vi.fn(async () => ({
      schema_version: 1,
      session: {
        id: '00000000-0000-0000-0000-000000000701',
        visibility: 'project',
        project_id: '00000000-0000-0000-0000-000000000401',
      },
    }))
    const persistence = new XAgentSessionPersistence(new Context(), value)

    await persistence.withUserToken('alice-token', () => persistence.create(header))
    await persistence.append(id, [event])

    expect(value.calls.find(call => call.name === 'append')?.args[0]).toBe('alice-token')
  })

  test('事件追加使用消息 rpcId 绑定的发起者，而不是最后一次访问者', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)
    const userEvent: SessionEvent = {
      seq: 0,
      time: 1_787_587_200_001,
      type: 'user/message',
      data: {
        id: 'message-alice' as never,
        role: 'user',
        source: { kind: 'user', rpcId: 'alice-rpc' },
        content: [],
      } as never,
      surfaceOp: 'append',
    }
    persistence.authorizeRequest(id, 'alice-rpc', 'alice-token')
    persistence.authorizeRequest(id, 'bob-rpc', 'bob-token')

    await persistence.append(id, [userEvent])

    expect(value.calls.find(call => call.name === 'append')?.args[0]).toBe('alice-token')
  })

  test('Session flush 等待实时事件写入 FastAPI', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const value = backend()
    const persistence = new XAgentSessionPersistence(ctx, value)
    persistence.authorizeRequest(id, undefined, 'alice-token')
    const session = ctx.sessions.create(id)
    session.append('turn/start', { turn: 1 })

    await ctx.sessions.flush(session)

    expect(value.calls.find(call => call.name === 'append')?.args).toEqual([
      'alice-token',
      '00000000-0000-0000-0000-000000000701',
      expect.objectContaining({ expected_sequence: -1 }),
      undefined,
    ])
    await ctx.fiber.dispose()
  })

  test('恢复发布先持久化 end-seed，再将待投递 Outbox 与用户 Turn 精确追加一次', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const value = backend()
    const stored = [
      { ...event, data: { turn: 1 } },
      {
        seq: 1,
        time: event.time + 1,
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'completed' } },
      } as SessionEvent,
    ]
    value.sessions.open = vi.fn(async (...args) => {
      value.calls.push({ name: 'open', args })
      return {
        schema_version: 1,
        session: { runtime_header: header, version: 2, last_event_sequence: stored.length - 1 },
        events: stored.map(item => ({ sequence: item.seq, payload: item })),
      }
    })
    const appendCalls: unknown[][] = []
    value.sessions.append = vi.fn(async (...args) => {
      appendCalls.push(args)
      const body = args[2] as { expected_sequence: number; events: readonly { payload: SessionEvent }[] }
      if (body.expected_sequence !== stored.length - 1) throw new XAgentBackendError('sequence-conflict')
      stored.push(...body.events.map(item => item.payload))
      return {
        schema_version: 1 as const,
        version: 3,
        last_event_sequence: stored.length - 1,
      }
    })
    const outboxAttachments = vi.fn((_sessionId: string, first: number, last: number) => (
      first <= 3 && last >= 3
        ? [{ eventSequence: 3, outboxId: '00000000-0000-0000-0000-000000000723', payloadHash: 'c'.repeat(64) }]
        : []
    ))
    ctx.provide('xagentFact', {
      receipts: { attachments: vi.fn(() => []), commit: vi.fn() },
      outbox: { attachments: outboxAttachments, commit: vi.fn() },
    } satisfies XAgentFactPersistenceSidecars as never)
    const persistence = new XAgentSessionPersistence(ctx, value)
    persistence.authorizeRequest(id, undefined, 'alice-token')

    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled before restart'))
    await expect(persistence.prepare(id, cancelled.signal)).rejects.toThrow('cancelled before restart')
    const rolledBack = await persistence.prepare(id)
    rolledBack[Symbol.dispose]()
    expect(appendCalls).toHaveLength(0)

    using resumed = await persistence.prepare(id)
    const session = resumed.session
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    session.append('fact/proposal-decided', factDecisionData)
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    await ctx.sessions.flush(session)

    expect(appendCalls).toHaveLength(1)
    const body = appendCalls[0]?.[2] as { expected_sequence: number; events: readonly { event_type: string }[] }
    expect(body.expected_sequence).toBe(1)
    expect(body.events.map(item => item.event_type)).toEqual([
      'session/end-seed',
      'fact/proposal-decided',
      'turn/start',
      'turn/end',
    ])
    expect(outboxAttachments).toHaveBeenCalledWith(String(id), 2, 5)
    detach()
    await ctx.fiber.dispose()
  })

  test('恢复已以 end-seed 结束的日志不产生重复追加', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const value = backend()
    const marker: SessionEvent = {
      seq: 0,
      time: event.time,
      type: 'session/end-seed',
      data: {},
    }
    value.sessions.open = vi.fn(async () => ({
      schema_version: 1,
      session: { runtime_header: header, version: 2, last_event_sequence: 0 },
      events: [{ sequence: 0, payload: marker }],
    }))
    const append = vi.spyOn(value.sessions, 'append')
    const persistence = new XAgentSessionPersistence(ctx, value)
    persistence.authorizeRequest(id, undefined, 'alice-token')

    using resumed = await persistence.prepare(id)
    const detach = ctx.sessions.enter(resumed.session)
    ctx.sessions.announce(resumed.session)
    await ctx.sessions.flush(resumed.session)

    expect(append).not.toHaveBeenCalled()
    detach()
    await ctx.fiber.dispose()
  })

  test('请求令牌作用域串行执行并在成功或失败后清除', async () => {
    const persistence = new XAgentSessionPersistence(new Context(), backend())
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    const first = persistence.withUserToken('alice', async () => {
      order.push('alice-start')
      await blocked
      order.push('alice-end')
    })
    const second = persistence.withUserToken('bob', async () => { order.push('bob') })
    await Promise.resolve()
    expect(order).toEqual(['alice-start'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['alice-start', 'alice-end', 'bob'])
    await expect(persistence.withUserToken('alice', async () => { throw new Error('failed') })).rejects.toThrow('failed')
    await expect(persistence.list()).rejects.toThrow('unauthenticated')
  })

  test.each([
    [null],
    [[]],
    [{}],
    [{ sessions: null }],
    [{ sessions: [null] }],
  ])('列表拒绝畸形响应 %#', async (response) => {
    const value = backend()
    value.sessions.list = vi.fn(async () => response as never)
    const persistence = new XAgentSessionPersistence(new Context(), value)
    await expect(persistence.withUserToken('token', () => persistence.list())).rejects.toThrow('invalid XAgent session response')
  })

  test.each([
    [{ id: 1 }],
    [{ id: 'bad' }],
    [{ version: 1 }],
    [{ createdAt: 'bad' }],
    [{ createdAt: 1.5 }],
    [{ createdAt: -1 }],
    [{ cwd: 1 }],
    [{ parentSession: 1 }],
    [{ agentPreset: 1 }],
    [{ seedLength: 1.5 }],
    [{ seedLength: -1 }],
    [{ delegationDepth: 1.5 }],
    [{ delegationDepth: -1 }],
    [{ origin: 'user' }],
  ])('列表拒绝畸形 Header %#', async (override) => {
    const value = backend()
    value.sessions.list = vi.fn(async () => ({ sessions: [{ runtime_header: { ...header, ...override } }] }))
    const persistence = new XAgentSessionPersistence(new Context(), value)
    await expect(persistence.withUserToken('token', () => persistence.list())).rejects.toThrow('invalid XAgent runtime header')
  })

  test.each([
    [null],
    [[]],
    [{ events: null }],
    [{ events: [null] }],
    [{ events: [{ sequence: 0, payload: null }] }],
    [{ events: [{ sequence: 0, payload: { ...event, type: 1 } }] }],
    [{ events: [{ sequence: 0, payload: { ...event, type: '' } }] }],
    [{ events: [{ sequence: 0, payload: { ...event, seq: 1.5 } }] }],
    [{ events: [{ sequence: 0, payload: { ...event, seq: -1 } }] }],
    [{ events: [{ sequence: 0, payload: { ...event, time: 1.5 } }] }],
    [{ events: [{ sequence: 0, payload: { ...event, time: -1 } }] }],
    [{ events: [{ sequence: 0, payload: { seq: 0, time: 1, type: 'event' } }] }],
    [{ events: [{ sequence: 0, payload: { ...event, ignorable: false } }] }],
    [{ events: [{ sequence: 1, payload: event }] }],
    [{ events: [{ sequence: 0, payload: { ...event, seq: 1 } }] }],
  ])('范围读取拒绝畸形事件响应 %#', async (response) => {
    const value = backend()
    value.sessions.events = vi.fn(async () => response as never)
    const persistence = new XAgentSessionPersistence(new Context(), value)
    await expect(persistence.withUserToken('token', () => persistence.readFrom(id, 0)))
      .rejects.toThrow(/invalid XAgent|non-contiguous/)
  })

  test('open 响应校验容器、连续序列和 Session 身份', async () => {
    for (const response of [
      null,
      {},
      { session: null, events: [] },
      { session: { runtime_header: header }, events: null },
      { session: { runtime_header: header }, events: [{ sequence: 1, payload: event }] },
      { session: { runtime_header: header }, events: [{ sequence: 0, payload: { ...event, seq: 1 } }] },
      { session: { runtime_header: { ...header, id: SessionId('session-00000000-0000-0000-0000-000000000702') } }, events: [] },
    ]) {
      const value = backend()
      value.sessions.open = vi.fn(async () => response as never)
      const persistence = new XAgentSessionPersistence(new Context(), value)
      await expect(persistence.withUserToken('token', () => persistence.inspect(id))).rejects.toThrow()
    }
  })

  test('取消信号、范围参数和 revision 失败关闭', async () => {
    const persistence = new XAgentSessionPersistence(new Context(), backend())
    for (const fromSeq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(persistence.readFrom(id, fromSeq)).rejects.toThrow('fromSeq must be a non-negative safe integer')
    }
    const cancelledOperations: Array<(signal: AbortSignal) => Promise<unknown>> = [
      (signal: AbortSignal) => persistence.inspect(id, signal),
      (signal: AbortSignal) => persistence.readFrom(id, 0, signal),
      (signal: AbortSignal) => persistence.list(signal),
      (signal: AbortSignal) => persistence.listForBootstrap(signal),
      (signal: AbortSignal) => persistence.listSnapshots(signal),
    ]
    for (const operation of cancelledOperations) {
      const controller = new AbortController(); controller.abort(new Error('cancelled'))
      await expect(Promise.resolve().then(() => operation(controller.signal))).rejects.toThrow('cancelled')
    }

    for (const row of [
      { runtime_header: header, version: 1.5, last_event_sequence: 0 },
      { runtime_header: header, version: 1, last_event_sequence: 1.5 },
    ]) {
      const value = backend()
      value.sessions.list = vi.fn(async () => ({ sessions: [row] }))
      const candidate = new XAgentSessionPersistence(new Context(), value)
      await expect(candidate.withUserToken('token', () => candidate.listSnapshots()))
        .rejects.toThrow('invalid XAgent session revision')
    }
  })

  test('范围读取翻页、缓存租约并拒绝不存在的 Session', async () => {
    const value = backend()
    const page = Array.from({ length: 500 }, (_, seq) => ({
      sequence: seq,
      payload: { seq, time: seq, type: 'event', data: {}, ignorable: true },
    }))
    const events = vi.fn()
      .mockResolvedValueOnce({ events: page })
      .mockResolvedValueOnce({ events: [] })
    value.sessions.events = events
    const persistence = new XAgentSessionPersistence(new Context(), value)
    const result = await persistence.withUserToken('token', () => persistence.readFrom(id, 0))
    expect(result.events).toHaveLength(500)
    expect(events).toHaveBeenLastCalledWith(
      'token', '00000000-0000-0000-0000-000000000701',
      { schema_version: 1, after_sequence: 499, limit: 500 }, undefined,
    )

    const missing = backend()
    missing.sessions.list = vi.fn(async () => ({ sessions: [] }))
    const absent = new XAgentSessionPersistence(new Context(), missing)
    await expect(absent.withUserToken('token', () => absent.readFrom(id, 0))).rejects.toThrow('session not found')
  })

  test('追加拒绝无租约与非连续事件，空批次为 no-op', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)
    await expect(persistence.append(id, [])).resolves.toBeUndefined()
    await expect(persistence.append(id, [event])).rejects.toThrow('unauthenticated')
    persistence.authorizeRequest(id, undefined, 'token')
    await expect(persistence.append(id, [event, { ...event, seq: 2 }])).rejects.toThrow('non-contiguous')
    await expect(persistence.append(id, Array(1) as SessionEvent[])).resolves.toBeUndefined()
    await expect(persistence.append(id, [event, undefined as never])).resolves.toBeUndefined()
    await expect(new XAgentSessionPersistence(new Context(), backend()).inspect(id)).rejects.toThrow('unauthenticated')
    await expect(persistence.withUserToken('token', () => persistence.create({ ...header, id: SessionId('bad') })))
      .rejects.toThrow('invalid XAgent session id')
  })

  test('消息令牌绑定忽略畸形或其他 Session 的 rpcId，并在 turn/end 后释放 turn lease', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)
    const message = (seq: number, rpcId: unknown): SessionEvent => ({
      seq, time: seq, type: 'user/message', surfaceOp: 'append',
      data: { id: `m-${seq}`, role: 'user', source: { kind: 'user', rpcId }, content: [] } as never,
    })
    persistence.authorizeRequest(SessionId('session-00000000-0000-0000-0000-000000000702'), 'other', 'other-token')
    persistence.authorizeRequest(id, undefined, 'lease-token')
    await persistence.append(id, [message(0, 1)])
    await persistence.append(id, [{ seq: 1, time: 1, type: 'user/message', data: {} } as never])
    await persistence.append(id, [message(2, 'other')])
    persistence.authorizeRequest(id, 'turn', 'turn-token')
    await persistence.append(id, [message(3, 'turn')])
    await persistence.append(id, [{ seq: 4, time: 4, type: 'turn/end', data: { turn: 0, status: 'done' } } as never])
    expect(value.calls.filter(call => call.name === 'append').map(call => call.args[0]))
      .toEqual(['lease-token', 'lease-token', 'lease-token', 'turn-token', 'turn-token'])
  })

  test('内存 Session 直接读取；活动中断回合禁止 crash repair', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persistence = new XAgentSessionPersistence(ctx, backend())
    const live = ctx.sessions.create(id)
    live.append('todo/write', { todos: [] })
    const inspected = await persistence.inspect(id)
    expect(inspected.meta.id).toBe(id)
    await expect(persistence.load(id)).resolves.toEqual(inspected)
    live.append('turn/start', { turn: 1 })
    await expect(persistence.load(id)).rejects.toThrow('cannot crash-repair live session')
    await ctx.fiber.dispose()
  })

  test('完整冷会话不追加 crash-repair 事件，列表可跳过其他 Header', async () => {
    const value = backend()
    value.sessions.open = vi.fn(async () => ({
      session: { runtime_header: header },
      events: [{ sequence: 0, payload: { ...event, type: 'event' } }],
    }))
    value.sessions.list = vi.fn(async () => ({ sessions: [
      { runtime_header: { ...header, id: SessionId('session-00000000-0000-0000-0000-000000000702') } },
      { runtime_header: header },
    ] }))
    const persistence = new XAgentSessionPersistence(new Context(), value)
    const loaded = await persistence.withUserToken('token', () => persistence.load(id))
    expect(loaded.events).toHaveLength(1)
    expect(value.calls.filter(call => call.name === 'append')).toEqual([])
    await expect(persistence.withUserToken('token', () => persistence.readFrom(id, 0))).resolves.toMatchObject({ meta: header })
  })

  test('实时写路径合并定时批次、等待并发 flush，并在 dispose 后释放绑定', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      const value = backend()
      let release!: () => void
      const blocked = new Promise<void>((resolve) => { release = resolve })
      const append = vi.fn(async () => {
        await blocked
        return { schema_version: 1 as const, version: 2, last_event_sequence: 1 }
      })
      value.sessions.append = append
      const persistence = new XAgentSessionPersistence(ctx, value)
      persistence.authorizeRequest(id, 'request', 'token')
      const session = { id } as Session
      ctx.emit('session/event', session, event)
      ctx.emit('session/event', session, { seq: 1, time: event.time + 1, type: 'todo/write', data: { todos: [] } })
      const first = ctx.parallel('session/flush', session)
      const second = ctx.parallel('session/flush', session)
      release()
      await Promise.all([first, second])
      expect(append).toHaveBeenCalledOnce()
      ctx.emit('session/disposed', session)
      await Promise.resolve(); await Promise.resolve()
      await expect(persistence.append(id, [event])).rejects.toThrow('unauthenticated')
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('空 checkpoint 后到达的事件仍会触发定时写入', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      const value = backend()
      const persistence = new XAgentSessionPersistence(ctx, value)
      persistence.authorizeRequest(id, undefined, 'token')
      const session = { id } as Session
      ctx.emit('session/event', session, event)
      await ctx.parallel('session/flush', session)
      await ctx.parallel('session/flush', session)

      ctx.emit('session/event', session, {
        seq: 1,
        time: event.time + 1,
        type: 'todo/write',
        data: { todos: [] },
      })
      await vi.advanceTimersByTimeAsync(200)

      expect(value.calls.filter(call => call.name === 'append')).toHaveLength(2)
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('定时写入失败保留原批次，checkpoint 使用相同事件重试', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      const value = backend()
      const append = vi.fn()
        .mockRejectedValueOnce(new Error('write failed'))
        .mockResolvedValueOnce({ schema_version: 1, version: 2, last_event_sequence: 0 })
      value.sessions.append = append
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      const persistence = new XAgentSessionPersistence(ctx, value)
      persistence.authorizeRequest(id, undefined, 'token')
      const session = { id } as Session
      ctx.emit('session/event', session, event)
      await vi.advanceTimersByTimeAsync(200)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('write failed'))
      await expect((persistence as unknown as { flushWrites(id: SessionId): Promise<void> }).flushWrites(id))
        .resolves.toBeUndefined()
      expect(append.mock.calls[0]?.[2]).toEqual(append.mock.calls[1]?.[2])
      ctx.emit('session/disposed', session)
      await Promise.resolve(); await Promise.resolve()
      expect(warn).toHaveBeenCalledOnce()
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('Session dispose 写失败保留批次，provider dispose 重试后才完成', async () => {
    const ctx = new Context()
    const value = backend()
    const append = vi.fn()
      .mockRejectedValueOnce(new Error('dispose write failed'))
      .mockResolvedValueOnce({ schema_version: 1, version: 2, last_event_sequence: 0 })
    value.sessions.append = append
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const persistence = new XAgentSessionPersistence(ctx, value)
    persistence.authorizeRequest(id, undefined, 'token')
    const session = { id } as Session
    ctx.emit('session/event', session, event)

    ctx.emit('session/disposed', session)
    await vi.waitFor(() => { expect(append).toHaveBeenCalledOnce() })
    await ctx.fiber.dispose()

    expect(append).toHaveBeenCalledTimes(2)
    expect(append.mock.calls[0]?.[2]).toEqual(append.mock.calls[1]?.[2])
  })

  test('非 Error 写失败也保留原批次，并清理未触发的 timer 和同 Session 请求绑定', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      const value = backend()
      value.sessions.append = vi.fn()
        .mockRejectedValueOnce('failure')
        .mockResolvedValueOnce({ schema_version: 1, version: 2, last_event_sequence: 0 })
      vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      const persistence = new XAgentSessionPersistence(ctx, value)
      persistence.authorizeRequest(id, 'same', 'token')
      persistence.authorizeRequest(SessionId('session-00000000-0000-0000-0000-000000000702'), 'other', 'other-token')
      const session = { id } as Session
      ctx.emit('session/event', session, event)
      const internal = persistence as unknown as { flushWrites(id: SessionId): Promise<void> }
      await expect(internal.flushWrites(id)).rejects.toBe('failure')
      await expect(internal.flushWrites(id)).resolves.toBeUndefined()
      ctx.emit('session/disposed', session)
      await Promise.resolve(); await Promise.resolve()
      vi.runOnlyPendingTimers()
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('没有写状态的 flush/dispose 均为 no-op，dispose 会清除尚未触发的 timer', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      const persistence = new XAgentSessionPersistence(ctx, backend())
      const absent = { id } as Session
      await expect(ctx.parallel('session/flush', absent)).resolves.toBeUndefined()
      ctx.emit('session/disposed', absent)
      await Promise.resolve()
      persistence.authorizeRequest(id, undefined, 'token')
      ctx.emit('session/event', absent, event)
      ;(persistence as unknown as { releaseSession(id: SessionId): void }).releaseSession(id)
      vi.runOnlyPendingTimers()
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('flushSession 对缺失 Session 为 no-op，对活动 Session 委托 registry flush', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persistence = new XAgentSessionPersistence(ctx, backend())
    await expect(persistence.flushSession(id)).resolves.toBeUndefined()
    persistence.authorizeRequest(id, undefined, 'token')
    const live = ctx.sessions.create(id)
    live.append('todo/write', { todos: [] })
    await persistence.flushSession(id)
    await ctx.fiber.dispose()
  })

  test('插件入口注册远端 Session Persistence 服务', async () => {
    const ctx = new Context()
    ctx.provide('sessions', { get: () => undefined } as never)
    persistenceModule.apply(ctx, { backendOrigin: 'https://api.example.test', serviceToken: 'service' })
    expect(ctx.get('sessionPersistence')).toBeInstanceOf(XAgentSessionPersistence)
    await ctx.fiber.dispose()
  })
})
