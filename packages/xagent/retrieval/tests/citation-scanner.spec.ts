import { describe, expect, test } from 'vitest'
import {
  CITATION_SCAN_MAX_CODE_UNITS,
  scanCitationCandidates,
} from '../src/citation-scanner.ts'

describe('citation syntax scanner', () => {
  test.each([
    ['[资料1]', true],
    ['[资料12]', true],
    ['[资料1]\u200B', false],
    ['\u2066[资料1]', false],
    ['[资料1]]', false],
    ['[资料1]﹈', false],
    ['[资料]', false],
    ['[资料 2]', false],
    ['[资料-2]', false],
    ['[资料２]', false],
    ['﹇资料2﹈', false],
    ['资料2]', false],
    ['[资料2', false],
  ])('classifies %s without normalizing aliases', (text, valid) => {
    const scan = scanCitationCandidates(text)
    expect(scan.candidates).toEqual([{ start: 0, end: text.length, value: text, valid }])
  })

  test('leaves ordinary Unicode prose outside citation syntax alone', () => {
    const text = '普通资料、RTL نص،emoji 🧭、组合字符 e\u0301 与分隔\u200B保持原样'
    expect(scanCitationCandidates(text).candidates).toEqual([])
  })

  test('keeps adjacent exact ASCII citations as separate valid tokens', () => {
    expect(scanCitationCandidates('[资料1][资料2]').candidates).toEqual([
      { start: 0, end: 5, value: '[资料1]', valid: true },
      { start: 5, end: 10, value: '[资料2]', valid: true },
    ])
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
