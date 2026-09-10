/** XAgent Fact workbench fixed Chinese product copy. */
export const factLocale = {
  title: '事实审阅工作台', current: '当前事实', currentList: '当前事实列表', pending: '待审提案', pendingList: '待审提案列表',
  processed: '已处理提案', processedList: '已处理提案列表', empty: '当前项目会话还没有事实',
  scopeEmpty: '仅可在已连接的项目会话中审阅事实', loading: '正在加载事实…', unavailable: '事实服务暂时不可用',
  more: '加载更多', detail: '事实详情', evidence: '证据', history: '修订记录', noEvidence: 'No artifact evidence',
  approve: '批准提案', reject: '拒绝提案',
  withdraw: '撤回提案', retry: '使用原请求重试', toolRunning: '正在提交事实提案…',
  toolFailed: '事实提案未提交', toolMalformed: '事实提案结果无法验证', toolProposal: '事实提案', toolStatus: '状态',
} as const

/** Human-readable proposal status.
 * @param status Server proposal status.
 * @returns Fixed Chinese label or the unknown status unchanged.
 */
export function factStatusText(status: string): string {
  return ({ pending: '待审', confirmed: '已确认', rejected: '已拒绝', withdrawn: '已撤回', conflicted: '有冲突' } as Record<string, string>)[status] ?? status
}
