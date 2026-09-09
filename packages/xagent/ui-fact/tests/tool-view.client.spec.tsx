// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { FactToolCard, parseFactToolMeta } from '../src/client/FactToolCard.tsx'

afterEach(cleanup)

function props(block: unknown): ToolCallViewProps {
  return { block, callId: 'call', toolName: 'propose_fact', openFile: () => {} } as unknown as ToolCallViewProps
}

describe('propose_fact ToolView', () => {
  it('renders only strict closed success metadata', () => {
    render(<FactToolCard {...props({ kind: 'tool-result', isError: false, meta: { kind: 'xagent-fact', status: 'pending', proposalId: '00000000-0000-0000-0000-000000000401' }, call: { argsRaw: '{"secret":"never"}' }, content: [{ text: 'never' }] })} />)
    expect(screen.getByRole('status').textContent).toContain('已提交事实提案')
    expect(document.body.textContent).not.toContain('secret')
  })

  it('uses neutral running/error states and alerts on malformed success', () => {
    const { rerender } = render(<FactToolCard {...props({})} />)
    expect(screen.getByRole('status').textContent).toBe('正在提交事实提案…')
    rerender(<FactToolCard {...props({ kind: 'tool-result', isError: true })} />)
    expect(screen.getByRole('status').textContent).toBe('事实提案未提交')
    rerender(<FactToolCard {...props({ kind: 'tool-result', isError: false, meta: { kind: 'xagent-fact', status: 'pending', proposalId: 'bad', extra: true } })} />)
    expect(screen.getByRole('alert').textContent).toBe('事实提案结果无法验证')
    expect(parseFactToolMeta(null)).toBeUndefined()
    expect(parseFactToolMeta([])).toBeUndefined()
    expect(parseFactToolMeta({ kind: 'xagent-fact', status: 'pending', proposalId: 1 })).toBeUndefined()
  })
})
