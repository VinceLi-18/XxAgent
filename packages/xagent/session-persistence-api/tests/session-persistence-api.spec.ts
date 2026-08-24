import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { XAgentBackend } from '@xagent/dsh-backend-client'
import { describe, expect, test, vi } from 'vitest'
import * as persistenceModule from '../src/index.ts'
import {
  XAgentSessionPersistence,
} from '../src/index.ts'

const id = SessionId('session-00000000-0000-0000-0000-000000000701')
const header: SessionHeader = {
  version: 0,
  id,
  createdAt: 1_787_587_200_000,
  cwd: '/workspace/alice',
}
const event: SessionEvent = {
  seq: 0,
  time: 1_787_587_200_001,
  type: 'turn/start',
  data: { turn: 0 },
}

function backend(): XAgentBackend & { calls: { name: string; args: unknown[] }[] } {
  const calls: { name: string; args: unknown[] }[] = []
  return {
    calls,
    login: vi.fn(),
    introspect: vi.fn(),
    revoke: vi.fn(),
    sessions: {
      list: async (...args) => {
        calls.push({ name: 'list', args })
        return { schema_version: 1, sessions: [{ runtime_header: header, version: 2, last_event_sequence: 0 }] }
      },
      create: async (...args) => {
        calls.push({ name: 'create', args })
        return { schema_version: 1, session: { runtime_header: header, version: 1, last_event_sequence: -1 } }
      },
      open: async (...args) => {
        calls.push({ name: 'open', args })
        return {
          schema_version: 1,
          session: { runtime_header: header, version: 2, last_event_sequence: 0 },
          events: [{ sequence: 0, payload: event }],
        }
      },
      events: async (...args) => {
        calls.push({ name: 'events', args })
        return { schema_version: 1, events: [{ sequence: 0, payload: event }] }
      },
      append: async (...args) => {
        calls.push({ name: 'append', args })
        return { schema_version: 1, version: 2, last_event_sequence: 0 }
      },
      fork: vi.fn(),
      archive: vi.fn(),
      authorize: vi.fn(),
    },
  }
}

describe('XAgent FastAPI Session Persistence', () => {
  test('模块插件入口只暴露带配置的安装函数', () => {
    expect('default' in persistenceModule).toBe(false)
    expect(typeof persistenceModule.apply).toBe('function')
  })

  test('进程启动索引不枚举任何用户会话', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)

    await expect(persistence.listForBootstrap()).resolves.toEqual([])
    expect(value.calls).toEqual([])
  })

  test('首次发布把 Header 和 seed 作为一个远端创建请求提交', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)
    const session = Session.create(id, [], header)

    await persistence.withUserToken('alice-token', () => persistence.preparePublication(session))

    const call = value.calls.find(candidate => candidate.name === 'create')
    expect(call?.args[0]).toBe('alice-token')
    expect(call?.args[1]).toMatchObject({
      session_id: '00000000-0000-0000-0000-000000000701',
      runtime_header: header,
      events: [{
        event_type: 'session/end-seed',
        payload: { seq: 0, type: 'session/end-seed' },
      }],
    })
    expect(call?.args[2]).toBeUndefined()
  })

  test('创建与追加使用当前请求令牌，后续写入使用按 Session 固定的租约', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)

    await persistence.withUserToken('alice-token', async () => {
      await persistence.create(header)
    })
    await persistence.append(id, [event])

    expect(value.calls.find(call => call.name === 'create')?.args).toEqual([
      'alice-token',
      expect.objectContaining({
        schema_version: 1,
        session_id: '00000000-0000-0000-0000-000000000701',
        runtime_header: header,
      }),
      undefined,
    ])
    expect(value.calls.find(call => call.name === 'append')?.args).toEqual([
      'alice-token',
      '00000000-0000-0000-0000-000000000701',
      expect.objectContaining({
        expected_sequence: -1,
        events: [{ event_type: 'turn/start', schema_version: 1, payload: event }],
      }),
      undefined,
    ])
  })

  test('读取严格还原 Header 和事件，且远端后端没有本地 artifact', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)

    const loaded = await persistence.withUserToken('alice-token', () => persistence.load(id))
    const ranged = await persistence.withUserToken('alice-token', () => persistence.readFrom(id, 0))

    expect(loaded).toEqual({
      meta: header,
      events: [event, expect.objectContaining({ seq: 1, type: 'turn/end' })],
    })
    expect(ranged).toEqual({ meta: header, events: [event] })
    expect(value.calls.filter(call => call.name === 'events')).toEqual([{
      name: 'events',
      args: [
        'alice-token',
        '00000000-0000-0000-0000-000000000701',
        { schema_version: 1, after_sequence: -1, limit: 500 },
        undefined,
      ],
    }])
    expect(value.calls.filter(call => call.name === 'open')).toHaveLength(1)
    expect(persistence.locate(header)).toBeUndefined()
    expect(persistence.supportsRawArtifacts).toBe(false)
    await expect(persistence.readRaw(id)).rejects.toThrow('does not expose raw artifacts')
  })

  test('冷加载会把中断回合的关闭事件持久化后再返回平衡日志', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)

    const loaded = await persistence.withUserToken('alice-token', () => persistence.load(id))

    expect(loaded.events.map(entry => entry.type)).toEqual(['turn/start', 'turn/end'])
    expect(value.calls.find(call => call.name === 'append')?.args).toEqual([
      'alice-token',
      '00000000-0000-0000-0000-000000000701',
      expect.objectContaining({
        expected_sequence: 0,
        events: [expect.objectContaining({ event_type: 'turn/end' })],
      }),
      undefined,
    ])
  })

  test('检查会在内存中平衡中断回合，但不会改写远端日志', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)

    const inspected = await persistence.withUserToken('alice-token', () => persistence.inspect(id))

    expect(inspected.events.map(entry => entry.type)).toEqual(['turn/start', 'turn/end'])
    expect(value.calls.filter(call => call.name === 'append')).toEqual([])
  })

  test('列表与 revision 只在显式请求作用域内工作', async () => {
    const persistence = new XAgentSessionPersistence(new Context(), backend())

    await expect(persistence.list()).rejects.toThrow('unauthenticated')
    await expect(persistence.withUserToken('alice-token', () => persistence.list())).resolves.toEqual([header])
    await expect(persistence.withUserToken('alice-token', () => persistence.listSnapshots())).resolves.toEqual([
      { header, revision: 'xagent-api:2:0' },
    ])
  })

  test('FastAPI 失败时不创建本地回退状态', async () => {
    const value = backend()
    value.sessions.create = vi.fn(async () => { throw new Error('service unavailable') })
    const persistence = new XAgentSessionPersistence(new Context(), value)

    await expect(persistence.withUserToken('alice-token', () => persistence.create(header)))
      .rejects.toThrow('service unavailable')
    await expect(persistence.append(id, [event])).rejects.toThrow('unauthenticated')
  })

  test('事件追加使用消息 rpcId 绑定的发起者，而不是最后一次访问者', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)
    const userEvent: SessionEvent = {
      seq: 0,
      time: 1_787_587_200_001,
      type: 'user/message',
      data: {
        id: 'message-alice' as never,
        role: 'user',
        source: { kind: 'user', rpcId: 'alice-rpc' },
        content: [],
      } as never,
      surfaceOp: 'append',
    }
    persistence.authorizeRequest(id, 'alice-rpc', 'alice-token')
    persistence.authorizeRequest(id, 'bob-rpc', 'bob-token')

    await persistence.append(id, [userEvent])

    expect(value.calls.find(call => call.name === 'append')?.args[0]).toBe('alice-token')
  })

  test('Session flush 等待实时事件写入 FastAPI', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const value = backend()
    const persistence = new XAgentSessionPersistence(ctx, value)
    persistence.authorizeRequest(id, undefined, 'alice-token')
    const session = ctx.sessions.create(id)
    session.append('turn/start', { turn: 1 })

    await ctx.sessions.flush(session)

    expect(value.calls.find(call => call.name === 'append')?.args).toEqual([
      'alice-token',
      '00000000-0000-0000-0000-000000000701',
      expect.objectContaining({ expected_sequence: -1 }),
      undefined,
    ])
    await ctx.fiber.dispose()
  })

  test('请求令牌作用域串行执行并在成功或失败后清除', async () => {
    const persistence = new XAgentSessionPersistence(new Context(), backend())
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const order: string[] = []
    const first = persistence.withUserToken('alice', async () => {
      order.push('alice-start')
      await blocked
      order.push('alice-end')
    })
    const second = persistence.withUserToken('bob', async () => { order.push('bob') })
    await Promise.resolve()
    expect(order).toEqual(['alice-start'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['alice-start', 'alice-end', 'bob'])
    await expect(persistence.withUserToken('alice', async () => { throw new Error('failed') })).rejects.toThrow('failed')
    await expect(persistence.list()).rejects.toThrow('unauthenticated')
  })

  test.each([
    [null],
    [[]],
    [{}],
    [{ sessions: null }],
    [{ sessions: [null] }],
  ])('列表拒绝畸形响应 %#', async (response) => {
    const value = backend()
    value.sessions.list = vi.fn(async () => response as never)
    const persistence = new XAgentSessionPersistence(new Context(), value)
    await expect(persistence.withUserToken('token', () => persistence.list())).rejects.toThrow('invalid XAgent session response')
  })

  test.each([
    [{ id: 1 }],
    [{ id: 'bad' }],
    [{ version: 1 }],
    [{ createdAt: 'bad' }],
    [{ createdAt: 1.5 }],
    [{ createdAt: -1 }],
    [{ cwd: 1 }],
    [{ parentSession: 1 }],
    [{ agentPreset: 1 }],
    [{ seedLength: 1.5 }],
    [{ seedLength: -1 }],
    [{ delegationDepth: 1.5 }],
    [{ delegationDepth: -1 }],
    [{ origin: 'user' }],
  ])('列表拒绝畸形 Header %#', async (override) => {
    const value = backend()
    value.sessions.list = vi.fn(async () => ({ sessions: [{ runtime_header: { ...header, ...override } }] }))
    const persistence = new XAgentSessionPersistence(new Context(), value)
    await expect(persistence.withUserToken('token', () => persistence.list())).rejects.toThrow('invalid XAgent runtime header')
  })

  test.each([
    [null],
    [[]],
    [{ events: null }],
    [{ events: [null] }],
    [{ events: [{ sequence: 0, payload: null }] }],
    [{ events: [{ sequence: 0, payload: { ...event, type: 1 } }] }],
    [{ events: [{ sequence: 0, payload: { ...event, type: '' } }] }],
    [{ events: [{ sequence: 0, payload: { ...event, seq: 1.5 } }] }],
    [{ events: [{ sequence: 0, payload: { ...event, seq: -1 } }] }],
    [{ events: [{ sequence: 0, payload: { ...event, time: 1.5 } }] }],
    [{ events: [{ sequence: 0, payload: { ...event, time: -1 } }] }],
    [{ events: [{ sequence: 0, payload: { seq: 0, time: 1, type: 'event' } }] }],
    [{ events: [{ sequence: 0, payload: { ...event, ignorable: false } }] }],
    [{ events: [{ sequence: 1, payload: event }] }],
    [{ events: [{ sequence: 0, payload: { ...event, seq: 1 } }] }],
  ])('范围读取拒绝畸形事件响应 %#', async (response) => {
    const value = backend()
    value.sessions.events = vi.fn(async () => response as never)
    const persistence = new XAgentSessionPersistence(new Context(), value)
    await expect(persistence.withUserToken('token', () => persistence.readFrom(id, 0)))
      .rejects.toThrow(/invalid XAgent|non-contiguous/)
  })

  test('open 响应校验容器、连续序列和 Session 身份', async () => {
    for (const response of [
      null,
      {},
      { session: null, events: [] },
      { session: { runtime_header: header }, events: null },
      { session: { runtime_header: header }, events: [{ sequence: 1, payload: event }] },
      { session: { runtime_header: header }, events: [{ sequence: 0, payload: { ...event, seq: 1 } }] },
      { session: { runtime_header: { ...header, id: SessionId('session-00000000-0000-0000-0000-000000000702') } }, events: [] },
    ]) {
      const value = backend()
      value.sessions.open = vi.fn(async () => response as never)
      const persistence = new XAgentSessionPersistence(new Context(), value)
      await expect(persistence.withUserToken('token', () => persistence.inspect(id))).rejects.toThrow()
    }
  })

  test('取消信号、范围参数和 revision 失败关闭', async () => {
    const persistence = new XAgentSessionPersistence(new Context(), backend())
    for (const fromSeq of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(persistence.readFrom(id, fromSeq)).rejects.toThrow('fromSeq must be a non-negative safe integer')
    }
    const cancelledOperations: Array<(signal: AbortSignal) => Promise<unknown>> = [
      (signal: AbortSignal) => persistence.inspect(id, signal),
      (signal: AbortSignal) => persistence.readFrom(id, 0, signal),
      (signal: AbortSignal) => persistence.list(signal),
      (signal: AbortSignal) => persistence.listForBootstrap(signal),
      (signal: AbortSignal) => persistence.listSnapshots(signal),
    ]
    for (const operation of cancelledOperations) {
      const controller = new AbortController(); controller.abort(new Error('cancelled'))
      await expect(Promise.resolve().then(() => operation(controller.signal))).rejects.toThrow('cancelled')
    }

    for (const row of [
      { runtime_header: header, version: 1.5, last_event_sequence: 0 },
      { runtime_header: header, version: 1, last_event_sequence: 1.5 },
    ]) {
      const value = backend()
      value.sessions.list = vi.fn(async () => ({ sessions: [row] }))
      const candidate = new XAgentSessionPersistence(new Context(), value)
      await expect(candidate.withUserToken('token', () => candidate.listSnapshots()))
        .rejects.toThrow('invalid XAgent session revision')
    }
  })

  test('范围读取翻页、缓存租约并拒绝不存在的 Session', async () => {
    const value = backend()
    const page = Array.from({ length: 500 }, (_, seq) => ({
      sequence: seq,
      payload: { seq, time: seq, type: 'event', data: {}, ignorable: true },
    }))
    const events = vi.fn()
      .mockResolvedValueOnce({ events: page })
      .mockResolvedValueOnce({ events: [] })
    value.sessions.events = events
    const persistence = new XAgentSessionPersistence(new Context(), value)
    const result = await persistence.withUserToken('token', () => persistence.readFrom(id, 0))
    expect(result.events).toHaveLength(500)
    expect(events).toHaveBeenLastCalledWith(
      'token', '00000000-0000-0000-0000-000000000701',
      { schema_version: 1, after_sequence: 499, limit: 500 }, undefined,
    )

    const missing = backend()
    missing.sessions.list = vi.fn(async () => ({ sessions: [] }))
    const absent = new XAgentSessionPersistence(new Context(), missing)
    await expect(absent.withUserToken('token', () => absent.readFrom(id, 0))).rejects.toThrow('session not found')
  })

  test('追加拒绝无租约与非连续事件，空批次为 no-op', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)
    await expect(persistence.append(id, [])).resolves.toBeUndefined()
    await expect(persistence.append(id, [event])).rejects.toThrow('unauthenticated')
    persistence.authorizeRequest(id, undefined, 'token')
    await expect(persistence.append(id, [event, { ...event, seq: 2 }])).rejects.toThrow('non-contiguous')
    await expect(persistence.append(id, Array(1) as SessionEvent[])).resolves.toBeUndefined()
    await expect(persistence.append(id, [event, undefined as never])).resolves.toBeUndefined()
    await expect(new XAgentSessionPersistence(new Context(), backend()).inspect(id)).rejects.toThrow('unauthenticated')
    await expect(persistence.withUserToken('token', () => persistence.create({ ...header, id: SessionId('bad') })))
      .rejects.toThrow('invalid XAgent session id')
  })

  test('消息令牌绑定忽略畸形或其他 Session 的 rpcId，并在 turn/end 后释放 turn lease', async () => {
    const value = backend()
    const persistence = new XAgentSessionPersistence(new Context(), value)
    const message = (seq: number, rpcId: unknown): SessionEvent => ({
      seq, time: seq, type: 'user/message', surfaceOp: 'append',
      data: { id: `m-${seq}`, role: 'user', source: { kind: 'user', rpcId }, content: [] } as never,
    })
    persistence.authorizeRequest(SessionId('session-00000000-0000-0000-0000-000000000702'), 'other', 'other-token')
    persistence.authorizeRequest(id, undefined, 'lease-token')
    await persistence.append(id, [message(0, 1)])
    await persistence.append(id, [{ seq: 1, time: 1, type: 'user/message', data: {} } as never])
    await persistence.append(id, [message(2, 'other')])
    persistence.authorizeRequest(id, 'turn', 'turn-token')
    await persistence.append(id, [message(3, 'turn')])
    await persistence.append(id, [{ seq: 4, time: 4, type: 'turn/end', data: { turn: 0, status: 'done' } } as never])
    expect(value.calls.filter(call => call.name === 'append').map(call => call.args[0]))
      .toEqual(['lease-token', 'lease-token', 'lease-token', 'turn-token', 'turn-token'])
  })

  test('内存 Session 直接读取；活动中断回合禁止 crash repair', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persistence = new XAgentSessionPersistence(ctx, backend())
    const live = ctx.sessions.create(id)
    live.append('todo/write', { todos: [] })
    const inspected = await persistence.inspect(id)
    expect(inspected.meta.id).toBe(id)
    await expect(persistence.load(id)).resolves.toEqual(inspected)
    live.append('turn/start', { turn: 1 })
    await expect(persistence.load(id)).rejects.toThrow('cannot crash-repair live session')
    await ctx.fiber.dispose()
  })

  test('完整冷会话不追加 crash-repair 事件，列表可跳过其他 Header', async () => {
    const value = backend()
    value.sessions.open = vi.fn(async () => ({
      session: { runtime_header: header },
      events: [{ sequence: 0, payload: { ...event, type: 'event' } }],
    }))
    value.sessions.list = vi.fn(async () => ({ sessions: [
      { runtime_header: { ...header, id: SessionId('session-00000000-0000-0000-0000-000000000702') } },
      { runtime_header: header },
    ] }))
    const persistence = new XAgentSessionPersistence(new Context(), value)
    const loaded = await persistence.withUserToken('token', () => persistence.load(id))
    expect(loaded.events).toHaveLength(1)
    expect(value.calls.filter(call => call.name === 'append')).toEqual([])
    await expect(persistence.withUserToken('token', () => persistence.readFrom(id, 0))).resolves.toMatchObject({ meta: header })
  })

  test('实时写路径合并定时批次、等待并发 flush，并在 dispose 后释放绑定', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      const value = backend()
      let release!: () => void
      const blocked = new Promise<void>((resolve) => { release = resolve })
      const append = vi.fn(async () => { await blocked; return {} as never })
      value.sessions.append = append
      const persistence = new XAgentSessionPersistence(ctx, value)
      persistence.authorizeRequest(id, 'request', 'token')
      const session = { id } as Session
      ctx.emit('session/event', session, event)
      ctx.emit('session/event', session, { seq: 1, time: event.time + 1, type: 'todo/write', data: { todos: [] } })
      const first = ctx.parallel('session/flush', session)
      const second = ctx.parallel('session/flush', session)
      release()
      await Promise.all([first, second])
      expect(append).toHaveBeenCalledOnce()
      ctx.emit('session/disposed', session)
      await Promise.resolve(); await Promise.resolve()
      await expect(persistence.append(id, [event])).rejects.toThrow('unauthenticated')
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('定时写入失败会记录并锁存 Error，dispose 仍释放 Session', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      const value = backend()
      value.sessions.append = vi.fn(async () => { throw new Error('write failed') })
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      const persistence = new XAgentSessionPersistence(ctx, value)
      persistence.authorizeRequest(id, undefined, 'token')
      const session = { id } as Session
      ctx.emit('session/event', session, event)
      await vi.advanceTimersByTimeAsync(200)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('write failed'))
      await expect((persistence as unknown as { flushWrites(id: SessionId): Promise<void> }).flushWrites(id))
        .rejects.toThrow('write failed')
      ctx.emit('session/disposed', session)
      await Promise.resolve(); await Promise.resolve()
      expect(warn).toHaveBeenCalledTimes(2)
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('非 Error 写失败转换稳定错误，并清理未触发的 timer 和同 Session 请求绑定', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      const value = backend()
      value.sessions.append = vi.fn(async () => { throw 'failure' })
      vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      const persistence = new XAgentSessionPersistence(ctx, value)
      persistence.authorizeRequest(id, 'same', 'token')
      persistence.authorizeRequest(SessionId('session-00000000-0000-0000-0000-000000000702'), 'other', 'other-token')
      const session = { id } as Session
      ctx.emit('session/event', session, event)
      const internal = persistence as unknown as { flushWrites(id: SessionId): Promise<void> }
      await expect(internal.flushWrites(id)).rejects.toBe('failure')
      await expect(internal.flushWrites(id)).rejects.toThrow('session persistence write failed')
      ctx.emit('session/disposed', session)
      await Promise.resolve(); await Promise.resolve()
      vi.runOnlyPendingTimers()
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('没有写状态的 flush/dispose 均为 no-op，dispose 会清除尚未触发的 timer', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      const persistence = new XAgentSessionPersistence(ctx, backend())
      const absent = { id } as Session
      await expect(ctx.parallel('session/flush', absent)).resolves.toBeUndefined()
      ctx.emit('session/disposed', absent)
      await Promise.resolve()
      persistence.authorizeRequest(id, undefined, 'token')
      ctx.emit('session/event', absent, event)
      ;(persistence as unknown as { releaseSession(id: SessionId): void }).releaseSession(id)
      vi.runOnlyPendingTimers()
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('flushSession 对缺失 Session 为 no-op，对活动 Session 委托 registry flush', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persistence = new XAgentSessionPersistence(ctx, backend())
    await expect(persistence.flushSession(id)).resolves.toBeUndefined()
    persistence.authorizeRequest(id, undefined, 'token')
    const live = ctx.sessions.create(id)
    live.append('todo/write', { todos: [] })
    await persistence.flushSession(id)
    await ctx.fiber.dispose()
  })

  test('插件入口注册远端 Session Persistence 服务', async () => {
    const ctx = new Context()
    ctx.provide('sessions', { get: () => undefined } as never)
    persistenceModule.apply(ctx, { backendOrigin: 'https://api.example.test', serviceToken: 'service' })
    expect(ctx.get('sessionPersistence')).toBeInstanceOf(XAgentSessionPersistence)
    await ctx.fiber.dispose()
  })
})
