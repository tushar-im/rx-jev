// Python's semantics, where the port must match the original byte for byte: whitespace as
// `str.isspace` and regex `\s` see it, and `json.dumps` output.

/** Python's whitespace, for a regex character class. JavaScript's `\s` differs. */
export const PY_SPACE =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'

const BLANK = new RegExp(`^[${PY_SPACE}]*$`)

/** `text.strip() == ""` in Python. */
export function isBlank(text: string): boolean {
  return BLANK.test(text)
}

/** Orders strings by code point, as Python does, rather than by UTF-16 unit. */
export function compareCodePoints(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0)
    if (d !== 0) return d
  }
  return x.length - y.length
}

type DumpOptions = { sortKeys: boolean; itemSeparator: string; keySeparator: string }

function dump(value: unknown, options: DumpOptions): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    // Python writes floats differently; the requests hold none, so refuse rather than differ.
    if (!Number.isSafeInteger(value)) throw new Error(`Cannot match Python for number ${value}`)
    return String(value)
  }
  // With ensure_ascii=False Python escapes exactly what JSON.stringify escapes.
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((v) => dump(v, options)).join(options.itemSeparator)}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (options.sortKeys) entries.sort(([a], [b]) => compareCodePoints(a, b))
    const items = entries.map(
      ([k, v]) => `${JSON.stringify(k)}${options.keySeparator}${dump(v, options)}`,
    )
    return `{${items.join(options.itemSeparator)}}`
  }
  throw new Error(`Cannot write ${typeof value} as JSON`)
}

/** `json.dumps(value, ensure_ascii=False)`: insertion order, ", " and ": " separators. */
export function dumps(value: unknown): string {
  return dump(value, { sortKeys: false, itemSeparator: ', ', keySeparator: ': ' })
}

/** `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. */
export function dumpsCanonical(value: unknown): string {
  return dump(value, { sortKeys: true, itemSeparator: ',', keySeparator: ':' })
}

/** Python's `len(text)`: code points, not UTF-16 units. */
export function codePointLength(text: string): number {
  let pairs = 0
  for (let i = 0; i < text.length - 1; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        pairs += 1
        i += 1
      }
    }
  }
  return text.length - pairs
}
