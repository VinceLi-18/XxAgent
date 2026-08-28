/** Query vectors verified against BAAI/bge-m3 at the retrieval-pinned revision. */

/** Exact tokenizer vectors without model-added special tokens. */
export const BGE_M3_TOKEN_VECTORS = Object.freeze([
  Object.freeze({ name: 'latin-511', query: Array.from({ length: 511 }, () => 'data').join(' '), tokens: 511 }),
  Object.freeze({ name: 'latin-512', query: Array.from({ length: 512 }, () => 'data').join(' '), tokens: 512 }),
  Object.freeze({ name: 'latin-513', query: Array.from({ length: 513 }, () => 'data').join(' '), tokens: 513 }),
  Object.freeze({ name: 'cjk-512', query: Array.from({ length: 256 }, () => '资料').join(' '), tokens: 512 }),
  Object.freeze({ name: 'whitespace-multibyte', query: 'data\t资料\n🚀', tokens: 5 }),
])
