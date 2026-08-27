import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { XAgentWorkbenchState } from './store.ts'
import css from './project.module.css'

export interface WorkbenchOperationShieldInjected {
  hooks: { workbench: HostObservable<XAgentWorkbenchState> }
}

export type WorkbenchOperationShieldProps =
  PropsRuntime<'shell.overlay'> & InjectFace<WorkbenchOperationShieldInjected>

/** 阻止上下文提交期间从产品壳启动不属于新范围的操作。 */
export function WorkbenchOperationShield({ useWorkbench }: WorkbenchOperationShieldProps) {
  const state = useWorkbench(value => value)
  if (!state.switching && !state.creating) return null
  return <div className={css.operationShield} role="status" aria-live="polite">
    {state.switching ? '正在切换工作范围…' : '正在创建项目…'}
  </div>
}
