/** Exact query-token counting for the pinned XAgent embedding model. */

/** BGE-M3 repository whose tokenizer defines the retrieval query limit. */
export const BGE_M3_MODEL_ID = 'BAAI/bge-m3'
/** Immutable BGE-M3 revision whose tokenizer defines the retrieval query limit. */
export const BGE_M3_REVISION = '5617a9f61b028005a4858fdac845db406aefb181'

/** Exact tokenizer provider for the immutable BGE-M3 model revision. */
export interface XAgentBgeM3Tokenizer {
  readonly modelId: string
  readonly revision: string
  /**
   * Count tokens without model-added special tokens.
   * @param value - exact query text sent to retrieval.
   * @param signal - request cancellation signal.
   * @returns the tokenizer's exact token count.
   */
  count(value: string, signal?: AbortSignal): Promise<number>
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** HTTP adapter for the pinned tokenizer served by the embedding service. */
export class XAgentBgeM3HttpTokenizer implements XAgentBgeM3Tokenizer {
  readonly modelId = BGE_M3_MODEL_ID
  readonly revision = BGE_M3_REVISION
  private readonly endpoint: string

  /**
   * @param origin - embedding service origin.
   * @param fetchImplementation - standards-compatible HTTP transport.
   */
  constructor(origin: string, private readonly fetchImplementation: Fetch = fetch) {
    this.endpoint = `${origin.replace(/\/$/u, '')}/token-count`
  }

  /** Count exact pinned BGE-M3 tokens through the embedding service. */
  async count(value: string, signal?: AbortSignal): Promise<number> {
    const response = await this.fetchImplementation(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: value }),
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) throw new Error('BGE-M3 tokenizer unavailable')
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('BGE-M3 tokenizer response rejected')
    }
    const row = body as Record<string, unknown>
    if (row.model !== BGE_M3_MODEL_ID || row.revision !== BGE_M3_REVISION
      || !Number.isSafeInteger(row.token_count) || (row.token_count as number) < 0) {
      throw new Error('BGE-M3 tokenizer response rejected')
    }
    return row.token_count as number
  }
}

/**
 * Reject a provider that does not own the exact pinned tokenizer revision.
 * @param value - tokenizer provider supplied by construction or composition.
 * @returns the provider after exact model and revision validation.
 */
export function validateBgeM3Tokenizer(value: XAgentBgeM3Tokenizer | undefined): XAgentBgeM3Tokenizer {
  if (value?.modelId !== BGE_M3_MODEL_ID || value.revision !== BGE_M3_REVISION) {
    throw new Error('xagent retrieval requires the pinned BGE-M3 tokenizer')
  }
  return value
}
