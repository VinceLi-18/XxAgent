import { createHash } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import { XAgentBackendClient, XAgentBackendError } from '../src/index.ts'

const principal = {
  actor_id: '00000000-0000-0000-0000-000000000001',
  role: 'specialist',
  permission_revision: 3,
  auth_session_id: '00000000-0000-0000-0000-000000000101',
}

const bootstrapResponse = {
  schema_version: 1,
  account: {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'alice@example.test',
    role: 'specialist',
    permission_revision: 3,
  },
  capabilities: ['project.create'],
  context: { kind: 'workbench', project_id: null },
  projects: [{
    id: '00000000-0000-0000-0000-000000000201',
    name: 'Alpha',
    created_at: '2026-08-25T08:00:00+00:00',
  }],
  session_scopes: [
    {
      session_id: '00000000-0000-0000-0000-000000000301',
      visibility: 'private',
      project_id: null,
    },
    {
      session_id: '00000000-0000-0000-0000-000000000302',
      visibility: 'project',
      project_id: '00000000-0000-0000-0000-000000000201',
    },
  ],
  session_summary: {
    private_count: 2,
    project_counts: { '00000000-0000-0000-0000-000000000201': 4 },
  },
}

const projectResponse = {
  schema_version: 1,
  account_id: '00000000-0000-0000-0000-000000000001',
  project: {
    id: '00000000-0000-0000-0000-000000000201',
    name: 'Alpha',
    created_at: '2026-08-25T08:00:00+00:00',
  },
  access: { can_edit: true },
  session_summary: { session_count: 4 },
}

const artifactIds = {
  private: '00000000-0000-0000-0000-000000000401',
  project: '00000000-0000-0000-0000-000000000402',
  failedVersion: '00000000-0000-0000-0000-000000000411',
  cleanVersion: '00000000-0000-0000-0000-000000000412',
  upload: '00000000-0000-0000-0000-000000000421',
  uploader: '00000000-0000-0000-0000-000000000431',
}

const privateArtifactSummary = {
  id: artifactIds.private,
  display_name: '合同.txt',
  scope: { kind: 'private' },
  latest_version: 2,
  latest_status: 'failed',
  latest_clean_version: 1,
}

const projectArtifactSummary = {
  id: artifactIds.project,
  display_name: '项目说明.pdf',
  scope: { kind: 'project', project_id: projectResponse.project.id },
  latest_version: 1,
  latest_status: 'pending',
}

const artifactDetailResponse = {
  ...privateArtifactSummary,
  can_edit: true,
  versions: [
    {
      id: artifactIds.failedVersion,
      version: 2,
      original_filename: '合同-修订.txt',
      uploaded_by: artifactIds.uploader,
      size: 12,
      content_type: 'text/plain',
      status: 'failed',
      created_at: '2026-08-25T09:00:00+00:00',
    },
    {
      id: artifactIds.cleanVersion,
      version: 1,
      original_filename: '合同.txt',
      uploaded_by: artifactIds.uploader,
      size: 10,
      content_type: 'text/plain',
      sha256: 'a'.repeat(64),
      status: 'clean',
      created_at: '2026-08-25T08:00:00Z',
    },
  ],
}

const artifactUploadResponse = {
  upload_id: artifactIds.upload,
  put_url: 'https://storage.example.test/staging/upload?signature=opaque',
  expires_at: '2026-08-25T08:10:00Z',
}

const retrievalIds = {
  session: '00000000-0000-0000-0000-000000000501',
  project: '00000000-0000-0000-0000-000000000502',
  artifact: '00000000-0000-0000-0000-000000000503',
  version: '00000000-0000-0000-0000-000000000504',
  chunk: '00000000-0000-0000-0000-000000000505',
}

const retrievalOperation = {
  sessionId: retrievalIds.session,
  toolCallId: 'tool-call-retrieval',
  permissionRevision: 3,
}

const retrievalScopeHashes = {
  projectOnly: 'c06adc0c89a5cc0f759a1a701a9a130dcc881e08c59ae441221c3b3ae13d2d8e',
  projectAndPrivate: 'b922e1206f075fb1932d67005e29c123942c9eb8b415a4bd95639d12c85e4056',
}
const alphaProjectId = 'aaaaaaaa-0000-0000-0000-000000000502'

const citationResponse = {
  id: '[资料1]',
  artifact_id: retrievalIds.artifact,
  version_id: retrievalIds.version,
  chunk_id: retrievalIds.chunk,
  display_name: '合同.txt',
  version_number: 2,
  line_start: 3,
  line_end: 8,
  text: '交付日期为九月。',
  scope: 'project',
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function retrievalPayloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

type ArtifactMethod =
  | 'list'
  | 'detail'
  | 'createUpload'
  | 'createVersionUpload'
  | 'completeUpload'
  | 'retry'
  | 'preview'
  | 'download'

function invokeArtifactMethod(client: XAgentBackendClient, method: ArtifactMethod): Promise<unknown> {
  switch (method) {
    case 'list': return client.artifacts.list('token')
    case 'detail': return client.artifacts.detail('token', artifactIds.private)
    case 'createUpload':
      return client.artifacts.createUpload('token', { filename: 'file.txt', size: 1, idempotencyKey: 'create' })
    case 'createVersionUpload':
      return client.artifacts.createVersionUpload(
        'token', artifactIds.private, { filename: 'file.txt', size: 1, idempotencyKey: 'version' },
      )
    case 'completeUpload':
      return client.artifacts.completeUpload('token', artifactIds.upload, {
        size: 1, sha256: 'a'.repeat(64), idempotencyKey: 'complete',
      })
    case 'retry': return client.artifacts.retry('token', artifactIds.failedVersion, 'retry')
    case 'preview': return client.artifacts.preview('token', artifactIds.cleanVersion)
    case 'download': return client.artifacts.download('token', artifactIds.cleanVersion)
  }
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function snakeOperation(input: typeof retrievalOperation): Record<string, unknown> {
  return {
    session_id: input.sessionId,
    tool_call_id: input.toolCallId,
    permission_revision: input.permissionRevision,
  }
}

function snakeCitation(input: {
  id: string
  artifactId: string
  versionId: string
  chunkId: string
}): Record<string, unknown> {
  return {
    id: input.id,
    artifact_id: input.artifactId,
    version_id: input.versionId,
    chunk_id: input.chunkId,
  }
}

function retrievalClient(body: unknown, status = 200): XAgentBackendClient {
  return new XAgentBackendClient({
    origin: 'https://api.example.test',
    serviceToken: 'service-secret',
    fetch: async () => Response.json(body, { status }),
  })
}

describe('XAgent 后端客户端', () => {
  test('检索方法发送三重身份、闭合 wire body 并严格转换四类响应', async () => {
    const calls: Array<{ path: string; headers: Headers; body: unknown }> = []
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(requestUrl(input)).pathname
      calls.push({
        path,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
      })
      if (path.endsWith('/projects')) return Response.json({
        schema_version: 1,
        projects: [{ project_id: retrievalIds.project, name: 'Alpha' }],
        receipt: 'opaque-project-receipt',
        payload_sha256: retrievalPayloadHash({
          schema_version: 1,
          projects: [{ project_id: retrievalIds.project, name: 'Alpha' }],
        }),
      })
      if (path.endsWith('/search')) return Response.json({
        schema_version: 1, citations: [citationResponse],
        receipt: 'opaque-search-receipt',
        payload_sha256: retrievalPayloadHash({ schema_version: 1, citations: [citationResponse] }),
      })
      if (path.endsWith('/authorize')) return Response.json({ schema_version: 1, authorized: true })
      return Response.json({
        schema_version: 1,
        artifact_id: retrievalIds.artifact, version_id: retrievalIds.version,
        chunk_id: retrievalIds.chunk, line_start: 3, line_end: 8,
      })
    })
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test/base', serviceToken: 'service-secret', fetch: fetcher,
    })
    const identity = {
      id: '[资料1]', artifactId: retrievalIds.artifact,
      versionId: retrievalIds.version, chunkId: retrievalIds.chunk,
    }

    await expect(client.retrieval.projects('user-secret', 'delegation-projects', {
      ...retrievalOperation, query: 'Al',
    })).resolves.toEqual({
      projects: [{ projectId: retrievalIds.project, name: 'Alpha' }],
      receipt: 'opaque-project-receipt',
      payloadHash: retrievalPayloadHash({
        schema_version: 1,
        projects: [{ project_id: retrievalIds.project, name: 'Alpha' }],
      }),
    })
    await expect(client.retrieval.search('user-secret', 'delegation-search', {
      ...retrievalOperation, query: '交付日期',
      projectIds: [retrievalIds.project], includePrivate: true,
      scopeHash: retrievalScopeHashes.projectAndPrivate,
    })).resolves.toEqual({
      citations: [{
        id: '[资料1]', artifactId: retrievalIds.artifact, versionId: retrievalIds.version,
        chunkId: retrievalIds.chunk, displayName: '合同.txt', versionNumber: 2,
        lineStart: 3, lineEnd: 8, text: '交付日期为九月。', scope: 'project',
      }],
      receipt: 'opaque-search-receipt',
      payloadHash: retrievalPayloadHash({ schema_version: 1, citations: [citationResponse] }),
    })
    await expect(client.retrieval.authorizeCitations(
      'user-secret', 'delegation-authorize', { ...retrievalOperation, citations: [identity] },
    )).resolves.toBeUndefined()
    await expect(client.retrieval.resolveCitation(
      'user-secret', 'delegation-resolve', { ...retrievalOperation, citationId: identity.id },
    )).resolves.toEqual({ ...identity, lineStart: 3, lineEnd: 8 })

    expect(calls.map(call => call.path)).toEqual([
      '/internal/xagent/retrieval/projects', '/internal/xagent/retrieval/search',
      '/internal/xagent/retrieval/citations/authorize', '/internal/xagent/retrieval/citations/resolve',
    ])
    expect(calls.map(call => call.body)).toEqual([
      { schema_version: 1, ...snakeOperation(retrievalOperation), query: 'Al' },
      {
        schema_version: 1, ...snakeOperation(retrievalOperation), query: '交付日期',
        project_ids: [retrievalIds.project], include_private: true,
      },
      { schema_version: 1, ...snakeOperation(retrievalOperation), citations: [snakeCitation(identity)] },
      { schema_version: 1, ...snakeOperation(retrievalOperation), citation_id: identity.id },
    ])
    expect(calls.map(call => call.headers.get('x-xagent-delegation'))).toEqual([
      'delegation-projects', 'delegation-search', 'delegation-authorize', 'delegation-resolve',
    ])
    expect(calls.every(call => call.headers.get('authorization') === 'Bearer user-secret')).toBe(true)
    expect(calls.every(call => call.headers.get('x-xagent-service-token') === 'service-secret')).toBe(true)
  })

  test.each([
    [[alphaProjectId.toUpperCase()], [alphaProjectId]],
    [[alphaProjectId, alphaProjectId.toUpperCase()], [alphaProjectId]],
    [['00000000-0000-0000-0000-000000000503', retrievalIds.project], [
      retrievalIds.project, '00000000-0000-0000-0000-000000000503',
    ]],
  ])('个人检索拒绝不是精确 canonical UUID 数组的范围 %#', async (projectIds, canonicalIds) => {
    const fetcher = vi.fn(async () => Response.json({
      schema_version: 1, citations: [], receipt: 'opaque',
      payload_sha256: retrievalPayloadHash({ schema_version: 1, citations: [] }),
    }))
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: fetcher,
    })
    await expect(client.retrieval.search('user', 'delegation', {
      ...retrievalOperation,
      query: 'query',
      projectIds,
      includePrivate: false,
      scopeHash: retrievalPayloadHash({
        include_private: false, kind: 'private', project_ids: canonicalIds,
      }),
    })).rejects.toMatchObject({ code: 'service-unavailable' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  test.each([
    [[]],
    [Array.from({ length: 21 }, (_, index) =>
      `00000000-0000-0000-0000-${String(800 + index).padStart(12, '0')}`)],
  ])('个人检索在发送前拒绝空范围或超过 20 个 canonical 项目 %#', async (projectIds) => {
    const fetcher = vi.fn(async () => Response.json({
      schema_version: 1, citations: [], receipt: 'opaque',
      payload_sha256: retrievalPayloadHash({ schema_version: 1, citations: [] }),
    }))
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: fetcher,
    })
    await expect(client.retrieval.search('user', 'delegation', {
      ...retrievalOperation,
      query: 'query',
      projectIds,
      includePrivate: false,
      scopeHash: retrievalPayloadHash({ include_private: false, kind: 'private', project_ids: projectIds }),
    })).rejects.toMatchObject({ code: 'service-unavailable' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('引用解析在首个 await 前快照短引用 ID', async () => {
    let finish: ((response: Response) => void) | undefined
    let sentBody: unknown
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentBody = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
      return new Promise<Response>((resolve) => { finish = resolve })
    })
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: fetcher,
    })
    const input = { ...retrievalOperation, citationId: '[资料1]' }
    const result = client.retrieval.resolveCitation(
      'user', 'delegation', input,
    )
    input.citationId = '[资料2]'
    finish?.(Response.json({
      schema_version: 1,
      artifact_id: retrievalIds.artifact,
      version_id: retrievalIds.version,
      chunk_id: retrievalIds.chunk,
      line_start: 3,
      line_end: 8,
    }))

    await expect(result).resolves.toEqual({
      id: '[资料1]', artifactId: retrievalIds.artifact, versionId: retrievalIds.version,
      chunkId: retrievalIds.chunk, lineStart: 3, lineEnd: 8,
    })
    expect(sentBody).toEqual({
      schema_version: 1,
      ...snakeOperation(retrievalOperation),
      citation_id: '[资料1]',
    })
  })

  test('项目发现和资料搜索拒绝与已验证 payload 不一致的摘要', async () => {
    const projectPayload = {
      schema_version: 1,
      projects: [{ project_id: retrievalIds.project, name: 'Alpha' }],
    }
    const projectClient = retrievalClient({
      ...projectPayload,
      projects: [{ project_id: retrievalIds.project, name: 'Changed' }],
      receipt: 'opaque',
      payload_sha256: retrievalPayloadHash(projectPayload),
    })
    await expect(projectClient.retrieval.projects('user', 'delegation', retrievalOperation))
      .rejects.toMatchObject({ code: 'service-unavailable' })

    const searchPayload = { schema_version: 1, citations: [citationResponse] }
    const searchClient = retrievalClient({
      ...searchPayload,
      citations: [{ ...citationResponse, text: 'mutated' }],
      receipt: 'opaque',
      payload_sha256: retrievalPayloadHash(searchPayload),
    })
    await expect(searchClient.retrieval.search('user', 'delegation', {
      ...retrievalOperation, query: 'query', projectIds: [retrievalIds.project], includePrivate: false,
      scopeHash: retrievalScopeHashes.projectOnly,
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('所有方法把流式响应中的畸形 UTF-8 收敛为 service-unavailable', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([
          0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
        ]))
        controller.close()
      },
    })
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret',
      fetch: async () => new Response(stream),
    })
    await expect(client.sessions.list('user')).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [['[资料2]', '[资料1]']],
    [['[资料1]', '[资料3]']],
    [['[资料9007199254740992]']],
  ])('资料搜索拒绝非连续递增或不安全的引用 ordinal %#', async (ids) => {
    const citations = ids.map((id, index) => ({
      ...citationResponse,
      id,
      chunk_id: `00000000-0000-0000-0000-${String(700 + index).padStart(12, '0')}`,
    }))
    const payload = { schema_version: 1, citations }
    const client = retrievalClient({
      ...payload, receipt: 'opaque', payload_sha256: retrievalPayloadHash(payload),
    })
    await expect(client.retrieval.search('user', 'delegation', {
      ...retrievalOperation, query: 'query', projectIds: [retrievalIds.project], includePrivate: false,
      scopeHash: retrievalScopeHashes.projectOnly,
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each(['authorize', 'resolve'])('引用请求拒绝不安全的 ordinal：%s', async (method) => {
    const identity = {
      id: '[资料9007199254740992]', artifactId: retrievalIds.artifact,
      versionId: retrievalIds.version, chunkId: retrievalIds.chunk,
    }
    const fetcher = vi.fn(async () => Response.json({ schema_version: 1, authorized: true }))
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: fetcher,
    })
    const request = method === 'authorize'
      ? client.retrieval.authorizeCitations(
        'user', 'delegation', { ...retrievalOperation, citations: [identity] },
      )
      : client.retrieval.resolveCitation(
        'user', 'delegation', { ...retrievalOperation, citationId: identity.id },
      )
    await expect(request).rejects.toMatchObject({ code: 'service-unavailable' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('引用授权接受来自多个搜索调用的非连续安全 ordinal', async () => {
    const client = retrievalClient({ schema_version: 1, authorized: true })
    const identities = ['[资料1]', '[资料10]'].map((id, index) => ({
      id,
      artifactId: retrievalIds.artifact,
      versionId: retrievalIds.version,
      chunkId: `00000000-0000-0000-0000-${String(900 + index).padStart(12, '0')}`,
    }))
    await expect(client.retrieval.authorizeCitations(
      'user', 'delegation', { ...retrievalOperation, citations: identities },
    )).resolves.toBeUndefined()
  })

  test('引用授权接受终态答案允许的 64 个唯一引用', async () => {
    const client = retrievalClient({ schema_version: 1, authorized: true })
    const identities = Array.from({ length: 64 }, (_, index) => ({
      id: `[资料${index + 1}]`,
      artifactId: retrievalIds.artifact,
      versionId: retrievalIds.version,
      chunkId: `00000000-0000-0000-0000-${String(1_000 + index).padStart(12, '0')}`,
    }))

    await expect(client.retrieval.authorizeCitations(
      'user', 'delegation', { ...retrievalOperation, citations: identities },
    )).resolves.toBeUndefined()
  })

  test.each([
    [{ schema_version: 1, projects: [], receipt: 'r', payload_sha256: 'a'.repeat(64), extra: true }],
    [{ schema_version: 1, projects: [{ project_id: 'bad', name: 'Alpha' }], receipt: 'r', payload_sha256: 'a'.repeat(64) }],
    [{ schema_version: 1, projects: [], receipt: 'r', payload_sha256: 'A'.repeat(64) }],
    [{ schema_version: 1, projects: [], receipt: 'https://secret.example/token', payload_sha256: 'a'.repeat(64) }],
  ])('项目发现拒绝未知、畸形或敏感响应 %#', async (body) => {
    const client = retrievalClient(body)
    await expect(client.retrieval.projects('user', 'delegation', retrievalOperation))
      .rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [{ ...citationResponse, line_start: 0 }],
    [{ ...citationResponse, line_end: 2 }],
    [{ ...citationResponse, text: 'x'.repeat(32 * 1024 + 1) }],
    [{ ...citationResponse, object_key: 'secret' }],
    [{ ...citationResponse, id: '[资料0]' }],
  ])('资料搜索拒绝越界、敏感或畸形引用 %#', async (citation) => {
    const client = retrievalClient({
      schema_version: 1, citations: [citation], receipt: 'opaque', payload_sha256: 'a'.repeat(64),
    })
    await expect(client.retrieval.search('user', 'delegation', {
      ...retrievalOperation, query: 'query', projectIds: [retrievalIds.project], includePrivate: false,
      scopeHash: retrievalScopeHashes.projectOnly,
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('资料搜索与引用授权拒绝重复、超限和无效请求输入', async () => {
    const client = retrievalClient({ schema_version: 1, citations: [], receipt: 'opaque', payload_sha256: 'a'.repeat(64) })
    await expect(client.retrieval.search('user', 'delegation', {
      ...retrievalOperation, query: '', projectIds: [], includePrivate: false,
      scopeHash: 'f'.repeat(64),
    })).rejects.toMatchObject({ code: 'service-unavailable' })
    const identity = {
      id: '[资料1]', artifactId: retrievalIds.artifact,
      versionId: retrievalIds.version, chunkId: retrievalIds.chunk,
    }
    await expect(client.retrieval.authorizeCitations('user', 'delegation', {
      ...retrievalOperation, citations: [identity, identity],
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [{ schema_version: 2, projects: [], receipt: 'opaque', payload_sha256: 'a'.repeat(64) }],
    [{ schema_version: 1, projects: null, receipt: 'opaque', payload_sha256: 'a'.repeat(64) }],
    [{
      schema_version: 1,
      projects: Array.from({ length: 21 }, (_, index) => ({
        project_id: `00000000-0000-0000-0000-${String(900 + index).padStart(12, '0')}`,
        name: `Project ${index}`,
      })),
      receipt: 'opaque',
      payload_sha256: 'a'.repeat(64),
    }],
  ])('项目发现拒绝无效 envelope %#', async (body) => {
    await expect(retrievalClient(body).retrieval.projects('user', 'delegation', retrievalOperation))
      .rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('项目发现拒绝重复项目和非 opaque receipt', async () => {
    const duplicateProjects = [
      { project_id: retrievalIds.project, name: 'Alpha' },
      { project_id: retrievalIds.project, name: 'Again' },
    ]
    await expect(retrievalClient({
      schema_version: 1,
      projects: duplicateProjects,
      receipt: 'opaque',
      payload_sha256: retrievalPayloadHash({ schema_version: 1, projects: duplicateProjects }),
    }).retrieval.projects('user', 'delegation', retrievalOperation))
      .rejects.toMatchObject({ code: 'service-unavailable' })

    const projects: unknown[] = []
    await expect(retrievalClient({
      schema_version: 1,
      projects,
      receipt: 'https://secret.example/token',
      payload_sha256: retrievalPayloadHash({ schema_version: 1, projects }),
    }).retrieval.projects('user', 'delegation', retrievalOperation))
      .rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('项目发现摘要按键名排序而不依赖 wire 插入顺序', async () => {
    const project = { name: 'Alpha', project_id: retrievalIds.project }
    const projects = [project]
    await expect(retrievalClient({
      schema_version: 1,
      projects,
      receipt: 'opaque',
      payload_sha256: retrievalPayloadHash({ schema_version: 1, projects }),
    }).retrieval.projects('user', 'delegation', retrievalOperation))
      .resolves.toMatchObject({ projects: [{ projectId: retrievalIds.project, name: 'Alpha' }] })
  })

  test.each([
    [{ schema_version: 2, citations: [], receipt: 'opaque', payload_sha256: 'a'.repeat(64) }],
    [{ schema_version: 1, citations: null, receipt: 'opaque', payload_sha256: 'a'.repeat(64) }],
    [{
      schema_version: 1,
      citations: Array.from({ length: 9 }, (_, index) => ({
        ...citationResponse,
        id: `[资料${index + 1}]`,
        chunk_id: `00000000-0000-0000-0000-${String(800 + index).padStart(12, '0')}`,
      })),
      receipt: 'opaque',
      payload_sha256: 'a'.repeat(64),
    }],
  ])('资料搜索拒绝无效 envelope %#', async (body) => {
    await expect(retrievalClient(body).retrieval.search('user', 'delegation', {
      ...retrievalOperation,
      query: 'query',
      projectIds: [retrievalIds.project],
      includePrivate: false,
      scopeHash: retrievalScopeHashes.projectOnly,
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [[citationResponse, { ...citationResponse, chunk_id: '00000000-0000-0000-0000-000000000506' }]],
    [[citationResponse, { ...citationResponse, id: '[资料2]' }]],
  ])('资料搜索拒绝重复 citation 身份 %#', async (citations) => {
    const payload = { schema_version: 1, citations }
    await expect(retrievalClient({
      ...payload,
      receipt: 'opaque',
      payload_sha256: retrievalPayloadHash(payload),
    }).retrieval.search('user', 'delegation', {
      ...retrievalOperation,
      query: 'query',
      projectIds: [retrievalIds.project],
      includePrivate: false,
      scopeHash: retrievalScopeHashes.projectOnly,
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [{ ...citationResponse, id: 1 }],
    [{ ...citationResponse, text: 'x'.repeat(32 * 1024 + 1) }],
  ])('资料搜索拒绝非字符串引用 ID 或超过总响应上限的正文 %#', async (citation) => {
    const payload = { schema_version: 1, citations: [citation] }
    await expect(retrievalClient({
      ...payload,
      receipt: 'opaque',
      payload_sha256: retrievalPayloadHash(payload),
    }).retrieval.search('user', 'delegation', {
      ...retrievalOperation,
      query: 'query',
      projectIds: [retrievalIds.project],
      includePrivate: false,
      scopeHash: retrievalScopeHashes.projectOnly,
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [{ ...retrievalOperation, sessionId: 'bad' }],
    [{ ...retrievalOperation, toolCallId: '' }],
    [{ ...retrievalOperation, toolCallId: '界'.repeat(256) }],
    [{ ...retrievalOperation, permissionRevision: 1.5 }],
    [{ ...retrievalOperation, permissionRevision: 0 }],
  ])('检索调用拒绝无效操作身份 %#', async (operation) => {
    await expect(retrievalClient({}).retrieval.projects('user', 'delegation', operation))
      .rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('资料搜索拒绝非布尔私有范围和非数组项目范围', async () => {
    const client = retrievalClient({})
    await expect(client.retrieval.search('user', 'delegation', {
      ...retrievalOperation, query: 'query', projectIds: [], includePrivate: 1, scopeHash: 'a'.repeat(64),
    } as never)).rejects.toMatchObject({ code: 'service-unavailable' })
    await expect(client.retrieval.search('user', 'delegation', {
      ...retrievalOperation, query: 'query', projectIds: null, includePrivate: false, scopeHash: 'a'.repeat(64),
    } as never)).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('资料搜索支持无显式项目范围，并拒绝不配对的私有标志或摘要', async () => {
    const payload = { schema_version: 1, citations: [] }
    await expect(retrievalClient({
      ...payload,
      receipt: 'opaque',
      payload_sha256: retrievalPayloadHash(payload),
    }).retrieval.search('user', 'delegation', {
      ...retrievalOperation, query: 'query', includePrivate: false,
    })).resolves.toEqual({
      citations: [], receipt: 'opaque', payloadHash: retrievalPayloadHash(payload),
    })
    await expect(retrievalClient({}).retrieval.search('user', 'delegation', {
      ...retrievalOperation, query: 'query', includePrivate: true,
    } as never)).rejects.toMatchObject({ code: 'service-unavailable' })
    await expect(retrievalClient({}).retrieval.search('user', 'delegation', {
      ...retrievalOperation, query: 'query', includePrivate: false, scopeHash: 'a'.repeat(64),
    } as never)).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [{ id: '[资料1]', artifactId: 'bad', versionId: retrievalIds.version, chunkId: retrievalIds.chunk }],
    [{ id: '[资料1]', artifactId: retrievalIds.artifact, versionId: 'bad', chunkId: retrievalIds.chunk }],
    [{ id: '[资料1]', artifactId: retrievalIds.artifact, versionId: retrievalIds.version, chunkId: 'bad' }],
  ])('引用授权拒绝无效不可变身份 %#', async (citation) => {
    await expect(retrievalClient({}).retrieval.authorizeCitations('user', 'delegation', {
      ...retrievalOperation, citations: [citation],
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [null],
    [[]],
    [Array.from({ length: 9 }, (_, index) => ({
      id: `[资料${index + 1}]`,
      artifactId: retrievalIds.artifact,
      versionId: retrievalIds.version,
      chunkId: `00000000-0000-0000-0000-${String(700 + index).padStart(12, '0')}`,
    }))],
  ])('引用授权拒绝无效 citation 集合 %#', async (citations) => {
    await expect(retrievalClient({}).retrieval.authorizeCitations('user', 'delegation', {
      ...retrievalOperation, citations,
    } as never)).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [{ schema_version: 2, authorized: true }],
    [{ schema_version: 1, authorized: false }],
  ])('引用授权拒绝非肯定响应 %#', async (body) => {
    await expect(retrievalClient(body).retrieval.authorizeCitations('user', 'delegation', {
      ...retrievalOperation,
      citations: [{
        id: '[资料1]', artifactId: retrievalIds.artifact,
        versionId: retrievalIds.version, chunkId: retrievalIds.chunk,
      }],
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [{
      schema_version: 2,
      artifact_id: retrievalIds.artifact,
      version_id: retrievalIds.version,
      chunk_id: retrievalIds.chunk,
      line_start: 3,
      line_end: 8,
    }],
    [{
      schema_version: 1,
      artifact_id: retrievalIds.artifact,
      version_id: retrievalIds.version,
      chunk_id: retrievalIds.chunk,
      line_start: 8,
      line_end: 3,
    }],
  ])('引用解析拒绝无效版本或倒置行区间 %#', async (body) => {
    await expect(retrievalClient(body).retrieval.resolveCitation('user', 'delegation', {
      ...retrievalOperation, citationId: '[资料1]',
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('所有检索调用拒绝空委托令牌', async () => {
    await expect(retrievalClient({}).retrieval.projects('user', '', retrievalOperation))
      .rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('资料搜索按完整模型可见 citations JSON 执行 32 KiB 上限', async () => {
    const citations = Array.from({ length: 8 }, (_, index) => ({
      ...citationResponse,
      id: `[资料${index + 1}]`,
      chunk_id: `00000000-0000-0000-0000-${String(600 + index).padStart(12, '0')}`,
      text: '界'.repeat(1_500),
    }))
    const client = retrievalClient({
      schema_version: 1, citations, receipt: 'opaque', payload_sha256: 'a'.repeat(64),
    })
    await expect(client.retrieval.search('user', 'delegation', {
      ...retrievalOperation, query: 'query', projectIds: [retrievalIds.project], includePrivate: false,
      scopeHash: retrievalScopeHashes.projectOnly,
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [400, 'invalid-retrieval-scope'],
    [503, 'retrieval-unavailable'],
    [503, 'service-unavailable'],
  ])('检索端点接受精确状态与稳定错误 %s/%s', async (status, code) => {
    const client = retrievalClient({ detail: { code } }, status)
    await expect(client.retrieval.search('user', 'delegation', {
      ...retrievalOperation, query: 'query', projectIds: [retrievalIds.project], includePrivate: false,
      scopeHash: retrievalScopeHashes.projectOnly,
    })).rejects.toMatchObject({ code })
  })

  test.each([
    [409, 'evidence-expired'],
    [409, 'evidence-conflict'],
    [422, 'citation-invalid'],
    [400, 'retrieval-unavailable'],
  ])('检索端点把错误端点或状态组合收敛为 service-unavailable %s/%s', async (status, code) => {
    const client = retrievalClient({ detail: { code } }, status)
    await expect(client.retrieval.search('user', 'delegation', {
      ...retrievalOperation, query: 'query', projectIds: [retrievalIds.project], includePrivate: false,
      scopeHash: retrievalScopeHashes.projectOnly,
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('资料搜索在发送前拒绝与规范请求体不一致的本地 scope hash', async () => {
    const fetcher = vi.fn(async () => Response.json({
      schema_version: 1, citations: [], receipt: 'opaque', payload_sha256: 'a'.repeat(64),
    }))
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: fetcher,
    })
    await expect(client.retrieval.search('user', 'delegation', {
      ...retrievalOperation, query: 'query', projectIds: [retrievalIds.project],
      includePrivate: false, scopeHash: 'f'.repeat(64),
    })).rejects.toMatchObject({ code: 'service-unavailable' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('缺少 FastAPI origin 或 Host 服务身份时构造立即失败', () => {
    expect(() => new XAgentBackendClient({ origin: '', serviceToken: 'service-secret' }))
      .toThrow('invalid XAgent backend configuration')
    expect(() => new XAgentBackendClient({ origin: 'https://api.example.test', serviceToken: '' }))
      .toThrow('invalid XAgent backend configuration')
    expect(() => new XAgentBackendClient({ origin: 'file:///tmp/api', serviceToken: 'service-secret' }))
      .toThrow('invalid XAgent backend configuration')
  })

  test('公开登录不发送 Host 服务身份并严格解析令牌响应', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
      access_token: 'user-token',
      token_type: 'bearer',
      expires_at: '2026-08-25T08:00:00Z',
      csrf_token: 'csrf-token',
    }))
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: fetcher,
    })

    await expect(client.login('alice@example.test', 'password')).resolves.toEqual({
      accessToken: 'user-token',
      expiresAt: '2026-08-25T08:00:00Z',
      csrfToken: 'csrf-token',
    })
    const [url, init] = fetcher.mock.calls[0]!
    expect(requestUrl(url)).toBe('https://api.example.test/api/v1/auth/login')
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    expect(new Headers(init?.headers).has('x-xagent-service-token')).toBe(false)
  })

  test('固定 origin、内部路径、服务身份和用户 JWT', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(principal), { status: 200 }))
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test/base/path',
      serviceToken: 'service-secret',
      fetch: fetcher,
      connectionId: () => 'connection-1',
    })

    const result = await client.introspect('user-secret')

    expect(result.connectionId).toBe('connection-1')
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(requestUrl(url)).toBe('https://api.example.test/internal/xagent/auth/introspect')
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' })
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer user-secret')
    expect(new Headers(init?.headers).get('x-xagent-service-token')).toBe('service-secret')
  })

  test('非成功响应只暴露稳定错误码，不回显凭据或正文', async () => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => new Response(
        JSON.stringify({ detail: { code: 'not-found' }, leaked: 'user-secret' }),
        { status: 404 },
      ),
    })

    const rejected = await client.sessions.open('user-secret', crypto.randomUUID()).catch((error: unknown) => error)

    expect(rejected).toBeInstanceOf(XAgentBackendError)
    expect(rejected).toMatchObject({ code: 'not-found' })
    expect(String(rejected)).not.toContain('user-secret')
  })

  test('限制完整响应正文大小', async () => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      maxResponseBytes: 32,
      fetch: async () => new Response(JSON.stringify({ value: 'x'.repeat(64) })),
    })

    await expect(client.sessions.list('user-secret')).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('调用方取消会传到 fetch 且统一映射服务不可用', async () => {
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('request aborted', { cause: init.signal?.reason }))
      }, { once: true })
    }))
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: fetcher,
    })
    const controller = new AbortController()
    const pending = client.sessions.list('user-secret', controller.signal)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'service-unavailable' })
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true)
  })

  test('会话授权使用固定路径且接受空成功响应', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 204 }))
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: fetcher,
    })

    await expect(client.sessions.authorize('user-secret', 'session/unsafe', 'edit')).resolves.toBeUndefined()
    expect(requestUrl(fetcher.mock.calls[0]![0])).toBe(
      'https://api.example.test/internal/xagent/sessions/session%2Funsafe/authorize',
    )
  })

  test.each([
    [null],
    ['invalid'],
    [{ token_type: 'basic', access_token: 'token', expires_at: 'time', csrf_token: 'csrf' }],
    [{ token_type: 'bearer', access_token: 1, expires_at: 'time', csrf_token: 'csrf' }],
    [{ token_type: 'bearer', access_token: '', expires_at: 'time', csrf_token: 'csrf' }],
    [{ token_type: 'bearer', access_token: 'token', expires_at: 1, csrf_token: 'csrf' }],
    [{ token_type: 'bearer', access_token: 'token', expires_at: '', csrf_token: 'csrf' }],
    [{ token_type: 'bearer', access_token: 'token', expires_at: 'time', csrf_token: 1 }],
    [{ token_type: 'bearer', access_token: 'token', expires_at: 'time', csrf_token: '' }],
  ])('拒绝畸形登录响应 %#', async (value) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json(value),
    })
    await expect(client.login('alice@example.test', 'password')).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('拒绝畸形 Principal，并把底层网络异常统一为服务不可用', async () => {
    const invalid = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: async () => Response.json({}),
    })
    await expect(invalid.introspect('token')).rejects.toMatchObject({ code: 'service-unavailable' })

    const failed = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: async () => { throw new Error('secret') },
    })
    await expect(failed.sessions.list('token')).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('全部 Session 方法固定编码路径和请求正文', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const client = new XAgentBackendClient({
      origin: 'http://127.0.0.1:3000',
      serviceToken: 'service-secret',
      fetch: async (input, init) => {
        const path = new URL(requestUrl(input)).pathname
        calls.push({
          url: requestUrl(input),
          body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
        })
        return Response.json(path.endsWith('/append')
          ? { schema_version: 1, version: 2, last_event_sequence: -1 }
          : { ok: true })
      },
    })
    const id = 'id/unsafe'
    await client.sessions.list('token')
    await client.sessions.create('token', { schema_version: 1, runtime_header: {} })
    await client.sessions.open('token', id)
    await client.sessions.events('token', id, { schema_version: 1, after_seq: 2 })
    await client.sessions.append('token', id, {
      schema_version: 1,
      expected_sequence: -1,
      idempotency_key: 'append-1',
      events: [],
      retrieval_receipts: [{
        event_sequence: 0,
        tool_call_id: 'call-1',
        receipt: 'opaque-secret',
        payload_hash: 'a'.repeat(64),
      }],
    })
    await client.sessions.fork('token', id, { schema_version: 1, target_session_id: 'target' })
    await client.sessions.archive('token', id, { schema_version: 1 })
    await client.revoke('token')

    expect(calls.map(call => new URL(call.url).pathname)).toEqual([
      '/internal/xagent/sessions/list',
      '/internal/xagent/sessions',
      '/internal/xagent/sessions/id%2Funsafe/open',
      '/internal/xagent/sessions/id%2Funsafe/events',
      '/internal/xagent/sessions/id%2Funsafe/append',
      '/internal/xagent/sessions/id%2Funsafe/fork',
      '/internal/xagent/sessions/id%2Funsafe/archive',
      '/internal/xagent/auth/revoke',
    ])
    expect(calls[0]?.body).toEqual({ schema_version: 1 })
    expect(calls[4]?.body).toEqual({
      schema_version: 1,
      expected_sequence: -1,
      idempotency_key: 'append-1',
      events: [],
      retrieval_receipts: [{
        event_sequence: 0,
        tool_call_id: 'call-1',
        receipt: 'opaque-secret',
        payload_hash: 'a'.repeat(64),
      }],
    })
  })

  test.each([
    [409, { detail: { code: 'evidence-conflict' } }, 'evidence-conflict'],
    [410, { detail: { code: 'evidence-expired' } }, 'evidence-expired'],
  ] as const)('Session append 保留精确证据错误 %i %s', async (status, body, code) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json(body, { status }),
    })
    await expect(client.sessions.append('token', retrievalIds.session, {
      schema_version: 1,
      expected_sequence: -1,
      idempotency_key: 'append-error',
      events: [{ event_type: 'turn/start', schema_version: 1, payload: { seq: 0 } }],
      retrieval_receipts: [],
    })).rejects.toMatchObject({ code })
  })

  test.each([
    [409, { detail: { code: 'evidence-expired' } }],
    [410, { detail: { code: 'evidence-conflict' } }],
    [409, { detail: { code: 'unknown' } }],
    [409, { detail: { code: 'evidence-conflict', private: 'secret' } }],
    [409, { detail: { code: 'evidence-conflict' }, private: 'secret' }],
  ])('Session append 拒绝错误状态、未知字段和未知代码 %#', async (status, body) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json(body, { status }),
    })
    await expect(client.sessions.append('token', retrievalIds.session, {
      schema_version: 1,
      expected_sequence: -1,
      idempotency_key: 'append-invalid-error',
      events: [{ event_type: 'turn/start', schema_version: 1, payload: { seq: 0 } }],
      retrieval_receipts: [],
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    {},
    { schema_version: 1, version: 2, last_event_sequence: 0, retrieval_receipts: [] },
    { schema_version: 1, version: 0, last_event_sequence: 0 },
    { schema_version: 1, version: 2, last_event_sequence: 1 },
  ])('Session append 拒绝畸形或私有成功响应 %#', async (body) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json(body),
    })
    await expect(client.sessions.append('token', retrievalIds.session, {
      schema_version: 1,
      expected_sequence: -1,
      idempotency_key: 'append-invalid-success',
      events: [{ event_type: 'turn/start', schema_version: 1, payload: { seq: 0 } }],
      retrieval_receipts: [],
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('Session append 返回关闭且与事件范围一致的成功响应', async () => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json({ schema_version: 1, version: 2, last_event_sequence: 0 }),
    })
    await expect(client.sessions.append('token', retrievalIds.session, {
      schema_version: 1,
      expected_sequence: -1,
      idempotency_key: 'append-success',
      events: [{ event_type: 'turn/start', schema_version: 1, payload: { seq: 0 } }],
      retrieval_receipts: [],
    })).resolves.toEqual({ schema_version: 1, version: 2, last_event_sequence: 0 })
  })

  test('内部调用缺少用户令牌时失败关闭', async () => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: vi.fn(),
    })
    await expect(client.sessions.list(undefined as never)).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  test.each([
    [401, {}, 'unauthenticated'],
    [403, { detail: { code: 'forbidden' } }, 'forbidden'],
    [404, { detail: { code: 'session-not-found' } }, 'session-not-found'],
    [500, {}, 'service-unavailable'],
    [503, { detail: { code: 'service-unavailable' } }, 'service-unavailable'],
    [500, 'failure', 'service-unavailable'],
    [409, { detail: null }, 'service-unavailable'],
    [409, { detail: { code: 1 } }, 'service-unavailable'],
    [409, { detail: { code: 'sequence-conflict' } }, 'sequence-conflict'],
    [409, { detail: { code: 'idempotency-conflict' } }, 'idempotency-conflict'],
    [400, { detail: { code: 'unsupported-version' } }, 'unsupported-version'],
  ])('规范化后端错误 %#', async (status, body, code) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => new Response(JSON.stringify(body), { status }),
    })
    await expect(client.sessions.list('token')).rejects.toMatchObject({ code })
  })

  test('拒绝空白或非 JSON 成功响应，并能拼接多段响应流', async () => {
    const invalid = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: async () => new Response('not-json'),
    })
    await expect(invalid.sessions.list('token')).rejects.toMatchObject({ code: 'service-unavailable' })

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"sessions":'))
        controller.enqueue(new TextEncoder().encode('[]}'))
        controller.close()
      },
    })
    const streamed = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: async () => new Response(stream),
    })
    await expect(streamed.sessions.list('token')).resolves.toEqual({ sessions: [] })
  })

  test('默认使用平台 fetch 和随机物理连接标识', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(principal))
    try {
      const client = new XAgentBackendClient({ origin: 'https://api.example.test', serviceToken: 'service-secret' })
      const result = await client.introspect('token')
      expect(result.connectionId).toMatch(/^[0-9a-f-]{36}$/)
      expect(fetcher).toHaveBeenCalledOnce()
    } finally {
      fetcher.mockRestore()
    }
  })

  test('工作台方法只调用固定 POST 路径并严格转换协议字段', async () => {
    const calls: Array<{ path: string; body: unknown; headers: Headers; redirect: RequestRedirect | undefined }> = []
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(requestUrl(input)).pathname
      calls.push({
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
        headers: new Headers(init?.headers),
        redirect: init?.redirect,
      })
      if (path === '/internal/xagent/workbench/bootstrap') return Response.json(bootstrapResponse)
      if (path === '/internal/xagent/workbench/context') {
        return Response.json({
          schema_version: 1,
          account_id: bootstrapResponse.account.id,
          context: { kind: 'workbench', project_id: null },
        })
      }
      if (path === '/internal/xagent/projects') {
        return Response.json({
          schema_version: 1,
          account_id: bootstrapResponse.account.id,
          project: projectResponse.project,
          context: { kind: 'project', project_id: projectResponse.project.id },
        }, { status: 201 })
      }
      if (path.startsWith('/internal/xagent/projects/')) return Response.json(projectResponse)
      if (path === '/internal/xagent/session-project-refs') return new Response(null, { status: 204 })
      return new Response(null, { status: 500 })
    })
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test/base',
      serviceToken: 'service-secret',
      fetch: fetcher,
    })

    const bootstrapped = await client.workbench.bootstrap('user-secret')
    const selected = await client.workbench.selectContext(
      'user-secret',
      { kind: 'workbench' },
    )
    const created = await client.workbench.createProject(
      'user-secret',
      { name: 'Alpha', idempotencyKey: 'create-1' },
    )
    const detail = await client.workbench.project(
      'user-secret',
      'project/unsafe',
    )
    await client.workbench.addSessionProjectRefs('user-secret', {
      sessionId: '00000000-0000-0000-0000-000000000301',
      projectIds: ['00000000-0000-0000-0000-000000000201'],
      idempotencyKey: 'refs-1',
    })

    expect(bootstrapped).toEqual({
      account: {
        id: bootstrapResponse.account.id,
        email: 'alice@example.test',
        role: 'specialist',
        permissionRevision: 3,
      },
      capabilities: ['project.create'],
      context: { kind: 'workbench' },
      projects: [{
        id: projectResponse.project.id,
        name: 'Alpha',
        createdAt: '2026-08-25T08:00:00+00:00',
      }],
      sessionScopes: [
        {
          sessionId: '00000000-0000-0000-0000-000000000301',
          visibility: 'private',
        },
        {
          sessionId: '00000000-0000-0000-0000-000000000302',
          visibility: 'project',
          projectId: '00000000-0000-0000-0000-000000000201',
        },
      ],
      sessionSummary: {
        privateCount: 2,
        projectCounts: { [projectResponse.project.id]: 4 },
      },
    })
    expect(selected).toEqual(bootstrapped)
    expect(created).toEqual(bootstrapped)
    expect(detail).toEqual({
      accountId: bootstrapResponse.account.id,
      id: projectResponse.project.id,
      name: 'Alpha',
      createdAt: '2026-08-25T08:00:00+00:00',
      canEdit: true,
      sessionCount: 4,
    })
    expect(calls.map(call => call.path)).toEqual([
      '/internal/xagent/workbench/bootstrap',
      '/internal/xagent/workbench/context',
      '/internal/xagent/workbench/bootstrap',
      '/internal/xagent/projects',
      '/internal/xagent/workbench/bootstrap',
      '/internal/xagent/projects/project%2Funsafe',
      '/internal/xagent/session-project-refs',
    ])
    expect(calls.map(call => call.body)).toEqual([
      { schema_version: 1 },
      { schema_version: 1, kind: 'workbench', project_id: null },
      { schema_version: 1 },
      { schema_version: 1, name: 'Alpha', idempotency_key: 'create-1' },
      { schema_version: 1 },
      { schema_version: 1 },
      {
        schema_version: 1,
        session_id: '00000000-0000-0000-0000-000000000301',
        project_ids: ['00000000-0000-0000-0000-000000000201'],
        idempotency_key: 'refs-1',
      },
    ])
    expect(calls.every(call => call.headers.get('authorization') === 'Bearer user-secret')).toBe(true)
    expect(calls.every(call => call.headers.get('x-xagent-service-token') === 'service-secret')).toBe(true)
    expect(calls.every(call => call.redirect === 'manual')).toBe(true)
  })

  test.each([
    [null],
    [{ ...bootstrapResponse, schema_version: 2 }],
    [{ ...bootstrapResponse, extra: true }],
    [{ ...bootstrapResponse, account: { ...bootstrapResponse.account, permission_revision: 0 } }],
    [{ ...bootstrapResponse, capabilities: null }],
    [{ ...bootstrapResponse, capabilities: ['project.delete'] }],
    [{ ...bootstrapResponse, capabilities: ['project.create', 'project.create'] }],
    [{ ...bootstrapResponse, context: { kind: 'project', project_id: null } }],
    [{ ...bootstrapResponse, context: { kind: 'shared', project_id: null } }],
    [{ ...bootstrapResponse, projects: null }],
    [{ ...bootstrapResponse, projects: [{ ...bootstrapResponse.projects[0], created_at: 'not-a-date' }] }],
    [{ ...bootstrapResponse, session_scopes: null }],
    [{ ...bootstrapResponse, session_scopes: [{ session_id: 'bad', visibility: 'private', project_id: null }] }],
    [{ ...bootstrapResponse, session_scopes: [{ session_id: '00000000-0000-0000-0000-000000000301', visibility: 'project', project_id: null }] }],
    [{ ...bootstrapResponse, session_scopes: [{ session_id: '00000000-0000-0000-0000-000000000301', visibility: 'shared', project_id: null }] }],
    [{ ...bootstrapResponse, session_scopes: [...bootstrapResponse.session_scopes, { session_id: '00000000-0000-0000-0000-000000000301', visibility: 'private', project_id: null }] }],
    [{ ...bootstrapResponse, session_scopes: [{ session_id: '00000000-0000-0000-0000-000000000301', visibility: 'project', project_id: '00000000-0000-0000-0000-000000000999' }] }],
    [{ ...bootstrapResponse, session_summary: { private_count: -1, project_counts: {} } }],
    [{ ...bootstrapResponse, session_summary: { private_count: 0, project_counts: {} } }],
    [{ ...bootstrapResponse, projects: [...bootstrapResponse.projects, bootstrapResponse.projects[0]] }],
  ])('拒绝畸形工作台 Bootstrap %#', async (value) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json(value),
    })

    await expect(client.workbench.bootstrap('token')).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [null],
    [{ ...projectResponse, schema_version: 2 }],
    [{ ...projectResponse, account_id: '' }],
    [{ ...projectResponse, project: { ...projectResponse.project, name: '' } }],
    [{ ...projectResponse, access: { can_edit: 'yes' } }],
    [{ ...projectResponse, session_summary: { session_count: -1 } }],
  ])('拒绝畸形项目详情 %#', async (value) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json(value),
    })

    await expect(client.workbench.project('token', 'project-id')).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('拒绝畸形操作响应和跨账号 Bootstrap', async () => {
    const malformedCreate = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json({
        schema_version: 1,
        account_id: bootstrapResponse.account.id,
        project: projectResponse.project,
        context: { kind: 'project', project_id: projectResponse.project.id },
        owner_id: bootstrapResponse.account.id,
      }),
    })
    await expect(malformedCreate.workbench.createProject('token', {
      name: 'Alpha',
      idempotencyKey: 'create-1',
    })).rejects.toMatchObject({ code: 'service-unavailable' })

    const responses = [
      Response.json({
        schema_version: 1,
        account_id: bootstrapResponse.account.id,
        context: { kind: 'workbench', project_id: null },
      }),
      Response.json({
        ...bootstrapResponse,
        account: {
          ...bootstrapResponse.account,
          id: '00000000-0000-0000-0000-000000000002',
        },
      }),
    ]
    const crossed = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => responses.shift()!,
    })
    await expect(crossed.workbench.selectContext('token', { kind: 'workbench' }))
      .rejects.toMatchObject({ code: 'service-unavailable' })

    const nonemptyRefs = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json({ ok: true }),
    })
    await expect(nonemptyRefs.workbench.addSessionProjectRefs('token', {
      sessionId: '00000000-0000-0000-0000-000000000301',
      projectIds: ['00000000-0000-0000-0000-000000000201'],
      idempotencyKey: 'refs-1',
    })).rejects.toMatchObject({ code: 'service-unavailable' })

    for (const value of [
      {
        schema_version: 2,
        account_id: bootstrapResponse.account.id,
        context: { kind: 'workbench', project_id: null },
      },
      {
        schema_version: 2,
        account_id: bootstrapResponse.account.id,
        project: projectResponse.project,
        context: { kind: 'project', project_id: projectResponse.project.id },
      },
      {
        schema_version: 1,
        account_id: bootstrapResponse.account.id,
        project: projectResponse.project,
        context: { kind: 'workbench', project_id: null },
      },
    ]) {
      const invalid = new XAgentBackendClient({
        origin: 'https://api.example.test',
        serviceToken: 'service-secret',
        fetch: async () => Response.json(value),
      })
      const operation = Object.hasOwn(value, 'project')
        ? invalid.workbench.createProject('token', { name: 'Alpha', idempotencyKey: 'create-1' })
        : invalid.workbench.selectContext('token', { kind: 'workbench' })
      await expect(operation).rejects.toMatchObject({ code: 'service-unavailable' })
    }

    const crossedCreateResponses = [
      Response.json({
        schema_version: 1,
        account_id: bootstrapResponse.account.id,
        project: projectResponse.project,
        context: { kind: 'project', project_id: projectResponse.project.id },
      }),
      Response.json({
        ...bootstrapResponse,
        account: { ...bootstrapResponse.account, id: '00000000-0000-0000-0000-000000000002' },
      }),
    ]
    const crossedCreate = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => crossedCreateResponses.shift()!,
    })
    await expect(crossedCreate.workbench.createProject('token', {
      name: 'Alpha', idempotencyKey: 'create-1',
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('工作台请求体超限、超时和重定向全部失败关闭', async () => {
    const notCalled = vi.fn()
    const oversized = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      maxRequestBytes: 32,
      fetch: notCalled,
    })
    await expect(oversized.workbench.createProject('token', {
      name: 'x'.repeat(64),
      idempotencyKey: 'key',
    })).rejects.toMatchObject({ code: 'service-unavailable' })
    expect(notCalled).not.toHaveBeenCalled()

    const timedOut = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      timeoutMs: 1,
      fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('request timed out'))
        }, { once: true })
      }),
    })
    await expect(timedOut.workbench.bootstrap('token')).rejects.toMatchObject({ code: 'service-unavailable' })

    const redirected = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
    })
    await expect(redirected.workbench.bootstrap('token')).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('Artifact 方法使用 Task 5 的固定 POST 请求并转换 snake_case 响应', async () => {
    const calls: Array<{
      path: string
      body: unknown
      headers: Headers
      signal: AbortSignal | null | undefined
      redirect: RequestRedirect | undefined
    }> = []
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(requestUrl(input)).pathname
      calls.push({
        path,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
        headers: new Headers(init?.headers),
        signal: init?.signal,
        redirect: init?.redirect,
      })
      if (path.endsWith('/uploads') && !path.includes(`/artifacts/${artifactIds.private}`)) {
        return Response.json(artifactUploadResponse, { status: 201 })
      }
      if (path.endsWith('/uploads')) return Response.json(artifactUploadResponse, { status: 201 })
      if (path.endsWith('/complete')) return Response.json(artifactDetailResponse, { status: 201 })
      if (path.endsWith('/retry')) return Response.json(artifactDetailResponse)
      if (path.endsWith('/preview')) return Response.json({ url: '/api/v1/xagent/artifact-content/opaque?signature=preview' })
      if (path.endsWith('/download')) {
        return Response.json({ url: 'https://api.example.test/api/v1/xagent/artifact-content/opaque?signature=download' })
      }
      if (path.endsWith('/list')) return Response.json([privateArtifactSummary, projectArtifactSummary])
      return Response.json(artifactDetailResponse)
    })
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test/base',
      serviceToken: 'service-secret',
      fetch: fetcher,
    })
    const controllers = Array.from({ length: 8 }, () => new AbortController())

    await expect(client.artifacts.list('user-secret', controllers[0]!.signal)).resolves.toEqual([
      {
        id: artifactIds.private,
        displayName: '合同.txt',
        scope: { kind: 'private' },
        latestVersion: 2,
        latestStatus: 'failed',
        latestCleanVersion: 1,
      },
      {
        id: artifactIds.project,
        displayName: '项目说明.pdf',
        scope: { kind: 'project', projectId: projectResponse.project.id },
        latestVersion: 1,
        latestStatus: 'pending',
      },
    ])
    await expect(client.artifacts.detail('user-secret', artifactIds.private, controllers[1]!.signal))
      .resolves.toEqual({
        id: artifactIds.private,
        displayName: '合同.txt',
        scope: { kind: 'private' },
        latestVersion: 2,
        latestStatus: 'failed',
        latestCleanVersion: 1,
        canEdit: true,
        versions: [
          {
            id: artifactIds.failedVersion,
            version: 2,
            originalFilename: '合同-修订.txt',
            uploadedBy: artifactIds.uploader,
            size: 12,
            contentType: 'text/plain',
            status: 'failed',
            createdAt: '2026-08-25T09:00:00+00:00',
          },
          {
            id: artifactIds.cleanVersion,
            version: 1,
            originalFilename: '合同.txt',
            uploadedBy: artifactIds.uploader,
            size: 10,
            contentType: 'text/plain',
            sha256: 'a'.repeat(64),
            status: 'clean',
            createdAt: '2026-08-25T08:00:00Z',
          },
        ],
      })
    await expect(client.artifacts.createUpload('user-secret', {
      filename: '合同.txt', size: 10, idempotencyKey: 'create-1',
    }, controllers[2]!.signal)).resolves.toEqual({
      id: artifactIds.upload,
      putUrl: artifactUploadResponse.put_url,
      expiresAt: artifactUploadResponse.expires_at,
    })
    await expect(client.artifacts.createVersionUpload('user-secret', artifactIds.private, {
      filename: '合同-修订.txt', size: 12, idempotencyKey: 'version-1',
    }, controllers[3]!.signal)).resolves.toEqual({
      id: artifactIds.upload,
      putUrl: artifactUploadResponse.put_url,
      expiresAt: artifactUploadResponse.expires_at,
    })
    await expect(client.artifacts.completeUpload('user-secret', artifactIds.upload, {
      size: 12, sha256: 'b'.repeat(64), idempotencyKey: 'complete-1',
    }, controllers[4]!.signal)).resolves.toMatchObject({ id: artifactIds.private, latestVersion: 2 })
    await expect(client.artifacts.retry(
      'user-secret', artifactIds.failedVersion, 'retry-1', controllers[5]!.signal,
    )).resolves.toEqual(await client.artifacts.detail('user-secret', artifactIds.private))
    await expect(client.artifacts.preview('user-secret', artifactIds.cleanVersion, controllers[6]!.signal))
      .resolves.toEqual({ url: '/api/v1/xagent/artifact-content/opaque?signature=preview' })
    await expect(client.artifacts.download('user-secret', artifactIds.cleanVersion, controllers[7]!.signal))
      .resolves.toEqual({
        url: 'https://api.example.test/api/v1/xagent/artifact-content/opaque?signature=download',
      })

    expect(calls.map(call => call.path)).toEqual([
      '/internal/xagent/artifacts/list',
      `/internal/xagent/artifacts/${artifactIds.private}`,
      '/internal/xagent/artifacts/uploads',
      `/internal/xagent/artifacts/${artifactIds.private}/uploads`,
      `/internal/xagent/artifacts/uploads/${artifactIds.upload}/complete`,
      `/internal/xagent/artifact-versions/${artifactIds.failedVersion}/retry`,
      `/internal/xagent/artifacts/${artifactIds.private}`,
      `/internal/xagent/artifact-versions/${artifactIds.cleanVersion}/preview`,
      `/internal/xagent/artifact-versions/${artifactIds.cleanVersion}/download`,
    ])
    expect(calls.map(call => call.body)).toEqual([
      {},
      {},
      { filename: '合同.txt', size: 10, idempotency_key: 'create-1' },
      { filename: '合同-修订.txt', size: 12, idempotency_key: 'version-1' },
      { actual_size: 12, sha256: 'b'.repeat(64), idempotency_key: 'complete-1' },
      { idempotency_key: 'retry-1' },
      {},
      {},
      {},
    ])
    expect(calls.every(call => call.headers.get('authorization') === 'Bearer user-secret')).toBe(true)
    expect(calls.every(call => call.headers.get('x-xagent-service-token') === 'service-secret')).toBe(true)
    expect(calls.every(call => !call.headers.has('idempotency-key'))).toBe(true)
    expect(calls.every(call => call.redirect === 'manual')).toBe(true)
    expect(calls.slice(0, 6).every((call, index) => call.signal !== controllers[index]?.signal
      && call.signal?.aborted === false)).toBe(true)
    expect(calls[7]?.signal?.aborted).toBe(false)
    expect(calls[8]?.signal?.aborted).toBe(false)
  })

  test.each([
    [null],
    [{ ...privateArtifactSummary, extra: true }],
    [(({ display_name: _removed, ...value }) => value)(privateArtifactSummary)],
    [{ ...privateArtifactSummary, id: 'bad' }],
    [{ ...privateArtifactSummary, display_name: '' }],
    [{ ...privateArtifactSummary, display_name: 'x'.repeat(256) }],
    [{ ...privateArtifactSummary, latest_version: 0 }],
    [{ ...privateArtifactSummary, latest_version: 1.5 }],
    [{ ...privateArtifactSummary, latest_status: 'ready' }],
    [{ ...privateArtifactSummary, latest_clean_version: 3 }],
    [(({ latest_clean_version: _removed, ...value }) => ({ ...value, latest_status: 'clean' }))(privateArtifactSummary)],
    [{ ...privateArtifactSummary, latest_status: 'clean', latest_clean_version: 1 }],
    [{ ...privateArtifactSummary, latest_clean_version: 2 }],
    [{ ...privateArtifactSummary, scope: { kind: 'private', project_id: projectResponse.project.id } }],
    [{ ...privateArtifactSummary, scope: { kind: 'shared' } }],
    [{ ...privateArtifactSummary, scope: { kind: 'project' } }],
    [{ ...privateArtifactSummary, scope: { kind: 'project', project_id: 'bad' } }],
  ])('拒绝畸形 Artifact 摘要 %#', async (value) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json([value]),
    })
    await expect(client.artifacts.list('token')).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    ['list', 201, [privateArtifactSummary], (client: XAgentBackendClient) => client.artifacts.list('token')],
    ['detail', 201, artifactDetailResponse, (client: XAgentBackendClient) =>
      client.artifacts.detail('token', artifactIds.private)],
    ['createUpload', 200, artifactUploadResponse, (client: XAgentBackendClient) =>
      client.artifacts.createUpload('token', { filename: 'file.txt', size: 1, idempotencyKey: 'create' })],
    ['createVersionUpload', 200, artifactUploadResponse, (client: XAgentBackendClient) =>
      client.artifacts.createVersionUpload(
        'token', artifactIds.private, { filename: 'file.txt', size: 1, idempotencyKey: 'version' },
      )],
    ['completeUpload', 200, artifactDetailResponse, (client: XAgentBackendClient) =>
      client.artifacts.completeUpload('token', artifactIds.upload, {
        size: 1, sha256: 'a'.repeat(64), idempotencyKey: 'complete',
      })],
    ['retry', 201, artifactDetailResponse, (client: XAgentBackendClient) =>
      client.artifacts.retry('token', artifactIds.failedVersion, 'retry')],
    ['preview', 201, { url: '/api/v1/xagent/artifact-content/opaque?signature=preview' },
      (client: XAgentBackendClient) => client.artifacts.preview('token', artifactIds.cleanVersion)],
    ['download', 206, { url: '/api/v1/xagent/artifact-content/opaque?signature=download' },
      (client: XAgentBackendClient) => client.artifacts.download('token', artifactIds.cleanVersion)],
  ] as const)('Artifact %s 拒绝错误的 2xx 成功状态', async (_method, status, body, invoke) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json(body, { status }),
    })
    await expect(invoke(client)).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('拒绝非数组、重复资料和超限 Artifact 列表', async () => {
    for (const value of [
      { items: [] },
      [privateArtifactSummary, privateArtifactSummary],
      Array.from({ length: 1_001 }, (_unused, index) => ({
        ...privateArtifactSummary,
        id: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
      })),
    ]) {
      const client = new XAgentBackendClient({
        origin: 'https://api.example.test',
        serviceToken: 'service-secret',
        fetch: async () => Response.json(value),
      })
      await expect(client.artifacts.list('token')).rejects.toMatchObject({ code: 'service-unavailable' })
    }
  })

  test.each([
    [{ ...artifactUploadResponse, extra: true }],
    [(({ expires_at: _removed, ...value }) => value)(artifactUploadResponse)],
    [{ ...artifactUploadResponse, upload_id: 'bad' }],
    [{ ...artifactUploadResponse, put_url: 'javascript:alert(1)' }],
    [{ ...artifactUploadResponse, put_url: 'https://user:pass@storage.example.test/put' }],
    [{ ...artifactUploadResponse, expires_at: 'tomorrow' }],
    [{ ...artifactUploadResponse, expires_at: '2026-08-25' }],
    [{ ...artifactUploadResponse, expires_at: '2026-02-30T08:10:00Z' }],
    [{ ...artifactUploadResponse, put_url: 'https://storage.example.test/a b' }],
  ])('拒绝畸形上传授权 %#', async (value) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json(value, { status: 201 }),
    })
    await expect(client.artifacts.createUpload('token', {
      filename: 'file.txt', size: 1, idempotencyKey: 'create',
    })).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [{ ...artifactDetailResponse, extra: true }],
    [(({ can_edit: _removed, ...value }) => value)(artifactDetailResponse)],
    [{ ...artifactDetailResponse, can_edit: 'yes' }],
    [{ ...artifactDetailResponse, versions: null }],
    [{ ...artifactDetailResponse, versions: [] }],
    [{ ...artifactDetailResponse, versions: [artifactDetailResponse.versions[1], artifactDetailResponse.versions[0]] }],
    [{ ...artifactDetailResponse, versions: [artifactDetailResponse.versions[0], artifactDetailResponse.versions[0]] }],
    [{
      ...artifactDetailResponse,
      versions: [
        artifactDetailResponse.versions[0],
        { ...artifactDetailResponse.versions[1]!, id: artifactDetailResponse.versions[0]!.id },
      ],
    }],
    [{ ...artifactDetailResponse, latest_version: 1 }],
    [{ ...artifactDetailResponse, latest_status: 'quarantined' }],
    [{ ...artifactDetailResponse, latest_status: 'clean' }],
    [{ ...artifactDetailResponse, latest_clean_version: 2 }],
    [(({ latest_clean_version: _removed, ...value }) => value)(artifactDetailResponse)],
    [{
      ...artifactDetailResponse,
      versions: artifactDetailResponse.versions.map(version => ({ ...version, status: 'failed' })),
    }],
    [{ ...artifactDetailResponse, versions: Array.from({ length: 1_001 }, () => artifactDetailResponse.versions[0]) }],
  ])('拒绝不一致或超限 Artifact Detail %#', async (value) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json(value),
    })
    await expect(client.artifacts.detail('token', artifactIds.private))
      .rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('接受 Artifact Version 省略可选正文元数据', async () => {
    const { size: _size, content_type: _contentType, ...latest } = artifactDetailResponse.versions[0]!
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json({
        ...artifactDetailResponse,
        versions: [latest, artifactDetailResponse.versions[1]],
      }),
    })

    const detail = await client.artifacts.detail('token', artifactIds.private)
    expect(detail.versions).toMatchObject([{ version: 2 }, { version: 1 }])
    expect(detail.versions[0]).not.toHaveProperty('size')
    expect(detail.versions[0]).not.toHaveProperty('contentType')
  })

  test.each([
    [(({ original_filename: _removed, ...value }) => value)(artifactDetailResponse.versions[0]!)],
    [{ ...artifactDetailResponse.versions[0], id: 'bad' }],
    [{ ...artifactDetailResponse.versions[0], version: 0 }],
    [{ ...artifactDetailResponse.versions[0], original_filename: 'x'.repeat(256) }],
    [{ ...artifactDetailResponse.versions[0], uploaded_by: 'bad' }],
    [{ ...artifactDetailResponse.versions[0], size: -1 }],
    [{ ...artifactDetailResponse.versions[0], size: 50 * 1024 * 1024 + 1 }],
    [{ ...artifactDetailResponse.versions[0], size: 1.5 }],
    [{ ...artifactDetailResponse.versions[0], content_type: '' }],
    [{ ...artifactDetailResponse.versions[0], sha256: 'A'.repeat(64) }],
    [{ ...artifactDetailResponse.versions[0], status: 'ready' }],
    [{ ...artifactDetailResponse.versions[0], created_at: 'not-a-date' }],
  ])('拒绝畸形 Artifact Version %#', async (version) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json({ ...artifactDetailResponse, versions: [
        version,
        artifactDetailResponse.versions[1],
      ] }),
    })
    await expect(client.artifacts.detail('token', artifactIds.private))
      .rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each(['object_key', 'staging_key', 'lease_token', 'failure_code', 'raw_scan_output'])(
    '拒绝非 clean 版本携带内部字段 %s',
    async (field) => {
      const client = new XAgentBackendClient({
        origin: 'https://api.example.test',
        serviceToken: 'service-secret',
        fetch: async () => Response.json({
          ...artifactDetailResponse,
          versions: [
            { ...artifactDetailResponse.versions[0], [field]: 'internal-secret' },
            artifactDetailResponse.versions[1],
          ],
        }),
      })
      await expect(client.artifacts.detail('token', artifactIds.private))
        .rejects.toMatchObject({ code: 'service-unavailable' })
    },
  )

  test('complete 与 retry 都必须返回完整 Detail', async () => {
    for (const [method, body] of [
      ['complete', { ...privateArtifactSummary, can_edit: true, versions: [] }],
      ['retry', privateArtifactSummary],
    ] as const) {
      const client = new XAgentBackendClient({
        origin: 'https://api.example.test',
        serviceToken: 'service-secret',
        fetch: async () => Response.json(body, { status: method === 'complete' ? 201 : 200 }),
      })
      const operation = method === 'complete'
        ? client.artifacts.completeUpload('token', artifactIds.upload, {
          size: 1, sha256: 'a'.repeat(64), idempotencyKey: 'complete',
        })
        : client.artifacts.retry('token', artifactIds.failedVersion, 'retry')
      await expect(operation).rejects.toMatchObject({ code: 'service-unavailable' })
    }
  })

  test.each([
    ['/api/v1/xagent/artifact-content/opaque?expires=1&signature=abc'],
    ['https://api.example.test/api/v1/xagent/artifact-content/opaque?expires=1&signature=abc'],
    ['/api/v1/xagent/artifact-content/合同?name=合同&signature=a%2Bb%2Fc%3D'],
    ['/content?ratio=100%25'],
    ['/content?signature=合同%25'],
    ['/content?signature=100%25valid&name=%25E5%2590%2588'],
    ['/content?name=%25E5%2590%2588&signature=100%25valid'],
    [`/content?signature=%${'25'.repeat(15)}41`],
    ['https://notxagent-private.storage.example.test/opaque'],
    ['/prefixxagent-private/content?name=notxagent-privatevalue'],
  ])('接受相对或绝对 opaque 读取 URL 且不读取其正文 %#', async (url) => {
    const fetcher = vi.fn(async () => Response.json({ url }))
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: fetcher,
    })
    await expect(client.artifacts.preview('token', artifactIds.cleanVersion)).resolves.toEqual({ url })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  test.each([
    ['content'],
    [{ url: '/content', extra: true }],
    [{ url: 'relative/content' }],
    [{ url: '//evil.example.test/content' }],
    [{ url: 'javascript:alert(1)' }],
    [{ url: 'http://[' }],
    [{ url: 'https://user:pass@api.example.test/content' }],
    [{ url: 'https://api.example.test/artifacts/00000000-0000-0000-0000-000000000401/00000000-0000-0000-0000-000000000412' }],
    [{ url: '/%61rtifacts%2F00000000-0000-0000-0000-000000000401%2F00000000-0000-0000-0000-000000000412' }],
    [{ url: '/artifacts%25252F00000000-0000-0000-0000-000000000401%25252F00000000-0000-0000-0000-000000000412' }],
    [{ url: '/%61rtifacts%2525252f00000000-0000-0000-0000-000000000401%2525252F00000000-0000-0000-0000-000000000412' }],
    [{ url: `/artifacts%${'25'.repeat(16)}2F00000000-0000-0000-0000-000000000401/opaque` }],
    [{ url: `/content?signature=%${'25'.repeat(17)}41` }],
    [{ url: `/content?signature=${'x'.repeat(16_384)}` }],
    [{ url: '/api/%0a/content' }],
    [{ url: '/api/%00/content' }],
    [{ url: '/api/%5C/content' }],
    [{ url: '/api/%20/content' }],
    [{ url: '/api/%E2%80%87/content' }],
    [{ url: '/%252F%252Fevil.example.test/content' }],
    [{ url: '/xagent-private/opaque' }],
    [{ url: '/XAGENT-PRIVATE/opaque' }],
    [{ url: 'https://xagent-private.storage.example.test/opaque' }],
    [{ url: '/content?xagent-private=value' }],
    [{ url: '/content?bucket=xagent-private' }],
    [{ url: '/content?bucket=XAGENT-PRIVATE' }],
    [{ url: '/content?bucket=xagent%252Dprivate' }],
    [{ url: '/content?signature=100%25valid&bucket=xagent%252Dprivate' }],
    [{ url: '/content#XAGENT-PRIVATE' }],
    [{ url: '/content?key=artifacts%252F00000000-0000-0000-0000-000000000401%252F00000000-0000-0000-0000-000000000412' }],
    [{ url: '/content?signature=100%25valid&key=artifacts%252F00000000-0000-0000-0000-000000000401%252F00000000-0000-0000-0000-000000000412' }],
    [{ url: '/content?signature=100%25valid&name=%E5%90' }],
    [{ url: '/content?signature=100%25valid&name=%FF' }],
    [{ url: '/content?signature=100%25valid#opaque' }],
    [{ url: '/content#secret' }],
  ])('拒绝畸形或泄漏对象 Key 的读取 URL %#', async (value) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: async () => Response.json(value),
    })
    await expect(client.artifacts.download('token', artifactIds.cleanVersion))
      .rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('Artifact 响应正文仍受共享字节上限约束', async () => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      maxResponseBytes: 64,
      fetch: async () => Response.json([privateArtifactSummary]),
    })
    await expect(client.artifacts.list('token')).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test('每个 Artifact 方法都把调用方取消传播到共享请求管线', async () => {
    const invoke = [
      (client: XAgentBackendClient, signal: AbortSignal) => client.artifacts.list('token', signal),
      (client: XAgentBackendClient, signal: AbortSignal) => client.artifacts.detail('token', artifactIds.private, signal),
      (client: XAgentBackendClient, signal: AbortSignal) => client.artifacts.createUpload('token', {
        filename: 'file.txt', size: 1, idempotencyKey: 'create',
      }, signal),
      (client: XAgentBackendClient, signal: AbortSignal) => client.artifacts.createVersionUpload(
        'token', artifactIds.private, { filename: 'file.txt', size: 1, idempotencyKey: 'version' }, signal,
      ),
      (client: XAgentBackendClient, signal: AbortSignal) => client.artifacts.completeUpload(
        'token', artifactIds.upload, { size: 1, sha256: 'a'.repeat(64), idempotencyKey: 'complete' }, signal,
      ),
      (client: XAgentBackendClient, signal: AbortSignal) => client.artifacts.retry(
        'token', artifactIds.failedVersion, 'retry', signal,
      ),
      (client: XAgentBackendClient, signal: AbortSignal) => client.artifacts.preview(
        'token', artifactIds.cleanVersion, signal,
      ),
      (client: XAgentBackendClient, signal: AbortSignal) => client.artifacts.download(
        'token', artifactIds.cleanVersion, signal,
      ),
    ]
    for (const operation of invoke) {
      const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          }, { once: true })
        }))
      const client = new XAgentBackendClient({
        origin: 'https://api.example.test', serviceToken: 'service-secret', fetch: fetcher,
      })
      const controller = new AbortController()
      const pending = operation(client, controller.signal)
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'service-unavailable' })
      expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true)
    }
  })

  test.each([
    ['list', [[401, 'unauthenticated'], [503, 'service-unavailable']]],
    ['detail', [[401, 'unauthenticated'], [404, 'not-found'], [503, 'service-unavailable']]],
    ['createUpload', [
      [401, 'unauthenticated'], [409, 'idempotency-conflict'], [503, 'service-unavailable'],
    ]],
    ['createVersionUpload', [
      [401, 'unauthenticated'], [404, 'not-found'], [409, 'idempotency-conflict'],
      [503, 'service-unavailable'],
    ]],
    ['completeUpload', [
      [401, 'unauthenticated'], [404, 'not-found'], [409, 'idempotency-conflict'],
      [422, 'upload-rejected'], [503, 'service-unavailable'],
    ]],
    ['retry', [
      [401, 'unauthenticated'], [404, 'not-found'], [409, 'idempotency-conflict'],
      [410, 'upload-expired'], [422, 'upload-rejected'], [503, 'service-unavailable'],
    ]],
    ['preview', [
      [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not-found'], [503, 'service-unavailable'],
    ]],
    ['download', [
      [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not-found'], [503, 'service-unavailable'],
    ]],
  ] as const)('Artifact %s 只公开真实 endpoint 错误', async (method, allowed) => {
    for (const [status, code] of allowed) {
      const client = new XAgentBackendClient({
        origin: 'https://api.example.test',
        serviceToken: 'service-secret',
        fetch: async () => Response.json({ detail: { code } }, { status }),
      })
      await expect(invokeArtifactMethod(client, method)).rejects.toMatchObject({ code })
    }
  })

  test.each([
    ['list', 400, 'unsupported-version'],
    ['detail', 409, 'idempotency-conflict'],
    ['createUpload', 403, 'forbidden'],
    ['createVersionUpload', 410, 'upload-expired'],
    ['completeUpload', 410, 'upload-expired'],
    ['retry', 403, 'forbidden'],
    ['preview', 409, 'idempotency-conflict'],
    ['download', 422, 'upload-rejected'],
  ] as const)('Artifact %s 拒绝其他 endpoint 的 %i %s', async (method, status, code) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json({ detail: { code } }, { status }),
    })
    await expect(invokeArtifactMethod(client, method)).rejects.toMatchObject({ code: 'service-unavailable' })
  })

  test.each([
    [401, {}, 'service-unavailable'],
    [401, { detail: { code: 'unknown-code' } }, 'service-unavailable'],
    [401, { detail: { code: 'unauthenticated', internal: 'secret' } }, 'service-unavailable'],
    [403, { detail: { code: 'forbidden' }, internal: 'secret' }, 'service-unavailable'],
    [403, { detail: { code: 'service-unauthorized' } }, 'service-unavailable'],
    [404, { detail: { code: 'session-not-found' } }, 'service-unavailable'],
    [409, { detail: { code: 'sequence-conflict' } }, 'service-unavailable'],
    [403, { detail: { code: 'not-found' } }, 'service-unavailable'],
    [500, { detail: { code: 'upload-rejected' } }, 'service-unavailable'],
    [410, { detail: { code: 'unknown-code' } }, 'service-unavailable'],
    [410, { detail: 'internal detail' }, 'service-unavailable'],
    [410, '<html>secret</html>', 'service-unavailable'],
  ])('拒绝畸形、未知或跨协议 Artifact 错误 %#', async (status, body, code) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    })
    await expect(client.artifacts.list('token')).rejects.toMatchObject({ code })
  })

  test.each([
    [410, 'upload-expired', 'upload-expired'],
    [422, 'upload-rejected', 'upload-rejected'],
    [418, 'not-found', 'service-unavailable'],
  ])('通用后端错误映射校验 %i %s', async (status, code, expected) => {
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: async () => Response.json({ detail: { code } }, { status }),
    })

    await expect(client.sessions.list('token')).rejects.toMatchObject({ code: expected })
  })

  test('选择项目上下文会发送项目标识', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        schema_version: 1,
        account_id: bootstrapResponse.account.id,
        context: { kind: 'project', project_id: projectResponse.project.id },
      }))
      .mockResolvedValueOnce(Response.json(bootstrapResponse))
    const client = new XAgentBackendClient({
      origin: 'https://api.example.test',
      serviceToken: 'service-secret',
      fetch: fetcher,
    })

    const selected = await client.workbench.selectContext('token', {
      kind: 'project', projectId: projectResponse.project.id,
    })
    expect(selected.account.id).toBe(bootstrapResponse.account.id)
    const body = fetcher.mock.calls[0]?.[1]?.body
    expect(typeof body).toBe('string')
    if (typeof body !== 'string') throw new TypeError('Expected a JSON request body')
    expect(JSON.parse(body)).toMatchObject({
      kind: 'project', project_id: projectResponse.project.id,
    })
  })
})
