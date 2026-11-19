import { SpeechError } from '../types.js'
import { captureFloat, closeStream } from './media.js'

/**
 * Microphone noise check. Pure analysis (`createNoiseMeter`, `assessNoise`)
 * plus browser glue (`measureNoise`, `checkNoise`).
 * Levels are dBFS (0 = full scale), not sound pressure: microphones and gains
 * differ, so the default thresholds are a starting point to calibrate.
 */

export type NoiseVerdict = 'quiet' | 'noisy' | 'too-noisy'
export type NoiseReason = 'loud-floor' | 'fluctuating' | 'low-snr' | 'clipping' | 'silent-input'

export type NoiseThresholds = {
  /** Noise floor (dBFS) from which the room counts as noisy. Default -50. */
  noisyFloorDb?: number
  /** Noise floor (dBFS) from which the room counts as too noisy. Default -35. */
  tooNoisyFloorDb?: number
  /** `fluctuationDb` from which the noise counts as fluctuating (voices, TV, traffic). Default 6. */
  fluctuationDb?: number
  /** Fluctuation only counts above this floor (dBFS); near digital silence any spread is meaningless. Default -60. */
  fluctuationMinFloorDb?: number
  /**
   * From this dynamic range (dB) the loud frames are taken as the user's
   * speech and the report gets `snrDb`; below it, the swings are noise.
   * Default 12.
   */
  speechRangeDb?: number
  /** SNR (dB) below which speech is hard to recognize. Default 15. */
  noisySnrDb?: number
  /** Share of clipped samples that flags the input as clipping. Default 0.001. */
  clippingRatio?: number
  /** Floor (dBFS) below which the input looks dead (muted or wrong device). Default -90. */
  silentFloorDb?: number
}

export type NoiseReport = {
  verdict: NoiseVerdict
  reasons: NoiseReason[]
  /** 10th percentile of frame levels (dBFS): the noise floor. */
  noiseFloorDb: number
  /** 95th percentile of frame levels (dBFS): speech, when there was any. */
  peakDb: number
  /** `peakDb - noiseFloorDb`. */
  dynamicRangeDb: number
  /** Estimated signal-to-noise ratio, present only when the range suggests speech. */
  snrDb?: number
  /** 75th minus 10th percentile (dB): how far typical frames sit above the floor. Near 0 for steady noise. */
  fluctuationDb: number
  /** Share of samples at or above 0.99 of full scale. */
  clippingRatio: number
  frames: number
  durationMs: number
}

export type NoiseMeter = {
  /** Feeds raw samples at `sampleRate`; frames of `frameMs` are measured as they fill. */
  push(samples: Float32Array, sampleRate: number): void
  /** Frames measured so far. */
  readonly frames: number
  /** Report for what was pushed; `undefined` before the first full frame. */
  report(): NoiseReport | undefined
  reset(): void
}

const DEFAULTS: Required<NoiseThresholds> = {
  noisyFloorDb: -50,
  tooNoisyFloorDb: -35,
  fluctuationDb: 6,
  fluctuationMinFloorDb: -60,
  speechRangeDb: 12,
  noisySnrDb: 15,
  clippingRatio: 0.001,
  silentFloorDb: -90,
}

const MIN_DB = -120
const toDb = (rms: number) => (rms > 0 ? Math.max(MIN_DB, 20 * Math.log10(rms)) : MIN_DB)

const percentile = (sorted: number[], p: number) => {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[index]!
}

export function createNoiseMeter({
  frameMs = 20,
  thresholds,
}: { frameMs?: number; thresholds?: NoiseThresholds } = {}): NoiseMeter {
  let levels: number[] = []
  let sum = 0
  let count = 0
  let clipped = 0
  let samples = 0
  let rate = 0

  return {
    push(chunk, sampleRate) {
      if (rate !== sampleRate) {
        rate = sampleRate
        sum = 0
        count = 0
      }
      const size = Math.max(1, Math.round((sampleRate * frameMs) / 1000))
      for (const value of chunk) {
        sum += value * value
        if (Math.abs(value) >= 0.99) clipped++
        samples++
        if (++count === size) {
          levels.push(toDb(Math.sqrt(sum / size)))
          sum = 0
          count = 0
        }
      }
    },
    get frames() {
      return levels.length
    },
    report() {
      if (levels.length === 0) return undefined
      return assessNoise(
        { levels, clippingRatio: samples ? clipped / samples : 0, durationMs: levels.length * frameMs },
        thresholds,
      )
    },
    reset() {
      levels = []
      sum = 0
      count = 0
      clipped = 0
      samples = 0
    },
  }
}

/** Turns frame levels (dBFS) into a report and a verdict. */
export function assessNoise(
  { levels, clippingRatio = 0, durationMs = 0 }: { levels: number[]; clippingRatio?: number; durationMs?: number },
  thresholds: NoiseThresholds = {},
): NoiseReport {
  const t = { ...DEFAULTS, ...thresholds }
  const sorted = [...levels].sort((a, b) => a - b)
  const noiseFloorDb = percentile(sorted, 0.1)
  const peakDb = percentile(sorted, 0.95)
  const dynamicRangeDb = peakDb - noiseFloorDb
  const fluctuationDb = percentile(sorted, 0.75) - noiseFloorDb
  const snrDb = dynamicRangeDb >= t.speechRangeDb ? dynamicRangeDb : undefined

  const reasons: NoiseReason[] = []
  let verdict: NoiseVerdict = 'quiet'
  const raise = (to: NoiseVerdict, reason: NoiseReason) => {
    if (!reasons.includes(reason)) reasons.push(reason)
    if (to === 'too-noisy' || verdict === 'quiet') verdict = to
  }

  if (peakDb <= t.silentFloorDb) reasons.push('silent-input')
  if (noiseFloorDb >= t.tooNoisyFloorDb) raise('too-noisy', 'loud-floor')
  else if (noiseFloorDb >= t.noisyFloorDb) raise('noisy', 'loud-floor')
  if (noiseFloorDb >= t.fluctuationMinFloorDb) {
    // With speech, the swings are the user's voice and SNR decides; without, they are noise.
    if (snrDb !== undefined) {
      if (snrDb < t.noisySnrDb) raise('noisy', 'low-snr')
    } else if (fluctuationDb >= t.fluctuationDb) raise('noisy', 'fluctuating')
  }
  if (clippingRatio >= t.clippingRatio) raise('noisy', 'clipping')

  return {
    verdict,
    reasons,
    noiseFloorDb,
    peakDb,
    dynamicRangeDb,
    ...(snrDb === undefined ? {} : { snrDb }),
    fluctuationDb,
    clippingRatio,
    frames: levels.length,
    durationMs,
  }
}

export type MeasureNoiseOptions = {
  /** How long to listen. Default 1500 ms. */
  durationMs?: number
  frameMs?: number
  thresholds?: NoiseThresholds
  signal?: AbortSignal
}

/** Measures an open stream for `durationMs` and resolves with the report. */
export async function measureNoise(stream: MediaStream, options: MeasureNoiseOptions = {}): Promise<NoiseReport> {
  const { durationMs = 1500, frameMs, thresholds, signal } = options
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  const meter = createNoiseMeter({ frameMs, thresholds })
  let started = 0
  let finish!: () => void
  const done = new Promise<void>(resolve => (finish = resolve))
  const stop = await captureFloat(stream, (frame, sampleRate) => {
    meter.push(frame, sampleRate)
    started += (frame.length / sampleRate) * 1000
    if (started >= durationMs) finish()
  })
  const onAbort = () => finish()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await done
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await stop()
  }
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  const report = meter.report()
  if (!report) throw new SpeechError('audio-capture', 'No audio frames were captured')
  return report
}

export type CheckNoiseOptions = MeasureNoiseOptions & {
  /**
   * Browser processing during the check. Default `false`: noise suppression
   * hides steady noise and automatic gain raises the floor in silence, so the
   * raw signal is measured. `true` measures what processed recognizers hear.
   */
  processing?: boolean
  deviceId?: string
}

/** Opens the microphone, measures it and closes it. */
export async function checkNoise(options: CheckNoiseOptions = {}): Promise<NoiseReport> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new SpeechError('not-supported', 'Microphone capture is not available')
  }
  const processing = options.processing ?? false
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: processing,
        noiseSuppression: processing,
        autoGainControl: processing,
        channelCount: 1,
        ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      },
      video: false,
    })
  } catch (error) {
    const name = (error as DOMException)?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new SpeechError('not-allowed', 'Microphone permission denied')
    throw new SpeechError('audio-capture', (error as Error)?.message)
  }
  try {
    return await measureNoise(stream, options)
  } finally {
    closeStream(stream)
  }
}
