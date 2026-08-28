/** Exact query-token counting for the pinned XAgent embedding model. */

/** BGE-M3 repository whose tokenizer defines the retrieval query limit. */
export const BGE_M3_MODEL_ID = 'BAAI/bge-m3'
/** Immutable BGE-M3 revision whose tokenizer defines the retrieval query limit. */
export const BGE_M3_REVISION = '5617a9f61b028005a4858fdac845db406aefb181'
/** Maximum UTF-8 query bytes accepted before tokenizer transport. */
export const MAX_BGE_M3_QUERY_BYTES = 8 * 1024
/** Maximum tokenizer response bytes accepted from the internal service. */
export const MAX_BGE_M3_RESPONSE_BYTES = 512
const TOKENIZER_TIMEOUT_MS = 5_000

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

class TokenizerResponseError extends Error {}

function rejectResponse(): never {
  throw new TokenizerResponseError('BGE-M3 tokenizer response rejected')
}

function exceedsUtf8Limit(value: string, limit: number): boolean {
  let bytes = 0
  for (const character of value) {
    const firstUnit = character.charCodeAt(0)
    const codePoint = character.length === 1
      ? firstUnit
      : (firstUnit - 0xd800) * 0x400 + character.charCodeAt(1) - 0xdc00 + 0x10000
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (bytes > limit) return true
  }
  return false
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) return rejectResponse()
  const chunks: Uint8Array[] = []
  let size = 0
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const item = await reader.read()
      signal.throwIfAborted()
      if (item.done) break
      size += item.value.byteLength
      if (size > MAX_BGE_M3_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return rejectResponse()
      }
      chunks.push(item.value)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    return rejectResponse()
  }
}

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
    if (exceedsUtf8Limit(value, MAX_BGE_M3_QUERY_BYTES)) {
      throw new Error('BGE-M3 tokenizer request rejected')
    }
    const timeout = AbortSignal.timeout(TOKENIZER_TIMEOUT_MS)
    const operationSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: value }),
        redirect: 'manual',
        signal: operationSignal,
      })
    } catch {
      throw new Error('BGE-M3 tokenizer unavailable')
    }
    if (response.status !== 200 || response.headers.get('content-type') !== 'application/json') {
      throw new Error('BGE-M3 tokenizer unavailable')
    }
    let body: unknown
    try {
      body = await readResponse(response, operationSignal)
    } catch (error) {
      if (operationSignal.aborted) throw new Error('BGE-M3 tokenizer unavailable')
      if (error instanceof TokenizerResponseError) throw error
      throw new Error('BGE-M3 tokenizer unavailable')
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('BGE-M3 tokenizer response rejected')
    }
    const row = body as Record<string, unknown>
    if (Object.keys(row).length !== 3 || row.model !== BGE_M3_MODEL_ID || row.revision !== BGE_M3_REVISION
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
