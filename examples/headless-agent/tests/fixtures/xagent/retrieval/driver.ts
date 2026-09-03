#!/usr/bin/env node

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { runWithXAgentAuthenticatedRequestScope } from '@xagent/dsh-principal'

const SESSION = '00000000-0000-0000-0000-000000000701'
const [configPath] = process.argv.slice(2)
if (configPath === undefined) throw new Error('xagent-cited-answer-driver: expected <config-path>')

const uninstallFailLoud = installFailLoud('xagent-cited-answer-driver')
let ctx: Context | undefined
try {
  loadEnv('xagent-cited-answer-driver')
  ctx = await boot('xagent-cited-answer-driver', resolveConfigPath(configPath, undefined))
  const [agent] = ctx.agents.roots()
  if (agent === undefined || ctx.agents.roots().length !== 1) throw new Error('expected one XAgent snapshot agent')
  const request = new AbortController()
  const connection = new AbortController()
  runWithXAgentAuthenticatedRequestScope(Object.freeze({
    principal: Object.freeze({
      actorId: '00000000-0000-0000-0000-000000000001',
      role: 'specialist' as const,
      permissionRevision: 3,
      authSessionId: '00000000-0000-0000-0000-000000000101',
      connectionId: 'snapshot-connection',
    }),
    userToken: 'snapshot-user-token',
    connectionId: 'snapshot-connection',
    sessionId: SESSION,
    requestSignal: request.signal,
    connectionSignal: connection.signal,
    visibility: 'private' as const,
    projectId: null,
  }), () => {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Answer from verified evidence.' }],
      source: { kind: 'user' },
    }))
  })
  await agent.whenIdle()
  const result = agent.session.events.find(event => event.type === 'tool/result'
    && event.data.message.source.callId === 'call-answer')
  if (result?.type !== 'tool/result' || result.data.meta === undefined) {
    throw new Error('missing canonical cited-answer result')
  }
  process.stdout.write(`${JSON.stringify({
    type: 'cited_answer',
    content: result.data.message.content[0],
    meta: result.data.meta,
  })}\n`)
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
