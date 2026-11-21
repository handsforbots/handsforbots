import { afterEach, describe, expect, it, vi } from 'vitest'

const capture = vi.hoisted(() => ({
  frame: undefined as Float32Array | undefined,
  stopped: 0,
  silent: false,
  delay: undefined as (() => Promise<void>) | undefined,
  lastContext: undefined as AudioContext | undefined,
}))

vi.mock('../src/providers/media.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/providers/media.js')>()
  return {
    ...original,
    // Delivers the same 100 ms frame on every microtask until stopped.
    captureFloat: async (
      _stream: MediaStream,
      onFrame: (frame: Float32Array, rate: number) => void,
      options?: { context?: AudioContext },
    ) => {
      capture.lastContext = options?.context
      if (capture.delay) await capture.delay()
      let running = true
      if (!capture.silent) {
        void (async () => {
          while (running) {
            onFrame(capture.frame ?? new Float32Array(1600), 16000)
            await Promise.resolve()
          }
        })()
      }
      return async () => {
        running = false
        capture.stopped++
      }
    },
  }
})

const {
  assessNoise,
  checkNoise,
  createNoiseMeter,
  measureNoise,
  noiseFloorTracker,
  speechThreshold,
} = await import('../src/index.js')

const RATE = 16000

/** Deterministic white noise with the given RMS. */
function noise(seconds: number, rms: number, seed = 1) {
  let state = seed
  const out = new Float32Array(Math.round(seconds * RATE))
  const scale = rms * Math.sqrt(3) // uniform on [-1, 1] has RMS 1/sqrt(3)
  for (let i = 0; i < out.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    out[i] = (state / 0xffffffff) * 2 - 1
    out[i]! *= scale
  }
  return out
}

/** A 200 Hz tone switched on and off every 250 ms, standing in for syllables. */
function bursts(seconds: number, rms: number) {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) {
    const on = Math.floor(i / (RATE / 4)) % 2 === 0
    out[i] = on ? Math.SQRT2 * rms * Math.sin((2 * Math.PI * 200 * i) / RATE) : 0
  }
  return out
}

const mix = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts[0]!.length)
  for (const part of parts) part.forEach((v, i) => (out[i]! += v))
  return out
}

const db = (value: number) => 10 ** (value / 20)

function measure(samples: Float32Array, thresholds?: Parameters<typeof assessNoise>[1]) {
  const meter = createNoiseMeter({ thresholds })
  // Push in uneven chunks, as an AudioWorklet would.
  for (let i = 0; i < samples.length; i += 333) meter.push(samples.subarray(i, i + 333), RATE)
  return meter.report()!
}

afterEach(() => {
  vi.useRealTimers()
  capture.frame = undefined
  capture.stopped = 0
  capture.silent = false
  capture.delay = undefined
  capture.lastContext = undefined
  vi.unstubAllGlobals()
})

describe('createNoiseMeter', () => {
  it('reports nothing before a full frame', () => {
    const meter = createNoiseMeter()
    meter.push(new Float32Array(100), RATE)
    expect(meter.frames).toBe(0)
    expect(meter.report()).toBeUndefined()
  })

  it('measures the noise floor in dBFS', () => {
    const report = measure(noise(1, db(-40)))
    expect(report.noiseFloorDb).toBeGreaterThan(-42)
    expect(report.noiseFloorDb).toBeLessThan(-38)
    expect(report.frames).toBe(50)
    expect(report.durationMs).toBe(1000)
  })

  it('calls a quiet room quiet', () => {
    const report = measure(noise(1.5, db(-70)))
    expect(report.verdict).toBe('quiet')
    expect(report.reasons).toEqual([])
  })

  it('calls a steady loud floor noisy, and a louder one too noisy', () => {
    expect(measure(noise(1.5, db(-45))).verdict).toBe('noisy')
    const loud = measure(noise(1.5, db(-25)))
    expect(loud.verdict).toBe('too-noisy')
    expect(loud.reasons).toContain('loud-floor')
  })

  it('estimates SNR when there is speech and keeps it out when there is none', () => {
    const clean = measure(mix(bursts(2, db(-20)), noise(2, db(-65))))
    expect(clean.snrDb).toBeGreaterThan(40)
    expect(clean.verdict).toBe('quiet')
    expect(measure(noise(1.5, db(-55))).snrDb).toBeUndefined()
  })

  it('flags speech barely above the noise as low SNR', () => {
    const report = measure(mix(bursts(2, db(-45)), noise(2, db(-58))))
    expect(report.snrDb).toBeGreaterThanOrEqual(12)
    expect(report.snrDb).toBeLessThan(15)
    expect(report.reasons).toEqual(['low-snr'])
    expect(report.verdict).toBe('noisy')
  })

  it('treats speech too close to the noise to tell apart as fluctuating noise', () => {
    const report = measure(mix(bursts(2, db(-50)), noise(2, db(-58))))
    expect(report.snrDb).toBeUndefined()
    expect(report.reasons).toEqual(['fluctuating'])
    expect(report.verdict).toBe('noisy')
  })

  it('does not count the swings of clear speech as fluctuating noise', () => {
    const report = measure(mix(bursts(2, db(-25)), noise(2, db(-58))))
    expect(report.fluctuationDb).toBeGreaterThan(6)
    expect(report.reasons).toEqual([])
  })

  it('flags fluctuating noise even when its floor is moderate', () => {
    // Background chatter: the quieter frames swing between two levels.
    const chatter = new Float32Array(2 * RATE)
    const low = noise(2, db(-58), 3)
    const high = noise(2, db(-40), 4)
    for (let i = 0; i < chatter.length; i++) chatter[i] = Math.floor(i / 800) % 3 === 0 ? high[i]! : low[i]!
    const report = measure(chatter, { speechRangeDb: 99 })
    expect(report.snrDb).toBeUndefined()
    expect(report.fluctuationDb).toBeGreaterThanOrEqual(6)
    expect(report.reasons).toContain('fluctuating')
  })

  it('flags clipping and dead input', () => {
    const clipped = noise(1, db(-70))
    for (let i = 0; i < clipped.length; i += 100) clipped[i] = 1
    expect(measure(clipped).reasons).toContain('clipping')
    expect(measure(new Float32Array(RATE)).reasons).toEqual(['silent-input'])
  })

  it('takes custom thresholds and resets', () => {
    const samples = noise(1, db(-45))
    expect(measure(samples, { noisyFloorDb: -40 }).verdict).toBe('quiet')
    const meter = createNoiseMeter()
    meter.push(samples, RATE)
    meter.reset()
    expect(meter.report()).toBeUndefined()
  })
})

describe('noise floor for end of speech', () => {
  it('tracks the minimum of the last readings', () => {
    const floor = noiseFloorTracker(3)
    expect(floor.floor).toBe(0)
    expect(floor.push(0.05)).toBe(0.05)
    floor.push(0.2)
    floor.push(0.3)
    expect(floor.push(0.4)).toBe(0.2)
  })

  it('raises the speech threshold over a loud floor and keeps it fixed with margin 0', () => {
    expect(speechThreshold(0.001)).toBe(0.015)
    expect(speechThreshold(0.02)).toBeCloseTo(0.06)
    expect(speechThreshold(0.02, { margin: 0 })).toBe(0.015)
  })
})

describe('measureNoise / checkNoise', () => {
  it('measures a stream for the given time and stops capturing', async () => {
    capture.frame = noise(0.1, db(-30))
    const report = await measureNoise({} as MediaStream, { durationMs: 500 })
    expect(report.verdict).toBe('too-noisy')
    expect(report.durationMs).toBeGreaterThanOrEqual(500)
    expect(capture.stopped).toBe(1)
  })

  it('rejects when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(measureNoise({} as MediaStream, { signal: controller.signal })).rejects.toBeDefined()
  })

  it('opens the raw microphone by default and closes it afterwards', async () => {
    const stop = vi.fn()
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    capture.frame = noise(0.1, db(-75))
    const report = await checkNoise({ durationMs: 300 })
    expect(report.verdict).toBe('quiet')
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      video: false,
    })
    expect(stop).toHaveBeenCalled()
  })

  it('maps permission errors', async () => {
    const denied = Object.assign(new Error('no'), { name: 'NotAllowedError' })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => Promise.reject(denied)) } })
    await expect(checkNoise()).rejects.toMatchObject({ code: 'not-allowed' })
  })

  it('aborts cleanly when signal aborts during captureFloat setup', async () => {
    const controller = new AbortController()
    let release!: () => void
    capture.delay = () => new Promise<void>((resolve) => (release = resolve))
    capture.silent = true

    const pending = measureNoise({} as MediaStream, { signal: controller.signal, timeoutMs: 0 })
    controller.abort()
    release()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(capture.stopped).toBe(1)
  })

  it('times out with SpeechError(audio-capture) and stops capture when no frames arrive', async () => {
    vi.useFakeTimers()
    capture.silent = true

    const pending = measureNoise({} as MediaStream, { durationMs: 500, timeoutMs: 250 })
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'audio-capture',
      message: 'Noise measurement timed out',
    })
    await vi.advanceTimersByTimeAsync(250)
    await assertion
    expect(capture.stopped).toBe(1)
  })

  it('checkNoise rejects immediately without calling getUserMedia when signal is already aborted', async () => {
    const getUserMedia = vi.fn()
    const audioContextCtor = vi.fn()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    vi.stubGlobal('AudioContext', audioContextCtor)

    const controller = new AbortController()
    controller.abort()

    await expect(checkNoise({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(audioContextCtor).not.toHaveBeenCalled()
  })

  it('checkNoise creates and resumes AudioContext synchronously before getUserMedia resolves', async () => {
    const stop = vi.fn()
    let resolveMedia!: (stream: MediaStream) => void
    const getUserMedia = vi.fn(
      () => new Promise<MediaStream>((resolve) => (resolveMedia = resolve)),
    )
    const contexts: { state: string; resume: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = []
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'suspended'
        resume = vi.fn(async () => {
          this.state = 'running'
        })
        close = vi.fn(async () => {
          this.state = 'closed'
        })
        constructor() {
          contexts.push(this)
        }
      },
    )

    capture.frame = noise(0.1, db(-75))
    const pending = checkNoise({ durationMs: 300 })

    // Synchronously created and resumed before getUserMedia resolves.
    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.resume).toHaveBeenCalledTimes(1)

    resolveMedia({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    const report = await pending
    expect(report.verdict).toBe('quiet')
    expect(capture.lastContext).toBe(contexts[0])
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('checkNoise closes the pre-created AudioContext if getUserMedia fails', async () => {
    const close = vi.fn(async () => {})
    const resume = vi.fn(async () => {})
    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'suspended'
        resume = resume
        close = close
      },
    )
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => Promise.reject(denied)) } })

    await expect(checkNoise()).rejects.toMatchObject({ code: 'not-allowed' })
    expect(resume).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('checkNoise closes both stream and pre-created AudioContext if aborted during getUserMedia', async () => {
    const stop = vi.fn()
    const close = vi.fn(async () => {})
    let resolveMedia!: (stream: MediaStream) => void
    vi.stubGlobal(
      'AudioContext',
      class {
        state = 'suspended'
        resume = vi.fn(async () => {})
        close = close
      },
    )
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(() => new Promise<MediaStream>((resolve) => (resolveMedia = resolve))),
      },
    })

    const controller = new AbortController()
    const pending = checkNoise({ signal: controller.signal })
    controller.abort()
    resolveMedia({ getTracks: () => [{ stop }] } as unknown as MediaStream)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
