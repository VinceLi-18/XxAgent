/** Linear lexer for exact and damaged XAgent short citations. */

const FORMAT_CHARACTER = /^\p{Cf}$/u
const DECIMAL_DIGIT = /^\p{Nd}$/u
const WORD_CHARACTER = /^[\p{L}\p{N}]$/u
const OPEN_BRACKETS = new Set(['[', '【', '［', '﹇'])
const CLOSE_BRACKETS = new Set([']', '】', '］', '﹈'])
const EXACT_CITATION = /^\[资料[1-9][0-9]*\]$/u

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

/** Deterministic ownership results for ordered citation candidates and rendered-text ranges. */
export interface CitationCandidateRangeOwnership {
  readonly contained: readonly boolean[]
  readonly steps: number
}

/**
 * Locate ordered citation candidates in ordered, non-overlapping rendered-text ranges.
 * @param candidates - Candidates in ascending source order.
 * @param ranges - Half-open ranges in ascending source order.
 * @returns One containment result per candidate and the number of range predicates evaluated.
 */
export function locateCitationCandidateRanges(
  candidates: readonly CitationSyntaxCandidate[],
  ranges: readonly (readonly [number, number])[],
): CitationCandidateRangeOwnership {
  const contained: boolean[] = []
  let rangeCursor = 0
  let steps = 0
  for (const candidate of candidates) {
    while (rangeCursor < ranges.length) {
      const range = ranges[rangeCursor]
      if (range === undefined) break
      steps += 1
      if (candidate.start < range[1]) {
        contained.push(candidate.start >= range[0] && candidate.end <= range[1])
        break
      }
      rangeCursor += 1
    }
    if (rangeCursor >= ranges.length) contained.push(false)
  }
  return { contained, steps }
}

interface Character {
  readonly value: string
  readonly start: number
  readonly end: number
}

interface CitationShape {
  sawZi: boolean
  sawOrderedKeyword: boolean
  sawOrdinalAfterKeyword: boolean
  sawForeignWordCharacter: boolean
}

interface BracketCandidate {
  readonly start: number
  end: number
  closed: boolean
  readonly shape: CitationShape
}

interface BareCandidate {
  readonly start: number
  end: number
  readonly shape: CitationShape
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

function createShape(): CitationShape {
  return {
    sawZi: false,
    sawOrderedKeyword: false,
    sawOrdinalAfterKeyword: false,
    sawForeignWordCharacter: false,
  }
}

function updateShape(shape: CitationShape, value: string): void {
  if (value === '资') {
    shape.sawZi = true
    return
  }
  if (value === '料') {
    if (shape.sawZi) shape.sawOrderedKeyword = true
    return
  }
  if (isDecimal(value)) {
    if (shape.sawOrderedKeyword) shape.sawOrdinalAfterKeyword = true
    else shape.sawForeignWordCharacter = true
    return
  }
  if (WORD_CHARACTER.test(value)) shape.sawForeignWordCharacter = true
}

function hasCitationShape(shape: CitationShape): boolean {
  return shape.sawOrderedKeyword
    && (shape.sawOrdinalAfterKeyword || !shape.sawForeignWordCharacter)
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
  let bracketed: BracketCandidate | undefined
  let bare: BareCandidate | undefined
  let prefixStart: number | undefined

  const resetPrefix = (): void => {
    prefixStart = undefined
  }

  const beginBracketed = (character: Character): void => {
    bracketed = {
      start: prefixStart ?? character.start,
      end: character.end,
      closed: false,
      shape: createShape(),
    }
    bare = undefined
    resetPrefix()
  }

  const finishBracketed = (): void => {
    if (bracketed === undefined) throw new Error('citation scanner lost its bracketed candidate')
    if (!hasCitationShape(bracketed.shape)) {
      bracketed = undefined
      return
    }
    const value = text.slice(bracketed.start, bracketed.end)
    candidates.push({
      start: bracketed.start,
      end: bracketed.end,
      value,
      valid: EXACT_CITATION.test(value),
    })
    bracketed = undefined
  }

  const finishBare = (character: Character): void => {
    if (bare === undefined) throw new Error('citation scanner lost its bare candidate')
    candidates.push({
      start: bare.start,
      end: character.end,
      value: text.slice(bare.start, character.end),
      valid: false,
    })
    bare = undefined
    resetPrefix()
  }

  let cursor = 0
  while (cursor < text.length) {
    const character = readCharacter(text, cursor)
    steps += 1
    cursor = character.end
    let reprocess = true
    while (reprocess) {
      reprocess = false
      if (bracketed !== undefined) {
        if (bracketed.closed) {
          if (OPEN_BRACKETS.has(character.value)) {
            finishBracketed()
            beginBracketed(character)
          } else if (CLOSE_BRACKETS.has(character.value) || isFormat(character.value)) {
            bracketed.end = character.end
          } else {
            finishBracketed()
            reprocess = true
          }
        } else if (CLOSE_BRACKETS.has(character.value)) {
          bracketed.end = character.end
          bracketed.closed = true
        } else {
          bracketed.end = character.end
          updateShape(bracketed.shape, character.value)
        }
        continue
      }

      if (OPEN_BRACKETS.has(character.value)) {
        beginBracketed(character)
        continue
      }
      if (CLOSE_BRACKETS.has(character.value)) {
        if (bare !== undefined && hasCitationShape(bare.shape)) finishBare(character)
        else {
          bare = undefined
          prefixStart ??= character.start
        }
        continue
      }
      if (isFormat(character.value)) {
        if (bare !== undefined) {
          bare.end = character.end
          updateShape(bare.shape, character.value)
        } else prefixStart ??= character.start
        continue
      }

      resetPrefix()
      if (bare === undefined && (character.value === '资' || character.value === '料')) {
        bare = { start: character.start, end: character.end, shape: createShape() }
      }
      if (bare !== undefined) {
        bare.end = character.end
        updateShape(bare.shape, character.value)
      }
    }
  }

  if (bracketed !== undefined) {
    const trailing = candidates.at(-1)
    if (hasCitationShape(bracketed.shape)) finishBracketed()
    else if (trailing?.end === bracketed.start) {
      candidates[candidates.length - 1] = {
        start: trailing.start,
        end: bracketed.end,
        value: text.slice(trailing.start, bracketed.end),
        valid: false,
      }
    }
  }

  const trailing = candidates.at(-1)
  if (prefixStart !== undefined && trailing?.end === prefixStart) {
    candidates[candidates.length - 1] = {
      start: trailing.start,
      end: text.length,
      value: text.slice(trailing.start),
      valid: false,
    }
  }

  return { candidates, overflow: false, steps }
}
