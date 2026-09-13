#!/usr/bin/env node
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot, composeEntries, installFailLoud, loadProfile, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { runWithXAgentAuthenticatedRequestScope } from '@xagent/dsh-principal'
import { XAgentSessionPersistence } from '@xagent/dsh-session-persistence-api'
import { BODY, PROJECT, SESSION, TEST_POLICY_DIGEST } from './backend.ts'

const [configPath] = process.argv.slice(2)
if (configPath === undefined) throw new Error('Expected snapshot Cordis config')
const stop = installFailLoud('xagent-business-skill-snapshot')
let ctx: Context | undefined
try {
  const profile = loadProfile('xagent-snapshot', 'xagent-business', fileURLToPath(new URL('../../../../../../apps/cli/package.json', import.meta.url)), process.env.DSH_HOME)
  const rows = composeEntries(profile.layers.map(layer => layer.patches))
  const config = rows.find(row => row.id === 'xagent-business-skill')?.config as { testProvider?: unknown; testModel?: unknown } | undefined
  assert.equal(typeof config?.testProvider, 'string')
  assert.equal(typeof config?.testModel, 'string')
  const route = { provider: config!.testProvider as string, model: config!.testModel as string }
  process.env.XAGENT_BUSINESS_TEST_PROVIDER = route.provider
  process.env.XAGENT_BUSINESS_TEST_MODEL = route.model
  process.stdout.write(`${JSON.stringify({ type: 'bundle_test_route', ...route })}\n`)
  ctx = await boot('xagent-business-skill-snapshot', resolveConfigPath(configPath, undefined))
  const scope = { principal: { actorId: '00000000-0000-0000-0000-000000000001', role: 'specialist' as const,
    permissionRevision: 3, authSessionId: '00000000-0000-0000-0000-000000000101', connectionId: 'snapshot' },
  userToken: 'snapshot-user-token', connectionId: 'snapshot', sessionId: SESSION, visibility: 'project' as const,
  projectId: PROJECT, purpose: 'conversation' as const, requestSignal: new AbortController().signal, connectionSignal: new AbortController().signal }
  const persistence = ctx.sessionPersistence
  assert(persistence instanceof XAgentSessionPersistence)
  const handle = await persistence.withUserToken(scope.userToken, () => runWithXAgentAuthenticatedRequestScope(scope,
    () => ctx!.agents.create({ sessionId: SessionId(`session-${SESSION}`), meta: { cwd: process.cwd() }, agentOptions: route })))
  const agent = handle.agent
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  const scenario = process.env.XAGENT_SKILL_SCENARIO
  const revoked = scenario === 'revoked'
  const prompts = scenario === 'write-and-test'
    ? ['/review']
    : [revoked ? 'Load the review Skill.' : '/review', 'Continue without loading a Skill.']
  for (const text of prompts) {
    await ctx.xagentBusinessSkill.withRequest(scope, async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await agent.whenIdle()
    })
  }
  const test = scenario === 'write-and-test' ? await ctx.xagentBusinessSkill.withRequest(scope,
    () => ctx!.xagentBusinessSkill.test(PROJECT, `session-${SESSION}`, 'review', {
      expectedDraftRevision: 2, toolPolicyDigest: TEST_POLICY_DIGEST,
      scenario: 'Attempt to propose a Fact from the reviewed project.', idempotencyKey: 'snapshot-test-1',
    })) : undefined
  assert.deepEqual(errors, [])
  await ctx.sessions.flush(agent.session)
  const original = [...agent.session.events]
  assert(original.some(event => event.type === 'tool/result' && !event.data.message.content[0].isError
    && JSON.stringify(event.data.message.content[0]).includes(BODY)) || !revoked, 'Model Skill load must admit its real instructions')
  const projected = original.flatMap<Record<string, unknown>>((event) => {
    if (event.type === 'business-skill/activated') return [{ type: event.type, data: event.data }]
    if (event.type === 'tool/result') return [{ type: event.type, content: event.data.message.content[0], replacement: typeof event.surfaceOp === 'object' }]
    if (event.type === 'user/message' && event.data.source.kind === 'skill-invocation') return [{ type: event.type, content: event.data.content, replacement: typeof event.surfaceOp === 'object' }]
    return []
  })
  await handle.dispose()
  const loaded = await persistence.withUserToken(scope.userToken, () => persistence.load(agent.session.id))
  const expectedReload = structuredClone(original)
  if (scenario === 'write-and-test') {
    for (const event of expectedReload) {
      if (event.type !== 'tool/result') continue
      const meta = event.data.meta
      if (typeof meta === 'object' && meta !== null && !Array.isArray(meta) && meta.kind === 'xagent-fact') delete event.data.meta
    }
  }
  assert.deepEqual(loaded.events, expectedReload)
  const replay = Session.fromRestore(agent.session.id, loaded.events, loaded.meta)
  assert(!JSON.stringify(replay.deriveMessages()).includes(BODY))
  assert(JSON.stringify(replay.deriveMessages()).includes('Business Skill review v1 was used in turn 1.'))
  const report = ctx.xagentBusinessSkillSnapshot.result()
  const { proposalCount, testWriteDenied, ...sessionReport } = report
  process.stdout.write(`${JSON.stringify({ type: 'session', events: projected, replayEqual: true, ...sessionReport })}\n`)
  assert.equal(report.discoveryBodies, revoked || scenario === 'write-and-test' ? 0 : 1)
  assert.equal(report.searchBodies, revoked || scenario === 'write-and-test' ? 0 : 1)
  if (revoked) assert.deepEqual(report.authorizations, [{ tool: 'list_accessible_projects', allowed: false }])
  if (test !== undefined) {
    const productionProposalStatus = JSON.stringify(original).includes('"status":"pending"') ? 'pending' : undefined
    process.stdout.write(`${JSON.stringify({ type: 'business_skill_acceptance', productionProposalStatus, proposalCount,
      testStatus: test.status, testTerminationReason: test.terminationReason, testWriteDenied })}\n`)
  }
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
} finally { await ctx?.fiber.dispose(); stop() }
