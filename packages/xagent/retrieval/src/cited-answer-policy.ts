/** Request-owned XAgent terminal-answer tool and protected stream policy. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError, type ContentBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { JsonValue, Session } from '@deepseek-ai/dsh-session'
import type {
  JsonSchemaNode,
  ToolDefinition,
  ToolExecution,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import type { XAgentCitationIdentity } from '@xagent/dsh-backend-client'
import {
  CITED_ANSWER_MAX_BLOCKS,
  CITED_ANSWER_MAX_BYTES,
  XAgentCitedAnswerError,
  normalizeCitedAnswer,
  renderCitedAnswer,
  toCitedAnswerMeta,
  type XAgentCitedAnswer,
} from './cited-answer.ts'

/** Native-only terminal tool used by evidence-bearing XAgent requests. */
export const CITED_ANSWER_TOOL = 'submit_cited_answer'
/** Order-190 instruction paired with the request-owned terminal tool. */
export const CITED_ANSWER_INSTRUCTION = 'When your evidence-backed final answer is complete, you MUST call '
  + `\`${CITED_ANSWER_TOOL}\` with closed markdown and citation blocks. `
  + 'Only citation blocks identify verified sources. Do not finish with ordinary assistant text.'

const TERMINAL_FAILURE_MESSAGE = 'cited answer was not submitted'
const CITATION_ID = /^\[资料([1-9][0-9]*)\]$/u
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const MAX_ALLOWED_CITATIONS = 64

/** Request owner required by the terminal answer lifecycle. */
export interface CitedAnswerRequestOwner {
  readonly agent: object
  readonly identity: object
  readonly allowed: ReadonlyMap<string, object>
  readonly signal: AbortSignal
  readonly settlement: Promise<void>
  attempts: 0 | 1 | 2
  close(): void
}

/** Capabilities needed to open one request-owned cited-answer runtime. */
export interface OpenCitedAnswerRequestOptions {
  readonly agent: Agent
  readonly identity: object
  readonly allowed: ReadonlyMap<string, XAgentCitationIdentity>
  readonly signal: AbortSignal
  /** Reauthorize the exact normalized citation identities before the tool succeeds. */
  readonly authorize: (citations: readonly XAgentCitationIdentity[], signal: AbortSignal) => Promise<void>
}

interface OwnerState {
  readonly controller: AbortController
  readonly staged: WeakMap<ToolExecution, XAgentCitedAnswer>
  readonly authorize: OpenCitedAnswerRequestOptions['authorize']
  readonly disposers: (() => unknown)[]
  readonly settle: () => void
  active: number
  closed: boolean
  committed: boolean
  running: ToolExecution | undefined
}

const ownerStates = new WeakMap<CitedAnswerRequestOwner, OwnerState>()

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function validCitationId(value: string): boolean {
  const ordinal = CITATION_ID.exec(value)?.[1]
  return ordinal !== undefined && Number.isSafeInteger(Number(ordinal))
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

function evidenceMessage(message: GenerateOptions['messages'][number]): readonly XAgentCitationIdentity[] | undefined {
  if (message.content.length !== 1) return undefined
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

/**
 * Reconstruct exact admitted citation identities from one request and its current Session log.
 * @param messages - model-visible messages for the request.
 * @param session - authoritative Session containing the matching retrieval metadata.
 * @returns citation identities in first admitted order, or undefined for absent or inconsistent evidence.
 */
export function reconstructCitedAnswerEvidence(
  messages: GenerateOptions['messages'],
  session: Session,
): ReadonlyMap<string, XAgentCitationIdentity> | undefined {
  const admittedMessages = new Map<string, {
    readonly callId: string
    readonly citationIds: readonly string[]
  }>()
  for (const event of session.events) {
    if (event.type !== 'tool/result') continue
    const meta = record(event.data.meta)
    if (meta?.kind !== 'xagent-retrieval' || typeof meta.payloadHash !== 'string'
      || !HASH_PATTERN.test(meta.payloadHash) || !Array.isArray(meta.citations)
      || meta.citations.length === 0 || meta.citations.length > 8
      || meta.citations.some(id => typeof id !== 'string' || !validCitationId(id))) continue
    admittedMessages.set(String(event.data.message.id), {
      callId: String(event.data.message.source.callId),
      citationIds: meta.citations as string[],
    })
  }
  const citations = new Map<string, XAgentCitationIdentity>()
  for (const message of messages) {
    const admitted = admittedMessages.get(String(message.id))
    if (admitted === undefined) continue
    if (message.source.kind !== 'tool' || String(message.source.callId) !== admitted.callId) return undefined
    const parsed = evidenceMessage(message)
    if (parsed === undefined || parsed.length !== admitted.citationIds.length
      || parsed.some((item, index) => item.id !== admitted.citationIds[index])) return undefined
    for (const item of parsed) {
      const previous = citations.get(item.id)
      if (previous !== undefined && (previous.artifactId !== item.artifactId
        || previous.versionId !== item.versionId || previous.chunkId !== item.chunkId)) return undefined
      if (previous === undefined) {
        if (citations.size >= MAX_ALLOWED_CITATIONS) return undefined
        citations.set(item.id, item)
      }
    }
  }
  return citations.size === 0 ? undefined : citations
}

const BLOCK_SCHEMA: JsonSchemaNode = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      properties: { type: { type: 'string', const: 'markdown' }, text: { type: 'string' } },
      required: ['type', 'text'],
    },
    {
      type: 'object', additionalProperties: false,
      properties: { type: { type: 'string', const: 'citation' }, id: { type: 'string' } },
      required: ['type', 'id'],
    },
  ],
}

const PARAMETERS: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: {
    blocks: { type: 'array', minItems: 1, maxItems: CITED_ANSWER_MAX_BLOCKS, items: BLOCK_SCHEMA },
  },
  required: ['blocks'],
}

const OUTPUT: JsonSchemaNode = {
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    blocks: { type: 'array', items: BLOCK_SCHEMA },
    citationIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['schemaVersion', 'blocks', 'citationIds'],
}

class CitedAnswerTerminalError extends HarnessError {
  constructor() {
    super(TERMINAL_FAILURE_MESSAGE, 'CITATION_FAILED')
  }
}

function stateFor(owner: CitedAnswerRequestOwner): OwnerState {
  const state = ownerStates.get(owner)
  if (state === undefined) throw new CitedAnswerTerminalError()
  return state
}

function maybeSettle(state: OwnerState): void {
  if ((state.closed || state.committed) && state.active === 0) state.settle()
}

async function ownedOperation<T>(owner: CitedAnswerRequestOwner, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const state = stateFor(owner)
  if (state.closed) throw new CitedAnswerTerminalError()
  state.active += 1
  try {
    owner.signal.throwIfAborted()
    return await operation(owner.signal)
  } finally {
    state.active -= 1
    maybeSettle(state)
  }
}

function asAnswer(value: JsonValue): XAgentCitedAnswer {
  return value as unknown as XAgentCitedAnswer
}

function toolDefinition(owner: CitedAnswerRequestOwner): ToolDefinition {
  return {
    name: CITED_ANSWER_TOOL,
    nativeOnly: true,
    description: 'Submit the complete evidence-backed answer as ordered markdown and verified citation blocks.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderCitedAnswer(asAnswer(value)) }],
      presentationMeta: (_args, value) => toCitedAnswerMeta(asAnswer(value)) as unknown as JsonValue,
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<JsonValue> {
      const state = stateFor(owner)
      if (state.closed || state.committed || exec.agent !== owner.agent
        || exec.parent !== undefined || owner.attempts >= 2) {
        throw new CitedAnswerTerminalError()
      }
      if (state.running !== undefined) throw new XAgentCitedAnswerError('invalid-schema')
      owner.attempts = (owner.attempts + 1) as 1 | 2
      state.running = exec
      const answer = normalizeCitedAnswer(args, new Set(owner.allowed.keys()))
      state.staged.set(exec, answer)
      const identities = answer.citationIds.map((id) => {
        const identity = owner.allowed.get(id)
        if (identity === undefined) throw new XAgentCitedAnswerError('citation-not-allowed')
        return identity as XAgentCitationIdentity
      })
      try {
        await ownedOperation(owner, signal => state.authorize(identities, AbortSignal.any([signal, exec.signal])))
      } catch (error: unknown) {
        if (owner.signal.aborted || exec.signal.aborted
          || error instanceof DOMException && error.name === 'AbortError') throw error
        throw new XAgentCitedAnswerError('citation-not-allowed')
      }
      owner.signal.throwIfAborted()
      exec.signal.throwIfAborted()
      exec.concludeTurn()
      return answer as unknown as JsonValue
    },
  }
}

/**
 * Open one Agent-scoped terminal tool, prompt, guard, and authoritative-result observer.
 * @param options - exact request identity, allowed citations, lifetime, and reauthorization operation.
 * @returns the owner; `close()` removes admission before aborting and `settlement` reaches quiescence.
 */
export function openCitedAnswerRequest(options: OpenCitedAnswerRequestOptions): CitedAnswerRequestOwner {
  const controller = new AbortController()
  const settled = Promise.withResolvers<void>()
  const signal = AbortSignal.any([controller.signal, options.signal])
  let closed = false
  const owner: CitedAnswerRequestOwner = {
    agent: options.agent,
    identity: options.identity,
    allowed: options.allowed,
    signal,
    settlement: settled.promise,
    attempts: 0,
    close(): void {
      if (closed) return
      closed = true
      const state = stateFor(owner)
      state.closed = true
      for (const dispose of state.disposers.splice(0).reverse()) dispose()
      controller.abort(new DOMException('xagent cited-answer request closed', 'AbortError'))
      maybeSettle(state)
    },
  }
  const state: OwnerState = {
    controller,
    staged: new WeakMap(),
    authorize: options.authorize,
    disposers: [],
    settle: settled.resolve,
    active: 0,
    closed: false,
    committed: false,
    running: undefined,
  }
  ownerStates.set(owner, state)
  state.disposers.push(options.agent.ctx.tools.register(toolDefinition(owner)))
  state.disposers.push(options.agent.ctx.systemPrompt.section({
    name: `tool:${CITED_ANSWER_TOOL}`,
    order: 190,
    text: CITED_ANSWER_INSTRUCTION,
  }))
  state.disposers.push(options.agent.ctx.tools.guard(exec =>
    exec.agent === options.agent
      && (state.committed || state.running !== undefined)
      ? 'cited answer submission is terminal'
      : undefined))
  state.disposers.push(options.agent.ctx.on('tools/result', (exec, result) => {
    if (exec.name !== CITED_ANSWER_TOOL) return
    const staged = state.staged.get(exec)
    if (state.running === exec) state.running = undefined
    if (staged === undefined) return
    state.staged.delete(exec)
    if (!result.isError) {
      state.committed = true
      maybeSettle(state)
    }
  }))
  const abort = (): void => { owner.close() }
  options.signal.addEventListener('abort', abort, { once: true })
  state.disposers.push(() => { options.signal.removeEventListener('abort', abort) })
  if (options.signal.aborted) owner.close()
  return owner
}

function terminalFailure(): StreamChunk {
  return {
    type: 'finish',
    reason: { kind: 'error', failure: { code: 'CITATION_FAILED', message: TERMINAL_FAILURE_MESSAGE } },
  }
}

function visibleProtocolChunk(chunk: StreamChunk): boolean {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return false
  if (chunk.type === 'block-start') return chunk.blockType !== 'text' && chunk.blockType !== 'reasoning'
  if (chunk.type === 'block-end') return chunk.block.type !== 'text' && chunk.block.type !== 'reasoning'
  return true
}

/**
 * Suppress untrusted prose for one protected model request while preserving tool and protocol chunks.
 * @param _options - exact model request, retained only as the policy boundary.
 * @param owner - request owner whose attempts and lifetime govern the stream.
 * @param next - downstream model stream.
 * @returns a stream that never buffers or publishes ordinary assistant prose.
 */
export function protectCitedAnswerStream(
  _options: GenerateOptions,
  owner: CitedAnswerRequestOwner,
  next: () => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncIterable<StreamChunk> {
    const state = stateFor(owner)
    if (state.closed) return
    const abort = (): void => { owner.close() }
    _options.signal?.addEventListener('abort', abort, { once: true })
    if (_options.signal?.aborted === true) {
      owner.close()
      _options.signal.removeEventListener('abort', abort)
      return
    }
    if (owner.attempts >= 2) {
      yield terminalFailure()
      owner.close()
      _options.signal?.removeEventListener('abort', abort)
      return
    }
    state.active += 1
    let iterator: AsyncIterator<StreamChunk> | undefined
    let done = false
    let sawTerminal = false
    let sawOtherTool = false
    const toolBlocks = new Map<number, { name: string | undefined; terminalArgumentBytes: number }>()
    try {
      iterator = next()[Symbol.asyncIterator]()
      while (!done) {
        const item = await iterator.next()
        if (item.done) {
          done = true
          break
        }
        owner.signal.throwIfAborted()
        const chunk = item.value
        if (chunk.type === 'tool-call-delta') {
          let block = toolBlocks.get(chunk.index)
          if (block === undefined) {
            block = { name: chunk.name, terminalArgumentBytes: 0 }
            toolBlocks.set(chunk.index, block)
          } else if (chunk.name !== undefined) {
            if (block.name !== undefined && block.name !== chunk.name) {
              yield terminalFailure()
              owner.close()
              return
            }
            block.name = chunk.name
          }
          if (block.name === undefined || block.name === CITED_ANSWER_TOOL) {
            const delta = Buffer.byteLength(chunk.argumentsDelta)
            if (delta > CITED_ANSWER_MAX_BYTES - block.terminalArgumentBytes) {
              yield terminalFailure()
              owner.close()
              return
            }
            block.terminalArgumentBytes += delta
          }
        }
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          const streamed = toolBlocks.get(chunk.index)
          if (streamed?.name !== undefined && streamed.name !== chunk.block.name) {
            yield terminalFailure()
            owner.close()
            return
          }
          if (streamed === undefined) {
            toolBlocks.set(chunk.index, { name: chunk.block.name, terminalArgumentBytes: 0 })
          } else {
            streamed.name = chunk.block.name
          }
          if (chunk.block.name === CITED_ANSWER_TOOL
            && Buffer.byteLength(chunk.block.arguments) > CITED_ANSWER_MAX_BYTES) {
            yield terminalFailure()
            owner.close()
            return
          }
        }
        if (chunk.type === 'tool-call-delta' && chunk.name !== undefined) {
          if (chunk.name === CITED_ANSWER_TOOL) sawTerminal = true
          else sawOtherTool = true
        }
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          if (chunk.block.name === CITED_ANSWER_TOOL) sawTerminal = true
          else sawOtherTool = true
        }
        if (chunk.type === 'finish' && chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted'
          && !sawTerminal && !sawOtherTool) {
          yield terminalFailure()
          owner.close()
          return
        }
        if (visibleProtocolChunk(chunk)) yield chunk
        if (chunk.type === 'finish') return
      }
      if (!sawTerminal && !sawOtherTool && !owner.signal.aborted) {
        yield terminalFailure()
        owner.close()
      }
    } finally {
      try {
        if (iterator !== undefined && !done) await iterator.return?.()
      } finally {
        _options.signal?.removeEventListener('abort', abort)
        state.active -= 1
        maybeSettle(state)
      }
    }
  })()
}

/** Resolve a loop-built request to its exact live cited-answer owner. */
export type CitedAnswerRequestResolver = (
  options: GenerateOptions,
) => CitedAnswerRequestOwner | undefined

/**
 * Install the narrow stream filter for evidence-bearing XAgent requests.
 * @param ctx - Retrieval plugin context receiving the stream waterfall.
 * @param resolve - exact request-to-owner resolver.
 * @returns the waterfall disposer.
 */
export function installXAgentCitedAnswerPolicy(
  ctx: import('@deepseek-ai/cordis').Context,
  resolve: CitedAnswerRequestResolver,
): () => void {
  return ctx.on('llm/stream', (options, next) => {
    const owner = resolve(options)
    return owner === undefined ? next() : protectCitedAnswerStream(options, owner, next)
  })
}
