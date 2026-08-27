import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test } from 'vitest'
import XAgentPrincipalService, { parseXAgentPrincipal } from '../src/index.ts'

const valid = {
  actor_id: '00000000-0000-0000-0000-000000000001',
  role: 'specialist',
  permission_revision: 7,
  auth_session_id: '00000000-0000-0000-0000-000000000101',
}

describe('XAgent Principal', () => {
  test('只接受后端验证结果并绑定 Host 生成的 connectionId', () => {
    expect(parseXAgentPrincipal(valid, 'connection-1')).toEqual({
      actorId: '00000000-0000-0000-0000-000000000001',
      role: 'specialist',
      permissionRevision: 7,
      authSessionId: '00000000-0000-0000-0000-000000000101',
      connectionId: 'connection-1',
    })
  })

  test.each([
    [null],
    ['invalid'],
    [valid, ''],
    [{ ...valid, actor_id: 1 }],
    [{ actor_id: 'not-uuid', role: 'specialist', permission_revision: 1, auth_session_id: crypto.randomUUID() }],
    [{ ...valid, role: 1 }],
    [{ actor_id: crypto.randomUUID(), role: 'admin', permission_revision: 1, auth_session_id: crypto.randomUUID() }],
    [{ ...valid, permission_revision: 1.5 }],
    [{ actor_id: crypto.randomUUID(), role: 'manager', permission_revision: 0, auth_session_id: crypto.randomUUID() }],
    [{ ...valid, auth_session_id: 1 }],
    [{ ...valid, auth_session_id: 'not-uuid' }],
  ])('拒绝不可信或不完整的验证结果', (value, connectionId = 'connection-1') => {
    expect(() => parseXAgentPrincipal(value, connectionId)).toThrow('invalid principal')
  })

  test('服务基类注册 xagentPrincipal 服务键', async () => {
    class PrincipalService extends XAgentPrincipalService {
      resolve(): Promise<ReturnType<typeof parseXAgentPrincipal>> {
        return Promise.resolve(parseXAgentPrincipal(valid, 'connection-1'))
      }
    }
    const ctx = new Context()
    const service = new PrincipalService(ctx)

    await expect(service.resolve()).resolves.toMatchObject({ connectionId: 'connection-1' })
    expect(service).toBeInstanceOf(XAgentPrincipalService)
    await ctx.fiber.dispose()
  })
})
