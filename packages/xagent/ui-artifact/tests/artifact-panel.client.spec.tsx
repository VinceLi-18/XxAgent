// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { XAgentArtifactDetail, XAgentArtifactSummary } from '@xagent/dsh-artifact/types'
import { ArtifactPanel } from '../src/client/ArtifactPanel.tsx'
import { XAgentArtifactStore } from '../src/client/store.ts'

const ARTIFACT_ID = '00000000-0000-0000-0000-000000000301'
const CLEAN_VERSION_ID = '00000000-0000-0000-0000-000000000401'
const FAILED_VERSION_ID = '00000000-0000-0000-0000-000000000402'

const summary: XAgentArtifactSummary = {
  id: ARTIFACT_ID, displayName: '项目说明.pdf', scope: { kind: 'project', projectId: 'project-1' },
  latestVersion: 2, latestStatus: 'failed', latestCleanVersion: 1,
}

const detail: XAgentArtifactDetail = {
  ...summary,
  canEdit: true,
  versions: [
    {
      id: FAILED_VERSION_ID, version: 2, originalFilename: '项目说明.pdf', uploadedBy: 'alice', size: 20,
      contentType: 'application/pdf', status: 'failed', createdAt: '2026-08-26T08:00:00Z',
    },
    {
      id: CLEAN_VERSION_ID, version: 1, originalFilename: '项目说明.pdf', uploadedBy: 'alice', size: 10,
      contentType: 'application/pdf', status: 'clean', createdAt: '2026-08-25T08:00:00Z',
    },
  ],
}

function hook(store: XAgentArtifactStore) {
  return function useArtifacts<S>(selector: (value: ReturnType<XAgentArtifactStore['getSnapshot']>) => S): S {
    return selector(useSyncExternalStore(store.subscribe, store.getSnapshot))
  }
}

function props(store: XAgentArtifactStore) {
  return {
    useSessions: vi.fn() as never,
    useWorkspaces: vi.fn() as never,
    useArtifacts: hook(store),
    selectArtifact: vi.fn(async () => {}),
    backToList: vi.fn(),
    upload: vi.fn(async () => {}),
    uploadNewVersion: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    openPreview: vi.fn(async () => {}),
    closePreview: vi.fn(),
    download: vi.fn(async () => {}),
  }
}

afterEach(cleanup)

describe('资料右栏', () => {
  it('列表显示服务端扫描状态，选择后进入详情并可返回原行焦点', async () => {
    const store = new XAgentArtifactStore()
    store.replace({
      phase: 'ready', accountId: 'alice', contextKey: 'project:project-1', items: [summary], selectedId: undefined,
    })
    const injected = props(store)
    injected.selectArtifact.mockImplementation(async () => {
      store.replace({
        phase: 'ready', accountId: 'alice', contextKey: 'project:project-1', items: [summary],
        selectedId: ARTIFACT_ID, detail,
      })
    })
    render(<ArtifactPanel {...injected} />)
    const row = screen.getByRole('button', { name: /打开资料“项目说明.pdf”/ })
    fireEvent.click(row)
    expect(await screen.findByRole('heading', { name: '项目说明.pdf' })).toBeTruthy()
    expect(screen.getAllByText('扫描失败')).toHaveLength(2)
    expect(screen.getByText('安全版本 v1')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试 v2 扫描' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '返回资料列表' }))
    store.replace({
      phase: 'ready', accountId: 'alice', contextKey: 'project:project-1', items: [summary], selectedId: undefined,
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /打开资料“项目说明.pdf”/ })).toBe(document.activeElement)
    })
  })

  it('上传与上传新版本是两个明确入口，并显示可访问进度名称', () => {
    const store = new XAgentArtifactStore()
    store.replace({
      phase: 'ready', accountId: 'alice', contextKey: 'project:project-1', items: [summary], selectedId: ARTIFACT_ID,
      detail, upload: { filename: '项目说明.pdf', progress: 0.5, phase: 'putting' },
    })
    render(<ArtifactPanel {...props(store)} />)
    expect(screen.getByLabelText('上传新版本')).toBeTruthy()
    expect(screen.queryByLabelText('上传资料')).toBeNull()
    const progress = screen.getByRole('progressbar', { name: '项目说明.pdf 上传进度' })
    expect(progress.getAttribute('aria-valuenow')).toBe('50')
  })

  it('全屏预览显式打开和关闭，关闭后保留详情并恢复按钮焦点', async () => {
    const store = new XAgentArtifactStore()
    store.replace({
      phase: 'ready', accountId: 'alice', contextKey: 'project:project-1', items: [summary], selectedId: ARTIFACT_ID, detail,
    })
    const injected = props(store)
    injected.openPreview.mockImplementation(async () => {
      store.replaceReady({
        preview: { versionId: CLEAN_VERSION_ID, filename: '项目说明.pdf', kind: 'pdf', url: '/preview/opaque' },
      })
    })
    injected.closePreview.mockImplementation(() => { store.replaceReady({ preview: undefined }) })
    render(<ArtifactPanel {...injected} />)
    const trigger = screen.getByRole('button', { name: '预览安全版本 v1' })
    fireEvent.click(trigger)
    expect(await screen.findByRole('dialog', { name: '项目说明.pdf 全屏预览' })).toBeTruthy()
    expect(screen.getByTitle('项目说明.pdf 预览')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.getByRole('heading', { name: '项目说明.pdf' })).toBeTruthy()
      expect(trigger).toBe(document.activeElement)
    })
  })

  it('上传完成后把焦点落到当前资料标题', async () => {
    const store = new XAgentArtifactStore()
    store.replace({
      phase: 'ready', accountId: 'alice', contextKey: 'project:project-1', items: [summary], selectedId: ARTIFACT_ID,
      detail, upload: { filename: '项目说明.pdf', progress: 0.8, phase: 'putting' },
    })
    render(<ArtifactPanel {...props(store)} />)
    store.replaceReady({ upload: { filename: '项目说明.pdf', progress: 1, phase: 'complete' } })
    await waitFor(() => { expect(screen.getByRole('heading', { name: '项目说明.pdf' })).toBe(document.activeElement) })
  })

  it('隔离资料没有预览或下载入口，只给失败版本提供重试', () => {
    const store = new XAgentArtifactStore()
    const quarantinedSummary: XAgentArtifactSummary = {
      id: summary.id,
      displayName: summary.displayName,
      scope: summary.scope,
      latestVersion: 2,
      latestStatus: 'quarantined',
    }
    store.replace({
      phase: 'ready', accountId: 'alice', contextKey: 'workbench', items: [quarantinedSummary],
      selectedId: ARTIFACT_ID,
      detail: {
        ...quarantinedSummary,
        canEdit: true,
        versions: [{ ...detail.versions[0]!, status: 'quarantined' }],
      },
    })
    render(<ArtifactPanel {...props(store)} />)
    expect(screen.getAllByText('已隔离')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /预览|下载|重试/ })).toBeNull()
  })

  it('空范围提供上传方向，加载失败提供重试列表方向', () => {
    const store = new XAgentArtifactStore()
    store.replace({ phase: 'ready', accountId: 'alice', contextKey: 'workbench', items: [], selectedId: undefined })
    const { rerender } = render(<ArtifactPanel {...props(store)} />)
    expect(screen.getByText('当前范围还没有资料')).toBeTruthy()
    expect(screen.getByLabelText('上传资料')).toBeTruthy()
    store.replace({ phase: 'unavailable', accountId: 'alice', contextKey: 'workbench', error: '资料服务暂时不可用' })
    rerender(<ArtifactPanel {...props(store)} />)
    expect(screen.getByRole('alert').textContent).toContain('资料服务暂时不可用')
  })
})
