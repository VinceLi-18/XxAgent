/** FastAPI 作为唯一数据源的 XAgent Session Persistence。 @module @xagent/dsh-session-persistence-api */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  SessionPersistence,
  SessionPersistenceRevision,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import {
  SESSION_FORMAT_VERSION,
  adoptSessionEvent,
  interruptedTurnClosers,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type SessionId as SessionIdType,
} from '@deepseek-ai/dsh-session'
import { XAgentBackendClient, type XAgentBackend } from '@xagent/dsh-backend-client'

const SESSION_ID_PATTERN = /^(?:session-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

export interface Config {
  backendOrigin: string
  serviceToken: string
}

export const Config: z<Config> = z.object({
  backendOrigin: z.string().required(),
  serviceToken: z.string().required(),
})

export const name = 'xagent-session-persistence-api'
export const inject = ['sessions']

function backendSessionId(id: SessionIdType): string {
  const match = SESSION_ID_PATTERN.exec(id)
  if (match?.[1] === undefined) throw new TypeError('invalid XAgent session id')
  return match[1]
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('invalid XAgent session response')
  return value as Record<string, unknown>
}

function headerFrom(value: unknown): SessionHeader {
  const row = object(value)
  const id = row.id
  const version = row.version
  const createdAt = row.createdAt
  if (
    typeof id !== 'string'
    || !SESSION_ID_PATTERN.test(id)
    || version !== SESSION_FORMAT_VERSION
    || typeof createdAt !== 'number'
    || !Number.isSafeInteger(createdAt)
    || createdAt < 0
  ) throw new TypeError('invalid XAgent runtime header')
  const optionalStrings = ['cwd', 'parentSession', 'agentPreset'] as const
  for (const key of optionalStrings) {
    if (row[key] !== undefined && typeof row[key] !== 'string') throw new TypeError('invalid XAgent runtime header')
  }
  for (const key of ['seedLength', 'delegationDepth'] as const) {
    if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0)) {
      throw new TypeError('invalid XAgent runtime header')
    }
  }
  if (row.origin !== undefined && row.origin !== 'subagent') throw new TypeError('invalid XAgent runtime header')
  return structuredClone(row) as unknown as SessionHeader
}

function eventFrom(value: unknown): SessionEvent {
  const row = object(value)
  if (
    typeof row.type !== 'string'
    || row.type.length === 0
    || !Number.isSafeInteger(row.seq)
    || (row.seq as number) < 0
    || !Number.isSafeInteger(row.time)
    || (row.time as number) < 0
    || !Object.hasOwn(row, 'data')
    || (row.ignorable !== undefined && row.ignorable !== true)
  ) throw new TypeError('invalid XAgent session event')
  return structuredClone(row) as unknown as SessionEvent
}

function responseSessions(value: unknown): Record<string, unknown>[] {
  const sessions = object(value).sessions
  if (!Array.isArray(sessions)) throw new TypeError('invalid XAgent session response')
  return sessions.map(object)
}

function responseInspection(value: unknown): SessionInspection {
  const row = object(value)
  const session = object(row.session)
  const events = row.events
  if (!Array.isArray(events)) throw new TypeError('invalid XAgent session response')
  const parsed = events.map((entry, index) => {
    const envelope = object(entry)
    const event = eventFrom(envelope.payload)
    if (envelope.sequence !== index || event.seq !== index) throw new TypeError('non-contiguous XAgent session events')
    return adoptSessionEvent(event)
  })
  return Object.freeze({ meta: headerFrom(session.runtime_header), events: Object.freeze(parsed) })
}

function responseEvents(value: unknown, expectedSequence: number): SessionEvent[] {
  const events = object(value).events
  if (!Array.isArray(events)) throw new TypeError('invalid XAgent session response')
  return events.map((entry, index) => {
    const envelope = object(entry)
    const event = eventFrom(envelope.payload)
    const sequence = expectedSequence + index
    if (envelope.sequence !== sequence || event.seq !== sequence) {
      throw new TypeError('non-contiguous XAgent session events')
    }
    return adoptSessionEvent(event)
  })
}

/** 远端 provider；请求作用域被串行化，后台 append 使用按 Session 固定的 Host 内部令牌租约。 */
export class XAgentSessionPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false
  private readonly leases = new Map<SessionIdType, string>()
  private readonly requestTokens = new Map<string, { sessionId: SessionIdType; token: string }>()
  private readonly turnTokens = new Map<SessionIdType, string>()
  private readonly writes = new Map<SessionIdType, {
    pending: SessionEvent[]
    flushing: Promise<void> | undefined
    timer: ReturnType<typeof setTimeout> | undefined
    failure?: unknown
  }>()
  private scopeTail: Promise<void> = Promise.resolve()
  private activeToken: string | undefined

  constructor(ctx: Context, private readonly backend: XAgentBackend) {
    super(ctx)
    this.installWritePath()
  }

  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  async withUserToken<T>(userToken: string, operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    const previous = this.scopeTail
    this.scopeTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    this.activeToken = userToken
    try {
      return await operation()
    } finally {
      this.activeToken = undefined
      release()
    }
  }

  authorizeRequest(id: SessionIdType, requestId: string | undefined, userToken: string): void {
    this.leases.set(id, userToken)
    if (requestId !== undefined) this.requestTokens.set(requestId, { sessionId: id, token: userToken })
  }

  override async preparePublication(session: Session): Promise<void> {
    const token = this.requireActiveToken()
    const events = session.events.map(event => structuredClone(event))
    await this.backend.sessions.create(token, {
      schema_version: 1,
      session_id: backendSessionId(session.id),
      runtime_header: structuredClone(session.header),
      title: session.id,
      visibility: 'private',
      project_id: null,
      idempotency_key: `publish:${session.id}`,
      events: events.map(event => ({
        event_type: event.type,
        schema_version: 1,
        payload: event,
      })),
    }, undefined)
    this.leases.set(session.id, token)
  }

  async flushSession(id: SessionIdType): Promise<void> {
    const session = this.ctx.get('sessions')?.get(id)
    if (session !== undefined) await this.ctx.sessions.flush(session)
  }

  async create(meta: SessionHeader): Promise<void> {
    const token = this.requireActiveToken()
    await this.backend.sessions.create(token, {
      schema_version: 1,
      session_id: backendSessionId(meta.id),
      runtime_header: structuredClone(meta),
      title: meta.id,
      visibility: 'private',
      project_id: null,
      idempotency_key: `create:${meta.id}`,
    }, undefined)
    this.leases.set(meta.id, token)
  }

  async append(id: SessionIdType, events: readonly SessionEvent[]): Promise<void> {
    if (events.length === 0) return
    const token = this.tokenForEvents(id, events)
    if (token === undefined) throw new Error('unauthenticated')
    const first = events[0]
    const last = events.at(-1)
    if (first === undefined || last === undefined) return
    for (let index = 0; index < events.length; index++) {
      if (events[index]?.seq !== first.seq + index) throw new TypeError('non-contiguous XAgent session append')
    }
    await this.backend.sessions.append(token, backendSessionId(id), {
      schema_version: 1,
      expected_sequence: first.seq - 1,
      idempotency_key: `append:${id}:${String(first.seq)}:${String(last.seq)}`,
      events: events.map(event => ({
        event_type: event.type,
        schema_version: 1,
        payload: structuredClone(event),
      })),
    }, undefined)
    if (events.some(event => event.type === 'turn/end')) this.turnTokens.delete(id)
  }

  async load(id: SessionIdType): Promise<SessionInspection> {
    const live = this.ctx.get('sessions')?.get(id)
    if (live !== undefined) {
      const events = live.events.map(entry => structuredClone(entry))
      if (interruptedTurnClosers(events).length > 0) {
        throw new Error(`cannot crash-repair live session "${id}"`)
      }
      return Object.freeze({ meta: live.header, events: Object.freeze(events) })
    }
    const inspected = await this.readInspection(id)
    const closers = interruptedTurnClosers(inspected.events).map(adoptSessionEvent)
    if (closers.length > 0) await this.append(id, closers)
    return Object.freeze({
      meta: inspected.meta,
      events: Object.freeze([...inspected.events, ...closers]),
    })
  }

  async inspect(id: SessionIdType, signal?: AbortSignal): Promise<SessionInspection> {
    signal?.throwIfAborted()
    const live = this.ctx.get('sessions')?.get(id)
    if (live !== undefined) {
      return Object.freeze({
        meta: live.header,
        events: Object.freeze(live.events.map(entry => structuredClone(entry))),
      })
    }
    const inspected = await this.readInspection(id, signal)
    const closers = interruptedTurnClosers(inspected.events).map(adoptSessionEvent)
    return Object.freeze({
      meta: inspected.meta,
      events: Object.freeze([...inspected.events, ...closers]),
    })
  }

  async readFrom(
    id: SessionIdType,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) throw new TypeError('fromSeq must be a non-negative safe integer')
    signal?.throwIfAborted()
    const token = this.tokenFor(id)
    const rows = responseSessions(await this.backend.sessions.list(token, signal))
    const meta = rows.map(row => headerFrom(row.runtime_header)).find(header => header.id === id)
    if (meta === undefined) throw new Error('session not found')
    const events: SessionEvent[] = []
    let nextSequence = fromSeq
    while (true) {
      signal?.throwIfAborted()
      const page = responseEvents(await this.backend.sessions.events(token, backendSessionId(id), {
        schema_version: 1,
        after_sequence: nextSequence - 1,
        limit: 500,
      }, signal), nextSequence)
      events.push(...page)
      if (page.length < 500) break
      nextSequence += page.length
    }
    this.leases.set(id, token)
    return { meta, events }
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    const token = this.requireActiveToken()
    const rows = responseSessions(await this.backend.sessions.list(token, signal))
    const headers = rows.map(row => headerFrom(row.runtime_header))
    for (const header of headers) this.leases.set(header.id, token)
    return headers
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    const token = this.requireActiveToken()
    const rows = responseSessions(await this.backend.sessions.list(token, signal))
    return rows.map((row) => {
      const header = headerFrom(row.runtime_header)
      if (!Number.isSafeInteger(row.version) || !Number.isSafeInteger(row.last_event_sequence)) {
        throw new TypeError('invalid XAgent session revision')
      }
      this.leases.set(header.id, token)
      return {
        header,
        revision: SessionPersistenceRevision(`xagent-api:${String(row.version)}:${String(row.last_event_sequence)}`),
      }
    })
  }

  private requireActiveToken(): string {
    if (this.activeToken === undefined) throw new Error('unauthenticated')
    return this.activeToken
  }

  private async readInspection(id: SessionIdType, signal?: AbortSignal): Promise<SessionInspection> {
    signal?.throwIfAborted()
    const token = this.tokenFor(id)
    const value = await this.backend.sessions.open(token, backendSessionId(id), signal)
    const inspected = responseInspection(value)
    if (inspected.meta.id !== id) throw new TypeError('XAgent session identity mismatch')
    this.leases.set(id, token)
    return inspected
  }

  private tokenFor(id: SessionIdType): string {
    const token = this.activeToken ?? this.leases.get(id)
    if (token === undefined) throw new Error('unauthenticated')
    return token
  }

  private tokenForEvents(id: SessionIdType, events: readonly SessionEvent[]): string | undefined {
    for (const event of events) {
      if (event.type !== 'user/message') continue
      const data = event.data as { source?: { rpcId?: unknown } }
      const requestId = data.source?.rpcId
      if (typeof requestId !== 'string') continue
      const bound = this.requestTokens.get(requestId)
      if (bound?.sessionId !== id) continue
      this.requestTokens.delete(requestId)
      this.turnTokens.set(id, bound.token)
      return bound.token
    }
    return this.turnTokens.get(id) ?? this.activeToken ?? this.leases.get(id)
  }

  private installWritePath(): void {
    this.ctx.on('session/event', (session, event) => {
      let state = this.writes.get(session.id)
      if (state === undefined) {
        state = { pending: [], flushing: undefined, timer: undefined }
        this.writes.set(session.id, state)
      }
      state.pending.push(structuredClone(event))
      if (state.timer === undefined) {
        const writeState = state
        state.timer = setTimeout(() => {
          writeState.timer = undefined
          void this.flushWrites(session.id).catch((error: unknown) => {
            this.ctx.logger.warn(`xagent session persistence failed for "${session.id}": ${String(error)}`)
          })
        }, 200)
      }
    })
    this.ctx.on('session/flush', session => this.flushWrites(session.id))
    this.ctx.on('session/disposed', (session) => {
      void this.flushWrites(session.id).then(
        () => { this.releaseSession(session.id) },
        (error: unknown) => {
          this.releaseSession(session.id)
          this.ctx.logger.warn(`xagent session persistence failed for "${session.id}": ${String(error)}`)
        },
      )
    })
    this.ctx.effect(() => async () => {
      await Promise.all([...this.writes.keys()].map(id => this.flushWrites(id)))
    }, 'xagent-session-persistence-api write path')
  }

  private flushWrites(id: SessionIdType): Promise<void> {
    const state = this.writes.get(id)
    if (state === undefined) return Promise.resolve()
    if (state.failure !== undefined) {
      return Promise.reject(state.failure instanceof Error
        ? state.failure
        : new Error('session persistence write failed', { cause: state.failure }))
    }
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    if (state.flushing !== undefined) return state.flushing
    state.flushing = (async () => {
      try {
        while (state.pending.length > 0) {
          const batch = state.pending.splice(0)
          await this.append(id, batch)
        }
      } catch (error) {
        state.failure = error
        throw error
      } finally {
        state.flushing = undefined
      }
    })()
    return state.flushing
  }

  private releaseSession(id: SessionIdType): void {
    const state = this.writes.get(id)
    if (state?.timer !== undefined) clearTimeout(state.timer)
    this.writes.delete(id)
    this.leases.delete(id)
    this.turnTokens.delete(id)
    for (const [requestId, bound] of this.requestTokens) {
      if (bound.sessionId === id) this.requestTokens.delete(requestId)
    }
  }
}

/** 安装失败关闭的远端 Session Persistence。 */
export function apply(ctx: Context, config: Config): void {
  new XAgentSessionPersistence(ctx, new XAgentBackendClient({
    origin: config.backendOrigin,
    serviceToken: config.serviceToken,
    connectionId: randomUUID,
  }))
}

export default XAgentSessionPersistence
