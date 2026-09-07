/** Browser-safe validation for persisted XAgent cited-answer replay metadata. */

import type { XAgentCitedAnswerBlock, XAgentCitedAnswerMeta } from './types.ts'

const CITED_ANSWER_META_MAX_BYTES = 64 * 1024
const CITED_ANSWER_META_MAX_BLOCKS = 256
const CITED_ANSWER_META_MAX_CITATIONS = 64
const CITATION_ID_PATTERN = /^\[资料([1-9][0-9]*)\]$/u

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function canonicalCitationId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const ordinal = CITATION_ID_PATTERN.exec(value)?.[1]
  return ordinal !== undefined && Number.isSafeInteger(Number(ordinal))
}

/**
 * Validate replay metadata before it can create citation UI authority.
 * @param value Candidate successful Tool-result metadata.
 * @returns A detached canonical value, or `undefined` for any noncanonical field, limit, ID, or order.
 */
export function parseXAgentCitedAnswerMeta(value: unknown): XAgentCitedAnswerMeta | undefined {
  const root = record(value)
  if (root === undefined || !exactKeys(root, ['kind', 'schemaVersion', 'blocks', 'citationIds'])
    || root.kind !== 'xagent-cited-answer' || root.schemaVersion !== 1
    || !Array.isArray(root.blocks) || root.blocks.length < 1 || root.blocks.length > CITED_ANSWER_META_MAX_BLOCKS
    || !Array.isArray(root.citationIds)) return undefined

  const blocks: XAgentCitedAnswerBlock[] = []
  const firstUse: string[] = []
  const seen = new Set<string>()
  let hasMarkdown = false
  let citationCount = 0
  for (const candidate of root.blocks) {
    const block = record(candidate)
    if (block === undefined || typeof block.type !== 'string') return undefined
    if (block.type === 'markdown') {
      if (!exactKeys(block, ['type', 'text']) || typeof block.text !== 'string') return undefined
      hasMarkdown ||= block.text.length > 0
      blocks.push(Object.freeze({ type: 'markdown', text: block.text }))
      continue
    }
    if (block.type !== 'citation' || !exactKeys(block, ['type', 'id']) || !canonicalCitationId(block.id)) {
      return undefined
    }
    citationCount += 1
    if (citationCount > CITED_ANSWER_META_MAX_CITATIONS) return undefined
    const previous = blocks.at(-1)
    if (previous?.type === 'citation' && previous.id === block.id) return undefined
    blocks.push(Object.freeze({ type: 'citation', id: block.id }))
    if (!seen.has(block.id)) {
      seen.add(block.id)
      firstUse.push(block.id)
    }
  }
  if (!hasMarkdown || citationCount === 0 || root.citationIds.length !== firstUse.length
    || root.citationIds.some((id, index) => !canonicalCitationId(id) || id !== firstUse[index])) return undefined
  try {
    if (new TextEncoder().encode(JSON.stringify({ blocks: root.blocks })).byteLength > CITED_ANSWER_META_MAX_BYTES) return undefined
  } catch {
    return undefined
  }
  return Object.freeze({
    kind: 'xagent-cited-answer',
    schemaVersion: 1,
    blocks: Object.freeze(blocks),
    citationIds: Object.freeze(firstUse),
  })
}
