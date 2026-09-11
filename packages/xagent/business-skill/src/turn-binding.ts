/** Agent-owned version pin and end-of-turn model-history projection. @module @xagent/dsh-business-skill/turn-binding */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { XAgentBusinessSkillLoad } from '@xagent/dsh-backend-client'
import type { BusinessSkillTurnBinding } from './types.ts'

/** One immutable admission and the exact model-tool calls that exposed its body. */
export class TurnBinding {
  /** Exact model-tool results eligible for instruction replacement. */
  readonly callIds = new Set<CallId>()
  /** Immutable public policy with the private retained version identity. */
  readonly binding: BusinessSkillTurnBinding
  private readonly firstSequence: number

  constructor(readonly agent: Agent, readonly definition: SkillDefinition, readonly version: XAgentBusinessSkillLoad, turn: number) {
    this.firstSequence = agent.session.events.length
    this.binding = Object.freeze({ slug: version.slug, version: version.versionNumber,
      opaqueVersionKey: version.versionKey as BusinessSkillTurnBinding['opaqueVersionKey'], toolPolicyDigest: version.toolPolicyDigest,
      completeTools: new Set(version.completeTools), turn })
  }

  /** Replace only this admission's current instructions; append records remain byte-exact. */
  replaceInstructions(): void {
    const { session } = this.agent
    const marker = [{ type: 'text' as const, text: `Business Skill ${this.binding.slug} v${this.binding.version} was used in turn ${this.binding.turn}.` }]
    const visible = new Set(session.surface.nodes)
    for (const event of session.events) {
      if (event.seq < this.firstSequence || !visible.has(event.seq)) continue
      const opts = { surfaceOp: { op: 'replace' as const, start: event.seq, end: event.seq }, sourceEventSeqs: [event.seq] }
      if (event.type === 'user/message' && event.data.source.kind === 'skill-invocation'
        && event.data.source.name === this.binding.slug) {
        session.append('user/message', { ...event.data, content: marker }, opts)
      } else if (event.type === 'tool/result' && event.data.turn === this.binding.turn
        && this.callIds.has(event.data.message.source.callId)) {
        session.append('tool/result', { ...event.data, message: { ...event.data.message,
          content: [{ ...event.data.message.content[0], content: marker }] } }, opts)
      }
    }
  }
}
