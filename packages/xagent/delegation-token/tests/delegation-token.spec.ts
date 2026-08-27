import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { issueDelegationToken, verifyDelegationToken } from '../src/index.ts'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const now = 1_787_500_000
const scope = {
  actorId: '00000000-0000-0000-0000-000000000001',
  projectId: null,
  sessionId: '00000000-0000-0000-0000-000000000201',
  toolCallId: 'tool-call-1',
  toolName: 'artifact.read',
  permissionRevision: 4,
}

function rawToken(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'EdDSA', typ: 'JWT' }): string {
  const head = Buffer.from(JSON.stringify(header)).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const input = `${head}.${body}`
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`
}

const payload = {
  iss: 'xagent-host', aud: 'xagent-api', iat: now, exp: now + 30,
  actor_id: scope.actorId, project_id: scope.projectId, session_id: scope.sessionId,
  tool_call_id: scope.toolCallId, tool_name: scope.toolName,
  permission_revision: scope.permissionRevision, nonce: 'nonce-valid',
}

const verifyOptions = {
  publicKey,
  issuer: 'xagent-host',
  audience: 'xagent-api',
  now: now + 1,
  expected: scope,
  currentPermissionRevision: 4,
  consumeNonce: async () => true,
}

describe('XAgent Ed25519 委托令牌', () => {
  test('签发并验证限定范围、60 秒内有效的单次令牌', async () => {
    const token = issueDelegationToken({
      ...scope,
      issuer: 'xagent-host',
      audience: 'xagent-api',
      privateKey,
      now,
      expiresInSeconds: 60,
      nonce: 'nonce-1',
    })
    const consumed = new Set<string>()

    const claims = await verifyDelegationToken(token, {
      publicKey,
      issuer: 'xagent-host',
      audience: 'xagent-api',
      now: now + 30,
      expected: scope,
      currentPermissionRevision: 4,
      consumeNonce: async (nonce) => {
        if (consumed.has(nonce)) return false
        consumed.add(nonce)
        return true
      },
    })

    expect(claims).toMatchObject({ ...scope, nonce: 'nonce-1', expiresAt: now + 60 })
    await expect(verifyDelegationToken(token, {
      publicKey,
      issuer: 'xagent-host',
      audience: 'xagent-api',
      now: now + 31,
      expected: scope,
      currentPermissionRevision: 4,
      consumeNonce: async nonce => !consumed.has(nonce),
    })).rejects.toThrow('delegation rejected')
  })

  test('拒绝超长有效期、篡改、错误 audience、范围和旧 revision', async () => {
    expect(() => issueDelegationToken({
      ...scope,
      issuer: 'xagent-host',
      audience: 'xagent-api',
      privateKey,
      now,
      expiresInSeconds: 61,
      nonce: 'nonce-long',
    })).toThrow('delegation rejected')

    const token = issueDelegationToken({
      ...scope,
      issuer: 'xagent-host',
      audience: 'xagent-api',
      privateKey,
      now,
      expiresInSeconds: 30,
      nonce: 'nonce-2',
    })
    const base = {
      publicKey,
      issuer: 'xagent-host',
      audience: 'xagent-api',
      now: now + 1,
      expected: scope,
      currentPermissionRevision: 4,
      consumeNonce: async () => true,
    }
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`

    await expect(verifyDelegationToken(tampered, base)).rejects.toThrow('delegation rejected')
    await expect(verifyDelegationToken(token, { ...base, audience: 'wrong' })).rejects.toThrow('delegation rejected')
    await expect(verifyDelegationToken(token, {
      ...base,
      expected: { ...scope, toolName: 'artifact.write' },
    })).rejects.toThrow('delegation rejected')
    await expect(verifyDelegationToken(token, {
      ...base,
      currentPermissionRevision: 5,
    })).rejects.toThrow('delegation rejected')
  })

  test.each([
    [{ actorId: 'bad' }],
    [{ projectId: 'bad' }],
    [{ sessionId: 'bad' }],
    [{ toolCallId: '' }],
    [{ toolName: '' }],
    [{ permissionRevision: 1.5 }],
    [{ permissionRevision: 0 }],
    [{ now: 1.5 }],
    [{ expiresInSeconds: 1.5 }],
    [{ expiresInSeconds: 0 }],
    [{ issuer: '' }],
    [{ audience: '' }],
    [{ nonce: '' }],
  ])('签发端拒绝无效字段 %#', (override) => {
    expect(() => issueDelegationToken({
      ...scope,
      issuer: 'xagent-host', audience: 'xagent-api', privateKey,
      now, expiresInSeconds: 30, nonce: 'nonce', ...override,
    })).toThrow('delegation rejected')
  })

  test.each([
    [{ iss: 'wrong' }],
    [{ aud: 'wrong' }],
    [{ actor_id: 'bad' }],
    [{ project_id: 'bad' }],
    [{ session_id: 'bad' }],
    [{ tool_call_id: '' }],
    [{ tool_name: '' }],
    [{ permission_revision: 1.5 }],
    [{ permission_revision: 0 }],
    [{ iat: 'bad' }],
    [{ iat: 1.5 }],
    [{ exp: 'bad' }],
    [{ exp: 1.5 }],
    [{ exp: now + 61 }],
    [{ exp: now + 1 }],
    [{ iat: now + 2 }],
    [{ nonce: 1 }],
    [{ nonce: '' }],
  ])('验证端拒绝无效 claim %#', async (override) => {
    await expect(verifyDelegationToken(rawToken({ ...payload, ...override }), verifyOptions))
      .rejects.toThrow('delegation rejected')
  })

  test.each([
    [{ actorId: crypto.randomUUID() }],
    [{ projectId: crypto.randomUUID() }],
    [{ sessionId: crypto.randomUUID() }],
    [{ toolCallId: 'other-call' }],
    [{ toolName: 'other.tool' }],
    [{ permissionRevision: 5 }],
  ])('验证端拒绝与预期作用域不同的 claim %#', async (override) => {
    await expect(verifyDelegationToken(rawToken(payload), {
      ...verifyOptions,
      expected: { ...scope, ...override },
    })).rejects.toThrow('delegation rejected')
  })

  test('拒绝畸形 compact token、header、签名和已消费 nonce', async () => {
    await expect(verifyDelegationToken('not-a-token', verifyOptions)).rejects.toThrow('delegation rejected')
    await expect(verifyDelegationToken(`*.${rawToken(payload).split('.').slice(1).join('.')}`, verifyOptions))
      .rejects.toThrow('delegation rejected')
    await expect(verifyDelegationToken(rawToken(payload, { alg: 'HS256', typ: 'JWT' }), verifyOptions))
      .rejects.toThrow('delegation rejected')
    await expect(verifyDelegationToken(rawToken(payload, { alg: 'EdDSA', typ: 'wrong' }), verifyOptions))
      .rejects.toThrow('delegation rejected')
    const parts = rawToken(payload).split('.')
    await expect(verifyDelegationToken(`${parts[0]}.${parts[1]}.*`, verifyOptions)).rejects.toThrow('delegation rejected')
    await expect(verifyDelegationToken(`${parts[0]}.${parts[1]}.${Buffer.alloc(64).toString('base64url')}`, verifyOptions))
      .rejects.toThrow('delegation rejected')
    await expect(verifyDelegationToken(rawToken(payload), { ...verifyOptions, consumeNonce: async () => false }))
      .rejects.toThrow('delegation rejected')
  })
})
