// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  XAgentArtifactDetail,
  XAgentArtifactSummary,
  XAgentArtifactUpload,
} from '@xagent/dsh-artifact/types'
import {
  MAX_ARTIFACT_BYTES,
  XAgentArtifactController,
  createBrowserArtifactTransport,
  type XAgentArtifactRemoteClient,
} from '../src/client/service.ts'

const ACCOUNT_A = '00000000-0000-0000-0000-000000000101'
const ACCOUNT_B = '00000000-0000-0000-0000-000000000102'
const PROJECT_A = '00000000-0000-0000-0000-000000000201'
const ARTIFACT_A = '00000000-0000-0000-0000-000000000301'
const VERSION_CLEAN = '00000000-0000-0000-0000-000000000401'
const VERSION_PENDING = '00000000-0000-0000-0000-000000000402'
const VERSION_FAILED = '00000000-0000-0000-0000-000000000403'
const UPLOAD_ID = '00000000-0000-0000-0000-000000000501'

const cleanSummary: XAgentArtifactSummary = {
  id: ARTIFACT_A,
  displayName: '季度报告.pdf',
  scope: { kind: 'private' },
  latestVersion: 1,
  latestStatus: 'clean',
  latestCleanVersion: 1,
}

function detail(status: 'pending' | 'scanning' | 'clean' | 'quarantined' | 'failed', contentType = 'application/pdf'): XAgentArtifactDetail {
  return {
    ...cleanSummary,
    latestVersion: status === 'clean' ? 1 : 2,
    latestStatus: status,
    latestCleanVersion: 1,
    canEdit: true,
    versions: [
      {
        id: status === 'clean' ? VERSION_CLEAN : status === 'failed' ? VERSION_FAILED : VERSION_PENDING,
        version: status === 'clean' ? 1 : 2,
        originalFilename: '季度报告.pdf',
        uploadedBy: ACCOUNT_A,
        size: 16,
        contentType,
        sha256: 'a'.repeat(64),
        status,
        createdAt: '2026-08-26T08:00:00Z',
      },
      ...(status === 'clean' ? [] : [{
        id: VERSION_CLEAN,
        version: 1,
        originalFilename: '季度报告.pdf',
        uploadedBy: ACCOUNT_A,
        size: 8,
        contentType: 'application/pdf',
        sha256: 'b'.repeat(64),
        status: 'clean' as const,
        createdAt: '2026-08-25T08:00:00Z',
      }]),
    ],
  }
}

const ok = <T>(value: T): Promise<RemoteResult<T>> => Promise.resolve({ ok: true, value })

function remote(initial: readonly XAgentArtifactSummary[] = [cleanSummary]) {
  const list = vi.fn((_signal?: AbortSignal) => ok(initial))
  const artifactDetail = vi.fn((_artifactId: string, _signal?: AbortSignal) => ok(detail('clean')))
  const retry = vi.fn(() => ok(detail('pending')))
  const preview = vi.fn(() => ok({ url: '/preview/opaque' }))
  const download = vi.fn(() => ok({ url: '/download/opaque' }))
  const upload: XAgentArtifactUpload = { id: UPLOAD_ID, putUrl: '/put/opaque', expiresAt: '2026-08-26T09:00:00Z' }
  const client: XAgentArtifactRemoteClient = {
    list,
    detail: artifactDetail,
    'create-upload': vi.fn(() => ok(upload)),
    'create-version-upload': vi.fn(() => ok(upload)),
    'complete-upload': vi.fn(() => ok(detail('pending'))),
    retry,
    preview,
    download,
  }
  return { client, list, artifactDetail, retry, preview, download }
}

function file(name = '季度报告.pdf', size = 16, type = 'application/pdf'): File {
  return new File([new Uint8Array(size)], name, { type })
}

describe('XAgent 资料控制器', () => {
  it('账号切换立即清空内存、取消旧请求并丢弃迟到列表', async () => {
    const first = Promise.withResolvers<RemoteResult<readonly XAgentArtifactSummary[]>>()
    const second = Promise.withResolvers<RemoteResult<readonly XAgentArtifactSummary[]>>()
    const list = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const { client } = remote([])
    client.list = list
    const controller = new XAgentArtifactController(client)

    const alice = controller.setScope(ACCOUNT_A, { kind: 'workbench' })
    const aliceSignal = list.mock.calls[0]![0] as AbortSignal
    const bob = controller.setScope(ACCOUNT_B, { kind: 'workbench' })
    expect(aliceSignal.aborted).toBe(true)
    expect(controller.snapshot.getSnapshot()).toMatchObject({ phase: 'loading', accountId: ACCOUNT_B })

    first.resolve({ ok: true, value: [cleanSummary] })
    second.resolve({ ok: true, value: [] })
    await Promise.all([alice, bob])
    expect(controller.snapshot.getSnapshot()).toMatchObject({ phase: 'ready', accountId: ACCOUNT_B, items: [] })
  })

  it('项目切换取消旧列表与详情并只发布新范围响应', async () => {
    const oldDetail = Promise.withResolvers<RemoteResult<XAgentArtifactDetail>>()
    const { client, list, artifactDetail } = remote([cleanSummary])
    artifactDetail.mockImplementationOnce(() => oldDetail.promise)
    const controller = new XAgentArtifactController(client)
    await controller.setScope(ACCOUNT_A, { kind: 'workbench' })
    const selecting = controller.selectArtifact(ARTIFACT_A)
    const detailSignal = (artifactDetail.mock.calls as unknown as readonly [string, AbortSignal][])[0]![1]

    await controller.setScope(ACCOUNT_A, { kind: 'project', projectId: PROJECT_A })
    expect(detailSignal.aborted).toBe(true)
    oldDetail.resolve({ ok: true, value: detail('clean') })
    await selecting
    expect(list).toHaveBeenCalledTimes(2)
    expect(controller.snapshot.getSnapshot()).toMatchObject({ contextKey: `project:${PROJECT_A}`, selectedId: undefined })
  })

  it('账号切换取消进行中的 PUT，且旧上传不能发布完成状态', async () => {
    const { client } = remote([])
    let putSignal: AbortSignal | undefined
    const transport = {
      put: vi.fn((_url: string, _file: File, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
        putSignal = signal
        signal.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      })),
      digest: vi.fn(async () => 'e'.repeat(64)),
    }
    const controller = new XAgentArtifactController(client, transport)
    await controller.setScope(ACCOUNT_A, { kind: 'workbench' })
    const uploading = controller.upload(file())
    await vi.waitFor(() => { expect(transport.put).toHaveBeenCalledTimes(1) })

    await controller.setScope(ACCOUNT_B, { kind: 'workbench' })
    expect(putSignal?.aborted).toBe(true)
    await uploading
    expect(client['complete-upload']).not.toHaveBeenCalled()
    const state = controller.snapshot.getSnapshot()
    expect(state).toMatchObject({ phase: 'ready', accountId: ACCOUNT_B })
    expect(state.phase === 'ready' ? state.upload : undefined).toBeUndefined()
  })

  it('不访问浏览器持久存储', async () => {
    vi.stubGlobal('indexedDB', { open: vi.fn() })
    const local = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('localStorage accessed') })
    const session = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('sessionStorage accessed') })
    const indexed = vi.spyOn(globalThis.indexedDB, 'open').mockImplementation(() => { throw new Error('IndexedDB accessed') })
    const { client } = remote([])
    const controller = new XAgentArtifactController(client)
    await expect(controller.setScope(ACCOUNT_A, { kind: 'workbench' })).resolves.toBeUndefined()
    expect(local).not.toHaveBeenCalled()
    expect(session).not.toHaveBeenCalled()
    expect(indexed).not.toHaveBeenCalled()
  })

  it('在签发上传前拒绝超过 50 MiB 的文件', async () => {
    const { client } = remote()
    const controller = new XAgentArtifactController(client)
    await controller.setScope(ACCOUNT_A, { kind: 'workbench' })
    await controller.upload(file('过大.pdf', MAX_ARTIFACT_BYTES + 1))
    expect(client['create-upload']).not.toHaveBeenCalled()
    expect(controller.snapshot.getSnapshot()).toMatchObject({ uploadError: '单个文件不能超过 50 MiB' })
  })

  it('使用真实 PUT 进度，完成后保留 pending 并轮询到 clean', async () => {
    const { client, list, artifactDetail } = remote([])
    const put = vi.fn(async (_url: string, _file: File, _signal: AbortSignal, progress: (loaded: number, total: number) => void) => {
      progress(4, 16)
      progress(16, 16)
    })
    const digest = vi.fn(async () => 'c'.repeat(64))
    const poll = Promise.withResolvers<undefined>()
    const controller = new XAgentArtifactController(client, { put, digest }, {
      schedule: (callback) => { void poll.promise.then(callback); return 1 },
      cancelSchedule: vi.fn(),
      idempotencyKey: () => 'stable-key',
    })
    await controller.setScope(ACCOUNT_A, { kind: 'workbench' })
    const uploading = controller.upload(file())
    await uploading

    expect(put).toHaveBeenCalledWith('/put/opaque', expect.any(File), expect.any(AbortSignal), expect.any(Function))
    expect(client['complete-upload']).toHaveBeenCalledWith(UPLOAD_ID, {
      size: 16, sha256: 'c'.repeat(64), idempotencyKey: 'stable-key',
    }, expect.any(AbortSignal))
    expect(controller.snapshot.getSnapshot()).toMatchObject({ detail: { latestStatus: 'pending' }, upload: { progress: 1 } })

    artifactDetail.mockImplementationOnce(() => ok(detail('clean')))
    list.mockImplementationOnce(() => ok([cleanSummary]))
    poll.resolve(undefined)
    await vi.waitFor(() => {
      expect(controller.snapshot.getSnapshot()).toMatchObject({ detail: { latestStatus: 'clean' } })
    })
  })

  it('同名文件仍创建新资料，只有详情内显式上传才追加版本', async () => {
    const { client } = remote([cleanSummary])
    const transport = { put: vi.fn(async () => {}), digest: vi.fn(async () => 'd'.repeat(64)) }
    const controller = new XAgentArtifactController(client, transport, { idempotencyKey: () => 'key' })
    await controller.setScope(ACCOUNT_A, { kind: 'workbench' })
    await controller.upload(file('同名.pdf'))
    await controller.upload(file('同名.pdf'))
    expect(client['create-upload']).toHaveBeenCalledTimes(2)
    expect(client['create-version-upload']).not.toHaveBeenCalled()

    await controller.selectArtifact(ARTIFACT_A)
    await controller.uploadNewVersion(file('同名.pdf'))
    expect(client['create-version-upload']).toHaveBeenCalledWith(ARTIFACT_A, {
      filename: '同名.pdf', size: 16, idempotencyKey: 'key',
    }, expect.any(AbortSignal))
  })

  it('失败版本可重试，隔离版本不可读取，旧 clean 仍为默认预览', async () => {
    const { client, artifactDetail, retry, preview } = remote([cleanSummary])
    artifactDetail.mockImplementationOnce(() => ok(detail('failed')))
    const controller = new XAgentArtifactController(client)
    await controller.setScope(ACCOUNT_A, { kind: 'workbench' })
    await controller.selectArtifact(ARTIFACT_A)
    await controller.retry(VERSION_FAILED)
    expect(retry).toHaveBeenCalledWith(VERSION_FAILED, expect.any(String), expect.any(AbortSignal))

    controller.snapshot.replaceReady({ detail: detail('quarantined') })
    await controller.openPreview(VERSION_PENDING)
    expect(preview).not.toHaveBeenCalled()
    await controller.openPreview(VERSION_CLEAN)
    expect(preview).toHaveBeenCalledWith(VERSION_CLEAN, expect.any(AbortSignal))
  })

  it('重试与下载的传输异常会留在当前详情内', async () => {
    const { client, artifactDetail, retry, download } = remote([cleanSummary])
    artifactDetail.mockImplementationOnce(() => ok(detail('failed')))
    const controller = new XAgentArtifactController(client)
    await controller.setScope(ACCOUNT_A, { kind: 'workbench' })
    await controller.selectArtifact(ARTIFACT_A)

    retry.mockRejectedValueOnce(new Error('offline'))
    await expect(controller.retry(VERSION_FAILED)).resolves.toBeUndefined()
    expect(controller.snapshot.getSnapshot()).toMatchObject({ detailError: '资料服务暂时不可用' })

    download.mockRejectedValueOnce(new Error('offline'))
    await expect(controller.download(VERSION_CLEAN)).resolves.toBeUndefined()
    expect(controller.snapshot.getSnapshot()).toMatchObject({ detailError: '下载暂时不可用' })
  })

  it.each([
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['text/html'],
    ['image/svg+xml'],
    ['application/octet-stream'],
  ])('不会为 %s 请求预览或创建 iframe 地址', async (contentType) => {
    const { client, artifactDetail, preview } = remote([cleanSummary])
    artifactDetail.mockImplementationOnce(() => ok(detail('clean', contentType)))
    const controller = new XAgentArtifactController(client)
    await controller.setScope(ACCOUNT_A, { kind: 'workbench' })
    await controller.selectArtifact(ARTIFACT_A)
    await controller.openPreview(VERSION_CLEAN)
    expect(preview).not.toHaveBeenCalled()
    expect(controller.snapshot.getSnapshot()).toMatchObject({ preview: undefined })
  })
})

describe('Browser PUT transport', () => {
  it('从 XMLHttpRequest.upload 发布真实字节进度并支持取消', async () => {
    class FakeUpload extends EventTarget {}
    class FakeXhr extends EventTarget {
      static instance: FakeXhr
      readonly upload = new FakeUpload()
      status = 204
      open = vi.fn()
      send = vi.fn(() => { FakeXhr.instance = this })
      abort = vi.fn(() => { this.dispatchEvent(new Event('abort')) })
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const transport = createBrowserArtifactTransport()
    const signal = new AbortController()
    const progress = vi.fn()
    const pending = transport.put('/put/opaque', file(), signal.signal, progress)
    const xhr = FakeXhr.instance
    xhr.upload.dispatchEvent(Object.assign(new Event('progress'), { lengthComputable: true, loaded: 8, total: 16 }))
    expect(progress).toHaveBeenCalledWith(8, 16)
    signal.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(xhr.abort).toHaveBeenCalled()
  })
})
