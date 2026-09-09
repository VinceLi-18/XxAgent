import { useState } from 'react'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ProjectFactValue, XAgentFactEvidence, XAgentFactProposal, XAgentFactRevision } from '@xagent/dsh-fact/types'
import type { XAgentFactState } from './store.ts'
import { factLocale as text, factStatusText } from './locales.ts'
import css from './fact.module.css'

/** Fact occupant state and commands supplied by the lifecycle controller. */
export interface FactPanelInjected {
  hooks: { facts: HostObservable<XAgentFactState> }
  selectHead(revisionId: string): Promise<void>
  selectProposal(proposalId: string): Promise<void>
  loadMoreHeads(): Promise<void>
  loadMoreProposals(): Promise<void>
  approve(proposalId: string, decisionNote: string): Promise<void>
  reject(proposalId: string, reason: string): Promise<void>
  withdraw(proposalId: string): Promise<void>
  retryDecision(): Promise<void>
  openEvidence(sessionId: string, evidence: XAgentFactEvidence): Promise<void>
}

export type FactPanelProps = PropsRuntime<'xagent.workbench.facts'> & InjectFace<FactPanelInjected>
/** Fact detail action face without its parent observable hook. */
export type FactActions = Omit<FactPanelInjected, 'hooks'>

function formatValue(value: ProjectFactValue): string {
  switch (value.type) {
    case 'text': return value.value
    case 'number': return new Intl.NumberFormat('zh-CN').format(value.value)
    case 'boolean': return value.value ? '是' : '否'
    case 'date': return value.value
  }
}

function EvidenceList({ sessionId, items, open }: { sessionId: string; items: readonly XAgentFactEvidence[]; open: FactPanelInjected['openEvidence'] }) {
  if (items.length === 0) return <p className={css.muted}>{text.noEvidence}</p>
  return <ul className={css.evidence}>{items.map(item => <li key={`${item.citationId}:${item.chunkId}`}>
    <button type="button" onClick={() => { void open(sessionId, item) }} aria-label={`打开证据 ${item.citationId}，第 ${item.lineStart} 至 ${item.lineEnd} 行`}>
      {item.citationId} · L{item.lineStart}–{item.lineEnd}
    </button>
  </li>)}</ul>
}

function RevisionLedger({ sessionId, items, open }: { sessionId: string; items: readonly XAgentFactRevision[]; open: FactPanelInjected['openEvidence'] }) {
  return <ol className={css.ledger} aria-label={text.history}>{items.map(item => <li key={item.id}>
    <span className={css.revision}>v{item.contentRevision}</span>
    <strong>{formatValue(item.value)}</strong>
    <span className={css.ledgerMeta}>已确认 · 提案人：{item.proposerId}</span>
    <span className={css.ledgerMeta}>确认人：{item.confirmedById}</span>
    <time dateTime={item.createdAt}>{item.createdAt.slice(0, 10)}</time>
    <EvidenceList sessionId={sessionId} items={item.evidence} open={open} />
  </li>)}</ol>
}

/** Selected Fact proposal or immutable revision detail. */
export function FactDetail({ state, actions }: { state: Extract<XAgentFactState, { phase: 'ready' }>; actions: FactActions }) {
  const [dialog, setDialog] = useState<'approve' | 'reject' | 'withdraw'>()
  const [reason, setReason] = useState('')
  if (state.detailLoading) return <p role="status">正在加载详情…</p>
  if (state.detailError !== undefined) return <p role="alert" className={css.error}>{state.detailError}</p>
  const detail = state.detail
  if (detail === undefined) return <p className={css.muted}>选择一项查看服务器详情</p>
  const proposal: XAgentFactProposal | undefined = detail.kind === 'proposal' ? detail.value : undefined
  const item: XAgentFactProposal | XAgentFactRevision = detail.kind === 'proposal' ? detail.value : detail.value.revision
  const pending = proposal?.status === 'pending'
  const manager = pending && state.role === 'manager' && !state.permissionBlocked
  const proposer = pending && item.proposerId === state.actorId && !state.permissionBlocked
  const closeDialog = (): void => { setDialog(undefined) }
  const submit = (): void => {
    /* v8 ignore next -- submit is rendered only from proposal detail with an open dialog. */
    if (detail.kind !== 'proposal' || dialog === undefined) return
    if (dialog === 'approve') void actions.approve(item.id, reason)
    else if (dialog === 'reject') void actions.reject(item.id, reason)
    else void actions.withdraw(item.id)
    setDialog(undefined); setReason('')
  }
  return <article className={css.detail} aria-label={text.detail}>
    <header><span className={css.fieldKey}>{item.fieldKey}</span><h3>{item.label}</h3></header>
    <p className={css.value}>{formatValue(item.value)}</p>
    {proposal !== undefined && <><span className={css.badge}>{factStatusText(proposal.status)}</span>
      <p className={css.attribution}>提案人：{proposal.proposerId}</p>
      {proposal.assertionReason !== undefined && <p><strong>提案说明：</strong>{proposal.assertionReason}</p>}
      {proposal.decisionReason !== undefined && <p><strong>决定理由：</strong>{proposal.decisionReason}</p>}</>}
    {detail.kind === 'proposal' && <><h4>{text.evidence}</h4><EvidenceList sessionId={state.sessionId} items={item.evidence} open={actions.openEvidence} /></>}
    {detail.kind === 'revision' && <><h4>{text.history}</h4><RevisionLedger sessionId={state.sessionId} items={detail.value.history} open={actions.openEvidence} /></>}
    {(manager || proposer) && <div className={css.actions}>
      {manager && <><button type="button" onClick={() => { setDialog('approve') }}>{text.approve}</button><button type="button" onClick={() => { setDialog('reject') }}>{text.reject}</button></>}
      {proposer && <button type="button" onClick={() => { setDialog('withdraw') }}>{text.withdraw}</button>}
    </div>}
    {state.decisionError !== undefined && <p role="alert" className={css.error}>{state.decisionError}</p>}
    {state.action?.phase === 'uncertain' && <button type="button" onClick={() => { void actions.retryDecision() }}>{text.retry}</button>}
    {dialog !== undefined && <Modal
      open title={`${dialog === 'approve' ? '批准' : dialog === 'reject' ? '拒绝' : '撤回'}事实提案`}
      closeLabel="取消事实决定" onClose={closeDialog} className={css.dialog ?? ''}
      footer={<div className={css.actions}>
        <button type="button" onClick={closeDialog}>取消</button>
        <button type="button" disabled={dialog === 'reject' && reason.trim() === ''} onClick={submit}>
          {`确认${dialog === 'approve' ? '批准' : dialog === 'reject' ? '拒绝' : '撤回'}`}
        </button>
      </div>}
    >
      {dialog !== 'withdraw' && <label>
        {dialog === 'reject' ? '拒绝理由' : '决定备注'}
        <textarea value={reason} onChange={(event) => { setReason(event.target.value) }} />
      </label>}
    </Modal>}
  </article>
}

function Row({ item, proposal, selected, activate }: {
  item: XAgentFactRevision | XAgentFactProposal
  proposal: boolean
  selected: boolean
  activate: () => void
}) {
  const action = proposal ? '审阅提案' : '打开当前事实'
  return <button
    type="button" className={css.row} aria-current={selected || undefined}
    aria-label={`${action}“${item.label}”`} onClick={activate}
  >
    <span><strong>{item.label}</strong><small>{item.fieldKey}</small></span><span>{formatValue(item.value)}</span>
  </button>
}

/** Compact list/detail review surface for one authorized Project Session. */
export function FactPanel(props: FactPanelProps) {
  const state = props.useFacts(value => value)
  if (state.phase === 'empty' || state.phase === 'loading') return <p role="status">{text.loading}</p>
  if (state.phase === 'unavailable') return <p role="alert" className={css.error}>{state.error}</p>
  return <section className={css.workbench} role="region" aria-label={text.title}>
    <div className={css.collection}>
      <header><h3>{text.current}</h3><span>{state.heads.length}</span></header>
      {state.heads.map(item => <Row
        key={item.id} item={item} proposal={false} selected={state.selection?.id === item.id}
        activate={() => { void props.selectHead(item.id) }}
      />)}
      {state.headsCursor !== undefined && <button type="button" disabled={state.headsLoading} onClick={() => { void props.loadMoreHeads() }}>{text.more}</button>}
      <header><h3>{text.pending}</h3><span>{state.proposals.filter(item => item.status === 'pending').length}</span></header>
      {state.proposals.map(item => <Row
        key={item.id} item={item} proposal selected={state.selection?.id === item.id}
        activate={() => { void props.selectProposal(item.id) }}
      />)}
      {state.proposalsCursor !== undefined && <button type="button" disabled={state.proposalsLoading} onClick={() => { void props.loadMoreProposals() }}>{text.more}</button>}
      {state.heads.length === 0 && state.proposals.length === 0 && <p className={css.muted}>{text.empty}</p>}
      {state.listError !== undefined && <p role="alert" className={css.error}>{state.listError}</p>}
    </div>
    <FactDetail state={state} actions={props} />
  </section>
}
