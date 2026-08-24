import { generateKeyPairSync } from 'node:crypto'
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
})
