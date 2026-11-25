/**
 * Word timings (ADR 0020): one tokenization for every source, timings mapped
 * onto it, estimation when nothing better exists, and WebVTT with inline
 * word timestamps for transport.
 */

/** How the timing of a word was obtained. */
export type WordQuality =
  /** The engine reported the timing of this word itself. */
  | 'measured'
  /** An aligner measured the audio against the text (forced alignment, or recognition with word timestamps). */
  | 'aligned'
  /** Spread by proportion (word length, a multi-word unit, unmatched text). */
  | 'estimated'

/** Where the timing came from, independent of its quality. */
export type WordSource = 'model' | 'backend' | 'boundary' | 'asr' | 'estimate'

/** A word in a text: `from` (inclusive) and `to` (exclusive) are UTF-16 positions. */
export type WordSpan = { text: string; from: number; to: number }

/** A word of a spoken chunk. Times are seconds since the chunk started, as heard. */
export type WordTiming = WordSpan & {
  start: number
  end: number
  quality: WordQuality
  source: WordSource
}

/**
 * Timing as a provider or backend gives it: positions (if any) are in the text
 * the provider received; `end` defaults to the next unit's `start`. A unit may
 * hold several words (WebVTT text between two timestamps).
 */
export type TimedWord = {
  text: string
  start: number
  end?: number
  from?: number
  to?: number
  quality?: WordQuality
  source?: WordSource
}

/** At most this many units are read from a provider or backend. */
export const MAX_TIMED_WORDS = 2000

/**
 * The words of a text: maximal runs of non-space characters, punctuation
 * included (`"Olá,"`). The one tokenization captions use, whatever the source.
 */
export function splitWords(text: string): WordSpan[] {
  const words: WordSpan[] = []
  for (const match of text.matchAll(/\S+/g)) words.push({ text: match[0], from: match.index, to: match.index + match[0].length })
  return words
}

const LETTERS = /[\p{L}\p{N}]/u

/** Lower case, no accents, letters and digits only: how spoken and written words are compared. */
export function normalizeWord(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/** How long a word takes relative to the others: its letters, at least one. */
const weightOf = (text: string) => Math.max(1, normalizeWord(text).length)

/** The pause after a word, in the same unit as `weightOf` (letters). */
const pauseAfter = (text: string) => (/[.!?…:;]["')\]]*$/.test(text) ? 4 : /[,—–]["')\]]*$/.test(text) ? 2 : 0)

/**
 * The span of `samples` with sound, in seconds: from the first to the last
 * sample above `threshold`. The whole audio when nothing passes it.
 */
export function voicedSpan(samples: Float32Array, sampleRate: number, threshold = 0.01): { start: number; end: number } {
  const duration = samples.length / sampleRate
  let first = -1
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) > threshold) {
      first = i
      break
    }
  }
  if (first < 0) return { start: 0, end: duration }
  let last = first
  for (let i = samples.length - 1; i > first; i--) {
    if (Math.abs(samples[i]!) > threshold) {
      last = i
      break
    }
  }
  return { start: first / sampleRate, end: (last + 1) / sampleRate }
}

/**
 * Spreads `words` over `[start, end]` by length, with pauses after
 * punctuation. Used for audio without timings and inside units that hold
 * several words.
 */
function spread(words: WordSpan[], start: number, end: number, quality: WordQuality, source: WordSource): WordTiming[] {
  const total = words.reduce((sum, word, i) => sum + weightOf(word.text) + (i < words.length - 1 ? pauseAfter(word.text) : 0), 0)
  const span = Math.max(0, end - start)
  let at = start
  return words.map((word, i) => {
    const length = (weightOf(word.text) / (total || 1)) * span
    const timing: WordTiming = { ...word, start: at, end: at + length, quality, source }
    at += length + (i < words.length - 1 ? (pauseAfter(word.text) / (total || 1)) * span : 0)
    return timing
  })
}

/**
 * Estimated timings for `text` spoken over `duration` seconds (or over the
 * voiced part of `samples`), by word length with pauses at punctuation.
 */
export function estimateWords(
  text: string,
  timing: { duration: number; voiced?: { start: number; end: number } },
): WordTiming[] {
  const duration = Number.isFinite(timing.duration) && timing.duration > 0 ? timing.duration : 0
  const start = Math.min(duration, Math.max(0, timing.voiced?.start ?? 0))
  const end = Math.max(start, Math.min(duration, timing.voiced?.end ?? duration))
  return spread(splitWords(text), start, end, 'estimated', 'estimate')
}

/** Characters per second of a voice at rate 1, for speech whose length is unknown until it ends. */
export const CHARS_PER_SECOND = 14

const QUALITIES = new Set<WordQuality>(['measured', 'aligned', 'estimated'])
const SOURCES = new Set<WordSource>(['model', 'backend', 'boundary', 'asr', 'estimate'])
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/**
 * Keeps only well-formed units (untrusted input: a backend, a worker): text as
 * text, finite non-negative times, integer positions, known quality and
 * source, at most `MAX_TIMED_WORDS`.
 */
export function cleanTimedWords(input: unknown, defaults: { quality: WordQuality; source: WordSource }): TimedWord[] {
  if (!Array.isArray(input)) return []
  const out: TimedWord[] = []
  for (const item of input.slice(0, MAX_TIMED_WORDS)) {
    if (!item || typeof item !== 'object') continue
    const unit = item as Record<string, unknown>
    const start = finite(unit.start)
    if (typeof unit.text !== 'string' || start === undefined || start < 0) continue
    const end = finite(unit.end)
    const from = finite(unit.from)
    const to = finite(unit.to)
    const word: TimedWord = {
      text: unit.text.slice(0, 200),
      start,
      quality: QUALITIES.has(unit.quality as WordQuality) ? (unit.quality as WordQuality) : defaults.quality,
      source: SOURCES.has(unit.source as WordSource) ? (unit.source as WordSource) : defaults.source,
    }
    if (end !== undefined && end >= start) word.end = end
    if (from !== undefined && to !== undefined && Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to > from) {
      word.from = from
      word.to = to
    }
    out.push(word)
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Longest common subsequence of two lists of normalized words: index pairs, in order. */
function commonWords(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] && a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] && a[i] === b[j]) {
      pairs.push([i++, j++])
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++
    else j++
  }
  return pairs
}

export type AlignOptions = {
  /** Length of the chunk's audio in seconds, for the last word's end and words after the last timing. */
  duration?: number
  /** Quality and source of units that do not say. */
  quality?: WordQuality
  source?: WordSource
}

/**
 * Maps a provider's timings onto the words of `text` (the original, as
 * written). Units with `from`/`to` cover the words they overlap; units without
 * them are matched by normalized text, in order. Written words with no spoken
 * match between two matches (a number read out, a spelled acronym) share the
 * time between them by length and become `estimated`, as do words inside a
 * unit that holds several. Positions are in `text`.
 */
export function alignWords(text: string, timed: TimedWord[], options: AlignOptions = {}): WordTiming[] {
  const words = splitWords(text)
  if (!words.length) return []
  const defaults = { quality: options.quality ?? 'measured', source: options.source ?? 'backend' }
  const units = cleanTimedWords(timed, defaults)
  const duration = finite(options.duration)
  if (!units.length) return estimateWords(text, { duration: duration ?? 0 })
  // Ends: the next unit's start, then the audio's end.
  const lastEnd = Math.max(duration ?? 0, units[units.length - 1]!.end ?? units[units.length - 1]!.start)
  const ended = units.map((unit, i) => ({ ...unit, end: unit.end ?? units[i + 1]?.start ?? lastEnd }))

  const result: (WordTiming | undefined)[] = new Array(words.length)
  const assign = (index: number, start: number, end: number, quality: WordQuality, source: WordSource) => {
    const word = words[index]!
    const current = result[index]
    if (current) {
      current.start = Math.min(current.start, start)
      current.end = Math.max(current.end, end)
    } else result[index] = { ...word, start, end, quality, source }
  }

  const positioned = ended.filter((unit) => unit.from !== undefined)
  if (positioned.length === ended.length) {
    for (const unit of ended) {
      const covered = words.map((w, i) => [w, i] as const).filter(([w]) => w.from < unit.to! && w.to > unit.from!)
      if (covered.length === 1) assign(covered[0]![1], unit.start, unit.end, unit.quality!, unit.source!)
      else
        for (const timing of spread(covered.map(([w]) => w), unit.start, unit.end, 'estimated', unit.source!))
          assign(covered.find(([w]) => w.from === timing.from)![1], timing.start, timing.end, 'estimated', unit.source!)
    }
  } else {
    // Units by text: split multi-word units, then match normalized words in order.
    const spoken: { norm: string; start: number; end: number; quality: WordQuality; source: WordSource }[] = []
    for (const unit of ended) {
      const parts = splitWords(unit.text)
      if (parts.length <= 1) {
        spoken.push({ norm: normalizeWord(unit.text), start: unit.start, end: unit.end, quality: unit.quality!, source: unit.source! })
        continue
      }
      for (const part of spread(parts, unit.start, unit.end, 'estimated', unit.source!)) {
        spoken.push({ norm: normalizeWord(part.text), start: part.start, end: part.end, quality: 'estimated', source: part.source })
      }
    }
    const pairs = commonWords(
      words.map((w) => normalizeWord(w.text)),
      spoken.map((s) => s.norm),
    )
    for (const [w, s] of pairs) assign(w, spoken[s]!.start, spoken[s]!.end, spoken[s]!.quality, spoken[s]!.source)
    // Between two matches: the written words share the spoken time between them.
    const anchors: [number, number][] = [[-1, -1], ...pairs, [words.length, spoken.length]]
    for (let k = 0; k < anchors.length - 1; k++) {
      const [w0, s0] = anchors[k]!
      const [w1, s1] = anchors[k + 1]!
      if (w1 - w0 <= 1) continue
      const between = spoken.slice(s0 + 1, s1)
      const start = between[0]?.start ?? (s0 >= 0 ? spoken[s0]!.end : 0)
      const end = between[between.length - 1]?.end ?? (s1 < spoken.length ? spoken[s1]!.start : lastEnd)
      const gap = words.slice(w0 + 1, w1)
      const source = between[0]?.source ?? defaults.source
      spread(gap, start, Math.max(start, end), 'estimated', source).forEach((timing, i) =>
        assign(w0 + 1 + i, timing.start, timing.end, 'estimated', source),
      )
    }
  }

  // Words no unit covered: between their neighbours.
  for (let i = 0; i < words.length; i++) {
    if (result[i]) continue
    let j = i
    while (j < words.length && !result[j]) j++
    const start = i > 0 ? result[i - 1]!.end : 0
    const end = j < words.length ? result[j]!.start : Math.max(start, lastEnd)
    spread(words.slice(i, j), start, Math.max(start, end), 'estimated', 'estimate').forEach((timing, k) => (result[i + k] = timing))
    i = j - 1
  }
  // Monotonic: no word starts before the previous one.
  const out = result as WordTiming[]
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.start < out[i - 1]!.start) out[i]!.start = out[i - 1]!.start
    if (out[i]!.end < out[i]!.start) out[i]!.end = out[i]!.start
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* WebVTT with inline word timestamps                                         */
/* -------------------------------------------------------------------------- */

const TIMESTAMP = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/

/** WebVTT timestamp (`00:01.250`, `01:00:01.250`) → seconds; undefined if malformed. */
export function parseVttTime(value: string): number | undefined {
  const match = TIMESTAMP.exec(value.trim())
  if (!match) return undefined
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000
}

/** Seconds → WebVTT timestamp, always with hours (`00:00:01.250`). */
export function formatVttTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const pad = (n: number, size = 2) => String(n).padStart(size, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '‎', rlm: '‏' }

/** Decodes the character references WebVTT text may hold (`&amp;`, `&lt;`, `&#233;`, `&#xE9;`). */
export function decodeVttText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

const escapeVtt = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Reads WebVTT cues with inline timestamps (`<00:00:01.250>`), as used for
 * karaoke-style captions. Each run of text between two timestamps becomes one
 * unit starting at the timestamp before it (the cue start for the first run);
 * several words between two timestamps stay one unit. Tags (`<c>`, `<v>`) are
 * dropped and character references decoded. Times are as written in the file:
 * subtract the chunk's own start if the file covers more than one chunk.
 */
export function parseWordVtt(vtt: string): TimedWord[] {
  const units: TimedWord[] = []
  const blocks = vtt.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n')
    const timing = lines.findIndex((line) => line.includes('-->'))
    if (timing < 0) continue
    const [startText, rest = ''] = lines[timing]!.split('-->')
    const cueStart = parseVttTime(startText ?? '')
    const cueEnd = parseVttTime(rest.trim().split(/\s+/)[0] ?? '')
    if (cueStart === undefined || cueEnd === undefined) continue
    const body = lines.slice(timing + 1).join('\n')
    let at = cueStart
    const cue: TimedWord[] = []
    for (const piece of body.split(/(<[^>]*>)/)) {
      if (piece.startsWith('<')) {
        const time = parseVttTime(piece.slice(1, -1))
        if (time !== undefined) at = time
        continue
      }
      const text = decodeVttText(piece).replace(/\s+/g, ' ').trim()
      if (!text) continue
      const last = cue[cue.length - 1]
      // Text split only by a tag (`<c>`) belongs to the same unit.
      if (last && last.start === at) last.text += ` ${text}`
      else cue.push({ text, start: at })
      if (units.length + cue.length >= MAX_TIMED_WORDS) break
    }
    cue.forEach((unit, i) => (unit.end = cue[i + 1]?.start ?? cueEnd))
    units.push(...cue)
    if (units.length >= MAX_TIMED_WORDS) break
  }
  return units.slice(0, MAX_TIMED_WORDS)
}

/**
 * Writes word timings as one WebVTT cue with an inline timestamp before each
 * word after the first. `from`, `to`, `quality` and `source` do not fit
 * WebVTT: send JSON when the reader needs them.
 */
export function toWordVtt(words: Pick<TimedWord, 'text' | 'start' | 'end'>[], options: { offset?: number } = {}): string {
  const offset = options.offset ?? 0
  if (!words.length) return 'WEBVTT\n'
  const first = words[0]!
  const last = words[words.length - 1]!
  const body = words.map((word, i) => (i === 0 ? '' : `<${formatVttTime(word.start + offset)}>`) + escapeVtt(word.text)).join(' ')
  return `WEBVTT\n\n${formatVttTime(first.start + offset)} --> ${formatVttTime((last.end ?? last.start) + offset)}\n${body}\n`
}
