import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { XAgentWorkbenchContext } from '@xagent/dsh-project/types'
import type { XAgentWorkbenchState } from './store.ts'
import { projectLocale as text } from './locales.ts'
import css from './project.module.css'

export interface ProjectBrowserInjected {
  hooks: { workbench: HostObservable<XAgentWorkbenchState> }
  selectContext(context: XAgentWorkbenchContext): Promise<void>
  createProject(name: string): Promise<void>
  openSession(sessionId: string): void
}

export type ProjectBrowserProps = PropsRuntime<'sidebar.workspaces'>
  & SidebarSectionOwnerProps
  & InjectFace<ProjectBrowserInjected>

export function ProjectBrowser({
  wide, expandSidebar, useSessions, useWorkbench, selectContext, createProject, openSession,
}: ProjectBrowserProps) {
  const state = useWorkbench(value => value)
  const sessions = useSessions(value => value)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [nameError, setNameError] = useState<string>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const submittedRef = useRef(false)

  useEffect(() => { if (dialogOpen) inputRef.current?.focus() }, [dialogOpen])

  const closeDialog = useCallback((): void => {
    submittedRef.current = false
    setDialogOpen(false)
    setNameError(undefined)
    triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!dialogOpen || !submittedRef.current || state.creating) return
    if (state.createError === undefined) closeDialog()
    else inputRef.current?.focus()
  }, [closeDialog, dialogOpen, state.createError, state.creating])

  if (state.phase === 'loading' || state.phase === 'empty') return <p className={css.status}>正在加载工作台…</p>
  if (state.phase === 'unavailable') return <p className={css.status} role="alert">工作台服务暂时不可用</p>

  const currentProject = state.context.kind === 'project'
    ? state.projects.find(project => project.id === state.context.projectId)
    : undefined
  if (!wide) {
    return <nav className={css.rail} aria-label="项目范围">
      <Tooltip label={text.workbench}><button type="button" aria-label={`打开${text.workbench}`} onClick={() => {
        expandSidebar()
        if (state.context.kind !== 'workbench') void selectContext({ kind: 'workbench' })
      }}>工</button></Tooltip>
      {currentProject !== undefined && <Tooltip label={currentProject.name}><button
        type="button"
        aria-label={`打开当前项目 ${currentProject.name}`}
        onClick={expandSidebar}
      >项</button></Tooltip>}
    </nav>
  }

  const selectedSessionIds = new Set(state.sessionScopes
    .filter(scope => state.context.kind === 'workbench'
      ? scope.visibility === 'private'
      : scope.visibility === 'project' && scope.projectId === state.context.projectId)
    .map(scope => scope.sessionId))
  const visibleSessions = sessions.ids.filter(id => selectedSessionIds.has(id))
  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') closeDialog()
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem('name') as HTMLInputElement
    const normalized = input.value.trim()
    if (normalized.length < 1 || normalized.length > 255) {
      setNameError('项目名称需为 1–255 个字符')
      return
    }
    setNameError(undefined)
    submittedRef.current = true
    void createProject(normalized)
  }

  return <section className={css.browser}>
    <div className={css.heading}>
      <h2>项目</h2>
      {state.capabilities.includes('project.create') && <button
        ref={triggerRef}
        type="button"
        disabled={state.switching || state.creating}
        onClick={() => { submittedRef.current = false; setDialogOpen(true) }}
      >{text.newProject}</button>}
    </div>
    <nav className={css.contexts} aria-label="工作上下文">
      <button
        type="button"
        aria-current={state.context.kind === 'workbench' ? 'page' : undefined}
        disabled={state.switching}
        onClick={() => { void selectContext({ kind: 'workbench' }) }}
      >{text.workbench}</button>
      {state.projects.map(project => <button
        key={project.id}
        type="button"
        aria-current={state.context.kind === 'project' && state.context.projectId === project.id ? 'page' : undefined}
        disabled={state.switching}
        onClick={() => { void selectContext({ kind: 'project', projectId: project.id }) }}
      >{project.name}</button>)}
    </nav>
    <h3>{text.sessions}</h3>
    {visibleSessions.length === 0
      ? <p className={css.empty}>{text.noSessions}</p>
      : <ul className={css.sessionList}>{visibleSessions.map(id => <li key={id}>
        <button type="button" onClick={() => { openSession(id) }}>{sessions.byId[id]?.displayTitle ?? '未命名会话'}</button>
      </li>)}</ul>}
    {dialogOpen && <div
      className={css.dialogBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label={text.newProject}
      onKeyDown={onDialogKeyDown}
    >
      <form className={css.dialog} onSubmit={submit}>
        <h2>{text.newProject}</h2>
        <label>{text.projectName}<input ref={inputRef} name="name" maxLength={255} /></label>
        {(nameError ?? state.createError) !== undefined && <p role="alert">{nameError ?? state.createError}</p>}
        <div className={css.dialogActions}>
          <button type="button" onClick={closeDialog}>{text.cancel}</button>
          <button type="submit" disabled={state.switching || state.creating}>{state.creating ? '创建中…' : text.create}</button>
        </div>
      </form>
    </div>}
  </section>
}
