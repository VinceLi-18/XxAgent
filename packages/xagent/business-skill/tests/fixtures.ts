import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { XAgentBackendClient } from '@xagent/dsh-backend-client'
import type { XAgentAuthenticatedSessionRequestScope } from '@xagent/dsh-principal'
import { FastApiBusinessSkillService } from '../src/index.ts'

export const projectId = '00000000-0000-0000-0000-000000000201'
export const sessionId = '00000000-0000-0000-0000-000000000301'
export const versionKey = '00000000-0000-0000-0000-000000000401'
export const version2 = '00000000-0000-0000-0000-000000000402'
export const signal = new AbortController().signal

export function request(overrides: Partial<XAgentAuthenticatedSessionRequestScope> = {}): XAgentAuthenticatedSessionRequestScope {
  return {
    principal: {
      actorId: '00000000-0000-0000-0000-000000000001', role: 'specialist', permissionRevision: 3,
      authSessionId: '00000000-0000-0000-0000-000000000101', connectionId: 'alice',
    },
    userToken: 'alice-token', connectionId: 'alice', requestSignal: signal, connectionSignal: signal,
    sessionId, projectId, visibility: 'project', purpose: 'conversation', ...overrides,
  } as XAgentAuthenticatedSessionRequestScope
}

export const entry = (slug = 'review', version = 1, key = versionKey) => ({
  schema_version: 1, slug, description: 'Review project evidence.', version_number: version, version_key: key,
})
export const loaded = () => ({
  ...entry(), instructions: 'Read the project evidence before answering.', content_digest: 'a'.repeat(64),
  tool_policy_digest: 'b'.repeat(64), complete_tools: ['skill'],
})
const detail = () => ({
  schema_version: 1, slug: 'review', display_name: 'Review', status: 'active',
  authorized: false, current_version: null, draft_revision: null, latest_test: null,
  updated_at: '2026-09-12T00:00:00Z', draft: null, versions: [], tests: [],
  next_version_cursor: null, next_run_cursor: null, audit_summary: [],
})

export const testRecord = {
  runNumber: 1, draftRevision: 1, contentDigest: 'a'.repeat(64), toolPolicyDigest: 'b'.repeat(64),
  status: 'completed' as const, terminationReason: 'completed' as const,
  startedAt: '2026-09-12T00:00:00Z', settledAt: '2026-09-12T00:01:00Z',
}
const wireTest = {
  run_number: 1, draft_revision: 1, content_digest: 'a'.repeat(64), tool_policy_digest: 'b'.repeat(64),
  status: 'completed', termination_reason: 'completed', verdict: null,
  started_at: '2026-09-12T00:00:00Z', settled_at: '2026-09-12T00:01:00Z', verdict_at: null,
}

export async function setup(maxCatalogEntries = 10) {
  const calls: { path: string; body: Record<string, unknown>; token: string | null; signal: AbortSignal | null | undefined }[] = []
  const state = {
    catalog: [entry('z-review'), entry('a-review')] as unknown[], load: loaded() as unknown,
    failure: undefined as string | undefined,
    wait: undefined as Promise<void> | undefined,
  }
  const client = new XAgentBackendClient({
    origin: 'https://backend.example', serviceToken: 'host-service',
    fetch: async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
      calls.push({ path, body: JSON.parse(init.body) as Record<string, unknown>,
        token: new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? null, signal: init?.signal })
      await state.wait
      if (state.failure) return Response.json({ detail: { code: state.failure } }, { status: state.failure === 'business-skill-retired' ? 409 : 403 })
      if (path.endsWith('/runtime/catalog')) return Response.json({ schema_version: 1, items: state.catalog })
      if (path.endsWith('/runtime/load')) return Response.json(state.load)
      if (path.endsWith('/list')) return Response.json({ schema_version: 1, items: [], next_cursor: null })
      if (path.endsWith('/transcript')) return Response.json({ schema_version: 1, test: wireTest, events: [], next_sequence: 0 })
      return Response.json(detail())
    },
  })
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolSkill)
  const service = new FastApiBusinessSkillService(ctx, client.businessSkills, { maxCatalogEntries })
  const id = SessionId(`session-${sessionId}`)
  const session = Session.create(id)
  let scope!: Scope
  const agent: Agent = {
    get ctx() { return scope.ctx }, id, session, options: {}, status: 'idle',
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
    runMaintenance: task => task(signal), whenIdle: () => Promise.resolve(),
  }
  await ctx.plugin({ inject: ['skills'], apply: (inner: Context) => { scope = createScope(inner, agent) } })
  return { ctx, service, agent, scope, calls, state }
}
