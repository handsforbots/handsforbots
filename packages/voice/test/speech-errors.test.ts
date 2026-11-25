// @vitest-environment jsdom
import { createH4B, type Transport } from '@handsforbots/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpeechError, voice, webSpeechTTS, type TextToSpeech, type VoiceService, type VoiceSpeechEvent } from '../src/index.js'

/** A fake `speechSynthesis`: the test decides what each utterance does. */
function fakeSynthesis() {
  const utterances: any[] = []
  const synth = { speak: vi.fn((u: any) => utterances.push(u)), cancel: vi.fn(), getVoices: () => [{ name: 'Luciana', lang: 'pt-BR' }] }
  ;(window as any).speechSynthesis = synth
  ;(globalThis as any).SpeechSynthesisUtterance = class {
    lang = ''
    volume = 1
    constructor(readonly text: string) {}
  }
  return { synth, utterances }
}

afterEach(() => {
  delete (window as any).speechSynthesis
  delete (globalThis as any).SpeechSynthesisUtterance
})

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

describe('browser voice (speechSynthesis)', () => {
  it('reports a blocked voice as output-blocked, at the speak stage', async () => {
    const { utterances } = fakeSynthesis()
    const speaking = webSpeechTTS().speak!('Olá.', { language: 'pt-BR' })
    await eventually(() => expect(utterances).toHaveLength(1))
    utterances[0].onerror({ error: 'not-allowed' })
    await expect(speaking).rejects.toMatchObject({ code: 'output-blocked', stage: 'speak' })
  })

  it('treats interrupted and canceled speech as finished, not failed', async () => {
    const { utterances } = fakeSynthesis()
    const speaking = webSpeechTTS().speak!('Olá.', { language: 'pt-BR' })
    await eventually(() => expect(utterances).toHaveLength(1))
    utterances[0].onerror({ error: 'interrupted' })
    await expect(speaking).resolves.toBeUndefined()
  })

  it('fails a sentence that never starts instead of staying silent forever', async () => {
    const { synth, utterances } = fakeSynthesis()
    const speaking = webSpeechTTS({ startTimeout: 20 }).speak!('Olá.', { language: 'pt-BR' })
    await expect(speaking).rejects.toMatchObject({ code: 'synthesis-failed', stage: 'speak' })
    expect(utterances).toHaveLength(1)
    expect(synth.cancel).toHaveBeenCalled()
  })

  it('does not time out once the sentence started', async () => {
    const { utterances } = fakeSynthesis()
    const speaking = webSpeechTTS({ startTimeout: 20 }).speak!('Olá.', { language: 'pt-BR' })
    await eventually(() => expect(utterances).toHaveLength(1))
    utterances[0].onstart()
    await new Promise((r) => setTimeout(r, 40))
    utterances[0].onend()
    await expect(speaking).resolves.toBeUndefined()
  })

  it('unlock speaks one silent utterance, once', () => {
    const { utterances } = fakeSynthesis()
    const tts = webSpeechTTS()
    tts.unlock!()
    tts.unlock!()
    expect(utterances).toHaveLength(1)
    expect(utterances[0]).toMatchObject({ text: '', volume: 0 })
  })
})

const transport: Transport = {
  name: 'reply',
  async *run(request) {
    yield { type: 'message.start', messageId: `m-${request.turnId}` }
    yield { type: 'message.delta', messageId: `m-${request.turnId}`, delta: 'Olá.' }
    yield { type: 'message.end', messageId: `m-${request.turnId}` }
  },
}

async function setup(tts: TextToSpeech) {
  const h4b = createH4B({ plugins: [voice({ language: 'pt-BR', output: 'voice', tts })] })
  h4b.provide('transport', transport)
  await h4b.start()
  const speech: VoiceSpeechEvent[] = []
  const errors: { error: unknown; source: string }[] = []
  h4b.on('voice.speech', (e) => speech.push(e))
  h4b.on('error', (e) => errors.push(e as { error: unknown; source: string }))
  return { h4b, voice: h4b.get('voice') as VoiceService, speech, errors }
}

describe('voice service: speaking errors', () => {
  it('reports a provider failure at the speak stage, with its source and a voice.speech error', async () => {
    const provider: TextToSpeech = {
      name: 'browser',
      isSupported: () => true,
      speak: () => Promise.reject(new Error('engine crashed')),
    }
    const { h4b, voice: v, speech, errors } = await setup(provider)
    h4b.send('oi')
    await eventually(() => expect(v.getState().error).toBeDefined())
    expect(v.getState().error).toMatchObject({ code: 'synthesis-failed', stage: 'speak' })
    expect(errors).toEqual([{ error: expect.objectContaining({ stage: 'speak' }), source: 'voice:tts:browser' }])
    const at = { messageId: expect.any(String), from: 0, to: 4 }
    expect(speech).toEqual([
      { phase: 'start', provider: 'browser', chars: 4, ...at },
      { phase: 'error', provider: 'browser', code: 'synthesis-failed', message: 'engine crashed', ...at },
    ])
    expect(v.getState().speaking).toBe(false)
  })

  it('moves listen-stage errors from a provider to the speak stage', async () => {
    const provider: TextToSpeech = {
      name: 'browser',
      isSupported: () => true,
      speak: () => Promise.reject(new SpeechError('not-allowed')),
    }
    const { h4b, voice: v } = await setup(provider)
    h4b.send('oi')
    await eventually(() => expect(v.getState().error).toMatchObject({ code: 'not-allowed', stage: 'speak' }))
  })

  it('reports start and end of each spoken chunk', async () => {
    const provider: TextToSpeech = { name: 'browser', isSupported: () => true, speak: () => Promise.resolve() }
    const { h4b, voice: v, speech } = await setup(provider)
    h4b.send('oi')
    await eventually(() => expect(speech.map((e) => e.phase)).toEqual(['start', 'end']))
    expect(speech[1]).toMatchObject({ provider: 'browser', ms: expect.any(Number) })
    expect(v.getState().error).toBeUndefined()
  })

  it('unlocks providers in user gestures and in unlockAudio()', async () => {
    const unlock = vi.fn()
    const provider: TextToSpeech = { name: 'browser', isSupported: () => true, speak: () => Promise.resolve(), unlock }
    const { voice: v } = await setup(provider)
    document.dispatchEvent(new Event('pointerdown'))
    expect(unlock).toHaveBeenCalledTimes(1)
    v.unlockAudio()
    expect(unlock).toHaveBeenCalledTimes(2)
  })
})

describe('browser voice word boundaries (ADR 0020)', () => {
  it('reports start and word boundaries with positions in the text it was given', async () => {
    const { utterances } = fakeSynthesis()
    const events: unknown[] = []
    // Spaces are joined in the utterance; positions map back to this text.
    const text = 'Olá,   mundo.  Tchau  tchau.'
    const speaking = webSpeechTTS().speak!(text, { language: 'pt-BR', onProgress: (e) => events.push(e) })
    await eventually(() => expect(utterances).toHaveLength(1))
    const first = utterances[0]
    expect(first.text).toBe('Olá, mundo. Tchau tchau.')
    first.onstart()
    first.onboundary({ name: 'word', charIndex: 0, charLength: 3, elapsedTime: 0 })
    first.onboundary({ name: 'sentence', charIndex: 0 })
    first.onboundary({ name: 'word', charIndex: 5, charLength: 5, elapsedTime: 0.4 })
    first.onboundary({ name: 'word', charIndex: 18 })
    first.onboundary({ name: 'word', charIndex: 999 })
    first.onstart()
    first.onend()
    await speaking
    expect(events).toEqual([
      { type: 'start' },
      { type: 'boundary', from: 0, to: 3, elapsed: 0 },
      { type: 'boundary', from: 7, to: 12, elapsed: 0.4 },
      { type: 'boundary', from: 22 },
    ])
    expect(text.slice(7, 12)).toBe('mundo')
    expect(text.slice(22, 27)).toBe('tchau')
  })
})
