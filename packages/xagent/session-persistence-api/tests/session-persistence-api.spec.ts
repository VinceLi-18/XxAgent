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
})
