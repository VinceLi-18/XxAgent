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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

class XAgentSnapshotAdapter extends LlmAdapter {
  private request = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.request += 1
    if (this.request === 1) {
      if (options.tools?.some(tool => tool.name === CITED_ANSWER_TOOL)) {
        throw new Error('terminal tool appeared before admitted evidence')
      }
      yield* toolCall('call-search', 'search_artifacts', {
        query: 'evidence', project_ids: ['00000000-0000-0000-0000-000000000401'], include_private: false,
      })
      return
    }
    const definition = options.tools?.find(tool => tool.name === CITED_ANSWER_TOOL)
    if (definition === undefined || options.system?.includes(CITED_ANSWER_INSTRUCTION) !== true) {
      throw new Error('terminal tool or instruction missing after admitted evidence')
    }
    const blocks = record(record(definition.parameters)?.properties)?.blocks
    const blockSchema = record(blocks)
    process.stdout.write(`${JSON.stringify({
      type: 'model_request',
      terminalTool: definition.name,
      instruction: CITED_ANSWER_INSTRUCTION,
      blocks: blockSchema === undefined
        ? null
        : { minItems: blockSchema.minItems, maxItems: blockSchema.maxItems },
    })}\n`)
    yield* toolCall('call-answer', CITED_ANSWER_TOOL, {
      blocks: [{ type: 'markdown', text: 'Loader verified.' }, { type: 'citation', id: '[资料1]' }],
    })
  }
}

export const name = 'xagent-snapshot-llm'
export const inject = ['llm']

/** Register the keyless adapter that exposes the evidence-gated request surface. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['xagent-snapshot'], new XAgentSnapshotAdapter())
}
