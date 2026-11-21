// @vitest-environment jsdom
import { createH4B } from '@handsforbots/core'
import { describe, expect, it, vi } from 'vitest'
import {
  SpeechError,
  assessNoise,
  voice,
  type NoiseReport,
  type SpeechToText,
  type VoiceNoiseEvent,
  type VoiceOptions,
  type VoiceService,
} from '../src/index.js'

const report = (floorDb: number): NoiseReport => assessNoise({ levels: Array(50).fill(floorDb), durationMs: 1000 })
const quiet = report(-70)
const noisy = report(-45)
const tooNoisy = report(-25)

function fakeSTT() {
  const listen = vi.fn((_options: unknown, handlers: { onEnd(): void }) => ({
    stop: vi.fn(() => handlers.onEnd()),
    abort: vi.fn(() => handlers.onEnd()),
  }))
  const provider: SpeechToText = {
    name: 'fake',
    capabilities: { partials: true, continuous: true },
    isSupported: () => true,
    listen: listen as never,
  }
  return { provider, listen }
}

/** A measurement the test resolves by hand. */
function manualMeasure() {
  const calls: { resolve(r: NoiseReport): void; reject(err: unknown): void; signal: AbortSignal }[] = []
  const measure = vi.fn(
    (signal: AbortSignal) =>
      new Promise<NoiseReport>((resolve, reject) => {
        calls.push({ resolve, reject, signal })
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }),
  )
  return {
    measure,
    resolve: (r: NoiseReport) => calls.at(-1)!.resolve(r),
    reject: (err: unknown) => calls.at(-1)!.reject(err),
    calls,
  }
}

async function setup(options: VoiceOptions) {
  const stt = fakeSTT()
  const h4b = createH4B({ plugins: [voice({ language: 'pt-BR', mode: 'hands-free', stt: stt.provider, ...options })] })
  await h4b.start()
  const v = h4b.get('voice') as VoiceService
  const events: VoiceNoiseEvent[] = []
  const errors: { source: string }[] = []
  h4b.on('voice.noise', (e) => events.push(e))
  h4b.on('error', (e) => errors.push(e))
  return { h4b, v, stt, events, errors }
}

describe('voice noise check', () => {
  it('is off by default', async () => {
    const { v, stt } = await setup({})
    await v.listen()
    expect(stt.listen).toHaveBeenCalledTimes(1)
    expect(v.getState().checkingNoise).toBe(false)
    expect(v.getState().noise).toBeUndefined()
  })

  it('measures before hands-free listening and listens when the room is fine', async () => {
    const m = manualMeasure()
    const { v, stt, events } = await setup({ noise: { measure: m.measure } })
    const listening = v.listen()
    await vi.waitFor(() => expect(m.measure).toHaveBeenCalled())
    expect(v.getState().checkingNoise).toBe(true)
    expect(stt.listen).not.toHaveBeenCalled()
    m.resolve(noisy)
    await listening
    expect(v.getState()).toMatchObject({ checkingNoise: false, listening: true, mode: 'hands-free', noiseFallback: false })
    expect(v.getState().noise?.verdict).toBe('noisy')
    expect(events).toEqual([{ report: noisy }])
  })

  it('falls back to push-to-talk when too noisy, until the mode is set again', async () => {
    const { v, stt, events } = await setup({ noise: { measure: async () => tooNoisy } })
    await v.listen()
    expect(stt.listen).not.toHaveBeenCalled()
    expect(v.getState()).toMatchObject({ mode: 'push-to-talk', noiseFallback: true, listening: false })
    expect(events).toEqual([{ report: tooNoisy, action: 'push-to-talk' }])
    // Push-to-talk is not checked.
    await v.listen()
    expect(stt.listen).toHaveBeenCalledTimes(1)
    v.stop()
    v.setMode('hands-free')
    expect(v.getState().noiseFallback).toBe(false)
  })

  it('only warns with tooNoisy: warn', async () => {
    const { v, stt, events } = await setup({ noise: { measure: async () => tooNoisy, tooNoisy: 'warn' } })
    await v.listen()
    expect(stt.listen).toHaveBeenCalledTimes(1)
    expect(v.getState()).toMatchObject({ mode: 'hands-free', noiseFallback: false })
    expect(events).toEqual([{ report: tooNoisy }])
  })

  it('reuses a recent report and measures again when it is old', async () => {
    const measure = vi.fn(async () => quiet)
    const { v, events } = await setup({ noise: { measure, maxAgeMs: 60_000 } })
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    await v.listen()
    v.stop()
    await v.listen()
    v.stop()
    expect(measure).toHaveBeenCalledTimes(1)
    expect(events).toHaveLength(1)
    now.mockReturnValue(1_000_000 + 60_001)
    await v.listen()
    expect(measure).toHaveBeenCalledTimes(2)
    now.mockRestore()
  })

  it('stop during the check aborts it and does not listen', async () => {
    const m = manualMeasure()
    const { v, stt, errors } = await setup({ noise: { measure: m.measure } })
    const listening = v.listen()
    await vi.waitFor(() => expect(m.measure).toHaveBeenCalled())
    await v.toggle()
    await listening
    expect(m.calls[0]!.signal.aborted).toBe(true)
    expect(stt.listen).not.toHaveBeenCalled()
    expect(v.getState()).toMatchObject({ checkingNoise: false, listening: false })
    expect(errors).toEqual([])
  })

  it('a second listen during the check starts one session', async () => {
    const m = manualMeasure()
    const { v, stt } = await setup({ noise: { measure: m.measure } })
    const first = v.listen()
    await vi.waitFor(() => expect(m.measure).toHaveBeenCalled())
    const second = v.listen()
    m.resolve(quiet)
    await Promise.all([first, second])
    expect(m.measure).toHaveBeenCalledTimes(1)
    expect(stt.listen).toHaveBeenCalledTimes(1)
  })

  it('listens anyway when the measurement fails, and reports the error', async () => {
    const { v, stt, errors } = await setup({ noise: { measure: async () => Promise.reject(new Error('no mic')) } })
    await v.listen()
    expect(stt.listen).toHaveBeenCalledTimes(1)
    expect(errors.map((e) => e.source)).toEqual(['voice:noise'])
  })

  it('manual: no check before listening; checkNoise() measures on demand', async () => {
    const measure = vi.fn(async () => noisy)
    const { v, stt, events } = await setup({ noise: { check: 'manual', measure } })
    await v.listen()
    expect(measure).not.toHaveBeenCalled()
    expect(stt.listen).toHaveBeenCalledTimes(1)
    await expect(v.checkNoise()).resolves.toBe(noisy)
    expect(v.getState().noise).toBe(noisy)
    expect(events).toEqual([{ report: noisy }])
  })

  it('transitions atomically from checkingNoise to listening without a false/false gap', async () => {
    const m = manualMeasure()
    const { v } = await setup({ noise: { measure: m.measure } })
    const transitions: Array<{ checkingNoise: boolean; listening: boolean; noise: NoiseReport | undefined }> = []
    v.subscribe(() => {
      const { checkingNoise, listening, noise } = v.getState()
      transitions.push({ checkingNoise, listening, noise })
    })
    const listening = v.listen()
    await vi.waitFor(() => expect(m.measure).toHaveBeenCalled())
    m.resolve(noisy)
    await listening
    expect(transitions).toEqual([
      { checkingNoise: true, listening: false, noise: undefined },
      { checkingNoise: false, listening: true, noise: noisy },
    ])
  })

  it('transitions atomically from checkingNoise to push-to-talk fallback when too noisy', async () => {
    const m = manualMeasure()
    const { v } = await setup({ noise: { measure: m.measure } })
    const transitions: Array<{
      checkingNoise: boolean
      listening: boolean
      mode: string
      noiseFallback: boolean
      noise: NoiseReport | undefined
    }> = []
    v.subscribe(() => {
      const { checkingNoise, listening, mode, noiseFallback, noise } = v.getState()
      transitions.push({ checkingNoise, listening, mode, noiseFallback, noise })
    })
    const listening = v.listen()
    await vi.waitFor(() => expect(m.measure).toHaveBeenCalled())
    m.resolve(tooNoisy)
    await listening
    expect(transitions).toEqual([
      { checkingNoise: true, listening: false, mode: 'hands-free', noiseFallback: false, noise: undefined },
      { checkingNoise: false, listening: false, mode: 'push-to-talk', noiseFallback: true, noise: tooNoisy },
    ])
  })

  it('transitions atomically from checkingNoise to listening when measurement fails', async () => {
    const m = manualMeasure()
    const { v, errors } = await setup({ noise: { measure: m.measure } })
    const transitions: Array<{ checkingNoise: boolean; listening: boolean; noise: NoiseReport | undefined }> = []
    v.subscribe(() => {
      const { checkingNoise, listening, noise } = v.getState()
      transitions.push({ checkingNoise, listening, noise })
    })
    const listening = v.listen()
    await vi.waitFor(() => expect(m.measure).toHaveBeenCalled())
    m.reject(new Error('no mic'))
    await listening
    expect(transitions).toEqual([
      { checkingNoise: true, listening: false, noise: undefined },
      { checkingNoise: false, listening: true, noise: undefined },
    ])
    expect(errors.map((e) => e.source)).toEqual(['voice:noise'])
  })

  it('calls stt.listen synchronously to preserve user activation when no check runs', async () => {
    // 1. noise off
    {
      const { v, stt } = await setup({})
      const pending = v.listen()
      expect(stt.listen).toHaveBeenCalledTimes(1)
      await pending
    }
    // 2. push-to-talk mode
    {
      const { v, stt } = await setup({ mode: 'push-to-talk', noise: { measure: async () => quiet } })
      const pending = v.listen()
      expect(stt.listen).toHaveBeenCalledTimes(1)
      await pending
    }
    // 3. manual check
    {
      const { v, stt } = await setup({ noise: { check: 'manual', measure: async () => quiet } })
      const pending = v.listen()
      expect(stt.listen).toHaveBeenCalledTimes(1)
      await pending
    }
    // 4. fresh cached report
    {
      const { v, stt } = await setup({ noise: { measure: async () => quiet, maxAgeMs: 60_000 } })
      await v.checkNoise()
      const pending = v.listen()
      expect(stt.listen).toHaveBeenCalledTimes(1)
      await pending
    }
  })

  it('waits settleMs after measurement before listening and aborts cleanly on stop', async () => {
    vi.useFakeTimers()
    try {
      const m1 = manualMeasure()
      const s1 = await setup({ noise: { measure: m1.measure, settleMs: 100 } })
      const transitions: Array<{ checkingNoise: boolean; listening: boolean }> = []
      s1.v.subscribe(() => {
        const { checkingNoise, listening } = s1.v.getState()
        transitions.push({ checkingNoise, listening })
      })
      const listening = s1.v.listen()
      expect(m1.measure).toHaveBeenCalledTimes(1)
      m1.resolve(quiet)
      await Promise.resolve()
      await Promise.resolve()
      expect(s1.v.getState()).toMatchObject({ checkingNoise: true, listening: false })
      expect(s1.stt.listen).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(99)
      expect(s1.v.getState()).toMatchObject({ checkingNoise: true, listening: false })
      expect(s1.stt.listen).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await listening
      expect(s1.stt.listen).toHaveBeenCalledTimes(1)
      expect(transitions).toEqual([
        { checkingNoise: true, listening: false },
        { checkingNoise: false, listening: true },
      ])

      // Aborting during settle window cancels immediately without starting STT.
      const m2 = manualMeasure()
      const s2 = await setup({ noise: { measure: m2.measure, settleMs: 100 } })
      const listening2 = s2.v.listen()
      expect(m2.measure).toHaveBeenCalledTimes(1)
      m2.resolve(quiet)
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(50)
      expect(s2.v.getState()).toMatchObject({ checkingNoise: true, listening: false })
      s2.v.stop()
      expect(s2.v.getState()).toMatchObject({ checkingNoise: false, listening: false })
      await vi.advanceTimersByTimeAsync(100)
      await listening2
      expect(s2.stt.listen).not.toHaveBeenCalled()
      expect(s2.v.getState()).toMatchObject({ checkingNoise: false, listening: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries once after 250ms when stt.listen throws audio-capture right after a noise check', async () => {
    vi.useFakeTimers()
    try {
      // Succeeds on the one-shot retry.
      let attempt = 0
      const listen = vi.fn((_options: unknown, handlers: { onEnd(): void }) => {
        attempt++
        if (attempt === 1) throw new SpeechError('audio-capture', 'busy')
        return { stop: vi.fn(() => handlers.onEnd()), abort: vi.fn(() => handlers.onEnd()) }
      })
      const provider: SpeechToText = {
        name: 'flaky',
        capabilities: { partials: true, continuous: true },
        isSupported: () => true,
        listen: listen as never,
      }
      const h4b = createH4B({
        plugins: [voice({ language: 'pt-BR', mode: 'hands-free', stt: provider, noise: { measure: async () => quiet } })],
      })
      await h4b.start()
      const v = h4b.get('voice') as VoiceService

      await v.listen()
      expect(listen).toHaveBeenCalledTimes(1)
      expect(v.getState().listening).toBe(false)

      await vi.advanceTimersByTimeAsync(250)
      expect(listen).toHaveBeenCalledTimes(2)
      expect(v.getState().listening).toBe(true)

      // Stops retrying if the retry also throws audio-capture.
      const alwaysFail = vi.fn(() => {
        throw new SpeechError('audio-capture', 'broken mic')
      })
      const broken: SpeechToText = {
        name: 'broken',
        capabilities: { partials: true, continuous: true },
        isSupported: () => true,
        listen: alwaysFail as never,
      }
      const h4b2 = createH4B({
        plugins: [voice({ language: 'pt-BR', mode: 'hands-free', stt: broken, noise: { measure: async () => quiet } })],
      })
      await h4b2.start()
      const v2 = h4b2.get('voice') as VoiceService

      await v2.listen()
      expect(alwaysFail).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(250)
      expect(alwaysFail).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1000)
      expect(alwaysFail).toHaveBeenCalledTimes(2)
      expect(v2.getState().listening).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts an in-flight noise check when the app is stopped (disposed)', async () => {
    const m = manualMeasure()
    const { h4b, v, stt } = await setup({ noise: { measure: m.measure } })
    const listening = v.listen()
    await vi.waitFor(() => expect(m.measure).toHaveBeenCalled())
    expect(m.calls[0]!.signal.aborted).toBe(false)
    await h4b.stop()
    await listening
    expect(m.calls[0]!.signal.aborted).toBe(true)
    expect(stt.listen).not.toHaveBeenCalled()
  })

  it('shares an in-flight noise check between checkNoise() and listen()', async () => {
    // checkNoise() while listen() is checking
    {
      const m = manualMeasure()
      const { v, stt, events } = await setup({ noise: { measure: m.measure } })
      const listening = v.listen()
      await vi.waitFor(() => expect(m.measure).toHaveBeenCalled())
      const checked = v.checkNoise()
      m.resolve(noisy)
      await listening
      await expect(checked).resolves.toBe(noisy)
      expect(m.measure).toHaveBeenCalledTimes(1)
      expect(stt.listen).toHaveBeenCalledTimes(1)
      expect(v.getState()).toMatchObject({ checkingNoise: false, listening: true, noise: noisy })
      expect(events).toEqual([{ report: noisy }])
    }
    // listen() while checkNoise() is checking
    {
      const m = manualMeasure()
      const { v, stt, events } = await setup({ noise: { measure: m.measure } })
      const checked = v.checkNoise()
      await vi.waitFor(() => expect(m.measure).toHaveBeenCalled())
      const listening = v.listen()
      m.resolve(noisy)
      await Promise.all([checked, listening])
      await expect(checked).resolves.toBe(noisy)
      expect(m.measure).toHaveBeenCalledTimes(1)
      expect(stt.listen).toHaveBeenCalledTimes(1)
      expect(v.getState()).toMatchObject({ checkingNoise: false, listening: true, noise: noisy })
      expect(events).toEqual([{ report: noisy }])
    }
  })
})
