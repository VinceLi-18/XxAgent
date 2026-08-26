import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import HttpServer, { type WebRoute, type WebServer } from '@deepseek-ai/dsh-host-webserver'
import { remoteMethods, TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import {
  XAgentBackendError,
  type XAgentArtifactBackend,
  type XAgentArtifactDetail,
  type XAgentArtifactSummary,
} from '@xagent/dsh-backend-client'
import type { XAgentAuthenticatedRequestScope } from '@xagent/dsh-principal'
import { PassThrough, Readable } from 'node:stream'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
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

async function requestStatus(port: number, path: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path }, (response) => {
      response.resume()
      response.once('end', () => { resolve(response.statusCode ?? 0) })
    })
    request.once('error', reject)
    request.end()
  })
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

async function artifactFiberRoute(events: string[]): Promise<{
  readonly fiber: Context['fiber']
  readonly route: WebRoute
  readonly routes: ReadonlyMap<string, WebRoute>
}> {
  const routes = new Map<string, WebRoute>()
  const ctx = new Context()
  ctx.provide('webServer', {
    register(route: WebRoute) {
      routes.set(route.path, route)
      return () => {
        events.push('route-unregistered')
        routes.delete(route.path)
      }
    },
  } as WebServer)
  const fiber = ctx.plugin({ apply, inject: [...inject] }, {
    backendOrigin: 'https://api.example.test',
    serviceToken: 'service-secret',
  })
  await fiber
  const route = routes.get('/api/v1/xagent/artifact-content')
  if (route === undefined) throw new Error('artifact content route was not registered')
  return { fiber, route, routes }
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
        'cache-control': 'private, no-store',
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
        expect(target.headers.get('cache-control')).toBe('private, no-store')
      }
      expect(fetcher).not.toHaveBeenCalled()

      fetcher.mockResolvedValueOnce(new Response(null, {
        status: 307,
        headers: {
          'cache-control': 'public, max-age=86400',
          location: 'https://storage.example.test/private',
        },
      }))
      const redirected = capturedResponse()
      await route.handler(
        nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`),
        redirected.response,
      )
      expect(redirected.response.statusCode).toBe(502)
      expect(redirected.headers.get('location')).toBeNull()
      expect(redirected.headers.get('cache-control')).toBe('private, no-store')

      fetcher.mockResolvedValueOnce(new Response('denied', {
        status: 403,
        headers: { 'cache-control': 'public, max-age=86400' },
      }))
      const denied = capturedResponse()
      await route.handler(
        nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`),
        denied.response,
      )
      expect(denied.response.statusCode).toBe(403)
      expect(denied.headers.get('cache-control')).toBe('private, no-store')

      fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }))
      const empty = capturedResponse()
      await route.handler(
        nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`),
        empty.response,
      )
      expect(empty.response.statusCode).toBe(204)
      expect(empty.headers.get('cache-control')).toBe('private, no-store')

      fetcher.mockRejectedValueOnce(new Error('backend unavailable'))
      const unavailable = capturedResponse()
      await route.handler(
        nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`),
        unavailable.response,
      )
      expect(unavailable.response.statusCode).toBe(502)
      expect(unavailable.headers.get('cache-control')).toBe('private, no-store')

      fetcher.mockRejectedValueOnce(new Error('backend unavailable after close'))
      const alreadyDestroyed = capturedResponse()
      alreadyDestroyed.stream.destroy()
      await route.handler(
        nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`),
        alreadyDestroyed.response,
      )
      expect(alreadyDestroyed.response.destroyed).toBe(true)

      for (const destroyed of [false, true]) {
        const unwritable = capturedResponse()
        if (destroyed) unwritable.stream.destroy()
        const destroy = vi.spyOn(unwritable.stream, 'destroy')
        unwritable.response.setHeader = () => { throw new Error('response headers unavailable') }
        await route.handler(
          nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`),
          unwritable.response,
        )
        expect(destroy).toHaveBeenCalledTimes(destroyed ? 0 : 1)
      }

      const rejectedOperation = capturedResponse()
      const setRejectedHeader = rejectedOperation.response.setHeader.bind(rejectedOperation.response)
      rejectedOperation.response.setHeader = (name, value) => {
        if (name.toLowerCase() === 'cache-control') return setRejectedHeader(name, value)
        throw new Error('allow header unavailable')
      }
      await expect(route.handler(
        nodeRequest('POST', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`),
        rejectedOperation.response,
      )).rejects.toThrow('allow header unavailable')

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
      const setHeader = headerFailure.response.setHeader.bind(headerFailure.response)
      headerFailure.response.setHeader = (name, value) => {
        if (name.toLowerCase() === 'cache-control') return setHeader(name, value)
        throw new Error('response closed')
      }
      await route.handler(
        nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=opaque`),
        headerFailure.response,
      )
      expect(headerFailure.response.destroyed).toBe(true)
      expect(headerFailure.headers.get('cache-control')).toBe('private, no-store')

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

  test('插件 fiber 释放先注销路由，再取消并等待响应头与正文中的请求', async () => {
    const events: string[] = []
    const { fiber, route, routes } = await artifactFiberRoute(events)
    let rejectHeaders: ((reason: unknown) => void) | undefined
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('mode=headers')) {
        return new Promise<Response>((_resolve, reject) => {
          rejectHeaders = reject
          init?.signal?.addEventListener('abort', () => {
            events.push('headers-aborted')
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller
          controller.enqueue(Buffer.from('partial'))
        },
        cancel() { events.push('body-cancelled') },
      }))
    })
    const headersTarget = capturedResponse()
    const bodyTarget = capturedResponse()
    const destroyBody = vi.spyOn(bodyTarget.stream, 'destroy')
    const headersPending = route.handler(
      nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?mode=headers&signature=secret`),
      headersTarget.response,
    )
    const bodyPending = route.handler(
      nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?mode=body&signature=secret`),
      bodyTarget.response,
    )
    try {
      await vi.waitFor(() => {
        expect(fetcher).toHaveBeenCalledTimes(2)
        expect(bodyTarget.body().toString()).toBe('partial')
      })
      let disposed = false
      const disposing = fiber.dispose().then(() => { disposed = true })
      await vi.waitFor(() => { expect(routes.has('/api/v1/xagent/artifact-content')).toBe(false) })
      expect(events[0]).toBe('route-unregistered')
      await vi.waitFor(() => {
        expect(events).toContain('headers-aborted')
        expect(events).toContain('body-cancelled')
      })
      await disposing
      expect(disposed).toBe(true)
      await Promise.all([headersPending, bodyPending])
      expect(destroyBody).toHaveBeenCalledTimes(1)
      const staleTarget = capturedResponse()
      await route.handler(
        nodeRequest('GET', `/api/v1/xagent/artifact-content/${VERSION_ID}?signature=secret`),
        staleTarget.response,
      )
      expect(staleTarget.response.statusCode).toBe(503)
      expect(staleTarget.headers.get('cache-control')).toBe('private, no-store')
    } finally {
      rejectHeaders?.(new DOMException('test cleanup', 'AbortError'))
      try {
        bodyController?.error(new DOMException('test cleanup', 'AbortError'))
      } catch {
        // 已取消的测试流拒绝后续控制器操作。
      }
      fetcher.mockRestore()
      await fiber.dispose()
      await Promise.allSettled([headersPending, bodyPending])
    }
  })

  test('真实 Host WebServer 的成功与失败正文请求都不记录 signed bearer', { timeout: 10_000 }, async () => {
    const ctx = new Context()
    const logs: unknown[] = []
    ctx.logger.warn = ((message: unknown) => { logs.push(message) }) as typeof ctx.logger.warn
    ctx.logger.error = ((message: unknown) => { logs.push(message) }) as typeof ctx.logger.error
    const fetcher = vi.spyOn(globalThis, 'fetch')
    try {
      await ctx.plugin(HttpServer, { host: '127.0.0.1', port: 0 })
      await ctx.plugin({ apply, inject: [...inject] }, {
        backendOrigin: 'https://api.example.test',
        serviceToken: 'service-secret',
      })
      ctx.webServer.register({
        kind: 'exact',
        path: '/logger-probe',
        handler: () => { throw new Error('logger-probe') },
      })
      expect(await requestStatus(ctx.webServer.port, '/logger-probe')).toBe(400)
      expect(logs.map(String).join('\n')).toContain('logger-probe')
      logs.length = 0

      fetcher.mockResolvedValueOnce(new Response('content', { status: 200 }))
      expect(await requestStatus(
        ctx.webServer.port,
        `/api/v1/xagent/artifact-content/${VERSION_ID}?expires=2000000000&mode=inline&signature=${'a'.repeat(64)}`,
      )).toBe(200)
      fetcher.mockRejectedValueOnce(new Error('backend unavailable'))
      expect(await requestStatus(
        ctx.webServer.port,
        `/api/v1/xagent/artifact-content/${VERSION_ID}?expires=2000000001&mode=inline&signature=${'b'.repeat(64)}`,
      )).toBe(502)
      expect(logs).toEqual([])
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
