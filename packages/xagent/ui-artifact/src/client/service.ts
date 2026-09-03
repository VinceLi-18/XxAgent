import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  XAgentArtifactDetail,
  XAgentArtifactSummary,
  XAgentArtifactUpload,
  XAgentArtifactUploadInput,
} from '@xagent/dsh-artifact/types'
import { XAgentArtifactStore } from './store.ts'

/** Browser 在签发请求前执行的单文件上限。 */
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024

/** Browser 调用的生成式 Artifact Remote。 */
export interface XAgentArtifactRemoteClient {
  list(signal?: AbortSignal): Promise<RemoteResult<readonly XAgentArtifactSummary[]>>
  detail(artifactId: string, signal?: AbortSignal): Promise<RemoteResult<XAgentArtifactDetail>>
  'create-upload'(input: XAgentArtifactUploadInput, signal?: AbortSignal): Promise<RemoteResult<XAgentArtifactUpload>>
  'create-version-upload'(
    artifactId: string,
    input: XAgentArtifactUploadInput,
    signal?: AbortSignal,
  ): Promise<RemoteResult<XAgentArtifactUpload>>
  'complete-upload'(
    uploadId: string,
    input: { readonly size: number; readonly sha256: string; readonly idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<RemoteResult<XAgentArtifactDetail>>
  retry(versionId: string, idempotencyKey: string, signal?: AbortSignal): Promise<RemoteResult<XAgentArtifactDetail>>
  preview(versionId: string, signal?: AbortSignal): Promise<RemoteResult<{ readonly url: string }>>
  download(versionId: string, signal?: AbortSignal): Promise<RemoteResult<{ readonly url: string }>>
}

/** PUT 与摘要计算的 Browser 适配器。 */
export interface XAgentArtifactTransport {
  put(
    url: string,
    file: File,
    signal: AbortSignal,
    onProgress: (loaded: number, total: number) => void,
  ): Promise<void>
  digest(file: File): Promise<string>
}

type ArtifactContext = { readonly kind: 'workbench' } | { readonly kind: 'project'; readonly projectId: string }

interface ControllerOptions {
  readonly schedule?: ((callback: () => void) => number) | undefined
  readonly cancelSchedule?: ((handle: number) => void) | undefined
  readonly idempotencyKey?: (() => string) | undefined
  readonly readText?: ((url: string, signal: AbortSignal) => Promise<string>) | undefined
  readonly openUrl?: ((url: string) => void) | undefined
}

/** Cited answer 交给 Artifact 面板的持久身份；不含读取地址。 */
export interface XAgentArtifactCitationTarget {
  readonly artifactId: string
  readonly versionId: string
  readonly lineStart: number
  readonly lineEnd: number
}

/** Browser citation 导航唯一允许调用的 Artifact seam。 */
export interface XAgentArtifactCitationOpener {
  openCitation(target: XAgentArtifactCitationTarget): Promise<void>
}

interface Operation {
  readonly controller: AbortController
  readonly epoch: number
  readonly accountId: string
  readonly contextKey: string
}

function abortError(): DOMException {
  return new DOMException('Operation aborted', 'AbortError')
}

function failed(result: RemoteResult<unknown>): string | undefined {
  return result.ok ? undefined : result.error.code
}

function errorText(code: string | undefined): string {
  switch (code) {
    case 'forbidden': return '当前范围只读，不能修改资料'
    case 'upload-expired': return '上传授权已过期，请重新选择文件'
    case 'upload-rejected': return '文件未通过服务端上传校验'
    default: return '资料服务暂时不可用'
  }
}

function contextKey(context: ArtifactContext): string {
  return context.kind === 'workbench' ? 'workbench' : `project:${context.projectId}`
}

function summaryOf(detail: XAgentArtifactDetail): XAgentArtifactSummary {
  return {
    id: detail.id,
    displayName: detail.displayName,
    scope: detail.scope,
    latestVersion: detail.latestVersion,
    latestStatus: detail.latestStatus,
    ...(detail.latestCleanVersion === undefined ? {} : { latestCleanVersion: detail.latestCleanVersion }),
  }
}

function replaceSummary(items: readonly XAgentArtifactSummary[], detail: XAgentArtifactDetail): readonly XAgentArtifactSummary[] {
  const next = summaryOf(detail)
  const index = items.findIndex(item => item.id === detail.id)
  if (index < 0) return [next, ...items]
  return items.map(item => item.id === detail.id ? next : item)
}

/**
 * 根据服务端内容识别结果选择内联方式。
 * @param contentType worker 识别并写入详情的 MIME。
 * @returns 支持的内联类型；Office、HTML、SVG 与未知二进制返回 `undefined`。
 */
export function previewKind(contentType: string | undefined): 'pdf' | 'image' | 'text' | undefined {
  if (contentType === 'application/pdf') return 'pdf'
  if (contentType === 'image/png' || contentType === 'image/jpeg' || contentType === 'image/webp') return 'image'
  if (contentType === 'text/plain' || contentType === 'text/markdown' || contentType === 'text/csv'
    || contentType === 'application/json') return 'text'
  return undefined
}

/**
 * 创建不会缓存读取地址的 Browser 上传与摘要适配器。
 * @returns 使用 XMLHttpRequest 真实进度与 Web Crypto 摘要的适配器。
 */
export function createBrowserArtifactTransport(): XAgentArtifactTransport {
  return {
    put: (url, file, signal, onProgress) => new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const settleAbort = () => { reject(abortError()) }
      const cleanup = () => { signal.removeEventListener('abort', onSignalAbort) }
      const onSignalAbort = () => { xhr.abort() }
      xhr.open('PUT', url)
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(event.loaded, event.total)
      })
      xhr.addEventListener('load', () => {
        cleanup()
        if (xhr.status >= 200 && xhr.status < 300) resolve()
        else reject(new Error('upload PUT failed'))
      })
      xhr.addEventListener('error', () => { cleanup(); reject(new Error('upload PUT failed')) })
      xhr.addEventListener('abort', () => { cleanup(); settleAbort() })
      if (signal.aborted) { settleAbort(); return }
      signal.addEventListener('abort', onSignalAbort, { once: true })
      xhr.send(file)
    }),
    digest: async (file) => {
      const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
    },
  }
}

/** 负责资料请求取消、范围 epoch、上传、轮询和详情状态的客户端控制器。 */
export class XAgentArtifactController {
  /** 供资料右栏订阅的只读内存快照。 */
  readonly snapshot = new XAgentArtifactStore()
  private epoch = 0
  private listOperation: AbortController | undefined
  private detailOperation: AbortController | undefined
  private uploadOperation: AbortController | undefined
  private readOperation: AbortController | undefined
  private pollOperation: AbortController | undefined
  private pollHandle: number | undefined
  private selectionGeneration = 0
  private citationSelectionGeneration: number | undefined
  private artifactOperationGeneration = 0
  private readonly activeTasks = new Set<Promise<void>>()
  private disposal: Promise<void> | undefined
  private disposed = false
  private readonly transport: XAgentArtifactTransport
  private readonly schedule: (callback: () => void) => number
  private readonly cancelSchedule: (handle: number) => void
  private readonly idempotencyKey: () => string
  private readonly readText: (url: string, signal: AbortSignal) => Promise<string>
  private readonly openUrl: (url: string) => void

  constructor(
    private readonly remote: XAgentArtifactRemoteClient,
    transport: XAgentArtifactTransport = createBrowserArtifactTransport(),
    options: ControllerOptions = {},
  ) {
    this.transport = transport
    this.schedule = options.schedule ?? (callback => window.setTimeout(callback, 2_000))
    this.cancelSchedule = options.cancelSchedule ?? ((handle) => { window.clearTimeout(handle) })
    this.idempotencyKey = options.idempotencyKey ?? (() => crypto.randomUUID())
    this.readText = options.readText ?? (async (url, signal) => {
      const response = await fetch(url, { signal, credentials: 'same-origin' })
      if (!response.ok) throw new Error('preview read failed')
      return response.text()
    })
    this.openUrl = options.openUrl ?? ((url) => { window.location.assign(url) })
  }

  /**
   * 采用当前账号与服务器所选工作范围并重新加载列表。
   * @param accountId 当前认证账号。
   * @param context 服务端当前工作台或项目上下文。
   */
  setScope(accountId: string, context: ArtifactContext): Promise<void> {
    return this.trackOperation(() => this.loadScope(accountId, context))
  }

  private async loadScope(accountId: string, context: ArtifactContext): Promise<void> {
    if (this.disposed) return
    const key = contextKey(context)
    const current = this.snapshot.getSnapshot()
    if (current.accountId === accountId && current.contextKey === key && current.phase !== 'empty' && current.phase !== 'unavailable') return
    this.invalidate()
    const epoch = ++this.epoch
    this.snapshot.replace({ phase: 'loading', accountId, contextKey: key })
    if (this.stale(epoch, accountId, key)) return
    const controller = new AbortController()
    this.listOperation = controller
    try {
      const result = await this.remote.list(controller.signal)
      if (this.stale(epoch, accountId, key)) return
      if (!result.ok) {
        this.snapshot.replace({ phase: 'unavailable', accountId, contextKey: key, error: errorText(result.error.code) })
        return
      }
      this.snapshot.replace({ phase: 'ready', accountId, contextKey: key, items: result.value, selectedId: undefined })
      if (result.value.some(item => item.latestStatus === 'pending' || item.latestStatus === 'scanning')) this.armPoll()
    } catch {
      if (!controller.signal.aborted && !this.stale(epoch, accountId, key)) {
        this.snapshot.replace({ phase: 'unavailable', accountId, contextKey: key, error: errorText(undefined) })
      }
    }
  }

  /**
   * 账号或项目切换开始时立即清空内存并取消全部旧范围操作。
   * @param accountId 正在进入的账号；未认证时省略。
   */
  clear(accountId?: string): void {
    if (this.disposed) return
    this.invalidate()
    ++this.epoch
    this.snapshot.replace({ phase: 'empty', accountId, contextKey: undefined })
  }

  /**
   * 进入资料详情层并读取版本历史。
   * @param artifactId 当前范围内的资料 ID。
   */
  selectArtifact(artifactId: string): Promise<void> {
    return this.trackOperation(() => this.loadDetail(artifactId))
  }

  /**
   * 重新读取 citation 指定的 Artifact 和不可变版本，再发布短期预览。
   * @param target Host 解析出的 Artifact、版本和行范围。
   */
  openCitation(target: XAgentArtifactCitationTarget): Promise<void> {
    return this.trackOperation(() => this.loadCitation(target))
  }

  private async loadCitation(target: XAgentArtifactCitationTarget): Promise<void> {
    const selectionGeneration = this.invalidateSelection()
    const operation = this.begin('detail')
    if (operation === undefined) return
    this.citationSelectionGeneration = selectionGeneration
    this.snapshot.replaceReady({
      selectedId: target.artifactId, detail: undefined, detailLoading: true, detailError: undefined,
      preview: undefined, citation: undefined,
    })
    try {
      const result = await this.remote.detail(target.artifactId, operation.controller.signal)
      if (this.isStale(operation) || !this.isCurrentSelection(selectionGeneration, target.artifactId)) return
      const version = result.ok && result.value.id === target.artifactId
        ? result.value.versions.find(item => item.id === target.versionId)
        : undefined
      if (!result.ok || version?.status !== 'clean' || previewKind(version.contentType) !== 'text') {
        this.snapshot.replaceReady({
          selectedId: target.artifactId, detail: undefined, detailLoading: false,
          detailError: '引用资料暂时不可用', preview: undefined, citation: undefined,
        })
        return
      }
      this.snapshot.replaceReady({
        detail: result.value, detailLoading: false, detailError: undefined,
        citation: { versionId: target.versionId, lineStart: target.lineStart, lineEnd: target.lineEnd },
      })
      await this.loadPreview(target.versionId)
      if (this.isStale(operation) || !this.isCurrentSelection(selectionGeneration, target.artifactId)
        || this.citationSelectionGeneration !== selectionGeneration) return
      const current = this.snapshot.getSnapshot()
      if (current.phase === 'ready' && current.citation?.versionId === target.versionId
        && current.preview?.versionId !== target.versionId) {
        this.snapshot.replaceReady({ citation: undefined, preview: undefined })
      }
    } catch {
      if (!operation.controller.signal.aborted && !this.isStale(operation)) {
        this.snapshot.replaceReady({
          detailLoading: false, detailError: '引用资料暂时不可用', preview: undefined, citation: undefined,
        })
      }
    }
  }

  private async loadDetail(artifactId: string): Promise<void> {
    const selectionGeneration = this.invalidateSelection()
    const operation = this.begin('detail')
    if (operation === undefined) return
    this.snapshot.replaceReady({
      selectedId: artifactId, detail: undefined, detailLoading: true, detailError: undefined, preview: undefined, citation: undefined,
    })
    if (this.isStale(operation) || !this.isCurrentSelection(selectionGeneration, artifactId)) return
    try {
      const result = await this.remote.detail(artifactId, operation.controller.signal)
      if (this.isStale(operation) || !this.isCurrentSelection(selectionGeneration, artifactId)) return
      if (!result.ok || result.value.id !== artifactId) {
        this.snapshot.replaceReady({ detailLoading: false, detailError: errorText(failed(result)) })
        return
      }
      this.snapshot.replaceReady({ detail: result.value, detailLoading: false, detailError: undefined })
      if (result.value.latestStatus === 'pending' || result.value.latestStatus === 'scanning') this.armPoll()
    } catch {
      if (!operation.controller.signal.aborted && !this.isStale(operation)) {
        this.snapshot.replaceReady({ detailLoading: false, detailError: errorText(undefined) })
      }
    }
  }

  /** 返回资料列表并撤销详情和预览读取。 */
  backToList(): void {
    this.invalidateSelection()
    this.snapshot.replaceReady({
      selectedId: undefined, detail: undefined, detailLoading: false, detailError: undefined, preview: undefined, citation: undefined,
    })
    this.armPollIfNeeded()
  }

  /** Session citation 范围变化时取消 handoff 并丢弃 locator 与短期 URL。 */
  cancelCitation(): void {
    const generation = this.citationSelectionGeneration
    if (generation === undefined) return
    this.citationSelectionGeneration = undefined
    if (generation !== this.selectionGeneration) return
    this.invalidateSelection()
    this.snapshot.replaceReady({
      selectedId: undefined, detail: undefined, detailLoading: false, detailError: undefined,
      preview: undefined, citation: undefined,
    })
    this.armPollIfNeeded()
  }

  /**
   * 创建一份新资料；同名文件不自动合并。
   * @param file 用户明确选择的正文。
   */
  upload(file: File): Promise<void> {
    return this.trackOperation(() => this.performUpload(file, undefined))
  }

  /**
   * 从当前详情显式追加不可变版本。
   * @param file 用户明确选择的新版本正文。
   */
  uploadNewVersion(file: File): Promise<void> {
    return this.trackOperation(() => {
      const state = this.snapshot.getSnapshot()
      if (state.phase !== 'ready' || state.selectedId === undefined) return Promise.resolve()
      return this.performUpload(file, state.selectedId)
    })
  }

  /**
   * 为失败版本请求服务端重新扫描。
   * @param versionId 当前详情中的失败版本 ID。
   */
  retry(versionId: string): Promise<void> {
    return this.trackOperation(() => this.performRetry(versionId))
  }

  private async performRetry(versionId: string): Promise<void> {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready' || state.detail?.versions.some(version => version.id === versionId && version.status === 'failed') !== true) return
    const artifactId = state.detail.id
    const artifactOperationGeneration = this.invalidateArtifactOperation()
    const operation = this.begin('detail')
    if (operation === undefined) return
    this.snapshot.replaceReady({ detailError: undefined })
    if (this.isStale(operation) || artifactOperationGeneration !== this.artifactOperationGeneration) return
    try {
      const result = await this.remote.retry(versionId, this.idempotencyKey(), operation.controller.signal)
      if (this.isStale(operation) || artifactOperationGeneration !== this.artifactOperationGeneration) return
      if (!result.ok) {
        this.snapshot.replaceReady({ detailError: errorText(result.error.code) })
        this.armPollIfNeeded()
        return
      }
      if (result.value.id !== artifactId) {
        this.snapshot.replaceReady({ detailError: errorText(undefined) })
        this.armPollIfNeeded()
        return
      }
      this.invalidateArtifactOperation()
      this.publishDetail(result.value)
      this.armPollIfNeeded()
    } catch {
      if (!operation.controller.signal.aborted && !this.isStale(operation)
        && artifactOperationGeneration === this.artifactOperationGeneration) {
        this.snapshot.replaceReady({ detailError: errorText(undefined) })
        this.armPollIfNeeded()
      }
    }
  }

  /**
   * 只为 clean 且 MIME 白名单内的版本请求短期预览地址。
   * @param versionId 当前详情的版本 ID。
   */
  openPreview(versionId: string): Promise<void> {
    return this.trackOperation(() => this.loadPreview(versionId))
  }

  private async loadPreview(versionId: string): Promise<void> {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready') return
    const version = state.detail?.versions.find(item => item.id === versionId)
    const kind = version?.status === 'clean' ? previewKind(version.contentType) : undefined
    if (version === undefined || kind === undefined) return
    const operation = this.begin('read')
    if (operation === undefined) return
    this.snapshot.replaceReady({ detailError: undefined })
    if (this.isStale(operation)) return
    try {
      const result = await this.remote.preview(versionId, operation.controller.signal)
      if (this.isStale(operation)) return
      if (!result.ok) {
        this.snapshot.replaceReady({ detailError: '预览暂时不可用' })
        return
      }
      if (kind === 'text') {
        const text = await this.readText(result.value.url, operation.controller.signal)
        if (this.isStale(operation)) return
        this.snapshot.replaceReady({ preview: { versionId, filename: version.originalFilename, kind, url: result.value.url, text } })
      } else {
        this.snapshot.replaceReady({ preview: { versionId, filename: version.originalFilename, kind, url: result.value.url } })
      }
    } catch {
      if (!operation.controller.signal.aborted && !this.isStale(operation)) {
        this.snapshot.replaceReady({ detailError: '预览暂时不可用' })
      }
    }
  }

  /** 关闭预览并立即丢弃短期读取地址和正文。 */
  closePreview(): void {
    this.readOperation?.abort()
    this.readOperation = undefined
    this.snapshot.replaceReady({ preview: undefined })
  }

  /**
   * 为 clean 版本请求一次下载地址并交给浏览器导航。
   * @param versionId 当前详情中的版本 ID。
   */
  download(versionId: string): Promise<void> {
    return this.trackOperation(() => this.performDownload(versionId))
  }

  private async performDownload(versionId: string): Promise<void> {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready' || state.detail?.versions.some(version => version.id === versionId && version.status === 'clean') !== true) return
    const operation = this.begin('read')
    if (operation === undefined) return
    this.snapshot.replaceReady({ detailError: undefined })
    if (this.isStale(operation)) return
    try {
      const result = await this.remote.download(versionId, operation.controller.signal)
      if (this.isStale(operation)) return
      if (!result.ok) {
        this.snapshot.replaceReady({ detailError: '下载暂时不可用' })
        return
      }
      this.openUrl(result.value.url)
    } catch {
      if (!operation.controller.signal.aborted && !this.isStale(operation)) {
        this.snapshot.replaceReady({ detailError: '下载暂时不可用' })
      }
    }
  }

  /**
   * 先封闭发布并清空内存，再等待已取消任务收敛。
   * @returns 所有在途控制器任务静默结束后的 Promise。
   */
  dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true
      this.invalidate()
      ++this.epoch
      this.snapshot.replace({ phase: 'empty', accountId: undefined, contextKey: undefined })
    }
    return this.disposal ??= this.waitForQuiescence()
  }

  private async performUpload(file: File, artifactId: string | undefined): Promise<void> {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready') return
    if (file.size > MAX_ARTIFACT_BYTES) {
      this.snapshot.replaceReady({ uploadError: '单个文件不能超过 50 MiB' })
      return
    }
    const artifactOperationGeneration = this.invalidateArtifactOperation()
    const operation = this.begin('upload')
    if (operation === undefined) return
    const idempotencyKey = this.idempotencyKey()
    const input = { filename: file.name, size: file.size, idempotencyKey }
    this.snapshot.replaceReady({ upload: { filename: file.name, progress: 0, phase: 'authorizing' }, uploadError: undefined })
    if (this.isStale(operation) || artifactOperationGeneration !== this.artifactOperationGeneration) return
    try {
      const authorization = artifactId === undefined
        ? await this.remote['create-upload'](input, operation.controller.signal)
        : await this.remote['create-version-upload'](artifactId, input, operation.controller.signal)
      if (this.isStale(operation) || artifactOperationGeneration !== this.artifactOperationGeneration) return
      if (!authorization.ok) {
        this.snapshot.replaceReady({ upload: undefined, uploadError: errorText(authorization.error.code) })
        this.armPollIfNeeded()
        return
      }
      this.snapshot.replaceReady({ upload: { filename: file.name, progress: 0, phase: 'putting' } })
      if (this.isStale(operation) || artifactOperationGeneration !== this.artifactOperationGeneration) return
      await this.transport.put(authorization.value.putUrl, file, operation.controller.signal, (loaded, total) => {
        if (!this.isStale(operation) && artifactOperationGeneration === this.artifactOperationGeneration) {
          this.snapshot.replaceReady({ upload: { filename: file.name, progress: total === 0 ? 0 : loaded / total, phase: 'putting' } })
        }
      })
      if (this.isStale(operation) || artifactOperationGeneration !== this.artifactOperationGeneration) return
      const sha256 = await this.transport.digest(file)
      if (this.isStale(operation) || artifactOperationGeneration !== this.artifactOperationGeneration) return
      this.snapshot.replaceReady({ upload: { filename: file.name, progress: 1, phase: 'completing' } })
      if (this.isStale(operation) || artifactOperationGeneration !== this.artifactOperationGeneration) return
      const completed = await this.remote['complete-upload'](authorization.value.id, {
        size: file.size, sha256, idempotencyKey,
      }, operation.controller.signal)
      if (this.isStale(operation) || artifactOperationGeneration !== this.artifactOperationGeneration) return
      if (!completed.ok) {
        this.snapshot.replaceReady({ upload: undefined, uploadError: errorText(completed.error.code) })
        this.armPollIfNeeded()
        return
      }
      if (artifactId !== undefined && completed.value.id !== artifactId) {
        this.snapshot.replaceReady({ upload: undefined, uploadError: errorText(undefined) })
        this.armPollIfNeeded()
        return
      }
      this.invalidateArtifactOperation()
      this.publishDetail(completed.value)
      this.snapshot.replaceReady({ upload: { filename: file.name, progress: 1, phase: 'complete' } })
      this.armPollIfNeeded()
    } catch {
      if (!operation.controller.signal.aborted && !this.isStale(operation)
        && artifactOperationGeneration === this.artifactOperationGeneration) {
        this.snapshot.replaceReady({ upload: undefined, uploadError: '上传未完成，请重新选择文件' })
        this.armPollIfNeeded()
      }
    }
  }

  private publishDetail(detail: XAgentArtifactDetail): void {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready') return
    this.snapshot.replace({
      ...state,
      items: replaceSummary(state.items, detail),
      selectedId: detail.id,
      detail,
      detailLoading: false,
      detailError: undefined,
      preview: undefined,
      citation: undefined,
    })
  }

  private armPoll(): void {
    if (this.pollHandle !== undefined || this.disposed) return
    this.pollHandle = this.schedule(() => {
      this.pollHandle = undefined
      void this.trackOperation(() => this.poll())
    })
  }

  private async poll(): Promise<void> {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready') return
    const operation = this.begin('poll')
    if (operation === undefined) return
    const selectedId = state.selectedId
    const selectionGeneration = this.selectionGeneration
    const artifactOperationGeneration = this.artifactOperationGeneration
    try {
      const listPromise = this.remote.list(operation.controller.signal)
      const detailPromise = selectedId === undefined || this.isStale(operation)
        || !this.isCurrentPoll(selectionGeneration, artifactOperationGeneration, selectedId)
        ? Promise.resolve(undefined)
        : this.remote.detail(selectedId, operation.controller.signal)
      const [listResult, detailResult] = await Promise.allSettled([
        listPromise,
        detailPromise,
      ])
      if (this.isStale(operation)
        || !this.isCurrentPoll(selectionGeneration, artifactOperationGeneration, selectedId)) return
      if (listResult.status === 'rejected' || detailResult.status === 'rejected') {
        this.armPoll()
        return
      }
      const list = listResult.value
      const detail = detailResult.value
      if (list.ok) this.snapshot.replaceReady({ items: list.value })
      if (detail?.ok === true && selectedId !== undefined
        && detail.value.id === selectedId && this.isCurrentSelection(selectionGeneration, selectedId)
        && this.isCurrentPoll(selectionGeneration, artifactOperationGeneration, selectedId)) {
        this.snapshot.replaceReady({ detail: detail.value })
      }
      this.armPollIfNeeded()
    } catch {
      if (!operation.controller.signal.aborted && !this.isStale(operation)) this.armPoll()
    }
  }

  private begin(kind: 'detail' | 'upload' | 'read' | 'poll'): Operation | undefined {
    const state = this.snapshot.getSnapshot()
    if (state.phase !== 'ready' || state.accountId === undefined || state.contextKey === undefined || this.disposed) return undefined
    const key = `${kind}Operation` as const
    const previous = this[key]
    previous?.abort()
    const controller = new AbortController()
    this[key] = controller
    return { controller, epoch: this.epoch, accountId: state.accountId, contextKey: state.contextKey }
  }

  private stale(epoch: number, accountId: string, key: string): boolean {
    const state = this.snapshot.getSnapshot()
    return this.disposed || epoch !== this.epoch || state.accountId !== accountId || state.contextKey !== key
  }

  private isStale(operation: Operation): boolean {
    return operation.controller.signal.aborted || this.stale(operation.epoch, operation.accountId, operation.contextKey)
  }

  private isCurrentSelection(generation: number, artifactId: string): boolean {
    const state = this.snapshot.getSnapshot()
    return generation === this.selectionGeneration && state.phase === 'ready' && state.selectedId === artifactId
  }

  private isCurrentPoll(
    selectionGeneration: number,
    artifactOperationGeneration: number,
    selectedId: string | undefined,
  ): boolean {
    const state = this.snapshot.getSnapshot()
    return selectionGeneration === this.selectionGeneration
      && artifactOperationGeneration === this.artifactOperationGeneration
      && state.phase === 'ready'
      && state.selectedId === selectedId
  }

  private invalidateArtifactOperation(): number {
    ++this.artifactOperationGeneration
    this.pollOperation?.abort()
    this.pollOperation = undefined
    if (this.pollHandle !== undefined) {
      this.cancelSchedule(this.pollHandle)
      this.pollHandle = undefined
    }
    return this.artifactOperationGeneration
  }

  private invalidateSelection(): number {
    this.citationSelectionGeneration = undefined
    ++this.selectionGeneration
    this.detailOperation?.abort()
    this.readOperation?.abort()
    this.detailOperation = undefined
    this.readOperation = undefined
    this.invalidateArtifactOperation()
    return this.selectionGeneration
  }

  private armPollIfNeeded(): void {
    const state = this.snapshot.getSnapshot()
    if (state.phase === 'ready' && (state.items.some(item => item.latestStatus === 'pending' || item.latestStatus === 'scanning')
      || state.detail?.latestStatus === 'pending' || state.detail?.latestStatus === 'scanning')) this.armPoll()
  }

  private track(task: Promise<void>): Promise<void> {
    const tracked = task.finally(() => { this.activeTasks.delete(tracked) })
    this.activeTasks.add(tracked)
    return tracked
  }

  private trackOperation(operation: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const settlement = Promise.withResolvers<void>()
    const tracked = this.track(settlement.promise)
    try {
      void operation().then(settlement.resolve, settlement.reject)
    } catch (error) {
      settlement.reject(error)
    }
    return tracked
  }

  private async waitForQuiescence(): Promise<void> {
    while (this.activeTasks.size > 0) {
      await Promise.allSettled([...this.activeTasks])
    }
  }

  private invalidate(): void {
    this.listOperation?.abort()
    this.uploadOperation?.abort()
    this.listOperation = undefined
    this.uploadOperation = undefined
    this.invalidateSelection()
  }
}
