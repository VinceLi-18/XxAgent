/** Linear lexer for exact and damaged XAgent short citations. */

const FORMAT_CHARACTER = /^\p{Cf}$/u
const DECIMAL_DIGIT = /^\p{Nd}$/u
const ASCII_DIGIT = /^[0-9]$/u
const SEPARATOR = /^[\s+\-\u2212\u2013\u2014]$/u
const OPEN_BRACKETS = new Set(['[', '【', '［', '﹇'])
const CLOSE_BRACKETS = new Set([']', '】', '］', '﹈'])
const BRACKETS = new Set([...OPEN_BRACKETS, ...CLOSE_BRACKETS])

/** Maximum UTF-16 code units accepted by one citation scan. */
export const CITATION_SCAN_MAX_CODE_UNITS = 64 * 1024

/** One citation-shaped token found in rendered prose. */
export interface CitationSyntaxCandidate {
  readonly start: number
  readonly end: number
  readonly value: string
  readonly valid: boolean
}

/** Citation candidates plus deterministic scan accounting. */
export interface CitationSyntaxScan {
  readonly candidates: readonly CitationSyntaxCandidate[]
  readonly overflow: boolean
  readonly steps: number
}

interface Character {
  readonly value: string
  readonly start: number
  readonly end: number
}

type BracketKind = 'open' | 'close'
type LexerState = 'search' | 'after-zi' | 'after-liao' | 'before-ordinal' | 'ordinal' | 'after-ordinal-separator' | 'suffix'

interface CandidateBuilder {
  readonly start: number
  readonly prefixExact: boolean
  readonly hasOpeningBracket: boolean
  end: number
  keywordExact: boolean
  digitCount: number
  asciiOrdinal: boolean
  firstDigit: string
  separatedOrdinal: boolean
  suffixCount: number
  suffix: string
  hasClosingSuffix: boolean
}

function readCharacter(text: string, index: number): Character {
  const codePoint = text.codePointAt(index)
  if (codePoint === undefined) throw new RangeError('citation scanner index is outside its input')
  const value = String.fromCodePoint(codePoint)
  return { value, start: index, end: index + value.length }
}

function isFormat(value: string): boolean {
  return FORMAT_CHARACTER.test(value)
}

function isDecimal(value: string): boolean {
  return DECIMAL_DIGIT.test(value)
}

function bracketKind(value: string): BracketKind | undefined {
  if (OPEN_BRACKETS.has(value)) return 'open'
  if (CLOSE_BRACKETS.has(value)) return 'close'
  return undefined
}

/**
 * Scan rendered text once, by code point, without normalization or backtracking.
 * @param text - Assistant prose or reconstructed raw-HTML text within the 64-KiB scanner limit.
 * @returns Citation-shaped ranges, overflow state, and the number of code points inspected.
 */
export function scanCitationCandidates(text: string): CitationSyntaxScan {
  if (text.length > CITATION_SCAN_MAX_CODE_UNITS) {
    return { candidates: [], overflow: true, steps: 0 }
  }

  const candidates: CitationSyntaxCandidate[] = []
  let steps = 0
  let state: LexerState = 'search'
  let builder: CandidateBuilder | undefined
  let prefixStart: number | undefined
  let prefixKind: BracketKind | undefined
  let trailingFormatStart: number | undefined

  const resetPrefix = (): void => {
    prefixStart = undefined
    prefixKind = undefined
    trailingFormatStart = undefined
  }

  const rememberPrefix = (character: Character): void => {
    if (isFormat(character.value)) {
      prefixStart ??= character.start
      trailingFormatStart ??= character.start
      return
    }
    const kind = bracketKind(character.value)
    if (kind === undefined) {
      resetPrefix()
      return
    }
    if (prefixKind !== undefined && prefixKind !== kind) {
      prefixStart = trailingFormatStart ?? character.start
    } else {
      prefixStart ??= character.start
    }
    prefixKind = kind
    trailingFormatStart = undefined
  }

  const beginCandidate = (character: Character): void => {
    builder = {
      start: prefixStart ?? character.start,
      prefixExact: prefixStart === character.start - 1 && text[prefixStart] === '[',
      hasOpeningBracket: prefixKind === 'open',
      end: character.end,
      keywordExact: true,
      digitCount: 0,
      asciiOrdinal: true,
      firstDigit: '',
      separatedOrdinal: false,
      suffixCount: 0,
      suffix: '',
      hasClosingSuffix: false,
    }
    resetPrefix()
  }

  const finishCandidate = (): void => {
    if (builder === undefined) throw new Error('citation scanner lost its candidate')
    const ordinalExact = builder.digitCount > 0
      && builder.asciiOrdinal
      && builder.firstDigit >= '1'
      && builder.firstDigit <= '9'
      && !builder.separatedOrdinal
    const suffixExact = builder.suffixCount === 1 && builder.suffix === ']'
    candidates.push({
      start: builder.start,
      end: builder.end,
      value: text.slice(builder.start, builder.end),
      valid: builder.prefixExact && builder.keywordExact && ordinalExact && suffixExact,
    })
    builder = undefined
    state = 'search'
  }

  const discardCandidate = (): void => {
    builder = undefined
    state = 'search'
  }

  const recordDigit = (character: Character): void => {
    if (builder === undefined) throw new Error('citation scanner lost its ordinal')
    if (builder.digitCount === 0) builder.firstDigit = character.value
    builder.digitCount += 1
    builder.asciiOrdinal &&= ASCII_DIGIT.test(character.value)
    builder.end = character.end
  }

  const recordSuffix = (character: Character): void => {
    if (builder === undefined) throw new Error('citation scanner lost its suffix')
    builder.suffixCount += 1
    builder.suffix = character.value
    builder.hasClosingSuffix ||= CLOSE_BRACKETS.has(character.value)
    builder.end = character.end
  }

  let cursor = 0
  while (cursor < text.length) {
    const character = readCharacter(text, cursor)
    steps += 1
    cursor = character.end
    let reprocess = true
    while (reprocess) {
      reprocess = false
      switch (state) {
        case 'search':
          if (character.value === '资') {
            beginCandidate(character)
            state = 'after-zi'
          } else rememberPrefix(character)
          break
        case 'after-zi':
          if (isFormat(character.value)) {
            if (builder === undefined) throw new Error('citation scanner lost its keyword')
            builder.keywordExact = false
            builder.end = character.end
          } else if (character.value === '料') {
            if (builder === undefined) throw new Error('citation scanner lost its keyword')
            builder.end = character.end
            state = 'after-liao'
          } else {
            discardCandidate()
            reprocess = true
          }
          break
        case 'after-liao':
          if (builder === undefined) throw new Error('citation scanner lost its keyword')
          if (isFormat(character.value)) {
            builder.keywordExact = false
            builder.end = character.end
          } else if (isDecimal(character.value)) {
            recordDigit(character)
            state = 'ordinal'
          } else if (builder.hasOpeningBracket && SEPARATOR.test(character.value)) {
            builder.separatedOrdinal = true
            builder.end = character.end
            state = 'before-ordinal'
          } else if (builder.hasOpeningBracket && BRACKETS.has(character.value)) {
            recordSuffix(character)
            state = 'suffix'
          } else {
            discardCandidate()
            reprocess = true
          }
          break
        case 'before-ordinal':
          if (builder === undefined) throw new Error('citation scanner lost its separated ordinal')
          if (isFormat(character.value) || SEPARATOR.test(character.value)) {
            builder.separatedOrdinal = true
            builder.end = character.end
          } else if (isDecimal(character.value)) {
            recordDigit(character)
            state = 'ordinal'
          } else if (BRACKETS.has(character.value)) {
            recordSuffix(character)
            state = 'suffix'
          } else {
            discardCandidate()
            reprocess = true
          }
          break
        case 'ordinal':
          if (builder === undefined) throw new Error('citation scanner lost its ordinal')
          if (isDecimal(character.value)) {
            recordDigit(character)
          } else if (isFormat(character.value)) {
            builder.separatedOrdinal = true
            builder.end = character.end
          } else if (SEPARATOR.test(character.value)) {
            builder.separatedOrdinal = true
            builder.end = character.end
            state = 'after-ordinal-separator'
          } else if (BRACKETS.has(character.value)) {
            recordSuffix(character)
            state = 'suffix'
          } else {
            finishCandidate()
            reprocess = true
          }
          break
        case 'after-ordinal-separator':
          if (builder === undefined) throw new Error('citation scanner lost its ordinal suffix')
          if (isFormat(character.value) || SEPARATOR.test(character.value)) {
            builder.end = character.end
          } else if (BRACKETS.has(character.value)) {
            recordSuffix(character)
            state = 'suffix'
          } else {
            finishCandidate()
            reprocess = true
          }
          break
        case 'suffix':
          if (builder === undefined) throw new Error('citation scanner lost its suffix')
          if ((!BRACKETS.has(character.value) && !isFormat(character.value))
            || (builder.hasClosingSuffix && OPEN_BRACKETS.has(character.value))) {
            finishCandidate()
            reprocess = true
          } else {
            recordSuffix(character)
            state = 'suffix'
          }
          break
        default:
          state satisfies never
      }
    }
  }

  if ((state === 'after-liao' && builder?.hasOpeningBracket)
    || state === 'before-ordinal' || state === 'ordinal'
    || state === 'after-ordinal-separator' || state === 'suffix') finishCandidate()

  return { candidates, overflow: false, steps }
}
