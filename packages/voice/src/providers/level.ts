import { openMicrophone, closeStream } from './media.js'

/**
 * Level gate: tells the user's speech from quieter voices around them (TV,
 * people nearby) by loudness. The user talks into the microphone, so their
 * speech is usually well above background voices; the gate learns how loud
 * the user's accepted utterances were and judges new speech against that.
 * No model: it fails when the user speaks much softer than usual or moves
 * away, and when background voices are as loud as the user.
 */

export type LevelGateOptions = {
  /**
   * What the gate drops. `barge-in` (default): background speech heard while
   * the bot answers neither interrupts it nor becomes a turn. `all`: also
   * background speech in hands-free while the bot is quiet.
   */
  scope?: 'barge-in' | 'all'
  /** Speech this many dB below the user's level is background. Default 10. */
  gapDb?: number
  /** Audio looked at when a transcript arrives (recognizers deliver late). Default 3000 ms. */
  lookbackMs?: number
  /** Accepted utterances kept to learn the user's level (the median is used). Default 5. */
  remember?: number
  /** Replaces the microphone monitor (tests, or audio you already have): call `onLevel` with dBFS readings. */
  open?: (onLevel: (db: number) => void) => Promise<() => void>
}

export type LevelVerdict = 'user' | 'background' | 'unknown'

export type LevelGate = {
  /** One level reading (dBFS) at `at` (epoch ms). */
  push(db: number, at?: number): void
  /** Loud end (95th percentile) of the readings in the lookback window; `undefined` without readings. */
  peak(at?: number): number | undefined
  /** The speech just heard was the user's: learn its level. */
  learn(at?: number): void
  /** Whether the speech in the lookback window was loud enough to be the user's. */
  judge(at?: number): LevelVerdict
  /** Median level of the user's last accepted utterances, once learned. */
  readonly userLevelDb: number | undefined
  /** `userLevelDb - gapDb`. */
  readonly gateDb: number | undefined
  reset(): void
}

const MIN_DB = -120
export const toDb = (rms: number) => (rms > 0 ? Math.max(MIN_DB, 20 * Math.log10(rms)) : MIN_DB)

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function createLevelGate({ gapDb = 10, lookbackMs = 3000, remember = 5 }: LevelGateOptions = {}): LevelGate {
  let readings: { at: number; db: number }[] = []
  let learned: number[] = []

  const gate: LevelGate = {
    push(db, at = Date.now()) {
      readings.push({ at, db })
      // Keep a little more than the window: transcripts are judged slightly after the fact.
      const oldest = at - lookbackMs * 2
      while (readings.length && readings[0]!.at < oldest) readings.shift()
    },
    peak(at = Date.now()) {
      const window = readings.filter((r) => r.at > at - lookbackMs && r.at <= at).map((r) => r.db)
      if (window.length === 0) return undefined
      window.sort((a, b) => a - b)
      return window[Math.min(window.length - 1, Math.round((window.length - 1) * 0.95))]
    },
    learn(at = Date.now()) {
      const level = gate.peak(at)
      if (level === undefined) return
      learned.push(level)
      if (learned.length > remember) learned.shift()
    },
    judge(at = Date.now()) {
      const threshold = gate.gateDb
      const level = gate.peak(at)
      if (threshold === undefined || level === undefined) return 'unknown'
      return level >= threshold ? 'user' : 'background'
    },
    get userLevelDb() {
      return learned.length ? median(learned) : undefined
    },
    get gateDb() {
      const user = gate.userLevelDb
      return user === undefined ? undefined : user - gapDb
    },
    reset() {
      readings = []
      learned = []
    },
  }
  return gate
}

/**
 * Opens the microphone (with the same processing as the recognizers) and
 * reports its level in dBFS every `intervalMs`. Resolves with a function that
 * stops and closes it.
 */
export async function monitorLevel(onLevel: (db: number) => void, { intervalMs = 50 } = {}): Promise<() => void> {
  const stream = await openMicrophone()
  try {
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    const source = context.createMediaStreamSource(stream)
    source.connect(analyser)
    const data = new Float32Array(analyser.fftSize)
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (const v of data) sum += v * v
      onLevel(toDb(Math.sqrt(sum / data.length)))
    }, intervalMs)
    return () => {
      clearInterval(timer)
      source.disconnect()
      closeStream(stream)
      void context.close()
    }
  } catch (error) {
    closeStream(stream)
    throw error
  }
}
