/** Lowercase, strip accents and punctuation, collapse spaces. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s/]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Optimal string alignment distance (Levenshtein + adjacent transpositions). */
export function distance(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prevPrev: number[] = []
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2]! + 1)
      }
      row.push(value)
    }
    prevPrev = prev
    prev = row
  }
  return prev[b.length]!
}

/** 0..1 similarity between two texts after normalization. */
export function similarity(a: string, b: string): number {
  const x = normalize(a)
  const y = normalize(b)
  const longest = Math.max(x.length, y.length)
  return longest === 0 ? 1 : 1 - distance(x, y) / longest
}

export type FuzzyEntry<T> = { phrase: string; value: T }
export type FuzzyResult<T> = { value: T; phrase: string; score: number }

export type FuzzyOptions = {
  /** Minimum similarity (0..1). Default 0.8. */
  threshold?: number
  /** Inputs with more words are not short commands; they go to the LLM. Default 6. */
  maxWords?: number
}

/**
 * Best phrase for a short input, or undefined. Tolerates typos and speech
 * transcription slips ("porximo" → "próximo"), not paraphrases: that is the
 * job of a semantic matcher.
 */
export function fuzzyBest<T>(input: string, entries: FuzzyEntry<T>[], options: FuzzyOptions = {}): FuzzyResult<T> | undefined {
  const best = fuzzyRank(input, entries, options)[0]
  return best && best.score >= (options.threshold ?? 0.8) ? best : undefined
}

/**
 * Every distinct value with its best-scoring phrase, highest score first,
 * with no threshold. Empty for empty or long inputs (`maxWords`).
 */
export function fuzzyRank<T>(input: string, entries: FuzzyEntry<T>[], options: Pick<FuzzyOptions, 'maxWords'> = {}): FuzzyResult<T>[] {
  const text = normalize(input)
  if (!text || text.split(' ').length > (options.maxWords ?? 6)) return []
  const best = new Map<T, FuzzyResult<T>>()
  for (const entry of entries) {
    const score = similarity(text, entry.phrase)
    const current = best.get(entry.value)
    if (!current || score > current.score) best.set(entry.value, { value: entry.value, phrase: entry.phrase, score })
  }
  return [...best.values()].sort((a, b) => b.score - a.score)
}
