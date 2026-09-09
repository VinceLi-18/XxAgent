import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { factLocale as text, factStatusText } from './locales.ts'
import css from './fact.module.css'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** Parse only the closed public `propose_fact` result metadata. */
export function parseFactToolMeta(value: unknown): { readonly proposalId: string; readonly status: 'pending' } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 3 || record.kind !== 'xagent-fact' || record.status !== 'pending'
    || typeof record.proposalId !== 'string' || !UUID.test(record.proposalId)) return undefined
  return { proposalId: record.proposalId, status: 'pending' }
}

/** Pure ToolView card for one running or settled `propose_fact` call. */
export function FactToolCard(props: ToolCallViewProps) {
  if (!('kind' in props.block)) return <p className={css.toolStatus} role="status">{text.toolRunning}</p>
  if (props.block.isError) return <p className={css.toolStatus} role="status">{text.toolFailed}</p>
  const meta = parseFactToolMeta(props.block.meta)
  if (meta === undefined) return <p className={css.error} role="alert">{text.toolMalformed}</p>
  return <p className={css.toolStatus} role="status">
    {text.toolProposal} {meta.proposalId} · {text.toolStatus}：{factStatusText(meta.status)}
  </p>
}
