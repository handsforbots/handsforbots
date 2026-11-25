import { describe, expect, it } from 'vitest'
import { webAudioPlayer, webSpeechTTS, type SpeakProgress } from '../src/index.js'

// Real Chromium (ADR 0020): the player's clock is the AudioContext's, and the
// browser voice reports word boundaries when its voice can.

describe('word timings in a real browser', () => {
  it('webAudioPlayer reports a clock that follows AudioContext.currentTime from the start of playback', async () => {
    const context = new AudioContext()
    const player = webAudioPlayer({ context })
    player.unlock()
    const sampleRate = context.sampleRate
    const samples = new Float32Array(Math.round(sampleRate * 0.3))
    const readings: number[] = []
    let clock: (() => number) | undefined
    const playing = player.play({ samples, sampleRate }, { onStart: (c) => (clock = c) })
    // Read the clock until playback ends.
    const reading = (async () => {
      while (!clock) await new Promise((r) => setTimeout(r, 5))
      for (let i = 0; i < 100; i++) {
        readings.push(clock())
        if (readings[readings.length - 1]! >= 0.25) break
        await new Promise((r) => setTimeout(r, 10))
      }
    })()
    await playing
    await reading
    expect(readings[0]).toBeGreaterThanOrEqual(0)
    expect(readings[0]).toBeLessThan(0.1)
    for (let i = 1; i < readings.length; i++) expect(readings[i]).toBeGreaterThanOrEqual(readings[i - 1]!)
    expect(Math.max(...readings)).toBeGreaterThan(0.15)
    await context.close()
  })

  it('webSpeechTTS reports boundaries inside the text it got, when the voice fires them', async (context) => {
    const synth = globalThis.speechSynthesis
    const voices = synth?.getVoices() ?? []
    // Headless Chromium has no voices: report the test as skipped rather than passed.
    if (!synth || !voices.some((v) => v.localService)) return context.skip()
    const events: SpeakProgress[] = []
    const text = 'One   two three.'
    await Promise.race([
      webSpeechTTS({ voice: (v) => v.localService }).speak!(text, { language: 'en-US', onProgress: (e) => events.push(e) }),
      new Promise((r) => setTimeout(r, 5000)),
    ])
    synth.cancel()
    for (const event of events) {
      if (event.type !== 'boundary') continue
      expect(/\S/.test(text[event.from]!)).toBe(true)
    }
  })
})
