import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
  CITED_ANSWER_MAX_BLOCKS,
  CITED_ANSWER_MAX_BYTES,
  CITED_ANSWER_MAX_CITATIONS,
  XAgentCitedAnswerError,
  normalizeCitedAnswer,
  renderCitedAnswer,
  parseXAgentCitedAnswerMeta,
  toCitedAnswerMeta,
  type XAgentCitedAnswerBlock,
} from '../src/cited-answer.ts'

const IDS = new Set(['[资料1]', '[资料2]', '[资料3]'])

function answer(blocks: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { blocks, ...extra }
}

function expectInvalid(value: unknown, allowed = IDS): void {
  try {
    normalizeCitedAnswer(value, allowed)
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(XAgentCitedAnswerError)
    expect((error as Error).message).toBe('invalid cited answer')
    expect(JSON.stringify(error)).not.toContain('rejected-secret')
    return
  }
  throw new Error('expected cited answer rejection')
}

describe('normalizeCitedAnswer', () => {
  test('accepts only replay metadata that is already canonical and bounded', () => {
    const canonical = {
      kind: 'xagent-cited-answer' as const,
      schemaVersion: 1 as const,
      blocks: [
        { type: 'markdown' as const, text: '正文' },
        { type: 'citation' as const, id: '[资料2]' },
        { type: 'markdown' as const, text: '后续' },
        { type: 'citation' as const, id: '[资料1]' },
      ],
      citationIds: ['[资料2]', '[资料1]'],
    }
    expect(parseXAgentCitedAnswerMeta(canonical)).toEqual(canonical)
    expect(parseXAgentCitedAnswerMeta({
      ...canonical,
      blocks: [...canonical.blocks, { type: 'citation', id: '[资料1]' }],
    })).toBeUndefined()
    expect(parseXAgentCitedAnswerMeta({
      ...canonical,
      blocks: [{ type: 'markdown', text: '正文' }, { type: 'citation', id: '[资料01]' }],
      citationIds: ['[资料01]'],
    })).toBeUndefined()
  })

  test('replay metadata rejects every noncanonical root, block, ID, order, and limit', () => {
    const meta = (blocks: unknown[], citationIds: unknown[] = ['[资料1]']): unknown => ({
      kind: 'xagent-cited-answer', schemaVersion: 1, blocks, citationIds,
    })
    const validBlocks = [{ type: 'markdown', text: '正文' }, { type: 'citation', id: '[资料1]' }]
    const invalid = [
      null,
      [],
      { kind: 'xagent-cited-answer', schemaVersion: 1, blocks: validBlocks },
      { kind: 'wrong', schemaVersion: 1, blocks: validBlocks, citationIds: ['[资料1]'] },
      { kind: 'xagent-cited-answer', schemaVersion: 2, blocks: validBlocks, citationIds: ['[资料1]'] },
      { kind: 'xagent-cited-answer', schemaVersion: 1, blocks: null, citationIds: ['[资料1]'] },
      meta([]),
      meta(Array.from({ length: CITED_ANSWER_MAX_BLOCKS + 1 }, () => ({ type: 'markdown', text: 'x' }))),
      { kind: 'xagent-cited-answer', schemaVersion: 1, blocks: validBlocks, citationIds: null },
      meta([null, ...validBlocks]),
      meta([{}, ...validBlocks]),
      meta([{ type: 'markdown', text: 1 }, { type: 'citation', id: '[资料1]' }]),
      meta([{ type: 'markdown', text: '正文', extra: true }, { type: 'citation', id: '[资料1]' }]),
      meta([{ type: 'markdown', text: '正文' }, { type: 'citation', id: 1 }]),
      meta([{ type: 'markdown', text: '正文' }, { type: 'unknown', id: '[资料1]' }]),
      meta([{ type: 'markdown', text: '' }, { type: 'citation', id: '[资料1]' }]),
      meta([{ type: 'markdown', text: '正文' }], []),
      meta(validBlocks, []),
      meta(validBlocks, [1]),
      meta(validBlocks, ['[资料2]']),
      meta([{ type: 'markdown', text: '正文' }, { type: 'citation', id: '[资料1]' }, {
        type: 'citation', id: '[资料1]',
      }]),
      meta([
        { type: 'markdown', text: '正文' },
        ...Array.from({ length: CITED_ANSWER_MAX_CITATIONS + 1 }, (_, index) => ({
          type: 'citation', id: index % 2 === 0 ? '[资料1]' : '[资料2]',
        })),
      ], ['[资料1]', '[资料2]']),
      meta([{ type: 'markdown', text: '文'.repeat(CITED_ANSWER_MAX_BYTES) }, { type: 'citation', id: '[资料1]' }]),
    ]
    for (const value of invalid) expect(parseXAgentCitedAnswerMeta(value)).toBeUndefined()

    expect(parseXAgentCitedAnswerMeta(meta([
      { type: 'markdown', text: 'A' },
      { type: 'citation', id: '[资料1]' },
      { type: 'markdown', text: 'B' },
      { type: 'citation', id: '[资料1]' },
    ]))).toBeDefined()
  })

  test('replay metadata contains serialization failures', () => {
    const blocks: unknown[] = [{ type: 'markdown', text: '正文' }, { type: 'citation', id: '[资料1]' }]
    Object.defineProperty(blocks, 'toJSON', {
      value: () => { throw new Error('serialization failed') },
    })
    expect(parseXAgentCitedAnswerMeta({
      kind: 'xagent-cited-answer', schemaVersion: 1, blocks, citationIds: ['[资料1]'],
    })).toBeUndefined()
  })

  test('rejects unknown root and block fields through a closed discriminated union', () => {
    expectInvalid(null)
    expectInvalid([])
    expectInvalid(answer([
      null,
      { type: 'markdown', text: 'valid' },
      { type: 'citation', id: '[资料1]' },
    ]))
    expectInvalid(answer([
      {},
      { type: 'markdown', text: 'valid' },
      { type: 'citation', id: '[资料1]' },
    ]))
    expectInvalid(answer([
      { type: 'markdown', text: 'valid' },
      { type: 'citation', id: '[资料1]' },
    ], { rejected: 'rejected-secret' }))
    expectInvalid(answer([
      { type: 'markdown', text: 'valid', rejected: 'rejected-secret' },
      { type: 'citation', id: '[资料1]' },
    ]))
    expectInvalid(answer([
      { type: 'markdown', text: 'valid' },
      { type: 'citation', id: '[资料1]', rejected: 'rejected-secret' },
    ]))
    expectInvalid(answer([
      { type: 'markdown', text: 'valid' },
      { type: 'unknown', id: '[资料1]' },
    ]))
  })

  test('rejects serialization failures and non-string JSON results', () => {
    const blocks = [{ type: 'markdown', text: 'valid' }, { type: 'citation', id: '[资料1]' }]
    Object.defineProperty(blocks, 'toJSON', {
      value: () => { throw new Error('serialization failed') },
    })
    expectInvalid(answer(blocks))

    const omitted = answer([{ type: 'markdown', text: 'valid' }, { type: 'citation', id: '[资料1]' }])
    Object.defineProperty(omitted, 'toJSON', { value: () => undefined })
    expectInvalid(omitted)
  })

  test('enforces the complete JSON UTF-8 limit including multibyte Markdown', () => {
    const exactTextLength = Math.floor((CITED_ANSWER_MAX_BYTES - Buffer.byteLength(JSON.stringify(answer([
      { type: 'markdown', text: '' },
      { type: 'citation', id: '[资料1]' },
    ])))) / 3)
    const within = answer([
      { type: 'markdown', text: '文'.repeat(exactTextLength) },
      { type: 'citation', id: '[资料1]' },
    ])
    expect(Buffer.byteLength(JSON.stringify(within))).toBeLessThanOrEqual(CITED_ANSWER_MAX_BYTES)
    expect(normalizeCitedAnswer(within, IDS).blocks[0]).toEqual({ type: 'markdown', text: '文'.repeat(exactTextLength) })

    const oversized = answer([
      { type: 'markdown', text: `${'文'.repeat(exactTextLength)}rejected-secret` },
      { type: 'citation', id: '[资料1]' },
    ])
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(CITED_ANSWER_MAX_BYTES)
    expectInvalid(oversized)
  })

  test('requires 1–256 blocks with non-empty Markdown and a citation', () => {
    expectInvalid(answer([]))
    expectInvalid(answer([{ type: 'markdown', text: '' }, { type: 'citation', id: '[资料1]' }]))
    expectInvalid(answer([{ type: 'markdown', text: 'only prose' }]))
    expectInvalid(answer([{ type: 'citation', id: '[资料1]' }]))
    expectInvalid(answer([
      ...Array.from({ length: CITED_ANSWER_MAX_BLOCKS }, () => ({ type: 'markdown', text: 'x' })),
      { type: 'citation', id: '[资料1]' },
    ]))
    expect(normalizeCitedAnswer(answer([
      ...Array.from({ length: CITED_ANSWER_MAX_BLOCKS - 1 }, () => ({ type: 'markdown', text: 'x' })),
      { type: 'citation', id: '[资料1]' },
    ]), IDS).blocks).toHaveLength(CITED_ANSWER_MAX_BLOCKS)
  })

  test('rejects an oversized block array before serializing any block', () => {
    let serialized = false
    const block = {
      toJSON(): never {
        serialized = true
        throw new Error('must not serialize')
      },
    }
    try {
      normalizeCitedAnswer(answer(Array.from({ length: CITED_ANSWER_MAX_BLOCKS + 1 }, () => block)), IDS)
    } catch (error: unknown) {
      expect(error).toMatchObject({ reason: 'blocks-out-of-range' })
      expect(serialized).toBe(false)
      return
    }
    throw new Error('expected block-count rejection')
  })

  test('limits citation blocks and requires exact allowed-ID membership', () => {
    expectInvalid(answer([
      { type: 'markdown', text: 'valid' },
      ...Array.from({ length: CITED_ANSWER_MAX_CITATIONS + 1 }, () => ({ type: 'citation', id: '[资料1]' })),
    ]))
    expectInvalid(answer([
      { type: 'markdown', text: 'valid' },
      { type: 'citation', id: '[资料9]' },
    ]))
    expectInvalid(answer([
      { type: 'markdown', text: 'valid' },
      { type: 'citation', id: '［资料1］' },
    ]))
  })

  test('collapses only adjacent duplicate citations and records first-use IDs', () => {
    const normalized = normalizeCitedAnswer(answer([
      { type: 'markdown', text: 'A' },
      { type: 'citation', id: '[资料2]' },
      { type: 'citation', id: '[资料2]' },
      { type: 'markdown', text: 'B' },
      { type: 'citation', id: '[资料1]' },
      { type: 'markdown', text: 'C' },
      { type: 'citation', id: '[资料2]' },
    ]), IDS)
    expect(normalized).toEqual({
      schemaVersion: 1,
      blocks: [
        { type: 'markdown', text: 'A' },
        { type: 'citation', id: '[资料2]' },
        { type: 'markdown', text: 'B' },
        { type: 'citation', id: '[资料1]' },
        { type: 'markdown', text: 'C' },
        { type: 'citation', id: '[资料2]' },
      ],
      citationIds: ['[资料2]', '[资料1]'],
    })
  })

  test('does not parse, trim, or normalize Markdown text', () => {
    const text = '  原文 [资料2] &amp; ［资料１］ e\u0301  '
    const normalized = normalizeCitedAnswer(answer([
      { type: 'markdown', text },
      { type: 'citation', id: '[资料1]' },
    ]), IDS)
    expect(normalized.blocks[0]).toEqual({ type: 'markdown', text })
    expect(normalized.citationIds).toEqual(['[资料1]'])
  })

  test('renders and projects the canonical value deterministically', () => {
    const normalized = normalizeCitedAnswer(answer([
      { type: 'markdown', text: '**结论**' },
      { type: 'citation', id: '[资料2]' },
      { type: 'markdown', text: '\n后续' },
      { type: 'citation', id: '[资料1]' },
    ]), IDS)
    expect(renderCitedAnswer(normalized)).toBe('**结论**【已验证资料：[资料2]】\n后续【已验证资料：[资料1]】')
    expect(toCitedAnswerMeta(normalized)).toEqual({
      kind: 'xagent-cited-answer',
      schemaVersion: 1,
      blocks: normalized.blocks,
      citationIds: ['[资料2]', '[资料1]'],
    })
  })

  test('authorizes exactly normalized citation blocks for arbitrary Unicode Markdown', () => {
    const markdown = fc.string({ unit: fc.string({ unit: 'grapheme-ascii', minLength: 0, maxLength: 4 }), maxLength: 80 })
    const citation = fc.constantFrom('[资料1]', '[资料2]', '[资料3]')
    fc.assert(fc.property(
      fc.array(fc.tuple(markdown, citation), { minLength: 1, maxLength: 20 }),
      (pairs) => {
        const blocks: XAgentCitedAnswerBlock[] = [{ type: 'markdown', text: pairs[0]?.[0] || '正文' }]
        for (const [text, id] of pairs) {
          blocks.push({ type: 'citation', id })
          blocks.push({ type: 'markdown', text })
        }
        const normalized = normalizeCitedAnswer(answer(blocks), IDS)
        const citationBlocks = normalized.blocks
          .filter((block): block is Extract<XAgentCitedAnswerBlock, { type: 'citation' }> => block.type === 'citation')
          .map(block => block.id)
        expect(normalized.citationIds).toEqual([...new Set(citationBlocks)])
      },
    ))
  })
})
