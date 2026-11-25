// @vitest-environment jsdom
import { createH4B, type H4B, type Transport } from '@handsforbots/core'
import { describe, expect, it, vi } from 'vitest'
import {
  httpTTS,
  voice,
  type AudioPlayer,
  type PlayOptions,
  type SpeakOptions,
  type SpeechAudio,
  type TextToSpeech,
  type VoiceWordEvent,
} from '../src/index.js'

const eventually = async (check: () => void, timeout = 1000) => {
  const start = Date.now()
  for (;;) {
    try {
      return check()
    } catch (error) {
      if (Date.now() - start > timeout) throw error
      await new Promise((r) => setTimeout(r, 5))
    }
  }
}

/** Each turn answers with the next reply, as one message with the given id. */
const reply = (text: string, messageId: string) => ({ text, messageId })
const scriptedTransport = (replies: { text: string; messageId: string }[]): Transport => {
  let turn = 0
  return {
    name: 'script',
    async *run() {
      const next = replies[turn++]
      if (!next) return
      yield { type: 'message.start', messageId: next.messageId }
      yield { type: 'message.delta', messageId: next.messageId, delta: next.text }
      yield { type: 'message.end', messageId: next.messageId }
    },
  }
}
const waitForIdle = (h4b: H4B) => eventually(() => expect(h4b.get('voice')!.getState().speaking).toBe(false))

/** A player whose clock the test moves by hand. */
function clockedPlayer(options: { callsOnStart?: boolean } = {}) {
  let time = 0
  const plays: { audio: SpeechAudio; options: PlayOptions; finish(): void }[] = []
  const player: AudioPlayer = {
    isSupported: () => true,
    unlock: vi.fn(),
    play(audio, play) {
      return new Promise((resolve) => {
        plays.push({ audio, options: play, finish: resolve })
        play.signal?.addEventListener('abort', () => resolve(), { once: true })
        if (options.callsOnStart !== false) play.onStart?.(() => time)
      })
    },
    stop: vi.fn(),
  }
  return {
    player,
    plays,
    set: (seconds: number) => (time = seconds),
    finish: () => plays.splice(0).forEach((p) => p.finish()),
  }
}

/** Lets `count` chunks play to the end, each as soon as it starts. */
async function playAll(clock: ReturnType<typeof clockedPlayer>, count: number) {
  for (let i = 0; i < count; i++) {
    await eventually(() => expect(clock.plays.length).toBeGreaterThan(0))
    clock.finish()
  }
}

/** A model that returns one second of audio per word, with timings when asked. */
function model(words?: (text: string) => SpeechAudio['words']): TextToSpeech {
  return {
    name: 'model',
    isSupported: () => true,
    async synthesize(text) {
      const count = text.trim().split(/\s+/).length
      return { samples: new Float32Array(count * 100).fill(0.5), sampleRate: 100, ...(words ? { words: words(text) } : {}) }
    },
  }
}

async function setup(tts: TextToSpeech, player?: AudioPlayer, script = [reply('Olá mundo. Tchau.', 'm1')]) {
  const h4b = await createH4B({
    memory: false,
    plugins: [voice({ language: 'pt-BR', output: 'voice', tts, player })],
  }).start()
  h4b.provide('transport', scriptedTransport(script))
  const events: VoiceWordEvent[] = []
  h4b.on('voice.word', (e) => events.push(e))
  return { h4b, events, voice: h4b.get('voice')! }
}

const phases = (events: VoiceWordEvent[]) =>
  events.map((e) => (e.phase === 'word' ? `word:${e.word.text}` : e.phase === 'end' ? `end:${e.reason}` : e.phase === 'gap' ? `gap:${e.index}` : e.phase))

describe('voice.word', () => {
  it('follows the player clock word by word, with message positions and an idle gap at the end', async () => {
    const clock = clockedPlayer()
    const { h4b, events, voice: service } = await setup(model(), clock.player)
    await h4b.ask('oi')
    await eventually(() => expect(clock.plays).toHaveLength(1))
    const chunk = events.find((e) => e.phase === 'chunk')!
    expect(chunk).toMatchObject({ messageId: 'm1', from: 0, to: 10, provider: 'model' })
    if (chunk.phase !== 'chunk') throw new Error('chunk')
    expect(chunk.words.map((w) => [w.text, w.from, w.to, w.quality])).toEqual([
      ['Olá', 0, 3, 'estimated'],
      ['mundo.', 4, 10, 'estimated'],
    ])
    await eventually(() => expect(phases(events)).toEqual(['chunk', 'word:Olá']))
    expect(service.getSpeechPosition()).toMatchObject({ index: 0, status: 'speaking', progress: 0 })

    clock.set(0.4)
    await eventually(() => expect(service.getSpeechPosition()!.progress).toBeGreaterThan(0.5))
    clock.set(1.5)
    await eventually(() => expect(phases(events)).toEqual(['chunk', 'word:Olá', 'word:mundo.']))
    clock.set(2)
    await eventually(() => expect(phases(events)).toContain('gap:1'))
    expect(service.getSpeechPosition()).toMatchObject({ status: 'gap', progress: 1 })

    clock.finish()
    await eventually(() => expect(phases(events)).toContain('end:done'))
    // The second sentence carries its own range in the message.
    await eventually(() => expect(events.filter((e) => e.phase === 'chunk')[1]).toMatchObject({ from: 10, to: 17 }))
    clock.finish()
    await waitForIdle(h4b)
    await eventually(() => expect(service.getSpeechPosition()).toBeUndefined())
  })

  it('uses the provider timings, aligned to the original text, and divides by the playback rate', async () => {
    const clock = clockedPlayer()
    const tts = model((text) =>
      text.includes('Olá') ? [{ text: 'ola', start: 0.1, end: 0.6 }, { text: 'mundo', start: 0.8, end: 1.6 }] : undefined,
    )
    const { h4b, events } = await setup({ ...tts, prosody: {} }, clock.player)
    h4b.get('voice')!.setEffects({ name: 'up', prosody: () => ({ pitch: 12 }), connect: (_, source) => ({ output: source }) })
    await h4b.ask('oi')
    await eventually(() => expect(events.find((e) => e.phase === 'chunk')).toBeDefined())
    const chunk = events.find((e) => e.phase === 'chunk')!
    if (chunk.phase !== 'chunk') throw new Error('chunk')
    // Pitch +12 st plays at double speed: heard times are halved.
    expect(chunk.words.map((w) => [w.text, w.start, w.end, w.quality, w.source])).toEqual([
      ['Olá', 0.05, 0.3, 'measured', 'model'],
      ['mundo.', 0.4, 0.8, 'measured', 'model'],
    ])
    await playAll(clock, 2)
    await waitForIdle(h4b)
  })

  it('falls back to the page clock when the player does not report its start', async () => {
    const clock = clockedPlayer({ callsOnStart: false })
    const { h4b, events } = await setup(model(), clock.player)
    await h4b.ask('oi')
    await eventually(() => expect(phases(events)).toContain('word:Olá'))
    await playAll(clock, 2)
    await waitForIdle(h4b)
  })

  it('ends the chunk as interrupted on cancelSpeech and on barge-in style interrupts', async () => {
    const clock = clockedPlayer()
    const { h4b, events, voice: service } = await setup(model(), clock.player)
    await h4b.ask('oi')
    await eventually(() => expect(phases(events)).toContain('word:Olá'))
    service.cancelSpeech()
    await eventually(() => expect(phases(events)).toContain('end:interrupted'))
    await eventually(() => expect(service.getSpeechPosition()).toBeUndefined())
    expect(phases(events).filter((p) => p === 'chunk')).toHaveLength(1)
  })

  it('ends the chunk as error when playback fails', async () => {
    const player: AudioPlayer = {
      isSupported: () => true,
      unlock: vi.fn(),
      play: async () => {
        throw new Error('device lost')
      },
      stop: vi.fn(),
    }
    const { h4b, events } = await setup(model(), player, [reply('Olá.', 'm1')])
    h4b.on('error', () => {})
    await h4b.ask('oi')
    await eventually(() => expect(phases(events)).toEqual(['chunk', 'word:Olá.', 'end:error']))
  })
})

describe('voice.word with providers that speak themselves', () => {
  function boundarySpeaker(options: { boundaries: boolean }) {
    let progress: SpeakOptions['onProgress']
    let finish: (() => void) | undefined
    const provider: TextToSpeech = {
      name: 'browser',
      isSupported: () => true,
      speak(_text, speakOptions) {
        progress = speakOptions.onProgress
        return new Promise((resolve) => {
          finish = resolve
          speakOptions.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      cancel: vi.fn(),
    }
    return {
      provider,
      started: () => progress?.({ type: 'start' }),
      boundary: (from: number) => options.boundaries && progress?.({ type: 'boundary', from }),
      finish: () => finish?.(),
    }
  }

  it('moves word by word on boundaries; a word ends where the next starts', async () => {
    const speaker = boundarySpeaker({ boundaries: true })
    const { h4b, events, voice: service } = await setup(speaker.provider, undefined, [reply('Um dois três quatro.', 'm1')])
    await h4b.ask('oi')
    await eventually(() => expect(phases(events)).toContain('chunk'))
    speaker.started()
    speaker.boundary(0)
    speaker.boundary(3)
    await eventually(() => expect(phases(events).slice(0, 3)).toEqual(['chunk', 'word:Um', 'word:dois']))
    // Jumping ahead still reports the skipped word, in order.
    speaker.boundary(13)
    await eventually(() => expect(phases(events)).toEqual(['chunk', 'word:Um', 'word:dois', 'word:três', 'word:quatro.']))
    const words = events.filter((e) => e.phase === 'word')
    const um = service.getSpeechPosition()!.words[0]!
    expect(um).toMatchObject({ quality: 'measured', source: 'boundary' })
    expect(um.end).toBe(service.getSpeechPosition()!.words[1]!.start)
    expect(words).toHaveLength(4)
    speaker.finish()
    await eventually(() => expect(phases(events)).toContain('end:done'))
  })

  it('estimates from characters per second when the voice never fires boundaries', async () => {
    const speaker = boundarySpeaker({ boundaries: false })
    const { h4b, events, voice: service } = await setup(speaker.provider, undefined, [reply('Um dois.', 'm1')])
    await h4b.ask('oi')
    await eventually(() => expect(phases(events)).toContain('word:Um'))
    expect(service.getSpeechPosition()!.words.every((w) => w.quality === 'estimated' && w.source === 'estimate')).toBe(true)
    // About 8 characters at 14 per second: the second word comes on its own.
    await eventually(() => expect(phases(events)).toContain('word:dois.'), 2000)
    speaker.finish()
    await eventually(() => expect(phases(events)).toContain('end:done'))
  })
})

describe('httpTTS word timings', () => {
  const wav = () => {
    // Decoding needs Web Audio: replace it with a fixed decoder for jsdom.
    ;(globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext = class {
      decodeAudioData() {
        return Promise.resolve({ length: 200, numberOfChannels: 1, sampleRate: 100, getChannelData: () => new Float32Array(200) })
      }
    }
  }
  const respond = (body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }))

  it('reads words from a JSON reply and cleans them', async () => {
    wav()
    const tts = httpTTS({
      url: '/tts',
      fetch: respond({ audio: btoa('RIFF'), words: [{ text: 'oi', start: 0, end: 0.5, quality: 'aligned', source: 'asr' }, { text: 1 }] }),
    })
    const audio = await tts.synthesize!('oi', { language: 'pt-BR' })
    expect(audio.words).toEqual([{ text: 'oi', start: 0, end: 0.5, quality: 'aligned', source: 'asr' }])
    expect(audio.sampleRate).toBe(100)
  })

  it('reads WebVTT from a JSON reply, as backend measurements', async () => {
    wav()
    const tts = httpTTS({ url: '/tts', fetch: respond({ audio: btoa('RIFF'), vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\noi <00:00.400>tchau' }) })
    const audio = await tts.synthesize!('oi tchau', { language: 'pt-BR' })
    expect(audio.words).toEqual([
      { text: 'oi', start: 0, end: 0.4, quality: 'measured', source: 'backend' },
      { text: 'tchau', start: 0.4, end: 1, quality: 'measured', source: 'backend' },
    ])
  })

  it('fails a JSON reply without audio and keeps raw audio replies as before', async () => {
    wav()
    await expect(httpTTS({ url: '/tts', fetch: respond({ words: [] }) }).synthesize!('oi', { language: 'pt-BR' })).rejects.toMatchObject({
      code: 'synthesis-failed',
    })
    const raw = httpTTS({ url: '/tts', fetch: vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/wav' } })) })
    expect((await raw.synthesize!('oi', { language: 'pt-BR' })).words).toBeUndefined()
  })
})

