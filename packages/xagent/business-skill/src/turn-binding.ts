/** Agent-owned version pins and durable completed-turn instruction projection. @module @xagent/dsh-business-skill/turn-binding */
import { isAppendSurfaceEvent, isReplacementSurfaceEvent, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { XAgentBusinessSkillLoad } from '@xagent/dsh-backend-client'
import type { BusinessSkillTurnBinding } from './types.ts'

/** One immutable admission retained until final turn end or Agent disposal. */
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
  const admissions = new Map<number, SessionEvent<'business-skill/activated'>>()
  let turn: number | undefined
  for (const event of session.events) {
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type === 'turn/end') turn = undefined
    if (isReplacementSurfaceEvent(event) && event.surfaceOp.start === event.surfaceOp.end) {
      const admission = admissions.get(event.surfaceOp.start)
      const original = session.events[event.surfaceOp.start] as SessionEvent
      if (admission !== undefined && (event.type === 'tool/result'
        || (event.type === 'user/message' && original.type === 'user/message' && event.data.id === original.data.id
          && event.data.source.kind === 'skill-invocation' && event.data.source.name === admission.data.slug))) {
        admissions.set(event.seq, admission)
      }
    }
    if (turn === undefined || !completed.has(turn)) continue
    const activation = activations.get(turn)
    if (activation === undefined || event.seq < activation.seq || !isAppendSurfaceEvent(event)) continue
    const { slug } = activation.data
    if (event.type === 'user/message' && event.data.source.kind === 'skill-invocation' && event.data.source.name === slug) {
      admissions.set(event.seq, activation)
    } else if (event.type === 'tool/result' && event.data.turn === turn) {
      const name = calls.get(`${event.data.turn}:${event.data.message.source.callId}`)
      if (name !== slug || event.data.message.content[0].isError) continue
      admissions.set(event.seq, activation)
    }
  }
  for (const seq of [...session.surface.nodes]) {
    const activation = admissions.get(seq)
    const event = session.events[seq] as SessionEvent
    if (activation === undefined || (event.type !== 'user/message' && event.type !== 'tool/result')) continue
    const { slug, version, turn } = activation.data
    const text = `Business Skill ${slug} v${version} was used in turn ${turn}.`
    const content = event.type === 'user/message' ? event.data.content : event.data.message.content[0].content
    const first = content[0] as ContentBlock
    if (content.length === 1 && first.type === 'text' && first.text === text) continue
    const marker = [{ type: 'text' as const, text }]
    const opts = { surfaceOp: { op: 'replace' as const, start: seq, end: seq }, sourceEventSeqs: [seq] }
    if (event.type === 'user/message') session.append('user/message', { ...event.data, content: marker }, opts)
    else {
      session.append('tool/result', { ...event.data, message: { ...event.data.message,
        content: [{ ...event.data.message.content[0], content: marker }] } }, opts)
    }
  }
}
