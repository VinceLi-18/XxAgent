/** 请求绑定的 XAgent 资料 Remote。 @module @xagent/dsh-artifact */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { Remote, TypertRemoteFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  XAgentBackendClient,
  XAgentBackendError,
  type XAgentArtifactBackend,
} from '@xagent/dsh-backend-client'
import {
  isXAgentAuthenticatedRequestScope,
  type XAgentAuthenticatedRequestScope,
} from '@xagent/dsh-principal'
import type {
  XAgentArtifactCompleteInput,
  XAgentArtifactDetail,
  XAgentArtifactRemote,
  XAgentArtifactScopeRunner,
  XAgentArtifactSummary,
  XAgentArtifactUpload,
  XAgentArtifactUploadInput,
} from './types.ts'

export type * from './types.ts'

const ARTIFACT_CONTENT_ROUTE = '/api/v1/xagent/artifact-content'
const ARTIFACT_CONTENT_PATH = new RegExp(`^${ARTIFACT_CONTENT_ROUTE}/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`, 'i')
const CONTENT_RESPONSE_HEADERS = ['content-type', 'content-disposition', 'content-length'] as const
const CONTENT_CACHE_CONTROL = 'private, no-store'
const ARTIFACT_FAILURE_CODES = new Set([
  'unauthenticated',
  'forbidden',
  'not-found',
  'upload-expired',
  'upload-rejected',
  'idempotency-conflict',
  'service-unavailable',
])

interface RequestScopeState {
  readonly scope: XAgentAuthenticatedRequestScope
  active: boolean
}

/* jscpd:ignore-start -- Project and Artifact intentionally expose the same backend transport configuration. */
/** XAgent Artifact Host plugin configuration. */
export interface Config {
  /** FastAPI 服务的绝对 HTTP origin。 */
  backendOrigin: string
  /** Host 调用内部资料接口时使用的服务身份。 */
  serviceToken: string
}

export const Config: z<Config> = z.object({
  backendOrigin: z.string().required(),
  serviceToken: z.string().required(),
})
/* jscpd:ignore-end */

export const name = 'xagent-artifact'
export const inject = ['webServer']

declare module '@deepseek-ai/cordis' {
  interface Context {
    xagentArtifact: XAgentArtifactService
  }
}

function finish(response: ServerResponse, status: number): void {
  response.statusCode = status
  response.end()
}

async function proxyArtifactContent(
  request: IncomingMessage,
  response: ServerResponse,
  backendOrigin: string,
  controller: AbortController,
): Promise<void> {
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET')
    finish(response, 405)
    return
  }
  let source: URL
  try {
    source = new URL(request.url ?? '/', 'http://xagent.internal')
  } catch {
    finish(response, 404)
    return
  }
  if (!ARTIFACT_CONTENT_PATH.test(source.pathname)) {
    finish(response, 404)
    return
  }

  const abort = (): void => { controller.abort() }
  const abortOnClose = (): void => {
    if (!response.writableFinished) controller.abort()
  }
  request.once('aborted', abort)
  response.once('close', abortOnClose)
  try {
    const target = new URL(`${source.pathname}${source.search}`, backendOrigin)
    const upstream = await fetch(target, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    })
    if (upstream.status >= 300 && upstream.status < 400) {
      finish(response, 502)
      await upstream.body?.cancel()
      return
    }
    response.statusCode = upstream.status
    for (const header of CONTENT_RESPONSE_HEADERS) {
      const value = upstream.headers.get(header)
      if (value !== null) response.setHeader(header, value)
    }
    if (upstream.body === null) {
      response.end()
      return
    }
    await pipeline(
      Readable.fromWeb(upstream.body as unknown as NodeReadableStream),
      response,
      { signal: controller.signal },
    )
  } catch {
    if (controller.signal.aborted) {
      if (!response.destroyed) response.destroy()
      return
    }
    if (response.headersSent || response.destroyed) {
      if (!response.destroyed) response.destroy()
      return
    }
    finish(response, 502)
  } finally {
    request.off('aborted', abort)
    response.off('close', abortOnClose)
    controller.abort()
  }
}

class ArtifactContentProxy {
  private readonly active = new Map<AbortController, Promise<void>>()
  private disposed = false

  constructor(private readonly backendOrigin: string) {}

  handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      response.setHeader('cache-control', CONTENT_CACHE_CONTROL)
    } catch {
      if (!response.destroyed) response.destroy()
      return Promise.resolve()
    }
    if (this.disposed) {
      finish(response, 503)
      return Promise.resolve()
    }
    const controller = new AbortController()
    const settled = Promise.withResolvers<void>()
    this.active.set(controller, settled.promise)
    const operation = proxyArtifactContent(request, response, this.backendOrigin, controller)
    void operation.then(
      () => {
        this.active.delete(controller)
        settled.resolve()
      },
      () => {
        this.active.delete(controller)
        settled.resolve()
      },
    )
    return operation
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const active = [...this.active.entries()]
    for (const [controller] of active) controller.abort()
    await Promise.allSettled(active.map(([, operation]) => operation))
  }
}

/** 将账号绑定请求逐次转发给 FastAPI 的资料服务。 */
export class XAgentArtifactService extends TypertRemoteService implements XAgentArtifactRemote, XAgentArtifactScopeRunner {
  private readonly requestScope = new AsyncLocalStorage<RequestScopeState>()
  private disposed = false

  constructor(ctx: Context, private readonly backend: XAgentArtifactBackend) {
    super(ctx, 'xagentArtifact')
    ctx.effect(() => () => { this.disposed = true }, 'dispose xagent artifact request scope')
  }

  /**
   * 在 Host 认证所得的单请求身份内执行完整 Remote 调用。
   * @param scope - 物理连接绑定的可信 Principal 与用户令牌。
   * @param operation - 下游完整 Remote 操作。
   * @returns 下游结果；退出时自动清除请求身份。
   */
  async withRequest<T>(scope: XAgentAuthenticatedRequestScope, operation: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('xagent artifact service is disposed')
    if (!isXAgentAuthenticatedRequestScope(scope)) throw new Error('invalid xagent authenticated request scope')
    if (this.requestScope.getStore()?.active === true) throw new Error('nested xagent artifact request scope')
    const state: RequestScopeState = { scope, active: true }
    try {
      return await this.requestScope.run(state, operation)
    } finally {
      state.active = false
    }
  }

  /**
   * 列出当前 FastAPI 工作台范围内可见的资料。
   * @param signal - 物理请求的取消信号。
   * @returns 当前请求重新读取的资料摘要。
   */
  @Remote
  async list(signal?: AbortSignal): Promise<readonly XAgentArtifactSummary[]> {
    const scope = this.requireScope()
    return this.callBackend(() => this.backend.list(scope.userToken, signal))
  }

  /**
   * 读取当前账号可见的一份资料与版本历史。
   * @param artifactId - 资料 UUID。
   * @param signal - 物理请求的取消信号。
   * @returns FastAPI 当前资料详情。
   */
  @Remote
  async detail(artifactId: string, signal?: AbortSignal): Promise<XAgentArtifactDetail> {
    const scope = this.requireScope()
    return this.callBackend(() => this.backend.detail(scope.userToken, artifactId, signal))
  }

  /**
   * 创建当前 FastAPI 工作台范围内的新资料暂存上传。
   * @param input - 文件名、声明大小和幂等键。
   * @param signal - 物理请求的取消信号。
   * @returns 单个暂存对象的短期 PUT 授权。
   */
  @Remote('create-upload')
  async createUpload(input: XAgentArtifactUploadInput, signal?: AbortSignal): Promise<XAgentArtifactUpload> {
    const scope = this.requireScope()
    return this.callBackend(() => this.backend.createUpload(scope.userToken, input, signal))
  }

  /**
   * 为一份现有资料创建不可变新版本的暂存上传。
   * @param artifactId - 资料 UUID。
   * @param input - 文件名、声明大小和幂等键。
   * @param signal - 物理请求的取消信号。
   * @returns 单个暂存对象的短期 PUT 授权。
   */
  @Remote('create-version-upload')
  async createVersionUpload(
    artifactId: string,
    input: XAgentArtifactUploadInput,
    signal?: AbortSignal,
  ): Promise<XAgentArtifactUpload> {
    const scope = this.requireScope()
    return this.callBackend(() => this.backend.createVersionUpload(scope.userToken, artifactId, input, signal))
  }

  /**
   * 完成暂存上传并把新版本提交到异步安全处理队列。
   * @param uploadId - 暂存上传 UUID。
   * @param input - 实际大小、SHA-256 和幂等键。
   * @param signal - 物理请求的取消信号。
   * @returns 新版本进入处理队列后的资料详情。
   */
  @Remote('complete-upload')
  async completeUpload(
    uploadId: string,
    input: XAgentArtifactCompleteInput,
    signal?: AbortSignal,
  ): Promise<XAgentArtifactDetail> {
    const scope = this.requireScope()
    return this.callBackend(() => this.backend.completeUpload(scope.userToken, uploadId, input, signal))
  }

  /**
   * 重试一份仍有有效暂存正文的失败版本。
   * @param versionId - 资料版本 UUID。
   * @param idempotencyKey - 当前重试意图的幂等键。
   * @param signal - 物理请求的取消信号。
   * @returns 重试入队后的资料详情。
   */
  @Remote
  async retry(versionId: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentArtifactDetail> {
    const scope = this.requireScope()
    return this.callBackend(() => this.backend.retry(scope.userToken, versionId, idempotencyKey, signal))
  }

  /**
   * 为 clean 版本创建一次新的安全预览地址。
   * @param versionId - 资料版本 UUID。
   * @param signal - 物理请求的取消信号。
   * @returns FastAPI 授权的短期 opaque 地址。
   */
  @Remote
  async preview(versionId: string, signal?: AbortSignal): Promise<{ readonly url: string }> {
    const scope = this.requireScope()
    return this.callBackend(() => this.backend.preview(scope.userToken, versionId, signal))
  }

  /**
   * 为 clean 版本创建一次新的安全下载地址。
   * @param versionId - 资料版本 UUID。
   * @param signal - 物理请求的取消信号。
   * @returns FastAPI 授权的短期 opaque 地址。
   */
  @Remote
  async download(versionId: string, signal?: AbortSignal): Promise<{ readonly url: string }> {
    const scope = this.requireScope()
    return this.callBackend(() => this.backend.download(scope.userToken, versionId, signal))
  }

  private async callBackend<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (!(error instanceof XAgentBackendError)) throw error
      const code = ARTIFACT_FAILURE_CODES.has(error.code) ? error.code : 'service-unavailable'
      throw new TypertRemoteFailure({ code, message: 'XAgent artifact request failed', details: {} })
    }
  }

  private requireScope(): XAgentAuthenticatedRequestScope {
    if (this.disposed) throw new Error('xagent artifact service is disposed')
    const state = this.requestScope.getStore()
    if (state?.active !== true) throw new Error('xagent artifact request scope is required')
    return state.scope
  }
}

/** 安装 XAgent 资料 Host 服务。 */
export function apply(ctx: Context, config: Config): void {
  const backend = new XAgentBackendClient({ origin: config.backendOrigin, serviceToken: config.serviceToken })
  const backendOrigin = new URL(config.backendOrigin).origin
  const contentProxy = new ArtifactContentProxy(backendOrigin)
  new XAgentArtifactService(
    ctx,
    backend.artifacts,
  )
  const content: WebRoute = {
    kind: 'prefix',
    path: ARTIFACT_CONTENT_ROUTE,
    handler: (request, response) => contentProxy.handle(request, response),
  }
  ctx.effect(function* () {
    yield () => contentProxy.dispose()
    yield ctx.webServer.register(content)
  }, 'xagent-artifact: content route')
}
