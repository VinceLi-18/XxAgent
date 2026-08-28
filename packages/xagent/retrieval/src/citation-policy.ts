/** Bounded answer validation and one reconstructable XAgent citation retry. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import {
  BlockAssembler,
  createUserMessage,
  type ContentBlock,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { XAgentCitationIdentity } from '@xagent/dsh-backend-client'
import type { Nodes, Root } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { XAgentCitationInvalidReason } from './events.ts'

/** Maximum complete buffered assistant output in UTF-8 bytes. */
export const CITATION_ANSWER_MAX_BYTES = 64 * 1024
/** Maximum aggregate tool-call arguments retained before release. */
export const CITATION_TOOL_ARGUMENTS_MAX_BYTES = 32 * 1024
/** Maximum number of protocol chunks retained before release. */
export const CITATION_STREAM_CHUNK_MAX = 4096
/** Maximum distinct streamed blocks retained in one evidence answer. */
export const CITATION_STREAM_BLOCK_MAX = 256
/** Maximum invalid-draft text retained in the durable correction event. */
export const CITATION_CORRECTION_DRAFT_MAX_BYTES = 8 * 1024
/** Maximum citation identities reconstructed from one request history. */
export const CITATION_ALLOWED_MAX = 64

const CITATION_ID = /^\[资料([1-9][0-9]*)\]$/u
const CITATION_TOKEN = /\[资料[1-9][0-9]*\]/gu
const CITATION_LIKE = /[\[\]【】［］]?资料[0-9]+[\[\]【】［］]?/gu
const HTML_LIKE = /<\/?[A-Za-z][A-Za-z0-9-]*/gu
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const CORRECTION_MESSAGE = '上一份回答未通过引用校验。请只根据已入账的资料证据重新回答；每个采用资料的事实陈述都必须使用以下允许引用，且不得编造或改写引用 ID：'
const RETRY_FAILURE_MESSAGE = '引用校验失败，正在重试。'
const TERMINAL_FAILURE_MESSAGE = '引用校验失败，无法提供经过验证的回答。'

function validCitationId(value: string): boolean {
  const match = CITATION_ID.exec(value)
  if (match?.[1] === undefined) return false
  const ordinal = Number(match[1])
  return Number.isSafeInteger(ordinal) && ordinal > 0
}

/** Authorization input evaluated immediately before the first answer byte is released. */
export interface XAgentCitationReleaseInput {
  readonly sessionId: string
  readonly citations: readonly XAgentCitationIdentity[]
  readonly signal?: AbortSignal
}

/** Live XAgent request facts resolved without trusting model-visible content. */
export interface XAgentCitationPolicyRequest {
  readonly agent: Agent
  readonly identity: object
  readonly session: Session
  /**
   * Register service ownership before starting one protected source stream.
   * @param signal - model generation cancellation joined with request and service lifetimes.
   * @returns an exact request operation whose settlement follows source iterator cleanup.
   */
  admit(signal: AbortSignal | undefined): XAgentCitationPolicyAdmission
  /**
   * Reauthorize cited evidence immediately before answer release.
   * @param input - exact Session identities and combined operation cancellation.
   * @returns when the current permission revision admits every identity.
   */
  authorize(input: XAgentCitationReleaseInput): Promise<void>
}

/** Closeable ownership registered before a protected stream starts pulling its source. */
export interface XAgentCitationPolicyAdmission {
  /** Start the exact protected operation on the first iterator pull. */
  start(): XAgentCitationPolicyOperation
  /** Close an admission that never started without claiming source settlement. */
  close(): void
}

/** Service-owned lifetime for one protected model stream. */
export interface XAgentCitationPolicyOperation {
  readonly identity: object
  readonly signal: AbortSignal
  /** Mark the owned source iterator and authorization path fully settled. */
  settle(): void
}

/** Resolve a loop-built request to its current authenticated XAgent operation. */
export type XAgentCitationPolicyResolver = (
  options: GenerateOptions,
) => XAgentCitationPolicyRequest | undefined

interface EvidenceSet {
  readonly citations: ReadonlyMap<string, XAgentCitationIdentity>
  readonly invalid: boolean
}

interface Validation {
  readonly ok: boolean
  readonly reason?: XAgentCitationInvalidReason
  readonly invalidIds: readonly string[]
  readonly used: readonly XAgentCitationIdentity[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function citationIdentity(value: unknown): XAgentCitationIdentity | undefined {
  const row = record(value)
  if (row === undefined) return undefined
  const id = row.id
  const artifactId = row.artifact_id
  const versionId = row.version_id
  const chunkId = row.chunk_id
  if (typeof id !== 'string' || !validCitationId(id)
    || typeof artifactId !== 'string' || !UUID_PATTERN.test(artifactId)
    || typeof versionId !== 'string' || !UUID_PATTERN.test(versionId)
    || typeof chunkId !== 'string' || !UUID_PATTERN.test(chunkId)) return undefined
  return Object.freeze({ id, artifactId, versionId, chunkId })
}

function toolResultText(block: ContentBlock): string | undefined {
  if (block.type !== 'tool-result' || block.isError || block.content.length !== 1) return undefined
  const content = block.content[0]
  return content?.type === 'text' ? content.text : undefined
}

function parseEvidenceMessage(message: GenerateOptions['messages'][number]): readonly XAgentCitationIdentity[] | undefined {
  if (message.source.kind !== 'tool' || message.content.length !== 1) return undefined
  const text = toolResultText(message.content[0] as ContentBlock)
  if (text === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const citations = record(value)?.citations
  if (!Array.isArray(citations) || citations.length === 0 || citations.length > 8) return undefined
  const parsed = citations.map(citationIdentity)
  return parsed.every((item): item is XAgentCitationIdentity => item !== undefined) ? parsed : undefined
}

function evidenceFor(options: GenerateOptions, session: Session): EvidenceSet | undefined {
  const admittedMessages = new Map<string, readonly string[]>()
  for (const event of session.events) {
    if (event.type !== 'tool/result') continue
    const meta = record(event.data.meta)
    if (meta?.kind !== 'xagent-retrieval' || !HASH_PATTERN.test(String(meta.payloadHash))) continue
    if (!Array.isArray(meta.citations) || meta.citations.length === 0
      || meta.citations.some(id => typeof id !== 'string' || !validCitationId(id))) continue
    admittedMessages.set(String(event.data.message.id), meta.citations as string[])
  }
  const citations = new Map<string, XAgentCitationIdentity>()
  let invalid = false
  for (const message of options.messages) {
    const admittedIds = admittedMessages.get(String(message.id))
    if (admittedIds === undefined) continue
    const parsed = parseEvidenceMessage(message)
    if (parsed === undefined || parsed.length !== admittedIds.length
      || parsed.some((item, index) => item.id !== admittedIds[index])) {
      invalid = true
      continue
    }
    for (const item of parsed) {
      const previous = citations.get(item.id)
      if (previous !== undefined && (previous.artifactId !== item.artifactId
        || previous.versionId !== item.versionId || previous.chunkId !== item.chunkId)) {
        invalid = true
      } else if (citations.size < CITATION_ALLOWED_MAX) {
        citations.set(item.id, item)
      } else {
        invalid = true
      }
    }
  }
  if (citations.size === 0 && !invalid) return undefined
  return { citations, invalid }
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle
    else high = middle - 1
  }
  let end = low
  const code = value.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return value.slice(0, end)
}

function answerText(assembler: BlockAssembler): { text: string; hasToolCall: boolean; hasReasoning: boolean } {
  const blocks = assembler.blocks()
  return {
    text: blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text).join('\n'),
    hasToolCall: blocks.some(block => block.type === 'tool-call'),
    hasReasoning: blocks.some(block => block.type === 'reasoning'),
  }
}

function unescaped(text: string, index: number): boolean {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashes += 1
  return slashes % 2 === 0
}

interface ProseSegment {
  readonly rendered: string
  readonly source: string
}

const HTML_VOID_ELEMENTS = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'img',
  'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
])

interface SourceRange {
  readonly start: number
  readonly end: number
}

function sourceRange(node: Nodes): SourceRange | undefined {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return start === undefined || end === undefined ? undefined : { start, end }
}

function insideRange(index: number, ranges: readonly SourceRange[]): boolean {
  return ranges.some(range => index >= range.start && index < range.end)
}

function proseSegments(markdown: string): { segments: ProseSegment[]; htmlAliases: string[]; htmlUnsafe: boolean } {
  const segments: ProseSegment[] = []
  const htmlAliases: string[] = []
  const htmlRanges: SourceRange[] = []
  const ignoredRanges: SourceRange[] = []
  const htmlStack: string[] = []
  let htmlUnsafe = false
  const visit = (node: Root | Nodes): void => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const range = sourceRange(node)
      if (range !== undefined) ignoredRanges.push(range)
      return
    }
    if (node.type === 'link') {
      const range = sourceRange(node)
      if (range !== undefined && markdown[range.start] === '<' && markdown[range.end - 1] === '>') {
        ignoredRanges.push(range)
      }
    }
    if (node.type === 'html') {
      htmlAliases.push(...[...node.value.matchAll(CITATION_LIKE)].map(match => match[0]))
      const range = sourceRange(node)
      if (range !== undefined) htmlRanges.push(range)
      const closing = /^<\/([A-Za-z][A-Za-z0-9-]*)\s*>$/u.exec(node.value)
      if (closing?.[1] !== undefined) {
        const name = closing[1].toLowerCase()
        if (htmlStack.at(-1) === name) htmlStack.pop()
        else htmlUnsafe = true
        return
      }
      const opening = /^<([A-Za-z][A-Za-z0-9-]*)(?:\s[\s\S]*?)?>$/u.exec(node.value)
      if (opening?.[1] !== undefined && !/\/\s*>$/u.test(node.value)) {
        const name = opening[1].toLowerCase()
        if (!HTML_VOID_ELEMENTS.has(name)) htmlStack.push(name)
      }
      return
    }
    if (node.type === 'text') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (htmlStack.length > 0) {
        htmlAliases.push(...[...node.value.matchAll(CITATION_LIKE)].map(match => match[0]))
        return
      }
      segments.push({
        rendered: node.value,
        source: start === undefined || end === undefined ? node.value : markdown.slice(start, end),
      })
      return
    }
    if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  visit(fromMarkdown(markdown))
  if (htmlStack.length > 0) htmlUnsafe = true
  for (const match of markdown.matchAll(HTML_LIKE)) {
    if (unescaped(markdown, match.index)
      && !insideRange(match.index, htmlRanges)
      && !insideRange(match.index, ignoredRanges)) {
      htmlUnsafe = true
    }
  }
  return { segments, htmlAliases, htmlUnsafe }
}

function explicitCitations(text: string): { ids: string[]; malformed: string[] } {
  const ids: string[] = []
  const prose = proseSegments(text)
  const malformed: string[] = [...prose.htmlAliases]
  if (prose.htmlUnsafe && [...text.matchAll(CITATION_LIKE)].length > 0) malformed.push('<raw-html>')
  let aggregateOffset = 0
  const aggregateRanges = prose.segments.map((segment) => {
    const range = [aggregateOffset, aggregateOffset + segment.rendered.length] as const
    aggregateOffset = range[1]
    return range
  })
  const aggregate = prose.segments.map(segment => segment.rendered).join('')
  for (const match of aggregate.matchAll(CITATION_LIKE)) {
    const end = match.index + match[0].length
    if (!aggregateRanges.some(([start, rangeEnd]) => match.index >= start && end <= rangeEnd)) {
      malformed.push(match[0])
    }
  }
  for (const segment of prose.segments) {
    const ignoredRanges: Array<[number, number]> = []
    let sourceCursor = 0
    for (const match of segment.rendered.matchAll(CITATION_TOKEN)) {
      const sourceIndex = segment.source.indexOf(match[0], sourceCursor)
      if (sourceIndex < 0) {
        malformed.push(match[0])
      } else {
        sourceCursor = sourceIndex + match[0].length
        if (unescaped(segment.source, sourceIndex)) ids.push(match[0])
      }
      ignoredRanges.push([match.index, match.index + match[0].length])
    }
    const covered = (index: number): boolean => ignoredRanges.some(([start, end]) => index >= start && index < end)
    for (const match of segment.rendered.matchAll(CITATION_LIKE)) {
      if (!covered(match.index)) malformed.push(match[0])
    }
  }
  return { ids: [...new Set(ids)], malformed: [...new Set(malformed)].slice(0, CITATION_ALLOWED_MAX) }
}

function validateAnswer(text: string, evidence: EvidenceSet): Validation {
  if (evidence.invalid) return { ok: false, reason: 'stream-invalid', invalidIds: [], used: [] }
  const { ids, malformed } = explicitCitations(text)
  if (malformed.length > 0) {
    return { ok: false, reason: 'citation-malformed', invalidIds: malformed.slice(0, CITATION_ALLOWED_MAX), used: [] }
  }
  if (text.trim().length > 0 && ids.length === 0) {
    return { ok: false, reason: 'citation-missing', invalidIds: [], used: [] }
  }
  const unknown = ids.filter(id => !evidence.citations.has(id))
  if (unknown.length > 0) {
    return { ok: false, reason: 'citation-unknown', invalidIds: unknown.slice(0, CITATION_ALLOWED_MAX), used: [] }
  }
  const used = ids.map(id => evidence.citations.get(id)).filter((item): item is XAgentCitationIdentity => item !== undefined)
  return { ok: true, invalidIds: [], used }
}

interface CanonicalChunk {
  readonly chunk?: StreamChunk
  readonly outputBytes: number
  readonly toolBytes: number
  readonly overflow: boolean
  readonly invalid: boolean
}

function canonicalChunk(chunk: StreamChunk, outputRemaining: number, toolRemaining: number): CanonicalChunk {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta': {
      const text = utf8Prefix(chunk.text, outputRemaining)
      return {
        chunk: { ...chunk, text }, outputBytes: Buffer.byteLength(text), toolBytes: 0,
        overflow: text !== chunk.text, invalid: false,
      }
    }
    case 'tool-call-delta': {
      const bytes = Buffer.byteLength(chunk.argumentsDelta)
        + Buffer.byteLength(chunk.name ?? '') + Buffer.byteLength(String(chunk.id))
      return bytes > toolRemaining
        ? { chunk: { type: 'block-start', index: chunk.index, blockType: 'tool-call' }, outputBytes: 0, toolBytes: toolRemaining, overflow: true, invalid: false }
        : { chunk, outputBytes: 0, toolBytes: bytes, overflow: false, invalid: false }
    }
    case 'block-end': {
      if (chunk.block.type === 'text' || chunk.block.type === 'reasoning') {
        const text = utf8Prefix(chunk.block.text, outputRemaining)
        return {
          chunk: { ...chunk, block: { ...chunk.block, text } },
          outputBytes: Buffer.byteLength(text), toolBytes: 0,
          overflow: text !== chunk.block.text, invalid: false,
        }
      }
      if (chunk.block.type === 'tool-call') {
        const bytes = Buffer.byteLength(chunk.block.arguments) + Buffer.byteLength(chunk.block.name)
          + Buffer.byteLength(String(chunk.block.id))
        return bytes > toolRemaining
          ? { chunk: { type: 'block-start', index: chunk.index, blockType: 'tool-call' }, outputBytes: 0, toolBytes: toolRemaining, overflow: true, invalid: false }
          : { chunk, outputBytes: 0, toolBytes: bytes, overflow: false, invalid: false }
      }
      return { chunk, outputBytes: 0, toolBytes: 0, overflow: false, invalid: false }
    }
    case 'block-start':
    case 'usage':
    case 'finish': return { chunk, outputBytes: 0, toolBytes: 0, overflow: false, invalid: false }
    default: return { outputBytes: 0, toolBytes: 0, overflow: false, invalid: true }
  }
}

async function nextChunk(
  iterator: AsyncIterator<StreamChunk>,
  signal: AbortSignal,
): Promise<IteratorResult<StreamChunk>> {
  const aborted = Promise.withResolvers<never>()
  const reject = (): void => { aborted.reject(signal.reason ?? new DOMException('aborted', 'AbortError')) }
  signal.addEventListener('abort', reject, { once: true })
  if (signal.aborted) reject()
  try {
    return await Promise.race([iterator.next(), aborted.promise])
  } finally {
    signal.removeEventListener('abort', reject)
  }
}

function finishError(code: 'CITATION_INVALID' | 'CITATION_FAILED', message: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function correctionInstruction(allowedIds: readonly string[]): string {
  return `${CORRECTION_MESSAGE}${allowedIds.join('、')}`
}

function appendInvalid(
  request: XAgentCitationPolicyRequest,
  retrying: boolean,
  draftSha256: string,
  text: string,
  validation: Validation,
  allowedIds: readonly string[],
): { chunk: StreamChunk; correctionMessageId?: string } {
  const reason = validation.reason ?? 'stream-invalid'
  if (!retrying) {
    request.session.append('xagent/citation-correction', {
      draftSha256,
      invalidDraft: utf8Prefix(text, CITATION_CORRECTION_DRAFT_MAX_BYTES),
      reason,
      invalidIds: validation.invalidIds,
      allowedIds,
    })
    const correction = createUserMessage({
      content: [{ type: 'text', text: correctionInstruction(allowedIds) }],
      source: { kind: 'plugin', plugin: 'xagent-retrieval' },
    })
    request.session.append('user/message', correction, { surfaceOp: 'append' })
    return {
      chunk: finishError('CITATION_INVALID', RETRY_FAILURE_MESSAGE),
      correctionMessageId: String(correction.id),
    }
  }
  request.session.append('xagent/citation-failure', {
    draftSha256,
    reason,
    invalidIds: validation.invalidIds,
    allowedIds,
  })
  return { chunk: finishError('CITATION_FAILED', TERMINAL_FAILURE_MESSAGE) }
}

function protectedStream(
  next: () => AsyncIterable<StreamChunk>,
  request: XAgentCitationPolicyRequest,
  admission: XAgentCitationPolicyAdmission,
  evidence: EvidenceSet,
  retrying: boolean,
  flush: () => Promise<void>,
  markInvalid: (failure: object, correctionMessageId: string) => void,
  markTerminal: (failure: object) => void,
  clearRetry: () => void,
): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    const operation = admission.start()
    const chunks: StreamChunk[] = []
    const assembler = new BlockAssembler()
    let iterator: AsyncIterator<StreamChunk> | undefined
    let sourceDone = false
    try {
      await flush()
      operation.signal.throwIfAborted()
      iterator = next()[Symbol.asyncIterator]()
      let outputBytes = 0
      let toolBytes = 0
      let overflow = false
      let invalidChunk = false
      let seenChunks = 0
      const blockIndexes = new Set<number>()
      let final: StreamChunk | undefined
      while (!sourceDone) {
        let item: IteratorResult<StreamChunk>
        try {
          item = await nextChunk(iterator, operation.signal)
        } catch (error: unknown) {
          if (operation.signal.aborted) return
          throw error
        }
        if (item.done) {
          sourceDone = true
          break
        }
        const raw = item.value
        seenChunks += 1
        const index = 'index' in raw && typeof raw.index === 'number' ? raw.index : undefined
        if (index !== undefined && !blockIndexes.has(index)) {
          if (blockIndexes.size >= CITATION_STREAM_BLOCK_MAX) {
            overflow = true
            break
          }
          blockIndexes.add(index)
        }
        const accepted = canonicalChunk(
          raw,
          Math.max(0, CITATION_ANSWER_MAX_BYTES - outputBytes),
          Math.max(0, CITATION_TOOL_ARGUMENTS_MAX_BYTES - toolBytes),
        )
        outputBytes += accepted.outputBytes
        toolBytes += accepted.toolBytes
        invalidChunk ||= accepted.invalid
        overflow ||= accepted.overflow
        if (accepted.chunk !== undefined) assembler.push(accepted.chunk)
        if (!invalidChunk && !overflow) chunks.push(raw)
        if (raw.type === 'finish') {
          final = raw
          break
        }
        if (seenChunks >= CITATION_STREAM_CHUNK_MAX
          || outputBytes >= CITATION_ANSWER_MAX_BYTES
          || toolBytes >= CITATION_TOOL_ARGUMENTS_MAX_BYTES
          || overflow) {
          overflow = true
          break
        }
      }
      if (!sourceDone) {
        await iterator.return?.()
        sourceDone = true
      }
      if (operation.signal.aborted) return
      if (final?.type === 'finish' && (final.reason.kind === 'error' || final.reason.kind === 'aborted')) {
        yield final
        return
      }
      const answer = answerText(assembler)
      const draftSha256 = createHash('sha256').update(answer.text).digest('hex')
      let validation = overflow
        ? { ok: false, reason: 'answer-too-large' as const, invalidIds: [], used: [] }
        : invalidChunk || final?.type !== 'finish'
          ? { ok: false, reason: 'stream-invalid' as const, invalidIds: [], used: [] }
          : validateAnswer(answer.text, evidence)
      if (answer.hasReasoning) {
        validation = { ok: false, reason: 'stream-invalid', invalidIds: [], used: [] }
      } else if (answer.text.length === 0 && answer.hasToolCall && !overflow && !evidence.invalid) {
        validation = { ok: true, invalidIds: [], used: [] }
      }
      const allowedIds = [...evidence.citations.keys()].sort((left, right) => {
        const a = Number(CITATION_ID.exec(left)?.[1] ?? 0)
        const b = Number(CITATION_ID.exec(right)?.[1] ?? 0)
        return a - b
      })
      if (!validation.ok) {
        const failure = appendInvalid(request, retrying, draftSha256, answer.text, validation, allowedIds)
        if (!retrying && failure.chunk.type === 'finish' && failure.chunk.reason.kind === 'error'
          && failure.correctionMessageId !== undefined) {
          markInvalid(failure.chunk.reason.failure, failure.correctionMessageId)
        }
        if (retrying && failure.chunk.type === 'finish' && failure.chunk.reason.kind === 'error') {
          markTerminal(failure.chunk.reason.failure)
        }
        yield failure.chunk
        return
      }
      if (validation.used.length > 0) {
        try {
          await request.authorize({
            sessionId: String(request.session.id),
            citations: validation.used,
            signal: operation.signal,
          })
        } catch (error: unknown) {
          if (aborted(operation.signal)
          || error instanceof DOMException && error.name === 'AbortError') return
          const failure = appendInvalid(request, retrying, draftSha256, answer.text, {
            ok: false, reason: 'citation-revoked', invalidIds: validation.used.map(item => item.id), used: [],
          }, allowedIds)
          if (!retrying && failure.chunk.type === 'finish' && failure.chunk.reason.kind === 'error'
            && failure.correctionMessageId !== undefined) {
            markInvalid(failure.chunk.reason.failure, failure.correctionMessageId)
          }
          if (retrying && failure.chunk.type === 'finish' && failure.chunk.reason.kind === 'error') {
            markTerminal(failure.chunk.reason.failure)
          }
          yield failure.chunk
          return
        }
      }
      if (aborted(operation.signal)) return
      clearRetry()
      for (const chunk of chunks) yield chunk
    } finally {
      try {
        if (iterator !== undefined && !sourceDone) await iterator.return?.()
      } finally {
        operation.settle()
      }
    }
  })()
}

/**
 * Install XAgent-only citation buffering and its one-attempt error recovery.
 * @param ctx - plugin context receiving the stream and request-error listeners.
 * @param resolve - live request resolver that binds authorization to the active Agent.
 * @returns a disposer that removes both listeners and clears retry state.
 */
export function installXAgentCitationPolicy(
  ctx: Context,
  resolve: XAgentCitationPolicyResolver,
): () => void {
  interface RetryLineage {
    readonly identity: object
    readonly agent: Agent
    readonly scopeIdentity: object
    correctionMessageId?: string
    retrying: boolean
  }
  const eligibleRetry = new WeakMap<object, RetryLineage>()
  const terminalFailures = new WeakMap<object, RetryLineage>()
  const scheduledRetries = new WeakMap<Agent, RetryLineage[]>()

  const claimLineage = (
    options: GenerateOptions,
    request: XAgentCitationPolicyRequest,
  ): { lineage: RetryLineage; ambiguous: boolean } => {
    const scheduled = scheduledRetries.get(request.agent)
    const lineage = scheduled?.shift()
    if (scheduled?.length === 0) scheduledRetries.delete(request.agent)
    if (lineage !== undefined) {
      const correctionMessageId = lineage.correctionMessageId
      const exactClaims = correctionMessageId === undefined ? 0 : options.messages
        .filter(message => String(message.id) === correctionMessageId).length
      const siblingClaim = (scheduled ?? []).some(sibling => sibling.correctionMessageId !== undefined
        && options.messages.some(message => String(message.id) === sibling.correctionMessageId))
      return {
        lineage,
        ambiguous: lineage.scopeIdentity !== request.identity || exactClaims !== 1 || siblingClaim,
      }
    }
    return {
      lineage: {
        identity: Object.freeze({}), agent: request.agent,
        scopeIdentity: request.identity, retrying: false,
      },
      ambiguous: false,
    }
  }
  const closeStream = ctx.on('llm/stream', (options, next) => {
    const request = resolve(options)
    if (request === undefined || options.sessionId === undefined
      || String(request.session.id) !== String(options.sessionId)) return next()
    const evidence = evidenceFor(options, request.session)
    if (evidence === undefined) return next()
    const admission = request.admit(options.signal)
    const { lineage, ambiguous } = claimLineage(options, request)
    return protectedStream(
      next,
      request,
      admission,
      ambiguous ? { ...evidence, invalid: true } : evidence,
      lineage.retrying,
      async () => { await ctx.sessions.flush(request.session) },
      (failure, correctionMessageId) => {
        lineage.correctionMessageId = correctionMessageId
        eligibleRetry.set(failure, lineage)
      },
      (failure) => {
        terminalFailures.set(failure, lineage)
      },
      () => {
        lineage.retrying = false
      },
    )
  })
  const closeError = ctx.on('agent/request-error', ({ agent, failure }, next): Promise<RequestErrorAction> => {
    if (failure.code === 'CITATION_INVALID') {
      const owner = eligibleRetry.get(failure)
      if (owner?.agent !== agent || owner.retrying || owner.correctionMessageId === undefined) return next()
      eligibleRetry.delete(failure)
      owner.retrying = true
      const scheduled = scheduledRetries.get(agent) ?? []
      scheduled.push(owner)
      scheduledRetries.set(agent, scheduled)
      return Promise.resolve({ kind: 'retry' })
    }
    if (failure.code === 'CITATION_FAILED') {
      const owner = terminalFailures.get(failure)
      if (owner?.agent !== agent || !owner.retrying) return next()
      terminalFailures.delete(failure)
      owner.retrying = false
      return Promise.resolve(undefined)
    }
    return next()
  })
  return () => {
    closeError()
    closeStream()
  }
}
