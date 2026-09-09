import { generateKeyPairSync } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { XAgentFactBackend } from '@xagent/dsh-backend-client'
import { describe, expect, test, vi } from 'vitest'
import { XAgentFactService } from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import { XAgentFactOutboxRegistry, XAgentFactReceiptRegistry } from '../src/receipt-registry.ts'

const { privateKey } = generateKeyPairSync('ed25519')

function backend(): XAgentFactBackend {
  return {
    prepare: async () => ({
      result: { proposalId: '00000000-0000-0000-0000-000000000401', status: 'pending' },
      receipt: 'opaque',
      payloadHash: 'a'.repeat(64),
    }),
    listHeads: async () => ({ items: [] }),
    listProposals: async () => ({ items: [] }),
    revision: async () => { throw new Error('unused') },
    proposal: async () => { throw new Error('unused') },
    approve: async () => { throw new Error('unused') },
    reject: async () => { throw new Error('unused') },
    withdraw: async () => { throw new Error('unused') },
    pullOutbox: async () => ({ items: [] }),
  }
}

function fact(ctx: Context): XAgentFactService {
  return new XAgentFactService(
    ctx,
    backend(),
    new XAgentFactReceiptRegistry(),
    new XAgentFactOutboxRegistry(),
    { issuer: 'issuer', audience: 'audience', privateKey },
  )
}

describe('XAgent Fact invariant', () => {
  test('installs when the optional Fact provider is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(invariant)).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })

  test('accepts the live Typert binding and two distinct private registries', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const service = fact(ctx)
    await expect(ctx.plugin(invariant)).resolves.toBeDefined()
    expect(() => { invariant.validateXAgentFactRelationships(service, (message) => { throw new Error(message) }) })
      .not.toThrow()
    await ctx.fiber.dispose()
  })

  test('rejects a service whose Typert identity or private registry ownership diverges', () => {
    const fail = (message: string): never => { throw new Error(message) }
    const wrongBinding = fact(new Context())
    Object.defineProperty(wrongBinding, 'typertRemote', {
      value: Object.freeze({ ...wrongBinding.typertRemote, namespace: 'other' }),
    })
    expect(() => {
      invariant.validateXAgentFactRelationships(wrongBinding, fail)
    }).toThrow('Typert binding')

    const sharedRegistry = fact(new Context())
    Object.defineProperty(sharedRegistry, 'outbox', { value: sharedRegistry.receipts })
    expect(() => {
      invariant.validateXAgentFactRelationships(sharedRegistry, fail)
    }).toThrow('separate registries')

    const wrongOwner = fact(new Context())
    vi.spyOn(wrongOwner, 'relationshipIssue').mockReturnValue('owner mismatch')
    expect(() => {
      invariant.validateXAgentFactRelationships(wrongOwner, fail)
    }).toThrow('owner mismatch')
  })
})
