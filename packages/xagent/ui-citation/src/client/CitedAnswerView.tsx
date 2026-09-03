import { useEffect, type KeyboardEvent } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { XAgentCitedAnswerBlock, XAgentCitedAnswerMeta } from '@xagent/dsh-retrieval/types'
import { citationLocale as text } from './locales.ts'
import css from './citation.module.css'

/** Cited-answer ToolView 取得的最小动作。 */
export interface CitedAnswerInjected {
  readonly sessionId: string
  readonly openCitation: (sessionId: string, citationId: string) => Promise<void>
  readonly cancelCitation: (sessionId: string) => void
}

export type CitedAnswerViewProps = ToolCallViewProps & CitedAnswerInjected

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function parseMeta(value: unknown): XAgentCitedAnswerMeta | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (!exactKeys(row, ['kind', 'schemaVersion', 'blocks', 'citationIds'])
    || row.kind !== 'xagent-cited-answer' || row.schemaVersion !== 1
    || !Array.isArray(row.blocks) || !Array.isArray(row.citationIds)
    || row.citationIds.some(id => typeof id !== 'string')) return undefined
  const blocks: XAgentCitedAnswerBlock[] = []
  for (const candidate of row.blocks) {
    if (typeof candidate !== 'object' || candidate === null) return undefined
    const block = candidate as Record<string, unknown>
    if (block.type === 'markdown' && exactKeys(block, ['type', 'text']) && typeof block.text === 'string') {
      blocks.push({ type: 'markdown', text: block.text })
    } else if (block.type === 'citation' && exactKeys(block, ['type', 'id']) && typeof block.id === 'string') {
      blocks.push({ type: 'citation', id: block.id })
    } else return undefined
  }
  const firstUse = [...new Set(blocks.flatMap(block => block.type === 'citation' ? [block.id] : []))]
  if (JSON.stringify(firstUse) !== JSON.stringify(row.citationIds)) return undefined
  return { kind: 'xagent-cited-answer', schemaVersion: 1, blocks, citationIds: firstUse }
}

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
  if (props.block.isError) return <p className={css.error} role="alert">{text.failed}</p>
  const meta = parseMeta(props.block.meta)
  if (meta === undefined) return <p className={css.error} role="alert">{text.malformed}</p>
  const activate = (id: string) => { void props.openCitation(props.sessionId, id) }
  return <article className={css.answer} aria-label={text.answer}>
    <div className={css.blocks}>{meta.blocks.map((block, index) => block.type === 'markdown'
      ? <MarkdownText key={index} text={block.text} />
      : <CitationChip key={index} id={block.id} activate={() => { activate(block.id) }} />)}</div>
    <nav className={css.sources} aria-label={text.sources}>
      <span>{text.sourcesLabel}</span>
      {meta.citationIds.map(id => <CitationChip key={id} id={id} activate={() => { activate(id) }} />)}
    </nav>
  </article>
}
