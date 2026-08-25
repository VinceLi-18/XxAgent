import type { ConnectionRequestContext } from '@deepseek-ai/dsh-client-connection'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {
  XAgentBackend,
  XAgentWorkbenchBackend,
  XAgentWorkbenchBootstrap,
  XAgentWorkbenchContext,
} from '@xagent/dsh-backend-client'
import { XAgentAuthorization } from '@xagent/dsh-authorization'
import { XAgentProjectService } from '@xagent/dsh-project'
import { XAgentSessionPersistence } from '@xagent/dsh-session-persistence-api'
import { describe, expect, test, vi } from 'vitest'

const actorId = '00000000-0000-0000-0000-000000000001'
const projectId = '00000000-0000-0000-0000-000000000401'
const request: ConnectionRequestContext = {
  principal: {
    actorId,
    role: 'specialist',
    permissionRevision: 3,
    authSessionId: '00000000-0000-0000-0000-000000000101',
    connectionId: 'connection-alice',
  },
  userToken: 'alice-token',
  connectionId: 'connection-alice',
}

interface StoredSession {
  readonly sessionId: string
  readonly runtimeHeader: SessionHeader
  readonly visibility: 'private' | 'project'
  readonly projectId: string | null
}

function composition(): {
  readonly project: XAgentProjectService
  readonly persistence: XAgentSessionPersistence
  readonly authorization: XAgentAuthorization
  readonly stored: StoredSession[]
  readonly createBodies: Record<string, unknown>[]
} {
  const contexts = new Map<string, XAgentWorkbenchContext>([['alice-token', { kind: 'workbench' }]])
  const stored: StoredSession[] = []
  const createBodies: Record<string, unknown>[] = []
  const bootstrap = (token: string): XAgentWorkbenchBootstrap => ({
    account: {
      id: actorId,
      email: 'alice@example.test',
      role: 'specialist',
      permissionRevision: 3,
    },
    capabilities: [],
    context: contexts.get(token) ?? { kind: 'workbench' },
    projects: [{ id: projectId, name: 'Alpha', createdAt: '2026-08-25T08:00:00+00:00' }],
    sessionScopes: stored.map(item => item.visibility === 'private'
      ? { sessionId: item.runtimeHeader.id, visibility: 'private' }
      : { sessionId: item.runtimeHeader.id, visibility: 'project', projectId: item.projectId as string }),
    sessionSummary: {
      privateCount: stored.filter(item => item.visibility === 'private').length,
      projectCounts: {
        [projectId]: stored.filter(item => item.projectId === projectId).length,
      },
    },
  })
  const workbench: XAgentWorkbenchBackend = {
    bootstrap: async token => bootstrap(token),
    selectContext: async (token, context) => {
      contexts.set(token, context)
      return bootstrap(token)
    },
    createProject: vi.fn(),
    project: vi.fn(),
    addSessionProjectRefs: vi.fn(async () => {}),
  }
  const backend: XAgentBackend = {
    login: vi.fn(),
    introspect: vi.fn(),
    revoke: vi.fn(),
    sessions: {
      list: async token => ({
        schema_version: 1,
        sessions: stored.map(item => ({ runtime_header: item.runtimeHeader })),
        token,
      }),
      create: async (token, value) => {
        const body = value as Record<string, unknown>
        createBodies.push(body)
        const runtimeHeader = body.runtime_header as SessionHeader
        const context = contexts.get(token) ?? { kind: 'workbench' }
        const scope = context.kind === 'project'
          ? { visibility: 'project' as const, projectId: context.projectId }
          : { visibility: 'private' as const, projectId: null }
        const sessionId = body.session_id as string
        stored.push({ sessionId, runtimeHeader, ...scope })
        return {
          schema_version: 1,
          session: {
            id: sessionId,
            visibility: scope.visibility,
            project_id: scope.projectId,
          },
        }
      },
      open: vi.fn(),
      events: vi.fn(),
      append: vi.fn(),
      fork: vi.fn(),
      archive: vi.fn(),
      authorize: vi.fn(async () => {}),
    },
    workbench,
  }
  const ctx = new Context()
  const project = new XAgentProjectService(ctx, workbench)
  const persistence = new XAgentSessionPersistence(ctx, backend)
  const authorization = new XAgentAuthorization(backend, persistence, project)
  return { project, persistence, authorization, stored, createBodies }
}

describe('XAgent 项目上下文与 Session 创建组合', () => {
  test('项目选择、创建和 Bootstrap 分组都使用同一服务端账号上下文', async () => {
    const value = composition()
    const signal = new AbortController().signal
    const projectSession = SessionId('session-00000000-0000-0000-0000-000000000711')
    const privateSession = SessionId('session-00000000-0000-0000-0000-000000000712')

    await expect(value.authorization.run(
      'xagentProject/select-context',
      { args: { context: { kind: 'project', projectId }, visibility: 'private' } },
      request,
      signal,
      async () => ({ ok: true, value: await value.project.selectContext({ kind: 'project', projectId }, signal) }),
    )).resolves.toMatchObject({ ok: true, value: { context: { kind: 'project', projectId } } })
    await expect(value.authorization.run(
      'session/create',
      { args: { visibility: 'private', projectId: null } },
      request,
      signal,
      async () => {
        await value.persistence.create({ version: 0, id: projectSession, createdAt: 1 })
        return { ok: true, value: { sessionId: projectSession } }
      },
    )).resolves.toEqual({ ok: true, value: { sessionId: projectSession } })

    await value.authorization.run(
      'xagentProject/select-context',
      { args: { context: { kind: 'workbench' }, visibility: 'project', projectId } },
      request,
      signal,
      async () => ({ ok: true, value: await value.project.selectContext({ kind: 'workbench' }, signal) }),
    )
    await value.authorization.run(
      'session/create',
      { args: { visibility: 'project', projectId } },
      request,
      signal,
      async () => {
        await value.persistence.create({ version: 0, id: privateSession, createdAt: 2 })
        return { ok: true, value: { sessionId: privateSession } }
      },
    )
    const bootstrapped = await value.authorization.run(
      'xagentProject/bootstrap',
      { args: {} },
      request,
      signal,
      async () => ({ ok: true, value: await value.project.bootstrap(signal) }),
    )
    const listed = await value.persistence.withUserToken('alice-token', () => value.persistence.list())

    expect(value.stored.map(item => [item.runtimeHeader.id, item.visibility, item.projectId])).toEqual([
      [projectSession, 'project', projectId],
      [privateSession, 'private', null],
    ])
    expect(value.createBodies.every(body => !Object.hasOwn(body, 'visibility') && !Object.hasOwn(body, 'project_id')))
      .toBe(true)
    expect(bootstrapped).toMatchObject({
      ok: true,
      value: {
        context: { kind: 'workbench' },
        sessionScopes: [
          { sessionId: projectSession, visibility: 'project', projectId },
          { sessionId: privateSession, visibility: 'private' },
        ],
      },
    })
    expect(listed.map(item => item.id)).toEqual([projectSession, privateSession])
  })
})
