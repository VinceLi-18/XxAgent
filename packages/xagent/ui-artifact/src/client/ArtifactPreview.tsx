import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { XAgentArtifactPreviewState } from './store.ts'
import css from './artifact.module.css'

/** 安全预览全屏层的 props。 */
export interface ArtifactPreviewProps {
  readonly preview: XAgentArtifactPreviewState
  readonly onClose: () => void
}

/** 只按控制器已判定的 pdf、image 或 text 方式渲染短期读取结果。 */
export function ArtifactPreview({ preview, onClose }: ArtifactPreviewProps) {
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
      {preview.kind === 'pdf' && <iframe
        src={preview.url}
        title={`${preview.filename} 预览`}
        referrerPolicy="no-referrer"
      />}
      {preview.kind === 'image' && <img src={preview.url} alt={`${preview.filename} 预览`} referrerPolicy="no-referrer" />}
      {preview.kind === 'text' && <pre>{preview.text}</pre>}
    </div>
  </Modal>
}
