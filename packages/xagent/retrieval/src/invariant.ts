/** Runtime checks for XAgent retrieval metadata. @module @xagent/dsh-retrieval/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@xagent/dsh-retrieval'
const META_KEYS = ['citations', 'kind', 'payloadHash']

export const name = 'xagent-retrieval-invariant'
export const inject = ['invariants']

function validate(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'tool/result' || event.data.meta === undefined) return
  const meta = event.data.meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return
  const row = meta as Record<string, unknown>
  if (row.kind !== 'xagent-retrieval') return
  if (Object.keys(row).sort().some((key, index) => key !== META_KEYS[index]) || Object.keys(row).length !== META_KEYS.length) {
    fail('xagent retrieval tool/result metadata must use the closed public fields')
  }
  if (typeof row.payloadHash !== 'string' || !/^[0-9a-f]{64}$/u.test(row.payloadHash)) {
    fail('xagent retrieval tool/result payloadHash must be a SHA-256 digest')
  }
  if (!Array.isArray(row.citations) || row.citations.some(value => typeof value !== 'string' || !/^\[资料[1-9][0-9]*\]$/u.test(value))) {
    fail('xagent retrieval tool/result citations must contain only short citation ids')
  }
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) for (const event of session.events) validate(event, fail)
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    validate((args as [Session, SessionEvent])[1], fail)
  }, { global: true })
}, { inject: ['sessions'] })

export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
