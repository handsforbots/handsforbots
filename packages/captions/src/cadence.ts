import { splitWords, type WordSpan } from '@handsforbots/core'
import {
  IDLE_CAPTION_STATE,
  type CaptionStore,
  type CaptionWord,
  type CaptionWordState,
  type CaptionsState,
} from './types.js'

export type CadenceWordTiming = {
  /** Duration of the word itself, in milliseconds. */
  durationMs: number
  /** Pause after the word before the next one starts, in milliseconds. */
  pauseMs?: number
}

export type CadencePaceOptions = {
  /** Reading speed in words per minute. Default 230. */
  wordsPerMinute?: number
  /** Minimum duration of a single word, in milliseconds. Default 80. */
  minWordMs?: number
  /** Extra pauses after punctuation, in milliseconds. */
  pauses?: {
    /** After `,`, `;`, `:`, `—`, `–`. Default 140. */
    comma?: number
    /** After `.`, `!`, `?`, `…`. Default 280. */
    sentence?: number
  }
  /** Delay before the first word starts, in milliseconds. Default 0. */
  startDelayMs?: number
  /**
   * When streamed text arrives faster than the reading pace, speed up once
   * more than `threshold` upcoming words are buffered. `false` or `0` disables.
   * Default `{ threshold: 12, maxFactor: 3 }`.
   */
  catchUp?: number | { threshold?: number; maxFactor?: number } | false
}

export type CadencePace =
  | CadencePaceOptions
  | ((word: WordSpan, index: number, all: readonly WordSpan[]) => number | CadenceWordTiming)

export type ReducedMotionPolicy = 'auto' | 'instant' | 'words'

export type CadenceOptions = {
  pace?: CadencePace
  /** Optional messageId attached to state snapshots. */
  messageId?: string
  /**
   * How `prefers-reduced-motion: reduce` is handled:
   * - `auto` (default): reveals instantly when the user prefers reduced motion.
   * - `instant`: always reveals immediately.
   * - `words`: always runs word by word.
   */
  reducedMotion?: ReducedMotionPolicy
  /** Monotonic clock in seconds (default: `performance.now() / 1000`). */
  clock?: () => number
  /** Custom timer scheduler (default: `setTimeout`). */
  schedule?: (fn: () => void, ms: number) => unknown
  /** Custom timer canceller (default: `clearTimeout`). */
  cancelSchedule?: (handle: unknown) => void
  /** Called when a subscriber throws. */
  onError?: (error: unknown) => void
}

export type CadenceController = CaptionStore & {
  /** Replaces the whole text and starts revealing from the beginning. */
  setText(text: string): void
  /** Appends streamed text (LLM delta) and continues revealing smoothly. */
  append(delta: string): void
  /** Marks the text stream as finished (no more deltas will arrive). */
  finish(): void
  /** Pauses the clock where it is. */
  pause(): void
  /** Resumes after `pause()`. */
  resume(): void
  /** Reveals every word immediately (`ended: 'done'`). */
  skip(): void
  /** Cuts at the current word: active becomes `spoken`, remaining become `skipped`, `ended: 'interrupted'`. */
  cut(): void
  /** Resets to empty idle state and cancels pending timers. */
  reset(): void
  /** UTF-16 offset of the end of the last revealed (`spoken` or `active`) word, or 0 if none. */
  shown(): number
  /** Stops timers and clears listeners. */
  dispose(): void
}

const DEFAULT_WPM = 230
const DEFAULT_MIN_WORD_MS = 80
const DEFAULT_COMMA_MS = 140
const DEFAULT_SENTENCE_MS = 280
const DEFAULT_CATCHUP_THRESHOLD = 12
const DEFAULT_CATCHUP_MAX = 3
const MIN_WAIT_MS = 16
const MAX_WAIT_MS = 250

const defaultClock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000

const wordLetters = (text: string) =>
  Math.max(
    1,
    text
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\p{L}\p{N}]/gu, '').length,
  )

function isReducedMotion(policy: ReducedMotionPolicy): boolean {
  if (policy === 'instant') return true
  if (policy === 'words') return false
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

function resolveCatchUp(catchUp: CadencePaceOptions['catchUp']): { threshold: number; maxFactor: number } {
  if (catchUp === false || catchUp === 0) return { threshold: Infinity, maxFactor: 1 }
  if (typeof catchUp === 'number') return { threshold: Math.max(1, catchUp), maxFactor: DEFAULT_CATCHUP_MAX }
  return {
    threshold: Math.max(1, catchUp?.threshold ?? DEFAULT_CATCHUP_THRESHOLD),
    maxFactor: Math.max(1, catchUp?.maxFactor ?? DEFAULT_CATCHUP_MAX),
  }
}

function measureWord(
  pace: CadencePace | undefined,
  word: WordSpan,
  index: number,
  all: readonly WordSpan[],
  backlog: number,
): { durationSec: number; pauseSec: number } {
  if (typeof pace === 'function') {
    const res = pace(word, index, all)
    const durationMs = typeof res === 'number' ? res : res.durationMs
    const pauseMs = typeof res === 'number' ? 0 : (res.pauseMs ?? 0)
    return {
      durationSec: Math.max(0.001, (Number.isFinite(durationMs) ? durationMs : DEFAULT_MIN_WORD_MS) / 1000),
      pauseSec: Math.max(0, (Number.isFinite(pauseMs) ? pauseMs : 0) / 1000),
    }
  }
  const wpm = pace?.wordsPerMinute && pace.wordsPerMinute > 0 ? pace.wordsPerMinute : DEFAULT_WPM
  const minWordMs = pace?.minWordMs !== undefined && pace.minWordMs >= 0 ? pace.minWordMs : DEFAULT_MIN_WORD_MS
  const commaMs = pace?.pauses?.comma ?? DEFAULT_COMMA_MS
  const sentenceMs = pace?.pauses?.sentence ?? DEFAULT_SENTENCE_MS
  const baseMs = 60_000 / wpm
  const weight = wordLetters(word.text)
  let durationMs = Math.max(minWordMs, baseMs * (0.5 + 0.5 * (weight / 5)))
  let pauseMs = /[.!?…]["')\]]*$/.test(word.text)
    ? sentenceMs
    : /[,;:—–]["')\]]*$/.test(word.text)
      ? commaMs
      : 0

  const { threshold, maxFactor } = resolveCatchUp(pace?.catchUp)
  if (backlog > threshold && maxFactor > 1) {
    const excess = (backlog - threshold) / threshold
    const factor = Math.min(maxFactor, 1 + excess)
    durationMs = Math.max(minWordMs / maxFactor, durationMs / factor)
    pauseMs = pauseMs / factor
  }
  return { durationSec: Math.max(0.001, durationMs / 1000), pauseSec: Math.max(0, pauseMs / 1000) }
}

/**
 * Headless reading cadence for text (standalone or streamed via `append` + `finish`).
 * Produces a `CaptionStore` compatible with `renderCaption`, `<h4b-caption>`,
 * React `useStore`/`useCaption` and Vue `useStore`/`useCaption`.
 */
export function createCadence(options: CadenceOptions = {}): CadenceController {
  const clock = options.clock ?? defaultClock
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const reducedMotion = options.reducedMotion ?? 'auto'
  const startDelaySec =
    typeof options.pace === 'object' && options.pace?.startDelayMs && options.pace.startDelayMs > 0
      ? options.pace.startDelayMs / 1000
      : 0

  const listeners = new Set<() => void>()
  let state: CaptionsState = options.messageId
    ? Object.freeze({ ...IDLE_CAPTION_STATE, messageId: options.messageId, driver: 'text' })
    : Object.freeze({ ...IDLE_CAPTION_STATE, driver: 'text' })

  let buffer = ''
  let finished = false
  let cutFlag = false
  let paused = false
  let disposed = false
  let elapsed = 0
  let startedAt: number | undefined
  let timer: unknown
  /** Committed words with scheduled `start`/`end` in cadence seconds. */
  let words: CaptionWord[] = []
  /** Next start time (cadence seconds) for newly committed words. */
  let nextStart = startDelaySec

  const now = () => (startedAt === undefined || paused ? elapsed : elapsed + Math.max(0, clock() - startedAt))

  const clearTimer = () => {
    if (timer !== undefined) {
      cancelSchedule(timer)
      timer = undefined
    }
  }

  const publish = (next: CaptionsState) => {
    state = Object.freeze(next)
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        options.onError?.(error)
      }
    }
  }

  const commitWords = () => {
    if (!buffer) return
    const all = splitWords(buffer)
    // While streaming, hold back the trailing word until whitespace or finish() closes it.
    const trailingOpen = !finished && all.length > 0 && !/\s$/.test(buffer)
    const ready = trailingOpen ? all.slice(0, -1) : all
    if (ready.length <= words.length) return

    const instant = isReducedMotion(reducedMotion)
    const current = now()
    // If we were waiting in a gap for new streamed words, start them from now.
    if (words.length > 0 && nextStart < current) nextStart = current
    const backlog = Math.max(0, ready.length - words.length)

    for (let i = words.length; i < ready.length; i++) {
      const span = ready[i]!
      if (instant) {
        words.push({ ...span, state: 'spoken', start: 0, end: 0, quality: 'estimated', source: 'cadence' })
      } else {
        const { durationSec, pauseSec } = measureWord(options.pace, span, i, ready, backlog)
        const start = nextStart
        const end = start + durationSec
        words.push({ ...span, state: 'upcoming', start, end, quality: 'estimated', source: 'cadence' })
        nextStart = end + pauseSec
      }
    }
  }

  const computeAndPublish = (force = false) => {
    clearTimer()
    if (disposed || cutFlag) return

    if (!words.length) {
      if (finished && buffer.trim() === '') {
        publish({
          status: 'idle',
          ...(options.messageId ? { messageId: options.messageId } : {}),
          words: Object.freeze([]) as readonly CaptionWord[],
          active: -1,
          ended: 'done',
          replyEnded: true,
          driver: 'text',
        })
      }
      return
    }

    if (isReducedMotion(reducedMotion)) {
      const done = words.map((w): CaptionWord => (w.state === 'spoken' ? w : { ...w, state: 'spoken' }))
      words = done
      publish({
        status: 'idle',
        ...(options.messageId ? { messageId: options.messageId } : {}),
        from: done[0]!.from,
        to: done[done.length - 1]!.to,
        words: Object.freeze([...done]),
        active: -1,
        ...(finished ? { ended: 'done', replyEnded: true } : {}),
        driver: 'text',
      })
      return
    }

    if (startedAt === undefined && !paused) startedAt = clock()
    const time = now()
    const eps = 1e-6

    let active = -1
    let spokenThrough = -1
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!
      if (time + eps >= (w.end ?? 0)) {
        spokenThrough = i
      } else if (time + eps >= (w.start ?? 0)) {
        active = i
        spokenThrough = i - 1
        break
      } else {
        break
      }
    }

    const allDone = finished && spokenThrough === words.length - 1 && active === -1
    const status: CaptionsState['status'] = allDone ? 'idle' : active >= 0 ? 'speaking' : 'gap'

    let changed =
      force ||
      state.status !== status ||
      state.active !== active ||
      state.words.length !== words.length ||
      state.replyEnded !== (allDone ? true : undefined)

    const nextWords = words.map((w, i): CaptionWord => {
      const next: CaptionWordState = i === active ? 'active' : i <= spokenThrough ? 'spoken' : 'upcoming'
      if (next !== w.state) {
        changed = true
        return { ...w, state: next }
      }
      return w
    })
    words = nextWords

    if (changed) {
      publish({
        status,
        ...(options.messageId ? { messageId: options.messageId } : {}),
        from: nextWords[0]!.from,
        to: nextWords[nextWords.length - 1]!.to,
        words: Object.freeze([...nextWords]),
        active,
        ...(allDone ? { ended: 'done', replyEnded: true } : {}),
        driver: 'text',
      })
    }

    if (allDone || paused) return

    let nextEvent = Infinity
    if (active >= 0) {
      nextEvent = nextWords[active]!.end ?? Infinity
    } else {
      const nextIndex = spokenThrough + 1
      if (nextIndex < nextWords.length) nextEvent = nextWords[nextIndex]!.start ?? Infinity
    }
    if (nextEvent === Infinity) return
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, (nextEvent - time) * 1000))
    timer = schedule(() => computeAndPublish(), waitMs)
  }

  const resetInternal = () => {
    clearTimer()
    buffer = ''
    finished = false
    cutFlag = false
    paused = false
    elapsed = 0
    startedAt = undefined
    words = []
    nextStart = startDelaySec
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    progress() {
      if (state.status === 'gap') return 1
      if (state.status !== 'speaking' || state.active < 0) return 0
      const word = state.words[state.active]
      if (!word || word.start === undefined || word.end === undefined) return 0
      const length = word.end - word.start
      if (length <= 0) return 1
      return Math.min(1, Math.max(0, (now() - word.start) / length))
    },
    setText(text) {
      if (disposed) return
      resetInternal()
      buffer = text
      finished = true
      commitWords()
      computeAndPublish(true)
    },
    append(delta) {
      if (disposed || cutFlag || !delta) return
      buffer += delta
      commitWords()
      computeAndPublish()
    },
    finish() {
      if (disposed || cutFlag || finished) return
      finished = true
      commitWords()
      computeAndPublish(true)
    },
    pause() {
      if (disposed || paused || cutFlag) return
      if (startedAt !== undefined) {
        elapsed += Math.max(0, clock() - startedAt)
        startedAt = undefined
      }
      paused = true
      clearTimer()
    },
    resume() {
      if (disposed || !paused || cutFlag) return
      paused = false
      startedAt = clock()
      computeAndPublish()
    },
    skip() {
      if (disposed || cutFlag) return
      clearTimer()
      finished = true
      commitWords()
      if (!words.length) {
        publish({
          status: 'idle',
          ...(options.messageId ? { messageId: options.messageId } : {}),
          words: Object.freeze([]) as readonly CaptionWord[],
          active: -1,
          ended: 'done',
          replyEnded: true,
          driver: 'text',
        })
        return
      }
      const done = words.map((w): CaptionWord => (w.state === 'spoken' ? w : { ...w, state: 'spoken' }))
      words = done
      publish({
        status: 'idle',
        ...(options.messageId ? { messageId: options.messageId } : {}),
        from: done[0]!.from,
        to: done[done.length - 1]!.to,
        words: Object.freeze(done),
        active: -1,
        ended: 'done',
        replyEnded: true,
        driver: 'text',
      })
    },
    cut() {
      if (disposed || cutFlag) return
      clearTimer()
      cutFlag = true
      finished = true
      if (!words.length) {
        publish({
          status: 'idle',
          ...(options.messageId ? { messageId: options.messageId } : {}),
          words: Object.freeze([]) as readonly CaptionWord[],
          active: -1,
          ended: 'interrupted',
          replyEnded: true,
          driver: 'text',
        })
        return
      }
      const cutAt =
        state.active >= 0
          ? state.active
          : words.reduce((last, w, i) => (w.state === 'spoken' ? i : last), -1)
      const nextWords = words.map((w, i): CaptionWord => {
        const next: CaptionWordState = i <= cutAt ? 'spoken' : 'skipped'
        return next === w.state ? w : { ...w, state: next }
      })
      words = nextWords
      publish({
        status: 'idle',
        ...(options.messageId ? { messageId: options.messageId } : {}),
        from: nextWords[0]!.from,
        to: nextWords[nextWords.length - 1]!.to,
        words: Object.freeze(nextWords),
        active: -1,
        ended: 'interrupted',
        replyEnded: true,
        driver: 'text',
      })
    },
    reset() {
      if (disposed) return
      resetInternal()
      publish(
        options.messageId
          ? { ...IDLE_CAPTION_STATE, messageId: options.messageId, driver: 'text' }
          : { ...IDLE_CAPTION_STATE, driver: 'text' },
      )
    },
    shown() {
      let end = 0
      for (const word of state.words) {
        if (word.state === 'spoken' || word.state === 'active') end = word.to
      }
      return end
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearTimer()
      listeners.clear()
    },
  }
}
