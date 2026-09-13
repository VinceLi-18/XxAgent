/**
 * Closed public activation payloads for FastAPI Session persistence.
 * @module @xagent/dsh-session-persistence-api/business-skill-event-codec
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function invalid(): never { throw new TypeError('invalid kosma Business Skill session event') }

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid()
  return row
}

function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid()
  return value
}

function parse(value: unknown, digestKey: string) {
  const event = record(value, ['type', 'seq', 'time', 'ignorable', 'data'])
  if (event.type !== 'business-skill/activated' || event.ignorable !== true) invalid()
  const data = record(event.data, ['slug', 'version', 'invocation', 'turn', digestKey])
  const digest = data[digestKey]
  if (typeof data.slug !== 'string' || data.slug.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.slug)
    || (data.invocation !== 'model-tool' && data.invocation !== 'user-explicit')
    || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) invalid()
  return { type: 'business-skill/activated' as const, seq: integer(event.seq, 0), time: integer(event.time, 0), ignorable: true as const,
    data: { slug: data.slug, version: integer(data.version, 1), invocation: data.invocation,
      turn: integer(data.turn, 0), toolPolicyDigest: digest } }
}

/**
 * Encode a closed public activation event, rejecting body or private fields.
 * @param value - untrusted DSH persistence input.
 * @returns detached FastAPI payload with a snake_case digest key.
 */
export function encodeBusinessSkillEvent(value: unknown): Record<string, unknown> {
  const event = parse(value, 'toolPolicyDigest')
  const { toolPolicyDigest, ...data } = event.data
  return { ...event, data: { ...data, tool_policy_digest: toolPolicyDigest } }
}

/**
 * Decode an activation without admitting unknown envelope or payload fields.
 * @param value - untrusted FastAPI stored payload.
 * @returns validated DSH event with its required ignorable marker.
 */
export function decodeBusinessSkillEvent(value: unknown): SessionEvent {
  return parse(value, 'tool_policy_digest') as SessionEvent
}
