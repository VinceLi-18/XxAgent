import { useEffect } from 'react'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { XAgentWorkbenchState } from './store.ts'
import { projectLocale as text } from './locales.ts'
import css from './project.module.css'

export interface WorkbenchDetailsInjected {
  hooks: { workbench: HostObservable<XAgentWorkbenchState> }
  loadProject(projectId: string): Promise<void>
}

export type WorkbenchDetailsProps = PropsRuntime<'shell.details'> & InjectFace<WorkbenchDetailsInjected>

export function WorkbenchDetails({ useWorkbench, loadProject }: WorkbenchDetailsProps) {
  const state = useWorkbench(value => value)
  const projectId = state.phase === 'ready' && state.context.kind === 'project' ? state.context.projectId : undefined
  const loadedProjectId = state.phase === 'ready' ? state.projectDetail?.id : undefined
  useEffect(() => {
    if (projectId !== undefined && loadedProjectId !== projectId) void loadProject(projectId)
  }, [loadProject, loadedProjectId, projectId])
  if (state.phase !== 'ready') return <p className={css.status}>正在加载详情…</p>

  if (state.context.kind === 'workbench') {
    return <aside className={css.details}>
      <h2>{text.workbench}</h2>
      <dl>
        <div><dt>可访问项目</dt><dd>{state.projects.length}</dd></div>
        <div><dt>私有会话</dt><dd>{state.sessionSummary.privateCount}</dd></div>
      </dl>
      <section><h3>{text.inbox}</h3><p>{text.emptyInbox}</p></section>
    </aside>
  }

  const summary = state.projects.find(project => project.id === state.context.projectId)
  const detail = state.projectDetail?.id === state.context.projectId ? state.projectDetail : undefined
  return <aside className={css.details}>
    <h2>{summary?.name ?? '项目'}</h2>
    <dl>
      <div><dt>创建时间</dt><dd>{summary?.createdAt.slice(0, 10) ?? '—'}</dd></div>
      <div><dt>当前权限</dt><dd>{detail === undefined ? '加载中' : detail.canEdit ? '可编辑' : '只读'}</dd></div>
      <div><dt>项目会话</dt><dd>{detail?.sessionCount ?? state.sessionSummary.projectCounts[state.context.projectId] ?? 0}</dd></div>
    </dl>
    <section><h3>{text.inbox}</h3><p>{text.emptyInbox}</p></section>
  </aside>
}
