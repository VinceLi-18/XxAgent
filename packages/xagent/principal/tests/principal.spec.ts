import { describe, expect, test } from 'vitest'
import { parseXAgentPrincipal } from '../src/index.ts'

describe('XAgent Principal', () => {
  test('只接受后端验证结果并绑定 Host 生成的 connectionId', () => {
    expect(parseXAgentPrincipal({
      actor_id: '00000000-0000-0000-0000-000000000001',
      role: 'specialist',
      permission_revision: 7,
      auth_session_id: '00000000-0000-0000-0000-000000000101',
    }, 'connection-1')).toEqual({
      actorId: '00000000-0000-0000-0000-000000000001',
      role: 'specialist',
      permissionRevision: 7,
      authSessionId: '00000000-0000-0000-0000-000000000101',
      connectionId: 'connection-1',
    })
  })

  test.each([
    [{ actor_id: 'not-uuid', role: 'specialist', permission_revision: 1, auth_session_id: crypto.randomUUID() }],
    [{ actor_id: crypto.randomUUID(), role: 'admin', permission_revision: 1, auth_session_id: crypto.randomUUID() }],
    [{ actor_id: crypto.randomUUID(), role: 'manager', permission_revision: 0, auth_session_id: crypto.randomUUID() }],
  ])('拒绝不可信或不完整的验证结果', (value) => {
    expect(() => parseXAgentPrincipal(value, 'connection-1')).toThrow('invalid principal')
  })
})
