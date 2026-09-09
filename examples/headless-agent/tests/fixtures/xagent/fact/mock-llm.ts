import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { CITED_ANSWER_INSTRUCTION, CITED_ANSWER_TOOL } from '@xagent/dsh-retrieval'

function toolCall(callId: string, name: string, args: object): StreamChunk[] {
  const id = CallId(callId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(value: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function text(options: GenerateOptions): string {
  return options.messages.flatMap(message => message.content)
    .filter(block => block.type === 'text').map(block => block.text).join('\n')
}

class XAgentFactSnapshotAdapter extends LlmAdapter {
  private request = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.request += 1
    const names = options.tools?.map(tool => tool.name) ?? []
    if (this.request === 1) {
      if (!names.includes('propose_fact')) throw new Error('Fact tool missing from the first Project request')
      yield* toolCall('call-search', 'search_artifacts', {
        query: 'launch evidence',
      })
      return
    }
    if (!names.includes('propose_fact')) throw new Error(`Fact tool missing from request ${String(this.request)}`)
    if (this.request === 2) {
      yield* toolCall('call-fact-evidence', 'propose_fact', {
        field_key: 'launch.date', label: 'Launch date', value: { type: 'date', value: '2026-10-01' }, evidence_ids: ['[资料1]'],
      })
      return
    }
    if (this.request === 4) {
      yield* toolCall('call-fact-reason', 'propose_fact', {
        field_key: 'launch.owner', label: 'Launch owner', value: { type: 'text', value: 'Operations' }, assertion_reason: 'Confirmed directly by the project owner.',
      })
      return
    }
    const terminal = names.includes(CITED_ANSWER_TOOL) && options.system?.includes(CITED_ANSWER_INSTRUCTION) === true
    if (!terminal && this.request !== 5) {
      throw new Error(`cited-answer terminal requirement missing after evidence admission: ${names.join(',')}`)
    }
    const decisionVisible = text(options).includes('<fact-proposal-decisions>')
    process.stdout.write(`${JSON.stringify({ type: 'model_request', request: this.request, terminal, decisionVisible })}\n`)
    if (!terminal) {
      yield* textResponse('Reason-backed proposal prepared.')
      return
    }
    yield* toolCall(`call-answer-${String(this.request)}`, CITED_ANSWER_TOOL, {
      blocks: [{ type: 'markdown', text: 'Verified.' }, { type: 'citation', id: '[资料1]' }],
    })
  }
}

export const name = 'xagent-fact-snapshot-llm'
export const inject = ['llm']

/** Register the deterministic adapter that exercises the assembled Fact flow. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['xagent-fact-snapshot'], new XAgentFactSnapshotAdapter())
}
