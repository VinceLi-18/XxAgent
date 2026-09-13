import { expect, test } from 'vitest'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { businessSkillRelationship, registerPolicyRelationship, registerTestRelationship } from '../src/relationships.ts'
import { setup } from './fixtures.ts'

test('run identity requires the claimed owner, exact definition and same policy admission', async () => {
  const h = await setup()
  const other = await setup()
  const definition: SkillDefinition = Object.freeze({ name: 'review', description: 'Review', content: 'Draft instructions', provider: 'xagent-draft',
    source: 'xagent-draft', invocation: { userInvocable: true, modelInvocable: true } })
  let claimed = false
  const selected = ['skill']
  const first = registerTestRelationship(h.agent, definition, 1, selected, () => claimed)
  selected.push('search_artifacts')
  try {
    expect(businessSkillRelationship(h.agent, definition)).toBeUndefined()
    claimed = true
    expect(businessSkillRelationship(h.agent, definition)).toEqual({ kind: 'test', tools: ['skill'], activated: false, denied: false })
    expect(Object.isFrozen(businessSkillRelationship(h.agent, definition)!.tools)).toBe(true)
    expect(businessSkillRelationship(other.agent, definition)).toBeUndefined()
    expect(businessSkillRelationship(h.agent, { ...definition })).toBeUndefined()
    const wrongDefinition = registerPolicyRelationship(h.agent, { ...definition }, selected, () => false, first)
    expect(businessSkillRelationship(h.agent, definition)).toBeUndefined()
    wrongDefinition()
    const second = registerTestRelationship(h.agent, definition, 2, ['skill'], () => true)
    const wrongRun = registerPolicyRelationship(h.agent, definition, selected, () => false, first)
    expect(businessSkillRelationship(h.agent, definition)).toBeUndefined()
    let denied = false
    const current = registerPolicyRelationship(h.agent, definition, ['skill'], () => denied, second)
    wrongRun()
    expect(businessSkillRelationship(h.agent, definition)).toEqual({ kind: 'test', tools: ['skill'], activated: true, denied: false })
    denied = true
    expect(businessSkillRelationship(h.agent, definition)?.denied).toBe(true)
    current()
    expect(businessSkillRelationship(h.agent, definition)?.activated).toBe(false)
  } finally { await h.ctx.fiber.dispose(); await other.ctx.fiber.dispose() }
  expect(businessSkillRelationship(h.agent, definition)).toBeUndefined()
})

test('production observation follows the exact policy lifecycle and never accepts a test token', async () => {
  const h = await setup()
  const definition: SkillDefinition = { name: 'review', description: 'Review', content: 'Published instructions', provider: 'xagent-project',
    source: 'xagent-project', invocation: { userInvocable: true, modelInvocable: true } }
  expect(businessSkillRelationship(h.agent, definition)).toBeUndefined()
  const testOwner = registerTestRelationship(h.agent, definition, 1, ['skill'], () => true)
  const invalid = registerPolicyRelationship(h.agent, definition, ['skill'], () => false, testOwner)
  expect(businessSkillRelationship(h.agent, definition)).toBeUndefined()
  invalid()
  const selected = ['skill']
  let denied = false
  const close = registerPolicyRelationship(h.agent, definition, selected, () => denied, undefined)
  selected.push('search_artifacts')
  expect(businessSkillRelationship(h.agent, { ...definition })).toBeUndefined()
  expect(businessSkillRelationship(h.agent, definition)).toEqual({ kind: 'production', tools: ['skill'], activated: true, denied: false })
  denied = true
  expect(businessSkillRelationship(h.agent, definition)?.denied).toBe(true)
  close()
  expect(businessSkillRelationship(h.agent, definition)).toBeUndefined()
  await h.ctx.fiber.dispose()
})
