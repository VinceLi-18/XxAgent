import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { XAgentWorkbenchState } from './store.ts'
import css from './project.module.css'

export interface ContextMarkerInjected {
  hooks: { workbench: HostObservable<XAgentWorkbenchState> }
}

export type ContextMarkerProps = PropsRuntime<'conversation.context'> & InjectFace<ContextMarkerInjected>

export function ContextMarker({ useWorkbench }: ContextMarkerProps) {
  const state = useWorkbench(value => value)
  if (state.phase !== 'ready') return null
  if (state.context.kind === 'workbench') return <div className={css.marker}>我的工作台 · 跨项目</div>
  const project = state.projects.find(item => item.id === state.context.projectId)
  return <div className={css.marker}>{project?.name ?? '项目'}</div>
}
