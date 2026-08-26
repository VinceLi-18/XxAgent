import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { remoteMethods, TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import {
  XAgentBackendError,
  type XAgentArtifactBackend,
  type XAgentArtifactDetail,
  type XAgentArtifactSummary,
} from '@xagent/dsh-backend-client'
import type { XAgentAuthenticatedRequestScope } from '@xagent/dsh-principal'
import { PassThrough, Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, test, vi } from 'vitest'
import { apply, inject, XAgentArtifactService } from '../src/index.ts'

const ALICE_ID = '00000000-0000-0000-0000-000000000001'
const BOB_ID = '00000000-0000-0000-0000-000000000002'
const PROJECT_ID = '00000000-0000-0000-0000-000000000201'
const ARTIFACT_ID = '00000000-0000-0000-0000-000000000301'
const VERSION_ID = '00000000-0000-0000-0000-000000000401'
const UPLOAD_ID = '00000000-0000-0000-0000-000000000501'

const alice: XAgentAuthenticatedRequestScope = {
  principal: {
    actorId: ALICE_ID,
    role: 'specialist',
    permissionRevision: 3,
    authSessionId: '00000000-0000-0000-0000-000000000101',
    connectionId: 'connection-alice',
  },
  userToken: 'alice-token',
  connectionId: 'connection-alice',
}

const bob: XAgentAuthenticatedRequestScope = {
  principal: {
    actorId: BOB_ID,
    role: 'manager',
    permissionRevision: 4,
    authSessionId: '00000000-0000-0000-0000-000000000102',
    connectionId: 'connection-bob',
  },
  userToken: 'bob-token',
  connectionId: 'connection-bob',
}

function summary(scope: XAgentArtifactSummary['scope'] = { kind: 'private' }): XAgentArtifactSummary {
  return {
    id: ARTIFACT_ID,
    displayName: '说明.pdf',
    scope,
    latestVersion: 1,
    latestStatus: 'clean',
    latestCleanVersion: 1,
  }
}

function detail(scope: XAgentArtifactSummary['scope'] = { kind: 'private' }): XAgentArtifactDetail {
  return {
    ...summary(scope),
    canEdit: true,
    versions: [{
      id: VERSION_ID,
      version: 1,
      originalFilename: '说明.pdf',
      uploadedBy: ALICE_ID,
      size: 8,
      contentType: 'application/pdf',
      sha256: 'a'.repeat(64),
      status: 'clean',
      createdAt: '2026-08-25T08:00:00+00:00',
    }],
  }
}

interface ArtifactMock extends XAgentArtifactBackend {
  readonly calls: Record<keyof XAgentArtifactBackend, unknown[][]>
}

function backend(): ArtifactMock {
  const calls: ArtifactMock['calls'] = {
    list: [],
    detail: [],
    createUpload: [],
    createVersionUpload: [],
    completeUpload: [],
    retry: [],
    preview: [],
    download: [],
  }
  return {
    calls,
    list: async (...args) => {
      calls.list.push(args)
      return args[0] === 'alice-token'
        ? [summary()]
        : [summary({ kind: 'project', projectId: PROJECT_ID })]
    },
    detail: async (...args) => {
      calls.detail.push(args)
      return args[0] === 'alice-token'
        ? detail()
        : detail({ kind: 'project', projectId: PROJECT_ID })
    },
    createUpload: async (...args) => {
      calls.createUpload.push(args)
      return { id: UPLOAD_ID, putUrl: '/upload/opaque', expiresAt: '2026-08-25T08:10:00+00:00' }
    },
    createVersionUpload: async (...args) => {
      calls.createVersionUpload.push(args)
      return { id: UPLOAD_ID, putUrl: '/upload/opaque', expiresAt: '2026-08-25T08:10:00+00:00' }
    },
    completeUpload: async (...args) => {
      calls.completeUpload.push(args)
      return args[0] === 'alice-token'
        ? detail()
        : detail({ kind: 'project', projectId: PROJECT_ID })
    },
    retry: async (...args) => {
      calls.retry.push(args)
      return args[0] === 'alice-token'
        ? detail()
        : detail({ kind: 'project', projectId: PROJECT_ID })
    },
    preview: async (...args) => {
      calls.preview.push(args)
      return { url: '/content/opaque?signature=preview' }
    },
    download: async (...args) => {
      calls.download.push(args)
      return { url: '/content/opaque?signature=download' }
    },
  }
}

function nodeRequest(method: string, url: string | undefined): IncomingMessage {
  const request = Readable.from([]) as IncomingMessage
  request.method = method
  request.url = url
  request.rawHeaders = []
  return request
}

interface CapturedResponse {
  readonly response: ServerResponse
  readonly body: () => Buffer
  readonly headers: Headers
  readonly stream: PassThrough
}

function capturedResponse(): CapturedResponse {
  const stream = new PassThrough()
  const chunks: Buffer[] = []
  const headers = new Headers()
  stream.on('data', (chunk: Buffer) => { chunks.push(chunk) })
  const response = stream as unknown as ServerResponse
  response.statusCode = 200
  response.setHeader = (name: string, value: string | number | readonly string[]) => {
    headers.set(name, Array.isArray(value) ? value.join(', ') : String(value))
    return response
  }
  return { response, body: () => Buffer.concat(chunks), headers, stream }
}

function artifactRoute(): { readonly ctx: Context; readonly route: WebRoute } {
  const routes = new Map<string, WebRoute>()
  const ctx = new Context()
  ctx.provide('webServer', {
    register(route: WebRoute) {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  } as WebServer)
  apply(ctx, { backendOrigin: 'https://api.example.test', serviceToken: 'service-secret' })
  const route = routes.get('/api/v1/xagent/artifact-content')
  if (route === undefined) throw new Error('artifact content route was not registered')
  return { ctx, route }
}

describe('XAgent Artifact Remote', () => {
  test('固定同源路由逐块转发正文、签名 query、状态和必要响应头', async () => {
    expect(inject).toEqual(['webServer'])
    const { ctx, route } = artifactRoute()
    expect(route.kind).toBe('prefix')
    const release = Promise.withResolvers<true>()
    let fetchedUrl: string | undefined
    let fetchedInit: RequestInit | undefined
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      fetchedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      fetchedInit = init
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(Buffer.from('first-'))
          await release.promise
          controller.enqueue(Buffer.from('second'))
          controller.close()
        },
      }), {
        status: 206,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'inline; filename="safe.txt"',
          'content-length': '12',
          'x-internal-secret': 'not-forwarded',
        },
      })
    })
    try {
      const target = capturedResponse()
      const firstChunk = new Promise<void>((resolve) => { target.stream.once('data', () => { resolve() }) })
      const pending = route.handler(
        nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?expires=123&mode=preview&signature=opaque`),
        target.response,
      )
      await firstChunk
      expect(target.body().toString('utf8')).toBe('first-')
      release.resolve(true)
      await pending

      expect(fetchedUrl).toBe(
        `https://api.example.test/api/v1/xagent/artifact-content/${VERSION_ID}?expires=123&mode=preview&signature=opaque`,
      )
      expect(fetchedInit).toMatchObject({ method: 'GET', redirect: 'manual' })
      expect(fetchedInit?.signal).toBeInstanceOf(AbortSignal)
      expect(target.response.statusCode).toBe(206)
      expect(Object.fromEntries(target.headers)).toEqual({
        'content-disposition': 'inline; filename="safe.txt"',
        'content-length': '12',
        'content-type': 'text/plain; charset=utf-8',
      })
      expect(target.body().toString('utf8')).toBe('first-second')
    } finally {
      release.resolve(true)
      fetcher.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  test('固定路由拒绝其他目标和重定向，并在浏览器断开时取消上游', async () => {
    const { ctx, route } = artifactRoute()
    const fetcher = vi.spyOn(globalThis, 'fetch')
    try {
      for (const [method, path, status] of [
        ['POST', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`, 405],
        ['GET', '/api/v1/xagent/artifact-content', 404],
        ['GET', `/api/v1/xagent/artifact-content/${VERSION_ID}/extra?signature=opaque`, 404],
        ['GET', '/api/v1/xagent/artifact-content/https://evil.example.test/file', 404],
        ['GET', undefined, 404],
        ['GET', 'http://[', 404],
      ] as const) {
        const target = capturedResponse()
        await route.handler(nodeRequest(method, path), target.response)
        expect(target.response.statusCode).toBe(status)
      }
      expect(fetcher).not.toHaveBeenCalled()

      fetcher.mockResolvedValueOnce(new Response(null, {
        status: 307,
        headers: { location: 'https://storage.example.test/private' },
      }))
      const redirected = capturedResponse()
      await route.handler(
        nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`),
        redirected.response,
      )
      expect(redirected.response.statusCode).toBe(502)
      expect(redirected.headers.get('location')).toBeNull()

      fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }))
      const empty = capturedResponse()
      await route.handler(
        nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`),
        empty.response,
      )
      expect(empty.response.statusCode).toBe(204)

      fetcher.mockRejectedValueOnce(new Error('backend unavailable'))
      const unavailable = capturedResponse()
      await route.handler(
        nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`),
        unavailable.response,
      )
      expect(unavailable.response.statusCode).toBe(502)

      let requestAbortSignal: AbortSignal | undefined
      fetcher.mockImplementationOnce(async (_input, init) => {
        requestAbortSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          requestAbortSignal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
      })
      const abortedRequest = nodeRequest(
        'GET',
        `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`,
      )
      const abortedTarget = capturedResponse()
      const abortedPending = route.handler(abortedRequest, abortedTarget.response)
      abortedRequest.emit('aborted')
      await abortedPending
      expect(requestAbortSignal?.aborted).toBe(true)

      fetcher.mockResolvedValueOnce(new Response('body', { headers: { 'content-type': 'text/plain' } }))
      const headerFailure = capturedResponse()
      Object.defineProperty(headerFailure.response, 'headersSent', { value: true })
      headerFailure.response.setHeader = () => { throw new Error('response closed') }
      await route.handler(
        nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`),
        headerFailure.response,
      )
      expect(headerFailure.response.destroyed).toBe(true)

      let upstreamSignal: AbortSignal | undefined
      let upstreamCancelled = false
      fetcher.mockImplementationOnce(async (_input, init) => {
        upstreamSignal = init?.signal ?? undefined
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(Buffer.from('partial')) },
          cancel() { upstreamCancelled = true },
        }))
      })
      const disconnected = capturedResponse()
      disconnected.stream.once('data', () => { disconnected.stream.destroy() })
      await route.handler(
        nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`),
        disconnected.response,
      )
      expect(upstreamSignal?.aborted).toBe(true)
      expect(upstreamCancelled).toBe(true)
    } finally {
      fetcher.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  test('只发布八个固定 Remote，作用域入口不进入协议', () => {
    const service = new XAgentArtifactService(new Context(), backend())
    expect(service.typertRemote).toMatchObject({ serviceKey: 'xagentArtifact', namespace: 'xagentArtifact' })
    expect(remoteMethods(service)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'detail', invocation: { kind: 'direct' } },
      { method: 'createUpload', exportName: 'create-upload', invocation: { kind: 'direct' } },
      { method: 'createVersionUpload', exportName: 'create-version-upload', invocation: { kind: 'direct' } },
      { method: 'completeUpload', exportName: 'complete-upload', invocation: { kind: 'direct' } },
      { method: 'retry', invocation: { kind: 'direct' } },
      { method: 'preview', invocation: { kind: 'direct' } },
      { method: 'download', invocation: { kind: 'direct' } },
    ])
  })

  test('插件 fiber dispose 后移除 Artifact Service contribution', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin((child) => { new XAgentArtifactService(child, backend()) })
    await fiber
    expect(ctx.get('xagentArtifact')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('xagentArtifact')).toBeUndefined()
  })

  test('插件入口使用固定配置安装 Artifact Service', async () => {
    const { ctx } = artifactRoute()
    expect(ctx.get('xagentArtifact')).toBeInstanceOf(XAgentArtifactService)
    await ctx.fiber.dispose()
  })

  test('包 invariant 从 live Service 校验 namespace 与 service key 的对象关系', async () => {
    const ArtifactInvariant = await import('../src/invariant.ts')
    const valid = new Context()
    await valid.plugin(InvariantRegistry, { enabled: true })
    new XAgentArtifactService(valid, backend())
    await valid.plugin(ArtifactInvariant)

    const validService = new XAgentArtifactService(new Context(), backend())
    ArtifactInvariant.validateXAgentArtifactBinding(validService, (message): never => {
      throw new Error(message)
    })

    for (const binding of [
      { service: new XAgentArtifactService(new Context(), backend()), serviceKey: 'xagentArtifact', namespace: 'xagentArtifact' },
      { serviceKey: 'xagentArtifactWrong', namespace: 'xagentArtifact' },
      { serviceKey: 'xagentArtifact', namespace: 'xagentArtifactWrong' },
    ]) {
      const service = new XAgentArtifactService(new Context(), backend())
      Object.defineProperty(service, 'typertRemote', {
        value: Object.freeze({ service, ...binding }),
      })
      expect(() => {
        ArtifactInvariant.validateXAgentArtifactBinding(service, (message): never => {
          throw new Error(message)
        })
      }).toThrow('xagentArtifact binding must identify its live Cordis service and namespace')
    }
  })

  test('八个 Remote 只从独立请求 scope 转发 token、业务输入和取消信号', async () => {
    const remote = backend()
    const service = new XAgentArtifactService(new Context(), remote)
    const signal = new AbortController().signal
    const uploadInput = { filename: '说明.pdf', size: 8, idempotencyKey: 'create-1' } as const
    const completeInput = { size: 8, sha256: 'a'.repeat(64), idempotencyKey: 'complete-1' } as const

    await service.withRequest(alice, async () => {
      await service.list(signal)
      await service.detail(ARTIFACT_ID, signal)
      await service.createUpload(uploadInput, signal)
      await service.createVersionUpload(ARTIFACT_ID, uploadInput, signal)
      await service.completeUpload(UPLOAD_ID, completeInput, signal)
      await service.retry(VERSION_ID, 'retry-1', signal)
      await service.preview(VERSION_ID, signal)
      await service.download(VERSION_ID, signal)
    })

    expect(remote.calls).toEqual({
      list: [['alice-token', signal]],
      detail: [['alice-token', ARTIFACT_ID, signal]],
      createUpload: [['alice-token', uploadInput, signal]],
      createVersionUpload: [['alice-token', ARTIFACT_ID, uploadInput, signal]],
      completeUpload: [['alice-token', UPLOAD_ID, completeInput, signal]],
      retry: [['alice-token', VERSION_ID, 'retry-1', signal]],
      preview: [['alice-token', VERSION_ID, signal]],
      download: [['alice-token', VERSION_ID, signal]],
    })
  })

  test('无 scope、嵌套 scope、畸形身份与 dispose 后调用全部失败关闭', async () => {
    const ctx = new Context()
    const service = new XAgentArtifactService(ctx, backend())
    await expect(service.list()).rejects.toThrow('request scope')
    await expect(service.withRequest(alice, () => service.withRequest(bob, async () => undefined)))
      .rejects.toThrow('nested')
    await expect(service.withRequest({ ...alice, connectionId: 'other-connection' }, async () => undefined))
      .rejects.toThrow('invalid xagent authenticated request scope')
    await ctx.fiber.dispose()
    await expect(service.withRequest(alice, () => service.list())).rejects.toThrow('disposed')
    await expect(service.list()).rejects.toThrow('disposed')
  })

  test('operation 完成、抛错或取消后，派生的迟到任务不能继续读取 scope', async () => {
    const service = new XAgentArtifactService(new Context(), backend())
    const cases = [
      { failure: undefined },
      { failure: new Error('operation failed') },
      { failure: new DOMException('cancelled', 'AbortError') },
    ]
    for (const { failure } of cases) {
      const release = Promise.withResolvers<true>()
      const late = Promise.withResolvers<Awaited<ReturnType<typeof service.list>>>()
      const operation = service.withRequest(alice, async () => {
        void release.promise.then(() => service.list()).then(late.resolve, late.reject)
        if (failure !== undefined) throw failure
      })
      if (failure === undefined) await expect(operation).resolves.toBeUndefined()
      else await expect(operation).rejects.toBe(failure)
      release.resolve(true)
      await expect(late.promise).rejects.toThrow('request scope')
    }
  })

  test('并发双账号的 token 和 Principal 请求 scope 不会串号', async () => {
    const entered = Promise.withResolvers<true>()
    const release = Promise.withResolvers<true>()
    const remote = backend()
    remote.list = vi.fn(async (token) => {
      if (token === 'alice-token') {
        entered.resolve(true)
        await release.promise
      }
      return token === 'alice-token'
        ? [summary()]
        : [summary({ kind: 'project', projectId: PROJECT_ID })]
    })
    const service = new XAgentArtifactService(new Context(), remote)
    const pendingAlice = service.withRequest(alice, () => service.list())
    await entered.promise
    const pendingBob = service.withRequest(bob, () => service.list())
    release.resolve(true)

    await expect(Promise.all([pendingAlice, pendingBob])).resolves.toEqual([
      [summary()],
      [summary({ kind: 'project', projectId: PROJECT_ID })],
    ])
  })

  test('BackendError 只映射已知 Artifact 错误，不暴露原始 detail', async () => {
    const remote = backend()
    remote.completeUpload = vi.fn(async () => { throw new XAgentBackendError('upload-rejected') })
    const service = new XAgentArtifactService(new Context(), remote)
    await expect(service.withRequest(alice, () => service.completeUpload(UPLOAD_ID, {
      size: 8, sha256: 'a'.repeat(64), idempotencyKey: 'complete-1',
    }))).rejects.toEqual(new TypertRemoteFailure({
      code: 'upload-rejected', message: 'XAgent artifact request failed', details: {},
    }))

    remote.completeUpload = vi.fn(async () => { throw new XAgentBackendError('sequence-conflict') })
    await expect(service.withRequest(alice, () => service.completeUpload(UPLOAD_ID, {
      size: 8, sha256: 'a'.repeat(64), idempotencyKey: 'complete-2',
    }))).rejects.toMatchObject({ failure: { code: 'service-unavailable', details: {} } })

    const unexpected = new Error('unexpected backend failure')
    remote.completeUpload = vi.fn(async () => { throw unexpected })
    await expect(service.withRequest(alice, () => service.completeUpload(UPLOAD_ID, {
      size: 8, sha256: 'a'.repeat(64), idempotencyKey: 'complete-3',
    }))).rejects.toBe(unexpected)
  })

  test('list、detail 和临时 URL 每次都重新请求 backend，不保存先前结果', async () => {
    const remote = backend()
    const service = new XAgentArtifactService(new Context(), remote)
    await service.withRequest(alice, async () => {
      await service.list()
      await service.list()
      await service.detail(ARTIFACT_ID)
      await service.detail(ARTIFACT_ID)
      await service.preview(VERSION_ID)
      await service.preview(VERSION_ID)
      await service.download(VERSION_ID)
      await service.download(VERSION_ID)
    })
    expect(remote.calls.list).toHaveLength(2)
    expect(remote.calls.detail).toHaveLength(2)
    expect(remote.calls.preview).toHaveLength(2)
    expect(remote.calls.download).toHaveLength(2)
  })
})
