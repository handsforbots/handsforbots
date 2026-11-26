import type { WordSpan } from '@handsforbots/core'

export type { WordSpan }

/** How the timing of a word was obtained. */
export type WordQuality = 'measured' | 'aligned' | 'estimated'

/** Where the timing came from, independent of its quality. */
export type WordSource = 'model' | 'backend' | 'boundary' | 'asr' | 'estimate' | 'cadence'

/** Where a word stands in the caption. */
export type CaptionWordState = 'spoken' | 'active' | 'upcoming' | 'skipped'

/**
 * A word of the caption. Positions are UTF-16 offsets in the source text.
 * Words of the active chunk carry their timing (seconds since the chunk
 * started) and how it was obtained.
 */
export type CaptionWord = WordSpan & {
  state: CaptionWordState
  start?: number
  end?: number
  quality?: WordQuality
  source?: WordSource
}

export type CaptionsState = {
  /** `speaking` inside a word, `gap` in a pause between words, `idle` before start, at the end and after a cut. */
  status: 'idle' | 'speaking' | 'gap'
  /** The reply being followed; absent for standalone text or `speak(text)` without a message. */
  messageId?: string
  /** The range of the active chunk in the message. */
  from?: number
  to?: number
  words: readonly CaptionWord[]
  /** Index in `words` of the active word, -1 when none is. */
  active: number
  /** Why the last chunk (or standalone cadence) ended, while `idle` after one. */
  ended?: 'done' | 'interrupted' | 'error'
  /** Whether the whole reply finished (not just one sentence chunk). */
  replyEnded?: boolean
  /** What is driving this caption right now. */
  driver?: 'voice' | 'text'
}

/** Any live caption source: the `captions` plugin, a per-message store, or `createCadence()`. */
export type CaptionStore = {
  getState(): CaptionsState
  subscribe(listener: () => void): () => void
  /** Progress of the active word, 0–1 (1 in a pause, 0 when idle). Read it on each animation frame. */
  progress(): number
}

export const IDLE_CAPTION_STATE: CaptionsState = Object.freeze({
  status: 'idle',
  words: Object.freeze([]) as readonly CaptionWord[],
  active: -1,
})
