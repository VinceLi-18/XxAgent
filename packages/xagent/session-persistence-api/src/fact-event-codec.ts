/** Exact FastAPI v1 codec for persisted Fact decision events. @module @xagent/dsh-session-persistence-api/fact-event-codec */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { FactProposalDecidedEvent } from '@xagent/dsh-backend-client'

const FACT_EVENT_TYPE = 'fact/proposal-decided'
const FIELD_KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const TERMINAL_STATUSES = new Set(['confirmed', 'rejected', 'withdrawn', 'conflicted'])

type FactStatus = FactProposalDecidedEvent['data']['status']
type FactSessionEvent = FactProposalDecidedEvent & {
  readonly seq: number
  readonly time: number
}
type FactFieldNames = {
  readonly proposalId: string
  readonly projectId: string
  readonly fieldKey: string
  readonly factRevisionId: string
  readonly contentRevision: string
  readonly decisionReason: string
}

const CAMEL_FIELDS: FactFieldNames = {
  proposalId: 'proposalId',
  projectId: 'projectId',
  fieldKey: 'fieldKey',
  factRevisionId: 'factRevisionId',
  contentRevision: 'contentRevision',
  decisionReason: 'decisionReason',
}
const SNAKE_FIELDS: FactFieldNames = {
  proposalId: 'proposal_id',
  projectId: 'project_id',
  fieldKey: 'field_key',
  factRevisionId: 'fact_revision_id',
  contentRevision: 'content_revision',
  decisionReason: 'decision_reason',
}

function invalidFactEvent(): never {
  throw new TypeError('invalid XAgent Fact session event')
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidFactEvent()
  return value as Record<string, unknown>
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const row = record(value)
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !allowed.has(key))) {
    invalidFactEvent()
  }
  return row
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidFactEvent()
  return value as number
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalidFactEvent()
  return value as number
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalidFactEvent()
  return value
}

function utf8String(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0) invalidFactEvent()
  if (new TextEncoder().encode(value).byteLength > maximum) invalidFactEvent()
  return value
}

function reason(value: unknown): string {
  const result = utf8String(value, 4 * 1024)
  if (result.trim().length === 0) invalidFactEvent()
  return result
}

function parseFactSessionEvent(value: unknown, fields: FactFieldNames): FactSessionEvent {
  const event = exactRecord(value, ['seq', 'time', 'type', 'data'])
  if (event.type !== FACT_EVENT_TYPE) invalidFactEvent()
  const data = exactRecord(
    event.data,
    [fields.proposalId, fields.projectId, fields.fieldKey, 'label', 'status'],
    [fields.factRevisionId, fields.contentRevision, fields.decisionReason],
  )
  if (typeof data.status !== 'string' || !TERMINAL_STATUSES.has(data.status)) invalidFactEvent()
  const status = data.status as FactStatus
  const hasRevisionId = Object.hasOwn(data, fields.factRevisionId)
  const hasContentRevision = Object.hasOwn(data, fields.contentRevision)
  if (hasRevisionId !== hasContentRevision || (status === 'confirmed') !== hasRevisionId) invalidFactEvent()
  const decisionReason = Object.hasOwn(data, fields.decisionReason)
    ? reason(data[fields.decisionReason])
    : undefined
  if (status === 'rejected' && decisionReason === undefined) invalidFactEvent()
  const fieldKey = utf8String(data[fields.fieldKey], 128)
  if (!FIELD_KEY_PATTERN.test(fieldKey)) invalidFactEvent()
  return {
    seq: nonNegativeInteger(event.seq),
    time: nonNegativeInteger(event.time),
    type: FACT_EVENT_TYPE,
    data: {
      proposalId: uuid(data[fields.proposalId]),
      projectId: uuid(data[fields.projectId]),
      fieldKey,
      label: utf8String(data.label, 255),
      status,
      ...(hasRevisionId ? {
        factRevisionId: uuid(data[fields.factRevisionId]),
        contentRevision: positiveInteger(data[fields.contentRevision]),
      } : {}),
      ...(decisionReason === undefined ? {} : { decisionReason }),
    },
  }
}

/**
 * Encode one closed camelCase DSH Fact event for FastAPI v1 Session storage.
 * @param value - untrusted event at the persistence write boundary.
 * @returns a detached event payload with only the admitted snake_case fields.
 */
export function encodeFactSessionEvent(value: unknown): Record<string, unknown> {
  const event = parseFactSessionEvent(value, CAMEL_FIELDS)
  return {
    seq: event.seq,
    time: event.time,
    type: event.type,
    data: {
      proposal_id: event.data.proposalId,
      project_id: event.data.projectId,
      field_key: event.data.fieldKey,
      label: event.data.label,
      status: event.data.status,
      ...(event.data.factRevisionId === undefined ? {} : {
        fact_revision_id: event.data.factRevisionId,
        content_revision: event.data.contentRevision,
      }),
      ...(event.data.decisionReason === undefined ? {} : { decision_reason: event.data.decisionReason }),
    },
  }
}

/**
 * Decode one closed snake_case FastAPI v1 Fact payload for DSH replay.
 * @param value - untrusted stored payload returned by FastAPI.
 * @returns a detached, validated camelCase DSH Session event.
 */
export function decodeFactSessionEvent(value: unknown): SessionEvent {
  return parseFactSessionEvent(value, SNAKE_FIELDS) as unknown as SessionEvent
}
