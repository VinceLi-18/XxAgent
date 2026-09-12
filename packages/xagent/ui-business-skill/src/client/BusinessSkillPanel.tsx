/** Skill release dossier: exact draft editing, isolated tests and Manager governance. */
import { useState } from 'react'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { XAgentBusinessSkillDetail, XAgentBusinessSkillDraft } from '@xagent/dsh-backend-client/types'
import type { BusinessSkillMutation, BusinessSkillMutationOutcome } from './service.ts'
import type { BusinessSkillScope, BusinessSkillState } from './store.ts'
import css from './business-skill.module.css'

/** Slot data and commands owned by the connected project controller. */
export interface BusinessSkillPanelInjected {
  hooks: { skills: HostObservable<BusinessSkillState> }
  select(slug: string): Promise<void>
  refresh(): Promise<void>
  loadMore(): Promise<void>
  loadHistory(kind: 'versions' | 'tests'): Promise<void>
  openTranscript(run: number, more?: boolean): Promise<void>
  mutate(request: BusinessSkillMutation): Promise<BusinessSkillMutationOutcome>
  retryMutation(): Promise<BusinessSkillMutationOutcome>
}
type Actions = Omit<BusinessSkillPanelInjected, 'hooks'>
type Ready = Extract<BusinessSkillState, { phase: 'ready' }>
type Props = PropsRuntime<'xagent.workbench.skills'> & InjectFace<BusinessSkillPanelInjected>
const TOOLS = [
  ['list_accessible_projects', '查看可访问项目'], ['search_artifacts', '检索项目资料'], ['propose_fact', '提交待审批事实（生产写权限）'],
] as const

function qualifyingRun(detail: XAgentBusinessSkillDetail) {
  const draft = detail.draft
  return detail.tests.find(run => run.status === 'completed' && run.terminationReason === 'completed' && run.verdict === 'pass'
    && run.draftRevision === draft?.revision && run.contentDigest === draft.contentDigest
    && run.toolPolicyDigest === draft.toolPolicyDigest)
}

function ReleaseTrack({ detail }: { detail: XAgentBusinessSkillDetail }) {
  const run = qualifyingRun(detail)
  const retired = detail.status === 'retired'
  const stages = [
    ['Draft', detail.draft === undefined ? '从已发布版本创建草稿' : `revision ${detail.draft.revision}`, detail.draft !== undefined],
    ['Test', run === undefined ? '需要当前草稿的完成测试与人工通过' : `run ${run.runNumber} · 人工通过`, run !== undefined],
    ['Publish', detail.currentVersion === undefined ? 'Manager 发布通过测试的草稿' : `v${detail.currentVersion} · 已发布`, detail.currentVersion !== undefined],
    ['Authorize', retired ? '已退役 · 不可恢复' : detail.authorized ? '已授权 · 项目成员可调用' : 'Manager 授权后可调用', detail.authorized],
  ] as const
  return <ol className={css.track} aria-label="发布流程">{stages.map(([name, status, complete]) => <li key={name} data-complete={complete} data-retired={retired}>
    <strong>{name}</strong><span>{status}</span>
  </li>)}</ol>
}

interface EditorValues {
  slug: string
  displayName: string
  description: string
  instructions: string
  tools: readonly string[]
}

function Editor({ detail, locked, mutate, initial, remember }: {
  detail?: XAgentBusinessSkillDetail & { draft: XAgentBusinessSkillDraft }
  locked: boolean
  mutate: Actions['mutate']
  initial?: EditorValues | undefined
  remember?: (values: EditorValues) => void
}) {
  const draft = detail?.draft
  const source = draft
  const [values, setValues] = useState<EditorValues>(() => initial ?? {
    slug: '', displayName: detail?.displayName ?? '', description: source?.description ?? '',
    instructions: source?.instructions ?? '', tools: source?.primaryTools ?? [],
  })
  const { slug, displayName, description, instructions, tools } = values
  const update = (patch: Partial<EditorValues>): void => {
    const next = { ...values, ...patch }
    setValues(next)
    remember?.(next)
  }
  const save = (): void => {
    const content = { displayName, description, instructions, primaryTools: [...tools].sort() }
    void mutate(detail === undefined ? { kind: 'create', input: { ...content, slug } }
      : { kind: 'draft', slug: detail.slug, input: { ...content, expectedDraftRevision: detail.draft.revision } })
  }
  return <fieldset className={css.editor} disabled={locked}>
    <legend>{detail === undefined ? '新建业务 Skill' : '草稿'}</legend>
    {detail === undefined && <label>Slug<input value={slug} onChange={(event) => { update({ slug: event.target.value }) }} placeholder="review-project-facts" /></label>}
    <label>显示名称<input value={displayName} onChange={(event) => { update({ displayName: event.target.value }) }} /></label>
    <label>目录说明<textarea value={description} onChange={(event) => { update({ description: event.target.value }) }} rows={2} /></label>
    <label>Markdown 指令<textarea className={css.markdown} value={instructions}
      onChange={(event) => { update({ instructions: event.target.value }) }} rows={9} /></label>
    <fieldset className={css.tools}><legend>允许使用的工具</legend>{TOOLS.map(([tool, label]) => <label key={tool}>
      <input type="checkbox" checked={tools.includes(tool)} onChange={(event) => {
        update({ tools: event.target.checked ? [...tools, tool] : tools.filter(item => item !== tool) })
      }} />
      <span>{label}<code>{tool}</code></span>
    </label>)}</fieldset>
    <p className={css.muted}>只读测试不会执行生产写权限。提交事实仍需事实审批。</p>
    <button type="button" disabled={!displayName.trim() || !description.trim() || !instructions.trim() || (detail === undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))} onClick={save}>
      {detail === undefined ? '创建草稿' : '保存草稿'}
    </button>
  </fieldset>
}

function Dossier({ state, detail, actions, scenario, setScenario }: {
  state: Ready
  detail: XAgentBusinessSkillDetail
  actions: Actions
  scenario: string
  setScenario: (value: string) => void
}) {
  const [confirmation, setConfirmation] = useState<{ title: string; label: string; body: string; request: BusinessSkillMutation }>()
  const draft = detail.draft
  const run = qualifyingRun(detail)
  const transcript = state.transcript
  const manager = state.scope.role === 'manager'
  const retired = detail.status === 'retired'
  const locked = state.action !== undefined || state.blocked === true || retired
  const confirm = (title: string, label: string, body: string, request: BusinessSkillMutation): void => {
    setConfirmation({ title, label, body, request })
  }
  return <article className={css.dossier} aria-label="Skill 详情">
    <header><code>/{detail.slug}</code><h3>{detail.displayName}</h3><p>{retired ? '已退役' : '使用中'} · {detail.authorized ? '已授权' : '未授权'} · {detail.currentVersion === undefined ? '尚未发布' : `v${detail.currentVersion}`}</p></header>
    <ReleaseTrack detail={detail} />
    {!retired && draft !== undefined && <Editor key={`${detail.slug}:${draft.revision}`} detail={{ ...detail, draft }} locked={locked} mutate={actions.mutate} />}
    {!retired && draft === undefined && <p role="alert">草稿不可用，请重新加载。</p>}
    {draft !== undefined && !retired && <section className={css.section} aria-label="测试草稿">
      <h4>只读测试 · <code>revision {draft.revision}</code></h4>
      <label>测试场景<textarea value={scenario} onChange={(event) => { setScenario(event.target.value) }} rows={3} disabled={locked} /></label>
      <button type="button" disabled={locked || !scenario.trim()} onClick={() => { void actions.mutate({ kind: 'test', slug: detail.slug, revision: draft.revision, policy: draft.toolPolicyDigest, scenario }) }}>运行只读测试</button>
    </section>}
    <section className={css.section} aria-label="测试历史"><h4>测试历史</h4>
      {detail.tests.length === 0 && <p className={css.muted}>暂无测试。保存草稿后运行一个场景。</p>}
      <ol className={css.history}>{detail.tests.map(test => <li key={test.runNumber}>
        <div><code>run {test.runNumber}</code> · <code>revision {test.draftRevision}</code> · {({ running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' })[test.status]}</div>
        <p>人工判定：{test.verdict === undefined ? '待判定' : test.verdict === 'pass' ? '通过' : '拒绝'} · {test.terminationReason ?? '尚未结束'}</p>
        {test.unexecutedWriteTools.length > 0 && <p className={css.warning}>测试未执行的生产写权限：{test.unexecutedWriteTools.join('、')}</p>}
        <time>{test.startedAt}</time>
        <div className={css.actions}><button type="button" onClick={() => { void actions.openTranscript(test.runNumber) }}>查看测试 run {test.runNumber}</button>
          {test.status !== 'running' && !retired && <><button type="button" disabled={locked} onClick={() => { void actions.mutate({ kind: 'verdict', slug: detail.slug, run: test.runNumber, verdict: 'pass' }) }}>人工通过 run {test.runNumber}</button>
            <button type="button" disabled={locked} onClick={() => { void actions.mutate({ kind: 'verdict', slug: detail.slug, run: test.runNumber, verdict: 'reject' }) }}>人工拒绝 run {test.runNumber}</button></>}
        </div>
      </li>)}</ol>
      {detail.nextRunCursor !== undefined && <button type="button" onClick={() => { void actions.loadHistory('tests') }}>更多测试</button>}
    </section>
    {transcript !== undefined && <section className={css.section} aria-label="测试记录"><h4>测试记录 · <code>run {transcript.test.runNumber}</code></h4>
      {transcript.events.map(event => <details key={event.sequence} open><summary>{event.eventType}</summary>
        <pre>{JSON.stringify(event.payload, null, 2)}</pre></details>)}
      <button type="button" onClick={() => { void actions.openTranscript(transcript.test.runNumber, true) }}>继续读取测试记录</button>
    </section>}
    {manager && !retired && <section className={css.section} aria-label="发布和授权"><h4>发布和授权</h4><div className={css.actions}>
      {draft !== undefined && <button type="button" disabled={locked || run === undefined} onClick={run === undefined ? undefined : () => { confirm('确认发布版本', '确认发布', `发布 /${detail.slug} 的 revision ${draft.revision}；合格测试 run ${run.runNumber}。生产写权限：${draft.primaryTools.includes('propose_fact') ? 'propose_fact（测试未执行）' : '无'}。已授权的 Skill 将在后续调用使用此版本。`, { kind: 'publish', slug: detail.slug, revision: draft.revision }) }}>发布版本</button>}
      {detail.currentVersion !== undefined && <button type="button" disabled={locked} onClick={() => { confirm(detail.authorized ? '确认取消授权' : '确认授权使用', detail.authorized ? '确认取消授权' : '确认授权', `/${detail.slug} · v${detail.currentVersion}。${detail.authorized ? '立即停止新调用；运行中的下一次工具调用将被拒绝。' : '项目成员可在项目会话中调用当前版本。'}`, { kind: 'authorization', slug: detail.slug, authorized: !detail.authorized }) }}>{detail.authorized ? '取消授权' : '授权使用'}</button>}
      <button type="button" disabled={locked} onClick={() => { confirm('确认退役 Skill', '确认退役', `/${detail.slug} 退役后不可恢复，并立即取消授权。新调用和运行中的下一次工具调用将被拒绝；历史版本和测试记录保留。`, { kind: 'retire', slug: detail.slug }) }}>退役 Skill</button>
    </div></section>}
    <section className={css.section} aria-label="版本历史"><h4>版本历史</h4><ol className={css.history}>{detail.versions.map(version => <li key={version.versionNumber}>
      <code>v{version.versionNumber}</code> · <code>revision {version.sourceDraftRevision}</code><time>{version.publishedAt}</time>
      <p>{version.description}</p><details><summary>版本指令与工具</summary><pre>{version.instructions}</pre><p>{version.completeTools.join('、')}</p></details>
      {manager && !retired && version.versionNumber !== detail.currentVersion && <button type="button" disabled={locked} onClick={() => { confirm('确认切换版本', '确认切换', `/${detail.slug} 切换至 v${version.versionNumber}，后续调用使用此版本；当前运行保持已绑定版本。`, { kind: 'version', slug: detail.slug, version: version.versionNumber }) }}>切换至 v{version.versionNumber}</button>}
    </li>)}</ol>{detail.nextVersionCursor !== undefined && <button type="button" onClick={() => { void actions.loadHistory('versions') }}>更多版本</button>}</section>
    <section className={css.section} aria-label="审计摘要"><h4>审计摘要</h4><ul className={css.history}>{detail.auditSummary.map((audit, index) => <li key={`${audit.createdAt}:${index}`}>{audit.action} · {audit.result}{audit.versionNumber !== undefined && <code> v{audit.versionNumber}</code>}<time>{audit.createdAt}</time></li>)}</ul></section>
    {confirmation !== undefined && <Modal open title={confirmation.title} closeLabel="取消操作" onClose={() => { setConfirmation(undefined) }} footer={<div className={css.actions}><button type="button" onClick={() => { setConfirmation(undefined) }}>取消</button><button type="button" disabled={locked} onClick={() => { void actions.mutate(confirmation.request); setConfirmation(undefined) }}>{confirmation.label}</button></div>}><p>{confirmation.body}</p></Modal>}
  </article>
}

/** Render the single project Skills occupant using only live controller records.
 * @param props Slot hooks and user commands.
 * @returns Accessible governance list and release dossier.
 */
export function BusinessSkillPanel({ useSkills, ...actions }: Props) {
  const state = useSkills(value => value)
  const [creating, setCreating] = useState(false)
  const [creation, setCreation] = useState<EditorValues>()
  const [scenario, setScenario] = useState('')
  const [formScope, setFormScope] = useState<BusinessSkillScope>()
  const resetForm = (): void => { setCreating(false); setCreation(undefined); setScenario('') }
  if (state.phase === 'empty' && formScope !== undefined) { setFormScope(undefined); resetForm() }
  if (state.phase === 'ready' && (formScope === undefined || formScope.accountId !== state.scope.accountId
    || formScope.projectId !== state.scope.projectId || formScope.sessionId !== state.scope.sessionId
    || formScope.generation !== state.scope.generation || formScope.role !== state.scope.role)) {
    setFormScope(state.scope); resetForm()
  }
  if (state.phase === 'empty') return <p>请选择项目会话以管理业务 Skill</p>
  if (state.phase === 'loading') return <p role="status">正在加载业务 Skill…</p>
  if (state.phase === 'error') return <div><p role="alert">{state.error}</p><button type="button" onClick={() => { void actions.refresh() }}>重新加载</button></div>
  return <div className={css.workbench}>
    <aside className={css.collection} aria-label="项目 Skill 列表"><header><h3>业务 Skills</h3><button type="button" disabled={state.action !== undefined} onClick={() => { setCreating(true) }}>新建 Skill</button></header>
      {state.items.length === 0 && <p>暂无业务 Skill。新建草稿开始测试和发布。</p>}
      <ul className={css.rows}>{state.items.map(item => <li key={item.slug}><button className={css.row} type="button" aria-current={state.selected === item.slug && !creating} disabled={state.action !== undefined} onClick={() => { setCreating(false); setScenario(''); void actions.select(item.slug) }}>
        <strong>{item.displayName}</strong><code>/{item.slug}</code><span>{item.status === 'retired' ? '已退役' : item.authorized ? '已授权' : '未授权'} · {item.currentVersion === undefined ? '未发布' : `v${item.currentVersion}`}</span>
        <small>草稿 {item.draftRevision ?? '—'} · 最近测试 {item.latestTest?.status ?? '暂无'}<time>{item.updatedAt}</time></small>
      </button></li>)}</ul>
      {state.cursor !== undefined && <button type="button" onClick={() => { void actions.loadMore() }}>更多 Skill</button>}
      <button type="button" disabled={state.action !== undefined} onClick={() => { void actions.refresh() }}>重新加载</button>
    </aside>
    <div className={css.content}>
      {state.error !== undefined && <p role="alert" className={css.error}>{state.error}</p>}
      {state.action === 'submitting' && <p role="status">正在提交，请等待服务器确认…</p>}
      {state.action === 'uncertain' && <button type="button" onClick={() => {
        void actions.retryMutation().then((outcome) => { if (creating && outcome === 'succeeded') resetForm() })
      }}>使用原请求重试</button>}
      {creating ? <Editor initial={creation} remember={setCreation} locked={state.action !== undefined || state.blocked === true}
        mutate={async (request) => {
          const outcome = await actions.mutate(request)
          if (outcome === 'succeeded') resetForm()
          return outcome
        }} />
        : state.detailLoading ? <p role="status">正在加载 Skill 详情…</p>
          : state.detail === undefined ? <p>选择 Skill 查看草稿、测试和版本。</p>
            : <Dossier key={`${state.scope.accountId}:${state.scope.projectId}:${state.detail.slug}`} state={state} detail={state.detail} actions={actions} scenario={scenario} setScenario={setScenario} />}
    </div>
  </div>
}
