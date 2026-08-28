/** Exact query-token counting for the pinned XAgent embedding model. */

/** BGE-M3 repository whose tokenizer defines the retrieval query limit. */
export const BGE_M3_MODEL_ID = 'BAAI/bge-m3'
/** Immutable BGE-M3 revision whose tokenizer defines the retrieval query limit. */
export const BGE_M3_REVISION = '5617a9f61b028005a4858fdac845db406aefb181'
/** Maximum UTF-8 query bytes accepted before tokenizer transport. */
export const MAX_BGE_M3_QUERY_BYTES = 8 * 1024
/** Maximum JSON request bytes after worst-case legal scalar escaping. */
export const MAX_BGE_M3_REQUEST_BYTES = MAX_BGE_M3_QUERY_BYTES * 6 + 11
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

function utf8Size(value: string, limit: number): number | undefined {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const firstUnit = value.charCodeAt(index)
    let codePoint = firstUnit
    if (firstUnit >= 0xd800 && firstUnit <= 0xdbff) {
      if (index + 1 >= value.length) return undefined
      const secondUnit = value.charCodeAt(index + 1)
      if (secondUnit < 0xdc00 || secondUnit > 0xdfff) return undefined
      codePoint = (firstUnit - 0xd800) * 0x400 + secondUnit - 0xdc00 + 0x10000
      index += 1
    } else if (firstUnit >= 0xdc00 && firstUnit <= 0xdfff) {
      return undefined
    }
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (bytes > limit) return bytes
  }
  return bytes
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
   * @param origin - published XAgent API origin.
   * @param serviceToken - exact Host service identity for the internal relay.
   * @param fetchImplementation - standards-compatible HTTP transport.
   */
  constructor(
    origin: string,
    private readonly serviceToken: string,
    private readonly fetchImplementation: Fetch = fetch,
  ) {
    let backend: URL
    try {
      backend = new URL(origin)
    } catch {
      throw new TypeError('invalid XAgent tokenizer configuration')
    }
    if ((backend.protocol !== 'http:' && backend.protocol !== 'https:') || serviceToken.length === 0) {
      throw new TypeError('invalid XAgent tokenizer configuration')
    }
    this.endpoint = new URL('/internal/xagent/retrieval/token-count', backend.origin).href
  }

  /** Count exact pinned BGE-M3 tokens through the embedding service. */
  async count(value: string, signal?: AbortSignal): Promise<number> {
    const rawBytes = utf8Size(value, MAX_BGE_M3_QUERY_BYTES)
    if (rawBytes === undefined || rawBytes > MAX_BGE_M3_QUERY_BYTES) {
      throw new Error('BGE-M3 tokenizer request rejected')
    }
    const requestBody = JSON.stringify({ text: value })
    if (new TextEncoder().encode(requestBody).byteLength > MAX_BGE_M3_REQUEST_BYTES) {
      throw new Error('BGE-M3 tokenizer request rejected')
    }
    const timeout = AbortSignal.timeout(TOKENIZER_TIMEOUT_MS)
    const operationSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-xagent-service-token': this.serviceToken,
        },
        body: requestBody,
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
