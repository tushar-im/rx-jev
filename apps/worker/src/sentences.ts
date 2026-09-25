import type { Label } from './clients/openfda.ts'
import { PY_SPACE } from './python.ts'

// Splits label sections into numbered candidate sentences for Jev to select from.
//
// Every candidate is a character span of the original section text, so what the UI shows is
// provably verbatim. Splitting is deliberately conservative: a missed split only makes a
// candidate longer, while a wrong split could cut a warning in half. OTC labels whose bullets
// were lost upstream therefore stay as one candidate per section.
//
// A bullet item often only means something with the text it hangs off: "contraindicated in
// patients with: • severe renal impairment". The first sentence of each bullet item carries
// that governing text as `lead_in`, also a verbatim span, and the UI must show both. openFDA
// flattens nested lists, so nesting is inferred: an item ending in ":" opens an inner list,
// and an item containing its own ":" ("children under 12 years: ask a doctor") belongs to the
// outer list. A multi-sentence item ending in ":" starts a new list after prose.
//
// This must split exactly as the Python original did, because stored judgments are keyed
// by a hash of the candidates. So whitespace is Python's (`str.isspace` and regex `\s`),
// not JavaScript's: Python counts \x1c to \x1f and \x85, JavaScript counts U+FEFF.

const IS_SPACE = new RegExp(`^[${PY_SPACE}]$`)
const BULLETS = /[•■▪●◆]/g
// A sentence ends at . ! or ? followed by whitespace and an uppercase letter.
const SENTENCE_END = new RegExp(`[.!?](?=[${PY_SPACE}]+[A-Z])`, 'g')
const ABBREVIATIONS = new Set([
  'e.g.',
  'i.e.',
  'vs.',
  'approx.',
  'dr.',
  'no.',
  'fig.',
  'al.',
  'inc.',
  'ltd.',
  'pvt.',
  'co.',
  'corp.',
  'st.',
  'mr.',
  'mrs.',
  'ms.',
  'jr.',
])
// Initialisms such as U.S. or U.S.P.
const INITIALISM = /^(?:[a-z]\.){2,}$/
const LETTER = /[A-Za-z]/

export type Span = {
  text: string
  // Offsets into the section text: text === sectionText.slice(start, end).
  start: number
  end: number
}

export type Candidate = Span & {
  id: string
  section: string
  // Governing text for a bullet item; null for prose and non-first item sentences.
  lead_in: Span | null
}

export function splitSection(section: string, text: string): Candidate[] {
  const candidates: Candidate[] = []
  let outer: Span | null = null // lead-in of the current top-level list
  let inner: Span | null = null // lead-in of a nested list opened by an item ending in ":"

  bulletItems(text).forEach(([segStart, segEnd], index) => {
    const spans = sentences(text, segStart, segEnd).map(([s, e]) => strip(text, s, e))
    const found: Span[] = spans
      .filter(([start, end]) => LETTER.test(text.slice(start, end)))
      .map(([start, end]) => ({ text: text.slice(start, end), start, end }))
    const last = found.at(-1)
    if (last === undefined) return

    found.forEach((sentence, n) => {
      let leadIn: Span | null = null
      if (index > 0 && n === 0) {
        leadIn = inner === null || sentence.text.includes(':') ? outer : inner
      }
      candidates.push({
        id: `${section}:${candidates.length + 1}`,
        section,
        text: sentence.text,
        start: sentence.start,
        end: sentence.end,
        lead_in: leadIn,
      })
    })

    if (index === 0 || (found.length > 1 && last.text.endsWith(':'))) {
      outer = last
      inner = null
    } else if (last.text.endsWith(':')) {
      inner = last
    }
  })
  return candidates
}

export function labelCandidates(label: Label, sections: readonly string[]): Candidate[] {
  return sections.flatMap((name) => splitSection(name, label.sections[name] ?? ''))
}

function bulletItems(text: string): [number, number][] {
  const spans: [number, number][] = []
  let pieceStart = 0
  for (const match of text.matchAll(BULLETS)) {
    spans.push([pieceStart, match.index])
    pieceStart = match.index + match[0].length
  }
  spans.push([pieceStart, text.length])
  return spans
}

function sentences(text: string, start: number, end: number): [number, number][] {
  const spans: [number, number][] = []
  let pieceStart = start
  // Python matched within text[start:end] only, so the lookahead cannot see past `end`.
  const pattern = new RegExp(SENTENCE_END.source, 'g')
  const window = text.slice(0, end)
  pattern.lastIndex = start
  for (let match = pattern.exec(window); match !== null; match = pattern.exec(window)) {
    const matchEnd = match.index + match[0].length
    if (isAbbreviation(text, pieceStart, matchEnd)) continue
    spans.push([pieceStart, matchEnd])
    pieceStart = matchEnd
  }
  spans.push([pieceStart, end])
  return spans
}

/** Python's str.rfind(sub, start, stop). */
function rfind(text: string, sub: string, start: number, stop: number): number {
  const at = text.slice(start, stop).lastIndexOf(sub)
  return at === -1 ? -1 : start + at
}

function isAbbreviation(text: string, start: number, stop: number): boolean {
  const wordStart = Math.max(rfind(text, ' ', start, stop), rfind(text, '\n', start, stop)) + 1
  const word = text.slice(Math.max(wordStart, start), stop).toLowerCase()
  return ABBREVIATIONS.has(word) || INITIALISM.test(word)
}

function isSpace(char: string | undefined): boolean {
  return char !== undefined && IS_SPACE.test(char)
}

function strip(text: string, start: number, end: number): [number, number] {
  let s = start
  let e = end
  while (s < e && isSpace(text[s])) s += 1
  while (e > s && isSpace(text[e - 1])) e -= 1
  return [s, e]
}
