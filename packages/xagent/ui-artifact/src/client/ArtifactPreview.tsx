import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { XAgentArtifactPreviewState } from './store.ts'
import css from './artifact.module.css'

/** 安全预览全屏层的 props。 */
export interface ArtifactPreviewProps {
  readonly preview: XAgentArtifactPreviewState
  readonly citation?: { readonly lineStart: number; readonly lineEnd: number } | undefined
  readonly onClose: () => void
}

/** 只按控制器已判定的 pdf、image 或 text 方式渲染短期读取结果。 */
export function ArtifactPreview({ preview, citation, onClose }: ArtifactPreviewProps) {
  return <Modal
    open
    headless
    className={css.previewDialog ?? ''}
    title={`${preview.filename} 全屏预览`}
    closeLabel="关闭预览"
    onClose={onClose}
  >
    <header className={css.previewHeader}>
      <strong>{preview.filename}</strong>
      <button type="button" aria-label="关闭预览" onClick={onClose}>关闭</button>
    </header>
    <div className={css.previewBody}>
      {citation !== undefined && <p className={css.citationLocation}>
        已定位至不可变版本，第 {citation.lineStart}–{citation.lineEnd} 行
      </p>}
      {preview.kind === 'pdf' && <iframe
        src={preview.url}
        title={`${preview.filename} 预览`}
        referrerPolicy="no-referrer"
      />}
      {preview.kind === 'image' && <img src={preview.url} alt={`${preview.filename} 预览`} referrerPolicy="no-referrer" />}
      {preview.kind === 'text' && <pre>{preview.text.split('\n').map((line, index, lines) => {
        const number = index + 1
        const selected = citation !== undefined && number >= citation.lineStart && number <= citation.lineEnd
        return <span key={number} data-citation-line={selected || undefined}>
          {line}{index + 1 < lines.length ? '\n' : undefined}
        </span>
      })}</pre>}
    </div>
  </Modal>
}
