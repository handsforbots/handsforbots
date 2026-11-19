import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkNoise, detectEndOfSpeech, measureNoise, monitorLevel } from '../src/index.js'

// Real Chromium: AudioWorklet capture, getUserMedia with the fake device, AnalyserNode.

const contexts: AudioContext[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.close()))
})

/** A live stream of looping white noise at `rms`, plus an optional tone gated by `toneGain`. */
function syntheticStream(rms: number) {
  const context = new AudioContext()
  contexts.push(context)
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate)
  const data = buffer.getChannelData(0)
  let state = 7
  for (let i = 0; i < data.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    data[i] = ((state / 0xffffffff) * 2 - 1) * rms * Math.sqrt(3)
  }
  const noise = context.createBufferSource()
  noise.buffer = buffer
  noise.loop = true
  const destination = context.createMediaStreamDestination()
  noise.connect(destination)
  noise.start()
  const tone = context.createOscillator()
  tone.frequency.value = 200
  const toneGain = context.createGain()
  toneGain.gain.value = 0
  tone.connect(toneGain).connect(destination)
  tone.start()
  return { stream: destination.stream, toneGain, context }
}

const db = (value: number) => 10 ** (value / 20)

describe('noise check in Chromium', () => {
  it('measures a quiet stream as quiet', async () => {
    const { stream } = syntheticStream(db(-70))
    const report = await measureNoise(stream, { durationMs: 600 })
    expect(report.frames).toBeGreaterThan(20)
    expect(report.noiseFloorDb).toBeGreaterThan(-73)
    expect(report.noiseFloorDb).toBeLessThan(-67)
    expect(report.verdict).toBe('quiet')
  })

  it('measures a loud stream as too noisy', async () => {
    const { stream } = syntheticStream(db(-30))
    const report = await measureNoise(stream, { durationMs: 600 })
    expect(report.noiseFloorDb).toBeGreaterThan(-33)
    expect(report.verdict).toBe('too-noisy')
    expect(report.reasons).toContain('loud-floor')
  })

  it('opens the fake microphone, measures it and releases it', async () => {
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia')
    const report = await checkNoise({ durationMs: 600 })
    expect(report.frames).toBeGreaterThan(20)
    const [constraints] = getUserMedia.mock.calls[0]!
    expect(constraints).toMatchObject({ audio: { noiseSuppression: false, autoGainControl: false } })
    const stream = await getUserMedia.mock.results[0]!.value
    expect(stream.getTracks().every((track: MediaStreamTrack) => track.readyState === 'ended')).toBe(true)
    getUserMedia.mockRestore()
  })

  it('monitors the fake microphone level for the level gate and releases it', async () => {
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia')
    const levels: number[] = []
    const close = await monitorLevel((db) => levels.push(db))
    await vi.waitFor(() => expect(levels.length).toBeGreaterThan(10), { timeout: 3000 })
    // The fake device beeps: some readings are well above digital silence.
    await vi.waitFor(() => expect(Math.max(...levels)).toBeGreaterThan(-60), { timeout: 3000 })
    close()
    const stream = await getUserMedia.mock.results[0]!.value
    expect(stream.getTracks().every((track: MediaStreamTrack) => track.readyState === 'ended')).toBe(true)
    getUserMedia.mockRestore()
  })

  it('ends speech over steady noise that the fixed threshold would take for speech', async () => {
    // Noise at ~0.03 RMS is above the fixed 0.015 threshold.
    const { stream, toneGain, context } = syntheticStream(0.03)
    const onSilence = vi.fn()
    const stop = detectEndOfSpeech(stream, onSilence, { silenceMs: 300 })
    try {
      // Let the floor settle on the noise, then speak (a loud tone) and stop.
      await vi.waitFor(() => expect(context.currentTime).toBeGreaterThan(0.3), { timeout: 2000 })
      toneGain.gain.setValueAtTime(0.5, context.currentTime)
      toneGain.gain.setValueAtTime(0, context.currentTime + 0.5)
      await vi.waitFor(() => expect(onSilence).toHaveBeenCalledTimes(1), { timeout: 4000, interval: 50 })
    } finally {
      stop()
    }
  })
})
