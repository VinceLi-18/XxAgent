import { describe, expect, test } from 'vitest'
import {
  CITATION_SCAN_MAX_CODE_UNITS,
  locateCitationCandidateRanges,
  scanCitationCandidates,
} from '../src/citation-scanner.ts'

describe('citation syntax scanner', () => {
  test.each([
    ['[资料1]', true],
    ['[资料12]', true],
    ['[资料1]\u200B', false],
    ['\u2066[资料1]', false],
    ['][资料1]', false],
    ['】[资料1]', false],
    ['[资料1][', false],
    ['[资料1]［', false],
    ['[资料1]]', false],
    ['[资料1]﹈', false],
    ['[资料]', false],
    ['[资料 2]', false],
    ['[资料-2]', false],
    ['[资料/2]', false],
    ['[资料#2]', false],
    ['[资料：2]', false],
    ['[资料＋2]', false],
    ['[资料.2]', false],
    ['[资料２]', false],
    ['﹇资料2﹈', false],
    ['[资料2', false],
    ['[x资料2]', false],
    ['[ 资料2]', false],
    ['[/资料2]', false],
    ['[\u0301资料2]', false],
    ['[\u200B资料2]', false],
    ['[🧭资料2]', false],
    ['[ab资料2]', false],
    ['资料2]', false],
  ])('classifies %s without normalizing aliases', (text, valid) => {
    const scan = scanCitationCandidates(text)
    expect(scan.candidates).toEqual([{ start: 0, end: text.length, value: text, valid }])
  })

  test('leaves ordinary Unicode prose outside citation syntax alone', () => {
    const text = '普通资料、资料2、资料2026版本、共有资料2份、资料/2、RTL نص،emoji 🧭、组合字符 e\u0301 与分隔\u200B保持原样'
    expect(scanCitationCandidates(text).candidates).toEqual([])
  })

  test.each([
    '[项目2]',
    '[附录A]',
    '[重要]',
    '[x]',
    '[材料2]',
    '[资产2]',
    '[肥料2]',
    '[参考资料]',
    '[相关资料]',
    '[资料库]',
    '[投资材料2]',
    '[融资材料2]',
    '[物资材料2]',
    '[资产材料2]',
    '[资x料2]',
    '[资abc料2]',
    '[料2]',
    '[资2]',
    '[x料2]',
  ])(
    'does not classify ordinary bracketed prose %s as a citation',
    (text) => {
      expect(scanCitationCandidates(text).candidates).toEqual([])
    },
  )

  test.each([
    '[资料①]',
    '[资料Ⅰ]',
    '[资料²]',
    '[资料A]',
    '[资料O]',
  ])('classifies non-ASCII citation ordinal %s as malformed', (text) => {
    expect(scanCitationCandidates(text).candidates).toEqual([
      { start: 0, end: text.length, value: text, valid: false },
    ])
  })

  test.each(Array.from('零〇一二两兩三四五六七八九十百千万萬亿億兆壹贰貳叁參肆伍陆陸柒捌玖拾佰仟廿卅卌'))(
    'classifies Han citation ordinal %s as malformed',
    (ordinal) => {
      const text = `[资料${ordinal}]`
      expect(scanCitationCandidates(text).candidates).toEqual([
        { start: 0, end: text.length, value: text, valid: false },
      ])
    },
  )

  test.each([
    '[资料库2]',
    '[资料馆A]',
    '[资料夹2026]',
  ])('keeps natural compound %s outside citation syntax', (text) => {
    expect(scanCitationCandidates(text).candidates).toEqual([])
  })

  test.each([
    ['ASCII punctuation', '[资/料2]'],
    ['ASCII whitespace', '[资 料2]'],
    ['fullwidth punctuation', '[资：料2]'],
    ['fullwidth symbol', '[资＋料2]'],
    ['combining mark', '[资\u0301料2]'],
    ['control character', '[资\u0001料2]'],
    ['astral symbol', '[资🧭料2]'],
    ['repeated zi', '[资资料2]'],
    ['repeated liao', '[资料料2]'],
  ])('retains a bracketed citation candidate damaged by %s', (_name, text) => {
    const scan = scanCitationCandidates(text)
    expect(scan.candidates).toEqual([{ start: 0, end: text.length, value: text, valid: false }])
    expect(scan.steps).toBe(Array.from(text).length)
  })

  test('keeps adjacent exact ASCII citations as separate valid tokens', () => {
    expect(scanCitationCandidates('[资料1][资料2]').candidates).toEqual([
      { start: 0, end: 5, value: '[资料1]', valid: true },
      { start: 5, end: 10, value: '[资料2]', valid: true },
    ])
  })

  test.each([
    ['many adjacent legal tokens', 2048],
    ['a maximum-size adversarial answer', Math.floor(CITATION_SCAN_MAX_CODE_UNITS / 5)],
  ])('locates %s with one monotonic range cursor', (_name, count) => {
    const text = '[资料1]'.repeat(count)
    const candidates = scanCitationCandidates(text).candidates
    const ranges = candidates.map(candidate => [candidate.start, candidate.end] as const)
    const ownership = locateCitationCandidateRanges(candidates, ranges)
    expect(ownership.contained).toEqual(candidates.map(() => true))
    expect(ownership.steps).toBeLessThanOrEqual(candidates.length + ranges.length)
  })

  test('locates candidates across alternating containing and crossing ranges linearly', () => {
    const text = '[资料1][资料2][资料3][资料4]'
    const candidates = scanCitationCandidates(text).candidates
    const ranges = [[0, 5], [5, 8], [8, 12], [12, 15], [15, 20]] as const
    const ownership = locateCitationCandidateRanges(candidates, ranges)
    expect(ownership.contained).toEqual([true, false, false, true])
    expect(ownership.steps).toBeLessThanOrEqual(candidates.length + ranges.length)
  })

  test.each(['\u00AD', '\u061C', '\u200B', '\u202E', '\u2066', '\uFEFF'])(
    'classifies representative %s format characters next to a token as malformed',
    (format) => {
      expect(scanCitationCandidates(`[资料1]${format}`).candidates[0]?.valid).toBe(false)
    },
  )

  test.each([
    ['format-only', '\u200B'.repeat(CITATION_SCAN_MAX_CODE_UNITS)],
    ['long candidate prefix', `[${'\u2066'.repeat(CITATION_SCAN_MAX_CODE_UNITS - 3)}资料`],
    ['repeated near matches', '资\u200B料x'.repeat(CITATION_SCAN_MAX_CODE_UNITS / 4)],
  ])('keeps %s scanning within a fixed linear operation budget', (_name, text) => {
    const scan = scanCitationCandidates(text)
    expect(scan.overflow).toBe(false)
    expect(scan.steps).toBeLessThanOrEqual(Array.from(text).length + 1)
  })

  test('fails closed before scanning input above its explicit limit', () => {
    const scan = scanCitationCandidates('x'.repeat(CITATION_SCAN_MAX_CODE_UNITS + 1))
    expect(scan).toEqual({ candidates: [], overflow: true, steps: 0 })
  })
})
