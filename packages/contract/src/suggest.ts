// Drug name suggestions for the search box, matched against RxNorm's display names. Shared
// by the API Worker and the browser, which matches a cached copy of the list locally.
//
// RxNorm's approximate search does not match partial words, so suggestions come from its
// display name list: names starting with the query first, then names with a word starting
// with it (so "metf" finds "glipiZIDE / metFORMIN"). Case is ignored; RxNorm keeps tall-man
// lettering such as "metFORMIN", which is shown as is.

export const SUGGESTION_LIMIT = 10

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
}

function rank(a: string, b: string): number {
  const byLength = [...a].length - [...b].length
  if (byLength !== 0) return byLength
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

export function suggest(
  names: readonly string[],
  query: string,
  limit: number = SUGGESTION_LIMIT,
): string[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const word = new RegExp(`(?<![a-z0-9])${escapeRegExp(needle)}`)
  const prefix: string[] = []
  const within: string[] = []
  for (const name of names) {
    const lower = name.toLowerCase()
    if (lower.startsWith(needle)) prefix.push(name)
    else if (word.test(lower)) within.push(name)
  }
  return [...prefix.sort(rank), ...within.sort(rank)].slice(0, limit)
}
