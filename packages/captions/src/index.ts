import {
  definePlugin,
  splitWords,
  textOf,
  type Events,
  type PluginContext,
  type Services,
  type WordSpan,
} from '@handsforbots/core'
import {
  createCadence,
  type CadenceController,
  type CadenceOptions,
  type CadencePace,
  type CadencePaceOptions,
  type CadenceWordTiming,
  type ReducedMotionPolicy,
} from './cadence.js'
import {
  CAPTION_STYLES,
  H4BCaptionElement,
  defineCaptionElement,
  renderCaption,
  type CaptionAriaMode,
  type CaptionDisplayMode,
  type RenderCaptionOptions,
} from './element.js'
import {
  IDLE_CAPTION_STATE,
  type CaptionStore,
  type CaptionWord,
  type CaptionWordState,
  type CaptionsState,
  type WordQuality,
  type WordSource,
} from './types.js'

export {
  CAPTION_STYLES,
  H4BCaptionElement,
  IDLE_CAPTION_STATE,
  createCadence,
  defineCaptionElement,
  renderCaption,
  type CadenceController,
  type CadenceOptions,
  type CadencePace,
  type CadencePaceOptions,
  type CadenceWordTiming,
  type CaptionAriaMode,
  type CaptionDisplayMode,
  type CaptionStore,
  type CaptionWord,
  type CaptionWordState,
  type CaptionsState,
  type ReducedMotionPolicy,
  type RenderCaptionOptions,
  type WordQuality,
  type WordSource,
  type WordSpan,
}

/** `chunk`: the sentence being spoken or revealed, like a caption line. `message`: the whole reply. */
export type CaptionsScope = 'chunk' | 'message'

/**
 * What drives the captions:
 * - `auto` (default): follows `voice.word` when voice speaks a reply; otherwise runs text cadence.
 * - `voice`: only follows `voice.word`.
 * - `text`: always runs text cadence on assistant replies, even when `voice` is installed.
 */
export type CaptionsFollow = 'auto' | 'voice' | 'text'

export type CaptionsOptions = {
  /** Default `chunk`. */
  scope?: CaptionsScope
  /** Default `auto`. */
  follow?: CaptionsFollow
  /** Reading pace for text cadence (ignored while driven by voice). */
  pace?: CadencePace
  /** Reduced-motion policy for text cadence. Default `auto`. */
  reducedMotion?: ReducedMotionPolicy
  /**
   * In text mode, cut an interrupted message at what has already been shown
   * (same as voice does with what was spoken). Default `true`.
   */
  cutOnInterrupt?: boolean
  /** Injectable clock/scheduler for text cadence (primarily for tests). */
  clock?: () => number
  schedule?: (fn: () => void, ms: number) => unknown
  cancelSchedule?: (handle: unknown) => void
}

/** The `captions` service: a `CaptionStore` plus per-message stores and text-mode skip. */
export type CaptionsService = CaptionStore & {
  readonly scope: CaptionsScope
  readonly follow: CaptionsFollow
  /** Store for a specific assistant message (e.g. for rendering a speech bubble per reply). */
  forMessage(messageId: string): CaptionStore
  /** Reveals all remaining words of the active text cadence immediately. */
  skip(): void
}

declare module '@handsforbots/core' {
  interface Services {
    captions: CaptionsService
  }
}

/* -------------------------------------------------------------------------- */
/* Structural shapes for optional integration with `@handsforbots/voice`      */
/* -------------------------------------------------------------------------- */

type VoiceWordTimingLike = WordSpan & {
  start: number
  end: number
  quality: WordQuality
  source: Exclude<WordSource, 'cadence'>
}

type VoiceWordEventLike = {
  messageId?: string
  from?: number
  to?: number
  provider: string
} & (
  | { phase: 'chunk'; words: VoiceWordTimingLike[]; revised?: true }
  | { phase: 'word'; index: number; word: VoiceWordTimingLike }
  | { phase: 'gap'; index: number }
  | { phase: 'end'; reason: 'done' | 'interrupted' | 'error' }
)

type VoiceTrackEventLike = { messageId: string; speak: boolean }

type VoiceLike = {
  willSpeakReplies?: () => boolean
  getSpeechPosition?: () =>
    | {
        messageId?: string
        from?: number
        status: 'speaking' | 'gap'
        progress: number
      }
    | undefined
}

const MAX_MESSAGE_STORES = 32
const SENTENCE_END = /[.!?…]["')\]]*$/

/** Projects a full-message cadence state onto the active sentence when `scope === 'chunk'`. */
function projectChunk(full: CaptionsState): CaptionsState {
  const words = full.words
  if (!words.length) return full

  // Find the anchor word: active word, else last spoken word, else first word.
  let anchor = full.active
  if (anchor < 0) {
    for (let i = words.length - 1; i >= 0; i--) {
      if (words[i]!.state === 'spoken') {
        anchor = i
        break
      }
    }
  }
  if (anchor < 0) anchor = 0

  // Sentence boundaries around `anchor`.
  let start = 0
  for (let i = anchor - 1; i >= 0; i--) {
    if (SENTENCE_END.test(words[i]!.text)) {
      start = i + 1
      break
    }
  }
  let end = words.length
  for (let i = anchor; i < words.length; i++) {
    if (SENTENCE_END.test(words[i]!.text)) {
      end = i + 1
      break
    }
  }

  const slice = words.slice(start, end)
  return Object.freeze({
    ...full,
    from: slice[0]!.from,
    to: slice[slice.length - 1]!.to,
    words: Object.freeze(slice),
    active: full.active >= start && full.active < end ? full.active - start : -1,
  })
}

type MessageBucket = {
  state: CaptionsState
  listeners: Set<() => void>
  driver?: 'voice' | 'text'
  cadence?: CadenceController
  unsubCadence?: () => void
  /** Characters of `textOf(message)` already fed into `cadence` (prevents double-appending across `voice.track` + `message.delta`). */
  fedLength: number
  /** Index in `state.words` of each word of the current voice chunk, by chunk index. */
  chunkIndex: number[]
  /** Store handle returned by `forMessage(messageId)`. */
  store: CaptionStore
}

function apply(ctx: PluginContext, options: CaptionsOptions = {}) {
  const scope = options.scope ?? 'chunk'
  if (scope !== 'chunk' && scope !== 'message') throw new TypeError(`captions: unknown scope "${String(scope)}"`)
  const follow = options.follow ?? 'auto'
  if (follow !== 'auto' && follow !== 'voice' && follow !== 'text') {
    throw new TypeError(`captions: unknown follow "${String(follow)}"`)
  }
  const cutOnInterrupt = options.cutOnInterrupt !== false
  const app = ctx.app

  const globalListeners = new Set<() => void>()
  let globalState: CaptionsState = IDLE_CAPTION_STATE
  /** Active standalone voice chunk (e.g. `voice.speak(text)` without a messageId). */
  let activeVoiceMessageId: string | undefined
  let activeTextMessageId: string | undefined
  let standaloneChunkIndex: number[] = []
  const endedMessages = new Set<string>()
  const buckets = new Map<string, MessageBucket>()

  const voice = () => app.get('voice' as keyof Services) as unknown as VoiceLike | undefined

  const notify = (listeners: Set<() => void>) => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        app.emit('error', { error, source: 'captions' })
      }
    }
  }

  const publishGlobal = (next: CaptionsState) => {
    globalState = Object.freeze(next)
    notify(globalListeners)
  }

  const voiceProgressFor = (state: CaptionsState): number => {
    if (state.status === 'gap') return 1
    if (state.status !== 'speaking') return 0
    const position = voice()?.getSpeechPosition?.()
    if (!position || position.messageId !== state.messageId || position.from !== state.from) return 0
    return position.status === 'gap' ? 1 : position.progress
  }

  const trimBuckets = () => {
    while (buckets.size > MAX_MESSAGE_STORES) {
      const oldestKey = buckets.keys().next().value!
      if (oldestKey === activeVoiceMessageId || oldestKey === activeTextMessageId) break
      const oldest = buckets.get(oldestKey)
      oldest?.unsubCadence?.()
      oldest?.cadence?.dispose()
      oldest?.listeners.clear()
      buckets.delete(oldestKey)
    }
  }

  const getBucket = (messageId: string, hydrateCompleted = false): MessageBucket => {
    let bucket = buckets.get(messageId)
    if (bucket) return bucket

    let initial: CaptionsState = Object.freeze({ ...IDLE_CAPTION_STATE, messageId })
    if (hydrateCompleted) {
      const msg = app.conversation.find(messageId)
      if (msg && msg.role === 'assistant' && !msg.streaming) {
        const words = splitWords(textOf(msg)).map((w): CaptionWord => ({ ...w, state: 'spoken' }))
        if (words.length) {
          initial = Object.freeze({
            status: 'idle',
            messageId,
            from: words[0]!.from,
            to: words[words.length - 1]!.to,
            words: Object.freeze(words),
            active: -1,
            ended: msg.interrupted ? 'interrupted' : 'done',
            replyEnded: true,
          })
        }
      }
    }

    const listeners = new Set<() => void>()
    bucket = {
      state: initial,
      listeners,
      fedLength: 0,
      chunkIndex: [],
      store: {
        getState: () => bucket!.state,
        subscribe(listener) {
          listeners.add(listener)
          return () => void listeners.delete(listener)
        },
        progress() {
          if (bucket!.driver === 'text' && bucket!.cadence) return bucket!.cadence.progress()
          return voiceProgressFor(bucket!.state)
        },
      },
    }
    buckets.set(messageId, bucket)
    trimBuckets()
    return bucket
  }

  const publishBucket = (bucket: MessageBucket, next: CaptionsState) => {
    bucket.state = Object.freeze(next)
    notify(bucket.listeners)
  }

  /* ---------------------------------------------------------------------- */
  /* Text cadence driver                                                    */
  /* ---------------------------------------------------------------------- */

  const startTextCadence = (messageId: string, initialText: string, alreadyEnded: boolean) => {
    const bucket = getBucket(messageId)
    if (bucket.driver === 'voice' || bucket.cadence) return
    bucket.driver = 'text'
    activeTextMessageId = messageId

    const cadence = createCadence({
      pace: options.pace,
      messageId,
      reducedMotion: options.reducedMotion,
      clock: options.clock,
      schedule: options.schedule,
      cancelSchedule: options.cancelSchedule,
      onError: (error) => app.emit('error', { error, source: 'captions' }),
    })
    bucket.cadence = cadence

    const sync = () => {
      const full = cadence.getState()
      const projected = scope === 'chunk' ? projectChunk(full) : full
      publishBucket(bucket, projected)
      if (activeTextMessageId === messageId && activeVoiceMessageId !== messageId) {
        publishGlobal(projected)
      }
    }
    bucket.unsubCadence = cadence.subscribe(sync)

    if (initialText) {
      cadence.append(initialText)
      bucket.fedLength = initialText.length
    }
    if (alreadyEnded) cadence.finish()
    sync()
  }

  const stopTextCadence = (bucket: MessageBucket) => {
    bucket.unsubCadence?.()
    bucket.unsubCadence = undefined
    bucket.cadence?.dispose()
    bucket.cadence = undefined
  }

  /* ---------------------------------------------------------------------- */
  /* Voice driver (`voice.word` + `voice.track`)                            */
  /* ---------------------------------------------------------------------- */

  const spokenThroughOf = (words: readonly CaptionWord[]) => {
    let last = -1
    words.forEach((word, i) => word.state === 'spoken' && (last = i))
    return last
  }

  const applyVoiceStates = (
    current: CaptionsState,
    chunkIndex: number[],
    active: number,
    spokenThrough: number,
    status: CaptionsState['status'],
    markRemainingSkipped: boolean,
    extra: Partial<CaptionsState> = {},
  ): CaptionsState => {
    const firstOfChunk = chunkIndex[0] ?? 0
    const words = current.words.map((word, i): CaptionWord => {
      const next: CaptionWordState =
        i === active
          ? 'active'
          : i <= spokenThrough || (scope === 'message' && i < firstOfChunk)
            ? 'spoken'
            : markRemainingSkipped
              ? 'skipped'
              : 'upcoming'
      return next === word.state ? word : { ...word, state: next }
    })
    return { ...current, ...extra, words: Object.freeze(words), active, status, driver: 'voice' }
  }

  const onVoiceChunk = (event: Extract<VoiceWordEventLike, { phase: 'chunk' }>) => {
    const range = {
      ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
      ...(event.from !== undefined ? { from: event.from } : {}),
      ...(event.to !== undefined ? { to: event.to } : {}),
    }
    const timed = event.words.map((w): CaptionWord => ({ ...w, state: 'upcoming' }))
    const message = event.messageId ? app.conversation.find(event.messageId) : undefined

    let nextWords: CaptionWord[] = timed
    let chunkIndex = timed.map((_, i) => i)

    if (scope === 'message' && message) {
      const text = textOf(message)
      const all = splitWords(text).map((w): CaptionWord => {
        const match = timed.find((t) => t.from === w.from)
        return match ?? { ...w, state: w.to <= (event.from ?? 0) ? 'spoken' : 'upcoming' }
      })
      const mapped = timed.map((t) => all.findIndex((w) => w.from === t.from))
      if (!mapped.some((i) => i < 0)) {
        nextWords = all
        chunkIndex = mapped
      }
    }

    const next: CaptionsState = {
      status: 'idle',
      ...range,
      words: Object.freeze(nextWords),
      active: -1,
      driver: 'voice',
    }

    if (event.messageId) {
      const bucket = getBucket(event.messageId)
      if (bucket.cadence) stopTextCadence(bucket)
      bucket.driver = 'voice'
      bucket.chunkIndex = chunkIndex
      activeVoiceMessageId = event.messageId
      publishBucket(bucket, next)
      publishGlobal(next)
    } else {
      activeVoiceMessageId = undefined
      standaloneChunkIndex = chunkIndex
      publishGlobal(next)
    }
  }

  const onVoiceWord = (event: VoiceWordEventLike) => {
    if (follow === 'text') return
    if (event.phase === 'chunk') return onVoiceChunk(event)

    const bucket = event.messageId ? buckets.get(event.messageId) : undefined
    const targetState = bucket ? bucket.state : globalState
    const chunkIndex = bucket ? bucket.chunkIndex : standaloneChunkIndex
    if (event.messageId !== targetState.messageId || event.from !== targetState.from) return

    let next: CaptionsState
    if (event.phase === 'word') {
      const at = chunkIndex[event.index] ?? -1
      next = applyVoiceStates(targetState, chunkIndex, at, at - 1, 'speaking', false, {
        ended: undefined,
        replyEnded: undefined,
      })
    } else if (event.phase === 'gap') {
      const at = chunkIndex[event.index] ?? -1
      next = applyVoiceStates(targetState, chunkIndex, -1, at, 'gap', false)
    } else {
      const cut = event.reason !== 'done'
      const through =
        event.reason === 'done'
          ? (chunkIndex[chunkIndex.length - 1] ?? -1)
          : targetState.active >= 0
            ? targetState.active
            : spokenThroughOf(targetState.words)
      let replyEnded: boolean | undefined
      if (cut) {
        replyEnded = true
      } else if (!event.messageId) {
        replyEnded = true
      } else if (endedMessages.has(event.messageId)) {
        const msg = app.conversation.find(event.messageId)
        const trimmedLen = msg ? textOf(msg).trimEnd().length : 0
        if ((event.to ?? 0) >= trimmedLen) replyEnded = true
      }
      next = applyVoiceStates(targetState, chunkIndex, -1, through, 'idle', cut, {
        ended: event.reason,
        ...(replyEnded ? { replyEnded } : {}),
      })
    }

    if (bucket) publishBucket(bucket, next)
    if (globalState.messageId === targetState.messageId && globalState.from === targetState.from) {
      publishGlobal(next)
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Kernel event wiring                                                    */
  /* ---------------------------------------------------------------------- */

  ctx.on('voice.word' as keyof Events, ((event: VoiceWordEventLike) => onVoiceWord(event)) as never)

  ctx.on('voice.track' as keyof Events, ((event: VoiceTrackEventLike) => {
    if (follow === 'text') return
    const bucket = getBucket(event.messageId)
    if (event.speak) {
      if (bucket.cadence) stopTextCadence(bucket)
      bucket.driver = 'voice'
      return
    }
    if (follow === 'auto' && !bucket.cadence) {
      const msg = app.conversation.find(event.messageId)
      const text = msg ? textOf(msg) : ''
      if (text || endedMessages.has(event.messageId)) {
        startTextCadence(event.messageId, text, endedMessages.has(event.messageId))
      }
    }
  }) as never)

  ctx.on('stimulus', ({ stimulus }) => {
    if (stimulus.type === 'message.delta') {
      const msg = app.conversation.find(stimulus.messageId)
      if (msg?.role !== 'assistant') return

      // F2: keep scope:'message' up to date while voice is speaking an earlier chunk.
      const existing = buckets.get(stimulus.messageId)
      if (existing?.driver === 'voice' && scope === 'message' && existing.state.words.length > 0) {
        const allSpans = splitWords(textOf(msg))
        if (allSpans.length > existing.state.words.length) {
          const appended = allSpans
            .slice(existing.state.words.length)
            .map((w): CaptionWord => ({ ...w, state: 'upcoming' }))
          const next: CaptionsState = {
            ...existing.state,
            words: Object.freeze([...existing.state.words, ...appended]),
          }
          publishBucket(existing, next)
          if (globalState.messageId === stimulus.messageId && globalState.driver === 'voice') {
            publishGlobal(next)
          }
        }
        return
      }

      if (follow === 'voice') return
      if (existing?.driver === 'voice') return
      if (follow === 'auto' && !existing?.cadence && voice()?.willSpeakReplies?.()) return

      const fullText = textOf(msg)
      if (!existing?.cadence) {
        startTextCadence(stimulus.messageId, fullText, false)
      } else if (fullText.length > existing.fedLength) {
        const chunk = fullText.slice(existing.fedLength)
        existing.fedLength = fullText.length
        existing.cadence.append(chunk)
      }
      return
    }

    if (stimulus.type === 'message.end') {
      const msg = app.conversation.find(stimulus.messageId)
      if (msg?.role !== 'assistant') return
      endedMessages.add(stimulus.messageId)
      const bucket = buckets.get(stimulus.messageId)
      if (bucket?.driver === 'text' && bucket.cadence) {
        bucket.cadence.finish()
      } else if (bucket?.driver === 'voice' && bucket.state.status === 'idle' && bucket.state.ended === 'done') {
        const trimmedLen = textOf(msg).trimEnd().length
        if ((bucket.state.to ?? 0) >= trimmedLen && !bucket.state.replyEnded) {
          const next: CaptionsState = { ...bucket.state, replyEnded: true }
          publishBucket(bucket, next)
          if (globalState.messageId === stimulus.messageId) publishGlobal(next)
        }
      }
    }
  })

  if (cutOnInterrupt) {
    ctx.intercept('interrupt.before', (point) => {
      const bucket = buckets.get(point.messageId)
      if (!bucket || bucket.driver !== 'text' || !bucket.cadence) return
      if (bucket.cadence.getState().replyEnded) return
      return { ...point, keep: Math.min(point.keep, bucket.cadence.shown()) }
    })
  }

  ctx.on('turn.interrupted', ({ messageId }) => {
    if (!messageId) return
    const bucket = buckets.get(messageId)
    if (bucket?.driver === 'text' && bucket.cadence) {
      bucket.cadence.cut()
    }
  })

  ctx.on('service.removed', ({ key }) => {
    if (key === ('voice' as keyof Services) && globalState.driver === 'voice') {
      publishGlobal(IDLE_CAPTION_STATE)
    }
  })

  const service: CaptionsService = {
    getState: () => globalState,
    subscribe(listener) {
      globalListeners.add(listener)
      return () => void globalListeners.delete(listener)
    },
    progress() {
      if (globalState.driver === 'text' && activeTextMessageId) {
        const bucket = buckets.get(activeTextMessageId)
        if (bucket?.cadence && bucket.state.messageId === globalState.messageId) {
          return bucket.cadence.progress()
        }
      }
      return voiceProgressFor(globalState)
    },
    scope,
    follow,
    forMessage(messageId) {
      return getBucket(messageId, true).store
    },
    skip() {
      if (!activeTextMessageId) return
      buckets.get(activeTextMessageId)?.cadence?.skip()
    },
  }

  ctx.provide('captions', service)
  ctx.onDispose(() => {
    for (const bucket of buckets.values()) {
      stopTextCadence(bucket)
      bucket.listeners.clear()
    }
    buckets.clear()
    globalListeners.clear()
  })
}

/**
 * Word-by-word captions and reading cadence (ADR 0020 / ADR 0021): follows
 * `voice.word` when replies are spoken, or drives assistant replies with a
 * text reading cadence when voice is absent or silent. Works with the widget,
 * `<h4b-caption>`, `renderCaption`, React/Vue `useCaption` or your own UI.
 */
export const captions = definePlugin<CaptionsOptions | undefined>({
  name: 'captions',
  provides: ['captions'],
  apply,
})
