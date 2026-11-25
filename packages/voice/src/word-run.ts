import type { SpeakProgress } from './types.js'
import type { WordTiming } from './words.js'

/** Where a chunk of an assistant reply sits in its text (UTF-16, `to` exclusive). */
export type ChunkRange = { messageId: string; from: number; to: number }

/**
 * Word progress of the chunk being spoken (ADR 0020). `from`/`to` (when
 * present) are the chunk's range in the message, like `voice.speech`; each
 * word carries its own. Progress within a word is not an event: read
 * `getSpeechPosition()` on each frame.
 */
export type VoiceWordEvent = Partial<ChunkRange> & { provider: string } & (
    /**
     * The chunk started playing: every word with its forecast timing
     * (boundaries correct it later). `revised`: better timings for the chunk
     * already playing (an aligner that finished late); `word` events follow
     * up to where speech is now.
     */
    | { phase: 'chunk'; words: WordTiming[]; revised?: true }
    /** Word `index` started. */
    | { phase: 'word'; index: number; word: WordTiming }
    /** Word `index` ended and the next has not started (a pause). */
    | { phase: 'gap'; index: number }
    /** The chunk is over: spoken to the end, cut (barge-in, `interrupt`, `cancelSpeech`) or failed. */
    | { phase: 'end'; reason: 'done' | 'interrupted' | 'error' }
  )

/** The chunk being spoken, now. */
export type SpeechPosition = Partial<ChunkRange> & {
  provider: string
  words: readonly WordTiming[]
  /** The current word, or the last one before a pause; -1 before the first. */
  index: number
  /** `speaking` inside a word, `gap` between words or after the last. */
  status: 'speaking' | 'gap'
  /** Seconds heard since the chunk started. */
  time: number
  /** How much of the current word was said, 0–1 (1 in a pause). */
  progress: number
}

export type WordRun = {
  /** The player's clock, from `PlayOptions.onStart`. */
  setClock(clock: () => number): void
  /** `speak` providers: start and word boundaries. */
  progress(event: SpeakProgress): void
  position(): SpeechPosition
  end(reason: 'done' | 'interrupted' | 'error'): void
  /** Replaces the forecast with better timings while the chunk plays. Ignored once boundaries lead or it ended. */
  revise(words: WordTiming[]): void
}

const MIN_WAIT = 16
const MAX_WAIT = 250

/**
 * Follows one chunk's words against a clock: emits `word` and `gap` as time
 * passes. The clock is the page's until the player gives its own. A
 * `boundary` from the provider moves to that word and shifts the forecast of
 * the words after it; from then on the provider leads and the word ends when
 * the next boundary arrives.
 */
export function startWordRun(options: {
  words: WordTiming[]
  provider: string
  range?: ChunkRange
  /** Offset of the provider's text in the message (`boundary` positions are in the provider's text). */
  offset: number
  emit(event: VoiceWordEvent): void
  /** Seconds, monotonic (the page's clock). */
  now(): number
}): WordRun {
  const words = options.words
  const range = options.range ?? {}
  const base = { provider: options.provider, ...range }
  const pageClock = (origin = options.now()) => () => Math.max(0, options.now() - origin)
  let clock = pageClock()
  let playerClock = false
  let led = false
  let index = -1
  let gap = false
  let ended = false
  let timer: ReturnType<typeof setTimeout> | undefined

  options.emit({ phase: 'chunk', ...base, words: words.map((w) => ({ ...w })) })

  const enter = (next: number) => {
    index = next
    gap = false
    options.emit({ phase: 'word', ...base, index, word: { ...words[index]! } })
  }

  const tick = () => {
    clearTimeout(timer)
    if (ended) return
    const time = clock()
    if (!led) {
      let current = index
      while (current + 1 < words.length && words[current + 1]!.start <= time) current++
      // Words skipped between two checks still start, in order.
      while (index < current) enter(index + 1)
      if (index >= 0 && !gap && time >= words[index]!.end && (words[index + 1]?.start ?? Infinity) > time) {
        gap = true
        options.emit({ phase: 'gap', ...base, index })
      }
    }
    const next = led ? Infinity : Math.min(words[index + 1]?.start ?? Infinity, gap || index < 0 ? Infinity : words[index]!.end)
    if (next === Infinity) return
    const wait = Math.min(MAX_WAIT, Math.max(MIN_WAIT, (next - time) * 1000))
    timer = setTimeout(tick, wait)
  }

  const shiftFrom = (i: number, delta: number) => {
    for (let j = i; j < words.length; j++) {
      words[j]!.start += delta
      words[j]!.end += delta
    }
  }

  tick()

  return {
    setClock(next) {
      playerClock = true
      clock = next
      tick()
    },
    progress(event) {
      if (ended) return
      if (event.type === 'start') {
        // The engine started late (voices load): time counts from here. Only once.
        if (!playerClock && !led && index < 0) clock = pageClock()
        tick()
        return
      }
      const at = event.from + options.offset
      const target = words.findIndex((w) => at < w.to)
      if (target < 0) return
      const time = clock()
      if (target < index) return
      led = true
      clearTimeout(timer)
      shiftFrom(target, time - words[target]!.start)
      // `boundary` only marks starts: a word ends where the next begins.
      if (target > 0) words[target - 1]!.end = time
      for (const word of words.slice(Math.max(0, index), target + 1)) {
        word.quality = 'measured'
        word.source = 'boundary'
      }
      if (target === index) return
      while (index < target - 1) enter(index + 1)
      enter(target)
    },
    position() {
      const time = clock()
      const word = words[index]
      let progress = 0
      let status: SpeechPosition['status'] = index < 0 ? 'gap' : 'speaking'
      if (word) {
        const length = word.end - word.start
        progress = length > 0 ? Math.min(1, Math.max(0, (time - word.start) / length)) : 1
        if (gap || ended) {
          progress = 1
          status = 'gap'
        }
        // Led by boundaries: the word lasts until the next one arrives.
        if (led && !ended && index < words.length - 1) progress = Math.min(progress, 0.99)
      }
      return { ...base, words, index, status, time, progress }
    },
    revise(next) {
      if (ended || led || !next.length) return
      words.splice(0, words.length, ...next)
      index = -1
      gap = false
      options.emit({ phase: 'chunk', ...base, words: words.map((w) => ({ ...w })), revised: true })
      tick()
    },
    end(reason) {
      if (ended) return
      ended = true
      clearTimeout(timer)
      options.emit({ phase: 'end', ...base, reason })
    },
  }
}
