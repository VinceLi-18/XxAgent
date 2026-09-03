/** Closed XAgent cited-answer value, validation, and deterministic projections. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  XAgentCitedAnswer,
  XAgentCitedAnswerBlock,
  XAgentCitedAnswerErrorReason,
  XAgentCitedAnswerMeta,
} from './types.ts'

export type {
  XAgentCitedAnswer,
  XAgentCitedAnswerBlock,
  XAgentCitedAnswerErrorReason,
  XAgentCitedAnswerMeta,
} from './types.ts'

/** Maximum UTF-8 bytes in the complete model-authored JSON value. */
export const CITED_ANSWER_MAX_BYTES = 64 * 1024
/** Maximum blocks in one model-authored answer. */
export const CITED_ANSWER_MAX_BLOCKS = 256
/** Maximum citation blocks before canonical adjacent-duplicate collapse. */
export const CITED_ANSWER_MAX_CITATIONS = 64

/** Stable cited-answer rejection with no model-authored text. */
export class XAgentCitedAnswerError extends HarnessError {
  constructor(readonly reason: XAgentCitedAnswerErrorReason) {
    super('invalid cited answer', 'CITATION_INVALID')
    this.name = 'XAgentCitedAnswerError'
  }
}

function reject(reason: XAgentCitedAnswerErrorReason): never {
  throw new XAgentCitedAnswerError(reason)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Validate and canonicalize one model-authored terminal answer before authorization.
 * @param value - candidate `{ blocks }` tool arguments.
 * @param allowedIds - citation IDs reconstructed from this exact request's admitted evidence.
 * @returns an immutable canonical answer whose citation IDs follow first use.
 */
export function normalizeCitedAnswer(value: unknown, allowedIds: ReadonlySet<string>): XAgentCitedAnswer {
  const root = record(value)
  if (root === undefined || !exactKeys(root, ['blocks']) || !Array.isArray(root.blocks)) {
    reject('invalid-schema')
  }
  const inputBlocks = root.blocks
  if (inputBlocks.length < 1 || inputBlocks.length > CITED_ANSWER_MAX_BLOCKS) {
    reject('blocks-out-of-range')
  }

  let serialized: unknown
  try {
    serialized = Reflect.apply(JSON.stringify, JSON, [value])
  } catch {
    reject('invalid-json')
  }
  if (typeof serialized !== 'string') reject('invalid-json')
  if (Buffer.byteLength(serialized) > CITED_ANSWER_MAX_BYTES) reject('answer-too-large')

  const blocks: XAgentCitedAnswerBlock[] = []
  const citationIds: string[] = []
  const seenCitationIds = new Set<string>()
  let markdown = false
  let citationCount = 0
  for (const candidate of inputBlocks) {
    const block = record(candidate)
    if (block === undefined || typeof block.type !== 'string') reject('invalid-schema')
    switch (block.type) {
      case 'markdown': {
        if (!exactKeys(block, ['type', 'text']) || typeof block.text !== 'string') reject('invalid-schema')
        if (block.text.length > 0) markdown = true
        blocks.push(Object.freeze({ type: 'markdown', text: block.text }))
        break
      }
      case 'citation': {
        if (!exactKeys(block, ['type', 'id']) || typeof block.id !== 'string') reject('invalid-schema')
        citationCount += 1
        if (citationCount > CITED_ANSWER_MAX_CITATIONS) reject('too-many-citations')
        if (!allowedIds.has(block.id)) reject('citation-not-allowed')
        const previous = blocks.at(-1)
        if (previous?.type !== 'citation' || previous.id !== block.id) {
          blocks.push(Object.freeze({ type: 'citation', id: block.id }))
        }
        if (!seenCitationIds.has(block.id)) {
          seenCitationIds.add(block.id)
          citationIds.push(block.id)
        }
        break
      }
      default:
        reject('invalid-schema')
    }
  }
  if (!markdown) reject('markdown-required')
  if (citationCount === 0) reject('citation-required')
  return Object.freeze({
    schemaVersion: 1,
    blocks: Object.freeze(blocks),
    citationIds: Object.freeze(citationIds),
  })
}

/**
 * Render a canonical answer for clients without the XAgent cited-answer view.
 * @param value - canonical cited answer.
 * @returns deterministic Markdown plus explicit verified-source markers.
 */
export function renderCitedAnswer(value: XAgentCitedAnswer): string {
  return value.blocks.map(block => block.type === 'markdown'
    ? block.text
    : `【已验证资料：${block.id}】`).join('')
}

/**
 * Project a canonical answer to the closed replay metadata consumed by Business Web.
 * @param value - canonical cited answer.
 * @returns metadata containing no model-authored fields outside canonical blocks.
 */
export function toCitedAnswerMeta(value: XAgentCitedAnswer): XAgentCitedAnswerMeta {
  return Object.freeze({
    kind: 'xagent-cited-answer',
    schemaVersion: 1,
    blocks: value.blocks,
    citationIds: value.citationIds,
  })
}
