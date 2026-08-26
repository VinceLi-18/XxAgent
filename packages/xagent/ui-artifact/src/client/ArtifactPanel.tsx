import { useEffect, useRef } from 'react'
import type { ChangeEvent } from 'react'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { XAgentArtifactVersionSummary } from '@xagent/dsh-artifact/types'
import { previewKind } from './service.ts'
import { artifactLocale as text, artifactStatusText } from './locales.ts'
import { ArtifactPreview } from './ArtifactPreview.tsx'
import type { XAgentArtifactState } from './store.ts'
import css from './artifact.module.css'

/** Artifact occupant 从控制器取得的响应式状态与动作。 */
export interface ArtifactPanelInjected {
  hooks: { artifacts: HostObservable<XAgentArtifactState> }
  selectArtifact(artifactId: string): Promise<void>
  backToList(): void
  upload(file: File): Promise<void>
  uploadNewVersion(file: File): Promise<void>
  retry(versionId: string): Promise<void>
  openPreview(versionId: string): Promise<void>
  closePreview(): void
  download(versionId: string): Promise<void>
}

export type ArtifactPanelProps = PropsRuntime<'xagent.workbench.artifacts'> & InjectFace<ArtifactPanelInjected>

function formatBytes(size: number | undefined): string {
  if (size === undefined) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`
  return `${(size / 1024 / 1024).toFixed(1)} MiB`
}

function FileInput({ label, onFile }: { label: string; onFile: (file: File) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null)
  return <>
    <button type="button" className={css.primaryAction} onClick={() => { input.current?.click() }}>{label}</button>
    <input
      ref={input}
      className={css.fileInput}
      type="file"
      aria-label={label}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        const selected = event.target.files?.[0]
        if (selected !== undefined) void onFile(selected)
        event.target.value = ''
      }}
    />
  </>
}

function UploadProgress({ state }: { state: Extract<XAgentArtifactState, { phase: 'ready' }> }) {
  if (state.upload === undefined) return state.uploadError === undefined
    ? null
    : <p className={css.error} role="alert">{state.uploadError}</p>
  const percent = Math.round(state.upload.progress * 100)
  return <div className={css.uploadState}>
    <span>{state.upload.phase === 'complete' ? '上传完成，等待服务端状态' : `正在上传 ${state.upload.filename}`}</span>
    <progress
      aria-label={`${state.upload.filename} 上传进度`}
      aria-valuenow={percent}
      value={percent}
      max={100}
    >{percent}%</progress>
  </div>
}

function VersionActions({
  version,
  retry,
  openPreview,
  rememberPreviewTrigger,
  download,
}: {
  version: XAgentArtifactVersionSummary
  retry: (versionId: string) => Promise<void>
  openPreview: (versionId: string) => Promise<void>
  rememberPreviewTrigger: (trigger: HTMLButtonElement) => void
  download: (versionId: string) => Promise<void>
}) {
  if (version.status === 'failed') {
    return <button type="button" onClick={() => { void retry(version.id) }}>重试 v{version.version} 扫描</button>
  }
  if (version.status !== 'clean') return null
  return <div className={css.versionActions}>
    {previewKind(version.contentType) !== undefined && <button
      type="button"
      onClick={(event) => {
        rememberPreviewTrigger(event.currentTarget)
        void openPreview(version.id)
      }}
    >预览安全版本 v{version.version}</button>}
    <button type="button" onClick={() => { void download(version.id) }}>下载 v{version.version}</button>
  </div>
}

/** 资料列表、逐级详情、版本历史、上传和预览入口。 */
export function ArtifactPanel(props: ArtifactPanelProps) {
  const state = props.useArtifacts(value => value)
  const returnArtifactId = useRef<string | undefined>(undefined)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const previewTrigger = useRef<HTMLButtonElement | null>(null)
  const detailHeading = useRef<HTMLHeadingElement | null>(null)
  const previousSelected = useRef<string | undefined>(undefined)
  const previousPreview = useRef(false)
  const previousUpload = useRef<string | undefined>(undefined)
  const closePreview = useRef(props.closePreview)
  closePreview.current = props.closePreview

  useEffect(() => () => { closePreview.current() }, [])

  useEffect(() => {
    if (previousSelected.current !== undefined && state.phase === 'ready' && state.selectedId === undefined) {
      const id = returnArtifactId.current
      if (id !== undefined) rowRefs.current.get(id)?.focus()
    }
    previousSelected.current = state.phase === 'ready' ? state.selectedId : undefined
  }, [state])
  useEffect(() => {
    const open = state.phase === 'ready' && state.preview !== undefined
    if (previousPreview.current && !open && previewTrigger.current?.isConnected === true) previewTrigger.current.focus()
    previousPreview.current = open
  }, [state])
  useEffect(() => {
    const phase = state.phase === 'ready' ? state.upload?.phase : undefined
    if (previousUpload.current !== 'complete' && phase === 'complete') detailHeading.current?.focus()
    previousUpload.current = phase
  }, [state])

  if (state.phase === 'empty' || state.phase === 'loading') return <p className={css.status}>{text.loading}</p>
  if (state.phase === 'unavailable') return <div className={css.error} role="alert">
    <p>{state.error}</p>
  </div>

  if (state.selectedId === undefined) {
    return <div className={css.panel}>
      <div className={css.panelHeading}>
        <div><span className={css.eyebrow}>当前范围</span><h3>资料</h3></div>
        <FileInput label={text.upload} onFile={props.upload} />
      </div>
      <UploadProgress state={state} />
      {state.items.length === 0
        ? <div className={css.emptyState}><strong>{text.empty}</strong><p>{text.emptyDirection}</p></div>
        : <ul className={css.artifactList}>
          {state.items.map(item => <li key={item.id}>
            <button
              ref={(node) => {
                if (node === null) rowRefs.current.delete(item.id)
                else rowRefs.current.set(item.id, node)
              }}
              type="button"
              aria-label={`打开资料“${item.displayName}”，${artifactStatusText(item.latestStatus)}`}
              onClick={() => {
                returnArtifactId.current = item.id
                void props.selectArtifact(item.id)
              }}
            >
              <span className={css.fileName}>{item.displayName}</span>
              <span className={css.itemMeta}>v{item.latestVersion} · {artifactStatusText(item.latestStatus)}</span>
              {item.latestCleanVersion !== undefined && item.latestCleanVersion !== item.latestVersion
                ? <span className={css.safeVersion}>安全版本 v{item.latestCleanVersion}</span>
                : null}
            </button>
          </li>)}
        </ul>}
    </div>
  }

  if (state.detailLoading || state.detail === undefined) return <div className={css.panel}>
    <button type="button" className={css.back} onClick={props.backToList}>{text.back}</button>
    {state.detailError === undefined ? <p className={css.status}>正在加载资料详情…</p> : <p className={css.error} role="alert">{state.detailError}</p>}
  </div>

  const latestClean = state.detail.latestCleanVersion === undefined
    ? undefined
    : state.detail.versions.find(version => version.version === state.detail?.latestCleanVersion && version.status === 'clean')
  return <div className={css.panel}>
    <button type="button" className={css.back} onClick={props.backToList}>{text.back}</button>
    <div className={css.detailHeading}>
      <div>
        <span className={css.eyebrow}>资料详情</span>
        <h3 ref={detailHeading} tabIndex={-1}>{state.detail.displayName}</h3>
      </div>
      {state.detail.canEdit && <FileInput label={text.uploadVersion} onFile={props.uploadNewVersion} />}
    </div>
    <UploadProgress state={state} />
    {state.detailError !== undefined && <p className={css.error} role="alert">{state.detailError}</p>}
    <div className={css.currentStatus} data-status={state.detail.latestStatus}>
      <span>{artifactStatusText(state.detail.latestStatus)}</span>
      <strong>{latestClean === undefined ? '暂无安全版本' : `安全版本 v${latestClean.version}`}</strong>
    </div>
    {latestClean !== undefined && <section className={css.safeCard} aria-label={text.currentSafe}>
      <dl>
        <div><dt>文件名</dt><dd>{latestClean.originalFilename}</dd></div>
        <div><dt>类型</dt><dd>{latestClean.contentType ?? '未知'}</dd></div>
        <div><dt>大小</dt><dd>{formatBytes(latestClean.size)}</dd></div>
        <div><dt>上传者</dt><dd>{latestClean.uploadedBy}</dd></div>
        <div><dt>时间</dt><dd>{latestClean.createdAt.slice(0, 16).replace('T', ' ')}</dd></div>
      </dl>
      <VersionActions
        version={latestClean}
        retry={props.retry}
        openPreview={props.openPreview}
        rememberPreviewTrigger={(trigger) => { previewTrigger.current = trigger }}
        download={props.download}
      />
      {previewKind(latestClean.contentType) === undefined && <p className={css.status}>{text.previewUnavailable}</p>}
    </section>}
    <section className={css.versionSection}>
      <h4>{text.versions}</h4>
      <ol className={css.versionList}>
        {state.detail.versions.map(version => <li key={version.id} data-status={version.status}>
          <div className={css.versionHeader}>
            <strong>v{version.version}</strong>
            <span>{artifactStatusText(version.status)}</span>
          </div>
          <p>{version.originalFilename} · {formatBytes(version.size)}</p>
          {version.status !== 'clean' || version.id !== latestClean?.id
            ? <VersionActions
              version={version}
              retry={props.retry}
              openPreview={props.openPreview}
              rememberPreviewTrigger={(trigger) => { previewTrigger.current = trigger }}
              download={props.download}
            />
            : null}
        </li>)}
      </ol>
    </section>
    {state.preview !== undefined && <ArtifactPreview preview={state.preview} onClose={props.closePreview} />}
  </div>
}
