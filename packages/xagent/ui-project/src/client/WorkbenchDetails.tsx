import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { XAgentWorkbenchDetailsTab, XAgentWorkbenchState } from './store.ts'
import { projectLocale as text } from './locales.ts'
import css from './project.module.css'

export interface WorkbenchDetailsInjected {
  hooks: {
    workbench: HostObservable<XAgentWorkbenchState>
    detailsTab: HostObservable<XAgentWorkbenchDetailsTab>
  }
  loadProject(projectId: string): Promise<void>
  selectDetailsTab(tab: XAgentWorkbenchDetailsTab): void
}

export type WorkbenchDetailsProps =
  & PropsRuntime<'shell.details'>
  & PropsRenderSlots<'xagent.workbench.artifacts'>
  & InjectFace<WorkbenchDetailsInjected>

const DETAILS_TABS: readonly (readonly [XAgentWorkbenchDetailsTab, string])[] = [
  ['overview', text.overview],
  ['artifacts', text.artifacts],
  ['inbox', text.inbox],
]

export function WorkbenchDetails({
  useWorkbench, useDetailsTab, loadProject, selectDetailsTab, renderSlot,
}: WorkbenchDetailsProps) {
  const state = useWorkbench(value => value)
  const requestedTab = useDetailsTab(value => value)
  const [tab, setTab] = useState<XAgentWorkbenchDetailsTab>(requestedTab)
  const tabRefs = useRef(new Map<XAgentWorkbenchDetailsTab, HTMLButtonElement>())
  const projectId = state.phase === 'ready' && state.context.kind === 'project' ? state.context.projectId : undefined
  const loadedProjectId = state.phase === 'ready' ? state.projectDetail?.id : undefined
  useEffect(() => {
    if (projectId !== undefined && loadedProjectId !== projectId) void loadProject(projectId)
  }, [loadProject, loadedProjectId, projectId])
  useEffect(() => { setTab(requestedTab) }, [requestedTab])
  if (state.phase !== 'ready') return <p className={css.status}>正在加载详情…</p>

  const heading = state.context.kind === 'workbench'
    ? text.workbench
    : state.projects.find(project => project.id === state.context.projectId)?.name ?? '项目'
  let overview
  if (state.context.kind === 'workbench') {
    overview = <dl>
      <div><dt>可访问项目</dt><dd>{state.projects.length}</dd></div>
      <div><dt>私有会话</dt><dd>{state.sessionSummary.privateCount}</dd></div>
    </dl>
  } else {
    const summary = state.projects.find(project => project.id === state.context.projectId)
    const detail = state.projectDetail?.id === state.context.projectId ? state.projectDetail : undefined
    overview = <dl>
      <div><dt>创建时间</dt><dd>{summary?.createdAt.slice(0, 10) ?? '—'}</dd></div>
      <div><dt>当前权限</dt><dd>{detail === undefined ? '加载中' : detail.canEdit ? '可编辑' : '只读'}</dd></div>
      <div><dt>项目会话</dt><dd>{detail?.sessionCount ?? state.sessionSummary.projectCounts[state.context.projectId] ?? 0}</dd></div>
    </dl>
  }

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number
    switch (event.key) {
      case 'ArrowRight': nextIndex = (index + 1) % DETAILS_TABS.length; break
      case 'ArrowLeft': nextIndex = (index - 1 + DETAILS_TABS.length) % DETAILS_TABS.length; break
      case 'Home': nextIndex = 0; break
      case 'End': nextIndex = DETAILS_TABS.length - 1; break
      default: return
    }
    event.preventDefault()
    const nextEntry = DETAILS_TABS[nextIndex]
    if (nextEntry === undefined) return
    const next = nextEntry[0]
    setTab(next)
    selectDetailsTab(next)
    tabRefs.current.get(next)?.focus()
  }

  return <aside className={css.details}>
    <h2>{heading}</h2>
    <div className={css.tabs} role="tablist" aria-label="工作台详情">
      {DETAILS_TABS.map(([id, label], index) => <button
        ref={(node) => {
          if (node === null) tabRefs.current.delete(id)
          else tabRefs.current.set(id, node)
        }}
        key={id}
        type="button"
        role="tab"
        aria-selected={tab === id}
        aria-controls={`xagent-workbench-${id}`}
        tabIndex={tab === id ? 0 : -1}
        onKeyDown={(event) => { onTabKeyDown(event, index) }}
        onClick={() => { setTab(id); selectDetailsTab(id) }}
      >{label}</button>)}
    </div>
    {tab === 'overview' && <section id="xagent-workbench-overview" role="tabpanel" aria-label={text.overview}>
      {overview}
    </section>}
    {tab === 'artifacts' && <section id="xagent-workbench-artifacts" role="tabpanel" aria-label={text.artifacts}>
      {renderSlot('xagent.workbench.artifacts', {}) ?? <p className={css.empty}>{text.emptyArtifacts}</p>}
    </section>}
    {tab === 'inbox' && <section id="xagent-workbench-inbox" role="tabpanel" aria-label={text.inbox}>
      <p>{text.emptyInbox}</p>
    </section>}
  </aside>
}
