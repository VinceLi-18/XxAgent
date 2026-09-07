import { useEffect, type KeyboardEvent } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { parseXAgentCitedAnswerMeta } from '@xagent/dsh-retrieval/cited-answer-meta'
import { citationLocale as text } from './locales.ts'
import css from './citation.module.css'

/** Cited-answer ToolView 取得的最小动作。 */
export interface CitedAnswerInjected {
  readonly sessionId: string
  readonly openCitation: (sessionId: string, citationId: string) => Promise<void>
  readonly cancelCitation: (sessionId: string) => void
}

export type CitedAnswerViewProps = ToolCallViewProps & CitedAnswerInjected

function CitationChip({ id, activate }: { id: string; activate: () => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    activate()
  }
  return <button type="button" className={css.chip} aria-label={`${text.source} ${id}`}
    onClick={activate} onKeyDown={onKeyDown}>{text.source} <span>{id}</span></button>
}

/**
 * 只从成功 Tool result 的封闭 metadata 渲染可验证回答。
 * @param props Tool result 和 citation 导航动作。
 * @returns 安全 Markdown、citation 按钮和去重资料栏。
 */
export function CitedAnswerView(props: CitedAnswerViewProps) {
  useEffect(() => () => { props.cancelCitation(props.sessionId) }, [props.cancelCitation, props.sessionId])
  if (!('kind' in props.block)) return <p className={css.status}>{text.running}</p>
  if (props.block.isError) return <p className={css.status} role="status">{text.failed}</p>
  const meta = parseXAgentCitedAnswerMeta(props.block.meta)
  if (meta === undefined) return <p className={css.error} role="alert">{text.malformed}</p>
  const activate = (id: string) => { void props.openCitation(props.sessionId, id) }
  return <article className={css.answer} aria-label={text.answer}>
    <div className={css.blocks}>{meta.blocks.map((block, index) => block.type === 'markdown'
      ? <MarkdownText key={index} text={block.text} linkPolicy="inert" />
      : <CitationChip key={index} id={block.id} activate={() => { activate(block.id) }} />)}</div>
    <nav className={css.sources} aria-label={text.sources}>
      <span>{text.sourcesLabel}</span>
      {meta.citationIds.map(id => <CitationChip key={id} id={id} activate={() => { activate(id) }} />)}
    </nav>
  </article>
}
