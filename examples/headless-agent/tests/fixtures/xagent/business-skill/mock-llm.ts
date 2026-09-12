import type { Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { BODY } from './backend.ts'

function call(name: string, args: object, step: number): StreamChunk[] {
  const id = CallId(`call-${String(step)}`)
  const argumentsJson = JSON.stringify(args)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}
class SnapshotAdapter extends LlmAdapter {
  private request = 0
  private readonly owner: Context
  constructor(owner: Context) { super(); this.owner = owner }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const step = ++this.request
    const scenario = process.env.XAGENT_SKILL_SCENARIO
    const revoked = scenario === 'revoked'
    const serialized = JSON.stringify(options.messages)
    process.stdout.write(`${JSON.stringify({ type: 'model_request', step, tools: options.tools?.map(tool => tool.name),
      catalog: serialized.includes('Review review project evidence.'), instructions: serialized.includes(BODY),
      marker: serialized.includes('Business Skill review v1 was used in turn 1.'),
      ...(scenario === 'write-and-test'
        ? { testScenario: serialized.includes('Attempt to propose a Fact from the reviewed project.') }
        : {}) })}\n`)
    if (scenario === 'write-and-test') {
      if (step === 1 || step === 3) {
        yield* call('propose_fact', { field_key: 'launch.date', label: 'Launch date',
          value: { type: 'date', value: '2027-03-15' }, assertion_reason: 'Approved planning date.' }, step)
        return
      }
      const text = step === 2 ? 'Production proposal submitted.' : 'Test write was denied.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (revoked) {
      if (step === 1) { yield* call('skill', { name: 'review' }, step); return }
      if (step === 2) this.owner.xagentBusinessSkillSnapshot.unauthorize()
      if (step === 2 || step === 3) { yield* call('list_accessible_projects', {}, step); return }
    } else {
      if (step === 1) { yield* call('list_accessible_projects', {}, step); return }
      if (step === 2) { yield* call('search_artifacts', { query: 'launch evidence' }, step); return }
      if (step === 3) { yield* call('skill', { name: 'second-review' }, step); return }
    }
    const text = step > 4 ? 'Later turn has no active instructions.' : 'Review completed.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export const name = 'xagent-business-skill-snapshot-llm'
export const inject = ['llm', 'xagentBusinessSkillSnapshot']
/** Supply the same deployment route used by the Business bundle. */
export function apply(ctx: Context): void { ctx.llm.registerAdapter(['deepseek-official'], new SnapshotAdapter(ctx)) }
