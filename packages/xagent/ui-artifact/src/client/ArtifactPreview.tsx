import { useEffect, useRef } from 'react'
import type { XAgentArtifactPreviewState } from './store.ts'
import css from './artifact.module.css'

/** 安全预览全屏层的 props。 */
export interface ArtifactPreviewProps {
  readonly preview: XAgentArtifactPreviewState
  readonly onClose: () => void
}

/** 只按控制器已判定的 pdf、image 或 text 方式渲染短期读取结果。 */
export function ArtifactPreview({ preview, onClose }: ArtifactPreviewProps) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => { dialog.current?.focus() }, [])
  return <div className={css.previewBackdrop}>
    <div
      ref={dialog}
      className={css.previewDialog}
      role="dialog"
      aria-modal="true"
      aria-label={`${preview.filename} 全屏预览`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <header className={css.previewHeader}>
        <strong>{preview.filename}</strong>
        <button type="button" aria-label="关闭预览" onClick={onClose}>关闭</button>
      </header>
      <div className={css.previewBody}>
        {preview.kind === 'pdf' && <iframe
          src={preview.url}
          title={`${preview.filename} 预览`}
          referrerPolicy="no-referrer"
        />}
        {preview.kind === 'image' && <img src={preview.url} alt={`${preview.filename} 预览`} referrerPolicy="no-referrer" />}
        {preview.kind === 'text' && <pre>{preview.text}</pre>}
      </div>
    </div>
  </div>
}
