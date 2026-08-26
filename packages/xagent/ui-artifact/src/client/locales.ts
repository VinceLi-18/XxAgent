/** XAgent 资料右栏固定中文文案。 */
export const artifactLocale = {
  upload: '上传资料',
  uploadVersion: '上传新版本',
  empty: '当前范围还没有资料',
  emptyDirection: '上传第一份资料后，扫描状态和安全版本会显示在这里。',
  loading: '正在加载资料…',
  back: '返回资料列表',
  versions: '版本历史',
  currentSafe: '当前安全版本',
  previewUnavailable: '此文件类型不支持在线预览，可在扫描通过后下载。',
} as const

/**
 * 把公开扫描状态转成一致的中文状态名。
 * @param status 服务端 ArtifactVersion 状态。
 * @returns 右栏和可访问名称共用的中文标签。
 */
export function artifactStatusText(status: 'pending' | 'scanning' | 'clean' | 'quarantined' | 'failed'): string {
  switch (status) {
    case 'pending': return '等待扫描'
    case 'scanning': return '扫描中'
    case 'clean': return '可预览'
    case 'quarantined': return '已隔离'
    case 'failed': return '扫描失败'
  }
}
