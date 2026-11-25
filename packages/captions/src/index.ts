import { definePlugin, textOf, type PluginContext, type Services } from '@handsforbots/core'
import type { VoiceService, VoiceWordEvent, WordQuality, WordSource, WordSpan } from '@handsforbots/voice'

/** Where a word stands against the voice. */
export type CaptionWordState = 'spoken' | 'active' | 'upcoming'

/**
 * A word of the caption. Positions are UTF-16 offsets in the message text.
 * Words of the chunk being spoken carry their timing (seconds since the chunk
 * started) and how it was obtained; the rest of a message (`scope: 'message'`)
 * has none.
 */
export type CaptionWord = WordSpan & {
  state: CaptionWordState
  start?: number
  end?: number
  quality?: WordQuality
  source?: WordSource
}

export type CaptionsState = {
  /** `speaking` inside a word, `gap` in a pause between words, `idle` before speech, at its end and after a cut. */
  status: 'idle' | 'speaking' | 'gap'
  /** The reply being spoken; absent for `speak(text)` without a message. */
  messageId?: string
  /** The range of the spoken chunk in the message. */
  from?: number
  to?: number
  words: readonly CaptionWord[]
  /** Index in `words` of the active word, -1 when none is. */
  active: number
  /** Why the last chunk ended, while `idle` after one. */
  ended?: 'done' | 'interrupted' | 'error'
}

/** The `captions` service: a store (React `useStore`, Vue) plus the live progress of the active word. */
export type CaptionsService = {
  getState(): CaptionsState
  subscribe(listener: () => void): () => void
  /** How much of the active word was said, 0–1, from the voice's clock. Read it on each animation frame. */
  progress(): number
  readonly scope: CaptionsScope
}

/** `chunk`: the sentence being spoken, like a caption line. `message`: the whole reply, with the spoken sentence highlighted. */
export type CaptionsScope = 'chunk' | 'message'

export type CaptionsOptions = {
  /** Default `chunk`. */
  scope?: CaptionsScope
}

declare module '@handsforbots/core' {
  interface Services {
    captions: CaptionsService
  }
}

const IDLE: CaptionsState = Object.freeze({ status: 'idle', words: Object.freeze([]) as readonly CaptionWord[], active: -1 })

function apply(ctx: PluginContext, options: CaptionsOptions = {}) {
  const scope = options.scope ?? 'chunk'
  if (scope !== 'chunk' && scope !== 'message') throw new TypeError(`captions: unknown scope "${String(scope)}"`)
  const app = ctx.app
  const listeners = new Set<() => void>()
  let state: CaptionsState = IDLE
  /** Index in `state.words` of each word of the current chunk, by the chunk's own index. */
  let chunkIndex: number[] = []

  const voice = () => app.get('voice' as keyof Services) as unknown as VoiceService | undefined

  const publish = (next: CaptionsState) => {
    state = Object.freeze(next)
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        app.emit('error', { error, source: 'captions' })
      }
    }
  }

  const setStates = (active: number, spokenThrough: number, status: CaptionsState['status'], extra: Partial<CaptionsState> = {}) => {
    const firstOfChunk = chunkIndex[0] ?? 0
    const words = state.words.map((word, i): CaptionWord => {
      const next: CaptionWordState =
        i === active ? 'active' : i <= spokenThrough || (scope === 'message' && i < firstOfChunk) ? 'spoken' : 'upcoming'
      return next === word.state ? word : { ...word, state: next }
    })
    publish({ ...state, ...extra, words, active, status })
  }

  const onChunk = (event: Extract<VoiceWordEvent, { phase: 'chunk' }>) => {
    const range = { messageId: event.messageId, from: event.from, to: event.to }
    const timed = event.words.map((w): CaptionWord => ({ ...w, state: 'upcoming' }))
    const message = event.messageId ? app.conversation.find(event.messageId) : undefined
    if (scope === 'message' && message) {
      const text = textOf(message)
      const all = (voice()?.wordsOf(text) ?? []).map((w): CaptionWord => {
        const match = timed.find((t) => t.from === w.from)
        return match ?? { ...w, state: w.to <= (event.from ?? 0) ? 'spoken' : 'upcoming' }
      })
      chunkIndex = timed.map((t) => all.findIndex((w) => w.from === t.from))
      // A chunk word the message split differently (should not happen): show the chunk alone.
      if (chunkIndex.some((i) => i < 0)) {
        chunkIndex = timed.map((_, i) => i)
        publish({ status: 'idle', ...range, words: timed, active: -1 })
        return
      }
      publish({ status: 'idle', ...range, words: all, active: -1 })
      return
    }
    chunkIndex = timed.map((_, i) => i)
    publish({ status: 'idle', ...range, words: timed, active: -1 })
  }

  const sameChunk = (event: VoiceWordEvent) => event.messageId === state.messageId && event.from === state.from

  ctx.on('voice.word', (event) => {
    if (event.phase === 'chunk') return onChunk(event)
    if (!sameChunk(event)) return
    if (event.phase === 'word') {
      const at = chunkIndex[event.index] ?? -1
      return setStates(at, at - 1, 'speaking', { ended: undefined })
    }
    if (event.phase === 'gap') {
      const at = chunkIndex[event.index] ?? -1
      return setStates(-1, at, 'gap')
    }
    // End: done marks the whole chunk spoken; a cut keeps what was heard.
    const through = event.reason === 'done' ? (chunkIndex[chunkIndex.length - 1] ?? -1) : state.active >= 0 ? state.active : spokenThrough()
    setStates(-1, through, 'idle', { ended: event.reason })
  })
  ctx.on('service.removed', ({ key }) => {
    if (key === ('voice' as keyof Services)) publish(IDLE)
  })

  /** The last spoken word of the current state. */
  const spokenThrough = () => {
    let last = -1
    state.words.forEach((word, i) => word.state === 'spoken' && (last = i))
    return last
  }

  const service: CaptionsService = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    progress() {
      if (state.status === 'gap') return 1
      if (state.status !== 'speaking') return 0
      const position = voice()?.getSpeechPosition()
      if (!position || position.messageId !== state.messageId || position.from !== state.from) return 0
      return position.status === 'gap' ? 1 : position.progress
    },
    scope,
  }
  ctx.provide('captions', service)
  ctx.onDispose(() => listeners.clear())
}

/**
 * Word-by-word captions (ADR 0020): follows `voice.word` and keeps the words
 * of the chunk (or the whole reply) as spoken, active or upcoming, with the
 * live progress of the active word. The widget draws them when this service
 * exists; any other UI reads the same service.
 */
export const captions = definePlugin<CaptionsOptions | undefined>({
  name: 'captions',
  provides: ['captions'],
  apply,
})
