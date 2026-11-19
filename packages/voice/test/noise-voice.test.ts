// @vitest-environment jsdom
import { createH4B } from '@handsforbots/core'
import { describe, expect, it, vi } from 'vitest'
import {
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
  const calls: { resolve(r: NoiseReport): void; signal: AbortSignal }[] = []
  const measure = vi.fn(
    (signal: AbortSignal) =>
      new Promise<NoiseReport>((resolve, reject) => {
        calls.push({ resolve, signal })
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }),
  )
  return { measure, resolve: (r: NoiseReport) => calls.at(-1)!.resolve(r), calls }
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
})
