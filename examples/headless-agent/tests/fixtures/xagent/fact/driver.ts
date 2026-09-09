#!/usr/bin/env node

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { runWithXAgentAuthenticatedRequestScope } from '@xagent/dsh-principal'

const SESSION = '00000000-0000-0000-0000-000000000701'
const PROJECT = '00000000-0000-0000-0000-000000000401'
const [configPath] = process.argv.slice(2)
if (configPath === undefined) throw new Error('xagent-fact-approval-driver: expected <config-path>')

const uninstallFailLoud = installFailLoud('xagent-fact-approval-driver')
let ctx: Context | undefined
try {
  loadEnv('xagent-fact-approval-driver')
  ctx = await boot('xagent-fact-approval-driver', resolveConfigPath(configPath, undefined))
  const [agent] = ctx.agents.roots()
  if (agent === undefined || ctx.agents.roots().length !== 1) throw new Error('expected one XAgent Fact snapshot agent')
  const errors: unknown[] = []
  ctx.on('agent/error', ({ agent: subject, error }) => {
    if (subject === agent) errors.push(error)
  })

  const followup = (prompt: string): void => {
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
      visibility: 'project' as const,
      projectId: PROJECT,
    }), () => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    })
  }

  followup('Propose the verified launch facts and answer with citations.')
  await agent.whenIdle()
  followup('Propose the directly confirmed launch owner.')
  await agent.whenIdle()
  followup('Report the manager decision and answer again.')
  await agent.whenIdle()
  followup('Answer once more without repeating old decisions.')
  await agent.whenIdle()
  if (errors.length > 0) {
    throw new Error(`Fact snapshot Agent failed: ${String(errors[0])}`)
  }

  const facts = agent.session.events.filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    .filter(event => String(event.data.message.source.callId).startsWith('call-fact-')
      || String(event.data.message.source.callId).startsWith('call-answer-'))
    .map(event => ({
      type: event.type,
      callId: String(event.data.message.source.callId),
      content: event.data.message.content[0],
      meta: event.data.meta,
    }))
  const decisions = agent.session.events.filter(event => event.type === 'fact/proposal-decided')
    .map(event => event.data)
  const factAdmissions = ctx.xagentFact.receipts.attachments(String(agent.session.id), 0, agent.session.seq)
    .map(({ eventSequence, toolCallId, proposalId }) => ({ eventSequence, toolCallId, proposalId }))
  const retrievalAdmissions = ctx.xagentRetrieval.receipts.attachments(String(agent.session.id), 0, agent.session.seq)
    .map(({ eventSequence, toolCallId }) => ({ eventSequence, toolCallId }))
  process.stdout.write(`${JSON.stringify({ type: 'session', facts, decisions, factAdmissions, retrievalAdmissions })}\n`)
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
