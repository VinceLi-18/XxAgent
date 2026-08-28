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
import type { XAgentCitationInvalidReason } from './events.ts'

/** Maximum complete buffered assistant output in UTF-8 bytes. */
export const CITATION_ANSWER_MAX_BYTES = 64 * 1024
/** Maximum aggregate tool-call arguments retained before release. */
export const CITATION_TOOL_ARGUMENTS_MAX_BYTES = 32 * 1024
/** Maximum number of protocol chunks retained before release. */
export const CITATION_STREAM_CHUNK_MAX = 4096
/** Maximum invalid-draft text retained in the durable correction event. */
export const CITATION_CORRECTION_DRAFT_MAX_BYTES = 8 * 1024
/** Maximum citation identities reconstructed from one request history. */
export const CITATION_ALLOWED_MAX = 64

const CITATION_ID = /^\[资料([1-9][0-9]*)\]$/u
const CITATION_LIKE = /\[资料[^\]\r\n]*\]/gu
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
  readonly session: Session
  authorize(input: XAgentCitationReleaseInput): Promise<void>
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
      } else {
        citations.set(item.id, item)
      }
    }
  }
  if (citations.size === 0 && !invalid) return undefined
  if (citations.size > CITATION_ALLOWED_MAX) invalid = true
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

function answerText(assembler: BlockAssembler): { text: string; hasToolCall: boolean } {
  const blocks = assembler.blocks()
  return {
    text: blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text).join('\n'),
    hasToolCall: blocks.some(block => block.type === 'tool-call'),
  }
}

function validateAnswer(text: string, evidence: EvidenceSet): Validation {
  if (evidence.invalid) return { ok: false, reason: 'stream-invalid', invalidIds: [], used: [] }
  const tokens = [...text.matchAll(CITATION_LIKE)].map(match => match[0])
  const malformed = tokens.filter(id => !validCitationId(id))
  if (malformed.length > 0) {
    return { ok: false, reason: 'citation-malformed', invalidIds: malformed.slice(0, CITATION_ALLOWED_MAX), used: [] }
  }
  const ids = [...new Set(tokens)]
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

interface BlockBytes {
  output: number
  tool: number
}

function bufferedBytes(chunk: StreamChunk, blocks: Map<number, BlockBytes>): { output: number; tool: number; invalid: boolean } {
  const update = (index: number, output: number, tool: number, replace = false) => {
    const previous = blocks.get(index) ?? { output: 0, tool: 0 }
    const next = replace
      ? { output, tool }
      : { output: previous.output + output, tool: previous.tool + tool }
    blocks.set(index, next)
    return { output: next.output - previous.output, tool: next.tool - previous.tool, invalid: false }
  }
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta': return update(chunk.index, Buffer.byteLength(chunk.text), 0)
    case 'tool-call-delta': return update(
      chunk.index,
      Buffer.byteLength(chunk.argumentsDelta) + (chunk.name === undefined ? 0 : Buffer.byteLength(chunk.name)),
      Buffer.byteLength(chunk.argumentsDelta),
    )
    case 'block-end': {
      if (chunk.block.type === 'text' || chunk.block.type === 'reasoning') {
        return update(chunk.index, Buffer.byteLength(chunk.block.text), 0, true)
      }
      if (chunk.block.type === 'tool-call') {
        return update(
          chunk.index,
          Buffer.byteLength(chunk.block.arguments) + Buffer.byteLength(chunk.block.name),
          Buffer.byteLength(chunk.block.arguments),
          true,
        )
      }
      return { output: 0, tool: 0, invalid: false }
    }
    case 'block-start':
    case 'usage':
    case 'finish': return { output: 0, tool: 0, invalid: false }
    default: return { output: 0, tool: 0, invalid: true }
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
): StreamChunk {
  const reason = validation.reason ?? 'stream-invalid'
  if (!retrying) {
    request.session.append('xagent/citation-correction', {
      draftSha256,
      invalidDraft: utf8Prefix(text, CITATION_CORRECTION_DRAFT_MAX_BYTES),
      reason,
      invalidIds: validation.invalidIds,
      allowedIds,
    })
    request.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: correctionInstruction(allowedIds) }],
      source: { kind: 'plugin', plugin: 'xagent-retrieval' },
    }), { surfaceOp: 'append' })
    return finishError('CITATION_INVALID', RETRY_FAILURE_MESSAGE)
  }
  request.session.append('xagent/citation-failure', {
    draftSha256,
    reason,
    invalidIds: validation.invalidIds,
    allowedIds,
  })
  request.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: TERMINAL_FAILURE_MESSAGE }],
    source: { kind: 'plugin', plugin: 'xagent-retrieval' },
  }), { surfaceOp: 'append' })
  return finishError('CITATION_FAILED', TERMINAL_FAILURE_MESSAGE)
}

function protectedStream(
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
  request: XAgentCitationPolicyRequest,
  evidence: EvidenceSet,
  retrying: boolean,
  flush: () => Promise<void>,
  markInvalid: () => void,
  clearRetry: () => void,
): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    await flush()
    options.signal?.throwIfAborted()
    const chunks: StreamChunk[] = []
    const assembler = new BlockAssembler()
    let outputBytes = 0
    let toolBytes = 0
    let overflow = false
    let invalidChunk = false
    let draftPreview = ''
    const draftHash = createHash('sha256')
    const textIndexes = new Set<number>()
    const deltaIndexes = new Set<number>()
    const hashText = (index: number, text: string): void => {
      if (!textIndexes.has(index)) {
        if (textIndexes.size > 0) draftHash.update('\n')
        textIndexes.add(index)
      }
      draftHash.update(text)
    }
    const blockBytes = new Map<number, BlockBytes>()
    let final: StreamChunk | undefined
    for await (const chunk of next()) {
      if (options.signal?.aborted === true) {
        if (chunk.type === 'finish' && chunk.reason.kind === 'aborted') yield chunk
        return
      }
      const bytes = bufferedBytes(chunk, blockBytes)
      outputBytes += bytes.output
      toolBytes += bytes.tool
      invalidChunk ||= bytes.invalid
      if (chunk.type === 'text-delta') {
        deltaIndexes.add(chunk.index)
        hashText(chunk.index, chunk.text)
        draftPreview = utf8Prefix(draftPreview + chunk.text, CITATION_CORRECTION_DRAFT_MAX_BYTES)
      } else if (chunk.type === 'block-end' && chunk.block.type === 'text' && !deltaIndexes.has(chunk.index)) {
        hashText(chunk.index, chunk.block.text)
        if (draftPreview.length === 0) {
          draftPreview = utf8Prefix(chunk.block.text, CITATION_CORRECTION_DRAFT_MAX_BYTES)
        }
      }
      if (chunks.length >= CITATION_STREAM_CHUNK_MAX
        || outputBytes > CITATION_ANSWER_MAX_BYTES
        || toolBytes > CITATION_TOOL_ARGUMENTS_MAX_BYTES) overflow = true
      if (!overflow && !invalidChunk) {
        chunks.push(chunk)
        assembler.push(chunk)
      }
      if (chunk.type === 'finish') {
        final = chunk
        break
      }
    }
    if (options.signal?.aborted === true) return
    if (final?.type === 'finish' && (final.reason.kind === 'error' || final.reason.kind === 'aborted')) {
      yield final
      return
    }
    const answer = answerText(assembler)
    const draftSha256 = draftHash.digest('hex')
    let validation = invalidChunk || final?.type !== 'finish'
      ? { ok: false, reason: 'stream-invalid' as const, invalidIds: [], used: [] }
      : overflow
        ? { ok: false, reason: 'answer-too-large' as const, invalidIds: [], used: [] }
        : validateAnswer(answer.text, evidence)
    if (answer.text.length === 0 && answer.hasToolCall && !overflow && !evidence.invalid) {
      validation = { ok: true, invalidIds: [], used: [] }
    }
    const allowedIds = [...evidence.citations.keys()].sort((left, right) => {
      const a = Number(CITATION_ID.exec(left)?.[1] ?? 0)
      const b = Number(CITATION_ID.exec(right)?.[1] ?? 0)
      return a - b
    })
    if (!validation.ok) {
      if (!retrying) markInvalid()
      yield appendInvalid(request, retrying, draftSha256, overflow ? draftPreview : answer.text, validation, allowedIds)
      return
    }
    if (validation.used.length > 0) {
      try {
        await request.authorize({
          sessionId: String(request.session.id),
          citations: validation.used,
          ...options.signal === undefined ? {} : { signal: options.signal },
        })
      } catch (error: unknown) {
        if (aborted(options.signal)
          || error instanceof DOMException && error.name === 'AbortError') return
        if (!retrying) markInvalid()
        yield appendInvalid(request, retrying, draftSha256, answer.text, {
          ok: false, reason: 'citation-revoked', invalidIds: validation.used.map(item => item.id), used: [],
        }, allowedIds)
        return
      }
    }
    if (aborted(options.signal)) return
    clearRetry()
    for (const chunk of chunks) yield chunk
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
  const retrying = new WeakSet<object>()
  const eligibleRetry = new WeakSet<object>()
  const closeStream = ctx.on('llm/stream', (options, next) => {
    const request = resolve(options)
    if (request === undefined || options.sessionId === undefined
      || String(request.session.id) !== String(options.sessionId)) return next()
    const evidence = evidenceFor(options, request.session)
    if (evidence === undefined) return next()
    return protectedStream(
      options,
      next,
      request,
      evidence,
      retrying.has(request.agent),
      async () => { await ctx.sessions.flush(request.session) },
      () => { eligibleRetry.add(request.agent) },
      () => {
        eligibleRetry.delete(request.agent)
        retrying.delete(request.agent)
      },
    )
  })
  const closeError = ctx.on('agent/request-error', ({ agent, failure }, next): Promise<RequestErrorAction> => {
    if (failure.code === 'CITATION_INVALID') {
      if (!eligibleRetry.has(agent) || retrying.has(agent)) return next()
      eligibleRetry.delete(agent)
      retrying.add(agent)
      return Promise.resolve({ kind: 'retry' })
    }
    if (failure.code === 'CITATION_FAILED') {
      if (!retrying.has(agent)) return next()
      eligibleRetry.delete(agent)
      retrying.delete(agent)
      return Promise.resolve(undefined)
    }
    return next()
  })
  const closeTurn = ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') {
      eligibleRetry.delete(agent)
      retrying.delete(agent)
    }
  })
  return () => {
    closeTurn()
    closeError()
    closeStream()
  }
}
