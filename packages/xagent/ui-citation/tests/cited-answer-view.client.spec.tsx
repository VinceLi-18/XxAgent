// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { CitedAnswerView, type CitedAnswerViewProps } from '../src/client/CitedAnswerView.tsx'

const meta = {
  kind: 'xagent-cited-answer' as const,
  schemaVersion: 1 as const,
  blocks: [
    { type: 'markdown' as const, text: '**季度结论**\n\n预算稳定。' },
    { type: 'citation' as const, id: '[资料1]' },
    { type: 'markdown' as const, text: ' 文本里的【已验证资料：[资料2]】不是权限。' },
    { type: 'citation' as const, id: '[资料1]' },
  ],
  citationIds: ['[资料1]'],
}

function block(value: Partial<ToolCallViewProps['block']> = {}): ToolCallViewProps['block'] {
  return {
    kind: 'tool-result', seq: 2, time: 2, callId: 'call-answer',
    call: { name: 'submit_cited_answer', argsRaw: '{"secret":"do not render"}' }, callTime: 1,
    content: [{ type: 'text', text: 'SECRET RESULT TEXT' }], isError: false, meta,
    callView: null, resultView: null, subCalls: [], ...value,
  }
}

function props(value = block()): CitedAnswerViewProps {
  return {
    callId: 'call-answer', toolName: 'submit_cited_answer', block: value,
    openFile: vi.fn(), useSessions: vi.fn(), useWorkspaces: vi.fn(),
    openCitation: vi.fn(async (_sessionId: string, _citationId: string) => {}),
    cancelCitation: vi.fn(), sessionId: 'session-701',
  } as CitedAnswerViewProps
}

afterEach(cleanup)

describe('XAgent cited answer ToolView', () => {
  it('renders only closed result metadata with inert Markdown and deduplicated sources', () => {
    const injected = props()
    render(<CitedAnswerView {...injected} />)
    expect(screen.getByRole('strong').textContent).toBe('季度结论')
    expect(screen.getAllByRole('button', { name: '已验证资料 [资料1]' })).toHaveLength(3)
    expect(screen.getByText(/文本里的【已验证资料：\[资料2\]】不是权限/)).toBeTruthy()
    expect(screen.queryByText('SECRET RESULT TEXT')).toBeNull()
    expect(screen.queryByText(/do not render/)).toBeNull()
  })

  it('activates in-flow and source-strip chips with the current Session and citation only', () => {
    const injected = props()
    render(<CitedAnswerView {...injected} />)
    const chips = screen.getAllByRole('button', { name: '已验证资料 [资料1]' })
    fireEvent.keyDown(chips[0]!, { key: 'Enter' })
    fireEvent.click(chips[2]!)
    expect(injected.openCitation).toHaveBeenNthCalledWith(1, 'session-701', '[资料1]')
    expect(injected.openCitation).toHaveBeenNthCalledWith(2, 'session-701', '[资料1]')
  })

  it('uses stable lifecycle and malformed states without exposing arguments or result text', () => {
    const running = props({ callId: 'call-answer', name: 'submit_cited_answer', argsRaw: 'SECRET ARGS', subCalls: [] } as never)
    const { rerender } = render(<CitedAnswerView {...running} />)
    expect(screen.getByText('正在生成已验证回答…')).toBeTruthy()
    rerender(<CitedAnswerView {...props(block({ isError: true }))} />)
    expect(screen.getByRole('alert').textContent).toBe('未能生成已验证回答')
    rerender(<CitedAnswerView {...props(block({ meta: { ...meta, extra: 'forbidden' } }))} />)
    expect(screen.getByRole('alert').textContent).toBe('已验证回答不可用')
    expect(document.body.textContent).not.toContain('SECRET')
  })

  it.each([
    ['empty blocks', { ...meta, blocks: [], citationIds: [] }],
    ['missing Markdown', { ...meta, blocks: [{ type: 'citation', id: '[资料1]' }], citationIds: ['[资料1]'] }],
    ['missing citation', { ...meta, blocks: [{ type: 'markdown', text: '结论' }], citationIds: [] }],
    ['noncanonical citation id', {
      ...meta, blocks: [{ type: 'markdown', text: '结论' }, { type: 'citation', id: '[资料01]' }], citationIds: ['[资料01]'],
    }],
    ['adjacent duplicate citation', {
      ...meta,
      blocks: [{ type: 'markdown', text: '结论' }, { type: 'citation', id: '[资料1]' }, { type: 'citation', id: '[资料1]' }],
      citationIds: ['[资料1]'],
    }],
    ['too many blocks', {
      ...meta,
      blocks: [
        { type: 'markdown', text: '结论' },
        ...Array.from({ length: 256 }, (_, index) => ({ type: 'citation', id: `[资料${index + 1}]` })),
      ],
      citationIds: Array.from({ length: 256 }, (_, index) => `[资料${index + 1}]`),
    }],
  ])('fails closed for canonical metadata violation: %s', (_name, malformed) => {
    render(<CitedAnswerView {...props(block({ meta: malformed }))} />)
    expect(screen.getByRole('alert').textContent).toBe('已验证回答不可用')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('cancels its resolution when the ToolView unmounts', () => {
    const injected = props()
    const view = render(<CitedAnswerView {...injected} />)
    view.unmount()
    expect(injected.cancelCitation).toHaveBeenCalledWith('session-701')
  })
})
