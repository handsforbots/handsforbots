// @vitest-environment jsdom
import { createH4B, type H4B, type Transport } from '@handsforbots/core'
import { voice, type AudioPlayer, type PlayOptions, type SpeechAudio, type TextToSpeech } from '@handsforbots/voice'
import { widget } from '@handsforbots/widget'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captions, type CaptionsOptions, type CaptionsState } from '../src/index.js'

const eventually = async (check: () => void, timeout = 1500) => {
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

const transport = (text: string, messageId = 'm1'): Transport => ({
  name: 'script',
  async *run() {
    yield { type: 'message.start', messageId }
    yield { type: 'message.delta', messageId, delta: text }
    yield { type: 'message.end', messageId }
  },
})

/** A player whose clock the test moves by hand. */
function clockedPlayer() {
  let time = 0
  const plays: { audio: SpeechAudio; options: PlayOptions; finish(): void }[] = []
  const player: AudioPlayer = {
    isSupported: () => true,
    unlock: vi.fn(),
    play(audio, play) {
      return new Promise((resolve) => {
        plays.push({ audio, options: play, finish: resolve })
        play.signal?.addEventListener('abort', () => resolve(), { once: true })
        play.onStart?.(() => time)
      })
    },
    stop: vi.fn(),
  }
  return {
    player,
    plays,
    set: (seconds: number) => (time = seconds),
    async finishNext() {
      await eventually(() => expect(plays.length).toBeGreaterThan(0))
      time = 0
      plays.shift()!.finish()
    },
  }
}

/** One second of audio per word: with the estimate, word i says [i, i+1) roughly. */
const model: TextToSpeech = {
  name: 'model',
  isSupported: () => true,
  async synthesize(text) {
    return { samples: new Float32Array(text.trim().split(/\s+/).length * 100).fill(0.5), sampleRate: 100 }
  },
}

let app: H4B | undefined
afterEach(async () => {
  await app?.stop()
  app = undefined
  document.body.replaceChildren()
})

async function setup(options: CaptionsOptions = {}, text = 'Olá mundo. Até logo.') {
  const clock = clockedPlayer()
  const h4b = createH4B({
    memory: false,
    plugins: [voice({ language: 'pt-BR', output: 'voice', tts: model, player: clock.player }), captions(options)],
  })
  h4b.provide('transport', transport(text))
  await h4b.start()
  app = h4b
  const service = h4b.get('captions')!
  const states = () => service.getState().words.map((w) => `${w.text}:${w.state}`)
  return { h4b, clock, service, states }
}

describe('captions', () => {
  it('marks the words of the spoken chunk as spoken, active and upcoming, idle in pauses and at the end', async () => {
    const { h4b, clock, service, states } = await setup()
    expect(service.getState()).toMatchObject({ status: 'idle', words: [], active: -1 })
    await h4b.ask('oi')
    await eventually(() => expect(states()).toEqual(['Olá:active', 'mundo.:upcoming']))
    expect(service.getState()).toMatchObject({ status: 'speaking', messageId: 'm1', from: 0, to: 10, active: 0 })
    expect(service.progress()).toBe(0)

    clock.set(0.3)
    await eventually(() => expect(service.progress()).toBeGreaterThan(0.2))
    clock.set(1.2)
    await eventually(() => expect(states()).toEqual(['Olá:spoken', 'mundo.:active']))
    clock.set(2)
    await eventually(() => expect(service.getState().status).toBe('gap'))
    expect(states()).toEqual(['Olá:spoken', 'mundo.:spoken'])
    expect(service.progress()).toBe(1)

    await clock.finishNext()
    // The next chunk replaces the line.
    await eventually(() => expect(states()).toEqual(['Até:active', 'logo.:upcoming']))
    expect(service.getState()).toMatchObject({ from: 10, to: 20 })
    await clock.finishNext()
    await eventually(() => expect(service.getState()).toMatchObject({ status: 'idle', ended: 'done' }))
    expect(states()).toEqual(['Até:spoken', 'logo.:spoken'])
  })

  it('keeps what was heard when speech is cut', async () => {
    const { h4b, clock, service, states } = await setup()
    await h4b.ask('oi')
    clock.set(1.2)
    await eventually(() => expect(states()).toEqual(['Olá:spoken', 'mundo.:active']))
    h4b.get('voice')!.cancelSpeech()
    await eventually(() => expect(service.getState()).toMatchObject({ status: 'idle', ended: 'interrupted', active: -1 }))
    expect(states()).toEqual(['Olá:spoken', 'mundo.:spoken'])
    expect(service.progress()).toBe(0)
  })

  it('shows the whole message with the spoken chunk highlighted (scope: message)', async () => {
    const { h4b, clock, service, states } = await setup({ scope: 'message' })
    expect(service.scope).toBe('message')
    await h4b.ask('oi')
    await eventually(() => expect(states()).toEqual(['Olá:active', 'mundo.:upcoming', 'Até:upcoming', 'logo.:upcoming']))
    await clock.finishNext()
    await eventually(() => expect(states()).toEqual(['Olá:spoken', 'mundo.:spoken', 'Até:active', 'logo.:upcoming']))
    expect(service.getState().words[2]).toMatchObject({ start: 0, quality: 'estimated', source: 'estimate' })
    expect(service.getState().words[0]!.start).toBeUndefined()
  })

  it('notifies subscribers, survives a failing one and goes idle when the voice is removed', async () => {
    const clock = clockedPlayer()
    const h4b = createH4B({ memory: false, plugins: [captions()] })
    h4b.provide('transport', transport('Olá mundo.'))
    await h4b.start()
    app = h4b
    const removeVoice = await h4b.use(voice({ language: 'pt-BR', output: 'voice', tts: model, player: clock.player }))
    const service = h4b.get('captions')!
    const errors: unknown[] = []
    h4b.on('error', (e) => errors.push(e.source))
    const seen: CaptionsState[] = []
    service.subscribe(() => {
      throw new Error('ui')
    })
    const stop = service.subscribe(() => seen.push(service.getState()))
    await h4b.ask('oi')
    await eventually(() => expect(seen.some((s) => s.status === 'speaking')).toBe(true))
    expect(errors).toContain('captions')
    stop()
    await removeVoice()
    await eventually(() => expect(service.getState()).toMatchObject({ status: 'idle', words: [] }))
  })

  it('rejects an unknown scope', async () => {
    const h4b = createH4B({ memory: false, plugins: [captions({ scope: 'page' as never })] })
    const errors: unknown[] = []
    h4b.on('error', (e) => errors.push(e.error))
    await h4b.start().catch((error) => errors.push(error))
    app = h4b
    expect(String(errors[0])).toMatch(/unknown scope/)
  })
})

describe('captions in the widget', () => {
  it('draws one span per word with its state and the progress of the active one, hidden from screen readers', async () => {
    const clock = clockedPlayer()
    const h4b = createH4B({
      memory: false,
      plugins: [
        voice({ language: 'pt-BR', output: 'voice', tts: model, player: clock.player }),
        captions(),
        widget({ layout: 'inline' }),
      ],
    })
    h4b.provide('transport', transport('Olá mundo.'))
    await h4b.start()
    app = h4b
    const root = document.querySelector('h4b-chat')!.shadowRoot!
    const box = root.querySelector<HTMLElement>('.captions')!
    expect(box.hidden).toBe(true)
    expect(box.getAttribute('aria-hidden')).toBe('true')

    await h4b.ask('oi')
    await eventually(() => expect(box.hidden).toBe(false))
    const words = () => [...box.querySelectorAll<HTMLElement>('.word')].map((w) => `${w.textContent}:${w.dataset.state}`)
    expect(words()).toEqual(['Olá:active', 'mundo.:upcoming'])
    expect(box.dataset.status).toBe('speaking')
    expect(box.textContent).toBe('Olá mundo.')
    clock.set(0.4)
    await eventually(() => expect(Number(box.querySelector<HTMLElement>('[data-state=active]')!.style.getPropertyValue('--progress'))).toBeGreaterThan(0))
    clock.set(1.2)
    await eventually(() => expect(words()).toEqual(['Olá:spoken', 'mundo.:active']))
    await clock.finishNext()
    await eventually(() => expect(box.dataset.status).toBe('idle'))
  })

  it('stays off with captions: false', async () => {
    const clock = clockedPlayer()
    const h4b = createH4B({
      memory: false,
      plugins: [
        voice({ language: 'pt-BR', output: 'voice', tts: model, player: clock.player }),
        captions(),
        widget({ layout: 'inline', captions: false }),
      ],
    })
    h4b.provide('transport', transport('Olá.'))
    await h4b.start()
    app = h4b
    await h4b.ask('oi')
    await eventually(() => expect(h4b.get('captions')!.getState().status).toBe('speaking'))
    expect(document.querySelector('h4b-chat')!.shadowRoot!.querySelector<HTMLElement>('.captions')!.hidden).toBe(true)
  })
})
