#!/usr/bin/env node
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot, composeEntries, installFailLoud, loadProfile, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { runWithXAgentAuthenticatedRequestScope } from '@xagent/dsh-principal'
import { XAgentSessionPersistence } from '@xagent/dsh-session-persistence-api'
import { BODY, PROJECT, SESSION } from './backend.ts'

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
    () => ctx!.agents.create({ sessionId: SessionId(`session-${SESSION}`), agentOptions: route })))
  const agent = handle.agent
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  const revoked = process.env.XAGENT_SKILL_SCENARIO === 'revoked'
  for (const text of [revoked ? 'Load the review Skill.' : '/review', 'Continue without loading a Skill.']) {
    await ctx.xagentBusinessSkill.withRequest(scope, async () => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await agent.whenIdle()
    })
  }
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
  assert.deepEqual(loaded.events, original)
  const replay = Session.fromRestore(agent.session.id, loaded.events, loaded.meta)
  assert(!JSON.stringify(replay.deriveMessages()).includes(BODY))
  assert(JSON.stringify(replay.deriveMessages()).includes('Business Skill review v1 was used in turn 1.'))
  const report = ctx.xagentBusinessSkillSnapshot.result()
  process.stdout.write(`${JSON.stringify({ type: 'session', events: projected, replayEqual: true, ...report })}\n`)
  assert.equal(report.discoveryBodies, revoked ? 0 : 1)
  assert.equal(report.searchBodies, revoked ? 0 : 1)
  if (revoked) assert.deepEqual(report.authorizations, [{ tool: 'list_accessible_projects', allowed: false }])
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
} finally { await ctx?.fiber.dispose(); stop() }
