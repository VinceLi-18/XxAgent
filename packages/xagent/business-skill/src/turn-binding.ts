/** Agent-owned version pins and durable completed-turn instruction projection. @module @xagent/dsh-business-skill/turn-binding */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { XAgentBusinessSkillLoad } from '@xagent/dsh-backend-client'
import type { BusinessSkillTurnBinding } from './types.ts'

/** One immutable admission retained until its turn ends or request owner closes. */
export class TurnBinding {
  /** Immutable public policy with the private retained version identity. */
  readonly binding: BusinessSkillTurnBinding

  constructor(readonly definition: SkillDefinition, readonly version: XAgentBusinessSkillLoad, turn: number) {
    this.binding = Object.freeze({ slug: version.slug, version: version.versionNumber,
      opaqueVersionKey: version.versionKey as BusinessSkillTurnBinding['opaqueVersionKey'], toolPolicyDigest: version.toolPolicyDigest,
      completeTools: new Set(version.completeTools), turn })
  }
}

function skillName(argumentsJson: string): unknown {
  let value: unknown
  try { value = JSON.parse(argumentsJson) } catch {
    // Invalid model arguments never identify an admitted Skill result.
    return undefined
  }
  return typeof value === 'object' && value !== null && 'name' in value ? value.name : undefined
}

/**
 * Replace completed admissions using durable activation and tool-call identities, including repaired crash tails.
 * @param session - Live Session outside a session/event notification; appends only content replacements and preserves original bytes.
 */
export function replaceCompletedInstructions(session: Session): void {
  const activations = new Map<number, SessionEvent<'business-skill/activated'>>()
  const completed = new Set<number>()
  const calls = new Map<string, unknown>()
  for (const event of session.events) {
    if (event.type === 'business-skill/activated') activations.set(event.data.turn, event)
    if (event.type === 'turn/end') completed.add(event.data.turn)
    if (event.type === 'tool/call' && event.data.name === 'skill') calls.set(`${event.data.turn}:${event.data.callId}`, skillName(event.data.arguments))
  }
  const visible = new Set(session.surface.nodes)
  let turn: number | undefined
  for (const event of [...session.events]) {
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type === 'turn/end') turn = undefined
    if (turn === undefined || !completed.has(turn)) continue
    const activation = activations.get(turn)
    if (activation === undefined || event.seq < activation.seq || !('surfaceOp' in event) || event.surfaceOp !== 'append' || !visible.has(event.seq)) continue
    const { slug, version } = activation.data
    const marker = [{ type: 'text' as const, text: `Business Skill ${slug} v${version} was used in turn ${turn}.` }]
    const opts = { surfaceOp: { op: 'replace' as const, start: event.seq, end: event.seq }, sourceEventSeqs: [event.seq] }
    if (event.type === 'user/message' && event.data.source.kind === 'skill-invocation' && event.data.source.name === slug) {
      session.append('user/message', { ...event.data, content: marker }, opts)
    } else if (event.type === 'tool/result') {
      const name = calls.get(`${event.data.turn}:${event.data.message.source.callId}`)
      if (name !== slug || event.data.message.content[0].isError) continue
      session.append('tool/result', { ...event.data, message: { ...event.data.message,
        content: [{ ...event.data.message.content[0], content: marker }] } }, opts)
    }
  }
}
