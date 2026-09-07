/** Query vectors verified against BAAI/bge-m3 at the retrieval-pinned revision. */

import { readFileSync } from 'node:fs'

interface LiteralTokenVectorSpec {
  readonly name: string
  readonly tokens: number
  readonly query: string
}

interface RepeatedTokenVectorSpec {
  readonly name: string
  readonly tokens: number
  readonly unit: string
  readonly repeat: number
  readonly separator: string
}

type TokenVectorSpec = LiteralTokenVectorSpec | RepeatedTokenVectorSpec

const parsed: unknown = JSON.parse(readFileSync(new URL('./bge-m3-token-vectors.json', import.meta.url), 'utf8'))
if (!Array.isArray(parsed) || !parsed.every((value): value is TokenVectorSpec => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const common = typeof row.name === 'string' && Number.isSafeInteger(row.tokens) && (row.tokens as number) > 0
  const literal = Object.keys(row).length === 3 && typeof row.query === 'string'
  const repeated = Object.keys(row).length === 5 && typeof row.unit === 'string'
    && Number.isSafeInteger(row.repeat) && (row.repeat as number) > 0 && typeof row.separator === 'string'
  return common && (literal || repeated)
})) throw new Error('invalid pinned BGE-M3 token vectors')

/** Exact tokenizer vectors without model-added special tokens. */
export const BGE_M3_TOKEN_VECTORS = Object.freeze(parsed.map(value => Object.freeze({
  name: value.name,
  query: 'query' in value
    ? value.query
    : Array.from({ length: value.repeat }, () => value.unit).join(value.separator),
  tokens: value.tokens,
})))
