// @vitest-environment jsdom
import { createH4B, textOf, type H4B, type Transport } from '@handsforbots/core'
import { voice, type AudioPlayer, type PlayOptions, type SpeechAudio, type TextToSpeech, type WordAligner } from '@handsforbots/voice'
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

  it('follows a late alignment that revises the chunk while it plays', async () => {
    let release = () => {}
    const aligner: WordAligner = {
      name: 'asr',
      align: () =>
        new Promise((resolve) => {
          release = () => resolve([{ text: 'olá', start: 0, end: 0.4 }, { text: 'mundo', start: 0.5, end: 1 }])
        }),
    }
    const clock = clockedPlayer()
    const h4b = createH4B({
      memory: false,
      plugins: [voice({ language: 'pt-BR', output: 'voice', tts: model, player: clock.player, align: aligner }), captions()],
    })
    h4b.provide('transport', transport('Olá mundo.'))
    await h4b.start()
    app = h4b
    const service = h4b.get('captions')!
    const states = () => service.getState().words.map((w) => `${w.text}:${w.state}:${w.quality}`)
    await h4b.ask('oi')
    await eventually(() => expect(states()).toEqual(['Olá:active:estimated', 'mundo.:upcoming:estimated']))
    // At 0.6 s the estimate is still on the first word; what was heard says the second.
    clock.set(0.6)
    release()
    await eventually(() => expect(states()).toEqual(['Olá:spoken:aligned', 'mundo.:active:aligned']))
    expect(service.getState().status).toBe('speaking')
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

  it('supports captions: { mode: "reveal" } in the widget', async () => {
    const h4b = createH4B({
      memory: false,
      plugins: [captions({ reducedMotion: 'instant' }), widget({ layout: 'inline', captions: { mode: 'reveal' } })],
    })
    h4b.provide('transport', transport('Olá mundo.'))
    await h4b.start()
    app = h4b
    await h4b.ask('oi')
    const box = document.querySelector('h4b-chat')!.shadowRoot!.querySelector<HTMLElement>('.captions')!
    await eventually(() => expect(box.hidden).toBe(false))
    expect(box.dataset.mode).toBe('reveal')
    expect(box.textContent).toBe('Olá mundo.')
  })
})

function fakeTimers() {
  let nowSec = 0
  let nextId = 1
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    clock: () => nowSec,
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++
      pending.set(id, { at: nowSec + ms / 1000, fn })
      return id
    },
    cancelSchedule: (handle: unknown) => {
      pending.delete(handle as number)
    },
    advance(ms: number) {
      const target = nowSec + ms / 1000
      for (;;) {
        let earliestId: number | undefined
        let earliestAt = Infinity
        for (const [id, entry] of pending) {
          if (entry.at <= target + 1e-9 && entry.at < earliestAt) {
            earliestAt = entry.at
            earliestId = id
          }
        }
        if (earliestId === undefined) break
        const entry = pending.get(earliestId)!
        pending.delete(earliestId)
        nowSec = Math.max(nowSec, entry.at)
        entry.fn()
      }
      nowSec = target
    },
  }
}

describe('captions without voice (text cadence) and review fixes', () => {
  it('runs text cadence without the voice plugin in scope: message and scope: chunk', async () => {
    const t = fakeTimers()
    const h4b = createH4B({
      memory: false,
      plugins: [
        captions({
          scope: 'chunk',
          pace: () => ({ durationMs: 200 }),
          reducedMotion: 'words',
          clock: t.clock,
          schedule: t.schedule,
          cancelSchedule: t.cancelSchedule,
        }),
      ],
    })
    h4b.provide('transport', transport('Olá mundo. Até logo.'))
    await h4b.start()
    app = h4b
    const service = h4b.get('captions')!
    expect(service.follow).toBe('auto')

    await h4b.ask('oi')
    const states = () => service.getState().words.map((w) => `${w.text}:${w.state}`)
    // First sentence only in scope: 'chunk'
    expect(states()).toEqual(['Olá:active', 'mundo.:upcoming'])
    expect(service.getState().driver).toBe('text')

    t.advance(420)
    // Moved to second sentence
    expect(states()).toEqual(['Até:active', 'logo.:upcoming'])

    t.advance(420)
    expect(service.getState()).toMatchObject({ status: 'idle', ended: 'done', replyEnded: true })
    expect(states()).toEqual(['Até:spoken', 'logo.:spoken'])
  })

  it('falls back to text cadence in follow: auto when voice is installed with output: text', async () => {
    const t = fakeTimers()
    const clock = clockedPlayer()
    const h4b = createH4B({
      memory: false,
      plugins: [
        voice({ language: 'pt-BR', output: 'text', tts: model, player: clock.player }),
        captions({
          scope: 'message',
          pace: () => ({ durationMs: 150 }),
          reducedMotion: 'words',
          clock: t.clock,
          schedule: t.schedule,
          cancelSchedule: t.cancelSchedule,
        }),
      ],
    })
    h4b.provide('transport', transport('Só texto aqui.'))
    await h4b.start()
    app = h4b
    await h4b.ask('oi')
    const service = h4b.get('captions')!
    expect(service.getState().driver).toBe('text')
    expect(service.getState().words.map((w) => `${w.text}:${w.state}`)).toEqual(['Só:active', 'texto:upcoming', 'aqui.:upcoming'])
    service.skip()
    expect(service.getState()).toMatchObject({ status: 'idle', ended: 'done', replyEnded: true })
  })

  it('provides independent per-message stores via forMessage() and hydrates completed messages', async () => {
    const t = fakeTimers()
    const h4b = createH4B({
      memory: false,
      plugins: [
        captions({
          scope: 'message',
          pace: () => ({ durationMs: 200 }),
          reducedMotion: 'words',
          clock: t.clock,
          schedule: t.schedule,
          cancelSchedule: t.cancelSchedule,
        }),
      ],
    })
    let count = 0
    h4b.provide('transport', {
      name: 'seq',
      async *run() {
        const id = `m${++count}`
        yield { type: 'message.start', messageId: id }
        yield { type: 'message.delta', messageId: id, delta: count === 1 ? 'Primeira resposta.' : 'Segunda resposta.' }
        yield { type: 'message.end', messageId: id }
      },
    })
    await h4b.start()
    app = h4b
    const service = h4b.get('captions')!
    const s1 = service.forMessage('m1')
    const s2 = service.forMessage('m2')

    await h4b.ask('um')
    t.advance(500)
    expect(s1.getState()).toMatchObject({ status: 'idle', ended: 'done', replyEnded: true })

    await h4b.ask('dois')
    expect(s2.getState().words.map((w) => `${w.text}:${w.state}`)).toEqual(['Segunda:active', 'resposta.:upcoming'])
    // First message store kept its own completed state.
    expect(s1.getState().words.map((w) => `${w.text}:${w.state}`)).toEqual(['Primeira:spoken', 'resposta.:spoken'])
  })

  it('cuts an interrupted text reply at what was already shown by default (cutOnInterrupt)', async () => {
    const t = fakeTimers()
    let release!: () => void
    const h4b = createH4B({
      memory: false,
      plugins: [
        captions({
          scope: 'message',
          pace: () => ({ durationMs: 200 }),
          reducedMotion: 'words',
          clock: t.clock,
          schedule: t.schedule,
          cancelSchedule: t.cancelSchedule,
        }),
      ],
    })
    h4b.provide('transport', {
      name: 'slow',
      async *run() {
        yield { type: 'message.start', messageId: 'm1' }
        yield { type: 'message.delta', messageId: 'm1', delta: 'um dois tres quatro ' }
        await new Promise<void>((r) => (release = r))
        yield { type: 'message.end', messageId: 'm1' }
      },
    })
    await h4b.start()
    app = h4b
    const service = h4b.get('captions')!
    const turn = h4b.ask('oi')
    await eventually(() => expect(service.getState().words.length).toBe(4))
    // Only 'um' (active) has been shown so far (shown() === 2).
    await h4b.interrupt()
    release()
    await turn

    const assistant = h4b.conversation.find('m1')!
    expect(textOf(assistant)).toBe('um')
    expect(service.getState().words.map((w) => `${w.text}:${w.state}`)).toEqual([
      'um:spoken',
      'dois:skipped',
      'tres:skipped',
      'quatro:skipped',
    ])
  })

  it('keeps the full text on interrupt when cutOnInterrupt is false', async () => {
    const t = fakeTimers()
    let release!: () => void
    const h4b = createH4B({
      memory: false,
      plugins: [
        captions({
          scope: 'message',
          cutOnInterrupt: false,
          pace: () => ({ durationMs: 200 }),
          reducedMotion: 'words',
          clock: t.clock,
          schedule: t.schedule,
          cancelSchedule: t.cancelSchedule,
        }),
      ],
    })
    h4b.provide('transport', {
      name: 'slow',
      async *run() {
        yield { type: 'message.start', messageId: 'm1' }
        yield { type: 'message.delta', messageId: 'm1', delta: 'um dois tres ' }
        await new Promise<void>((r) => (release = r))
        yield { type: 'message.end', messageId: 'm1' }
      },
    })
    await h4b.start()
    app = h4b
    const service = h4b.get('captions')!
    const turn = h4b.ask('oi')
    await eventually(() => expect(service.getState().words.length).toBe(3))
    await h4b.interrupt()
    release()
    await turn

    expect(textOf(h4b.conversation.find('m1')!)).toBe('um dois tres ')
  })

  it('marks remaining words as skipped on voice cut (F3) and sets replyEnded only on the last chunk (F4)', async () => {
    const { h4b, clock, service, states } = await setup({}, 'Um dois tres.')
    await h4b.ask('oi')
    await eventually(() => expect(states()).toEqual(['Um:active', 'dois:upcoming', 'tres.:upcoming']))
    h4b.get('voice')!.cancelSpeech()
    await eventually(() => expect(service.getState()).toMatchObject({ status: 'idle', ended: 'interrupted', replyEnded: true }))
    expect(states()).toEqual(['Um:spoken', 'dois:skipped', 'tres.:skipped'])
    await clock.finishNext().catch(() => {})
  })

  it('sets replyEnded only after the last chunk of a multi-sentence voice reply (F4)', async () => {
    const { h4b, clock, service } = await setup({}, 'Olá mundo. Até logo.')
    await h4b.ask('oi')
    await eventually(() => expect(service.getState().status).toBe('speaking'))
    await clock.finishNext()
    await eventually(() => expect(service.getState()).toMatchObject({ from: 10, to: 20 }))
    expect(service.getState().replyEnded).toBeUndefined()
    await clock.finishNext()
    await eventually(() => expect(service.getState()).toMatchObject({ status: 'idle', ended: 'done', replyEnded: true }))
  })

  it('appends streamed deltas to scope: message while voice speaks an earlier chunk (F2)', async () => {
    const clock = clockedPlayer()
    let sendSecond!: () => void
    const h4b = createH4B({
      memory: false,
      plugins: [voice({ language: 'pt-BR', output: 'voice', tts: model, player: clock.player }), captions({ scope: 'message' })],
    })
    h4b.provide('transport', {
      name: 'stream',
      async *run() {
        yield { type: 'message.start', messageId: 'm1' }
        yield { type: 'message.delta', messageId: 'm1', delta: 'Primeira frase. ' }
        await new Promise<void>((r) => (sendSecond = r))
        yield { type: 'message.delta', messageId: 'm1', delta: 'Segunda frase.' }
        yield { type: 'message.end', messageId: 'm1' }
      },
    })
    await h4b.start()
    app = h4b
    const service = h4b.get('captions')!
    const turn = h4b.ask('oi')
    await eventually(() => expect(service.getState().words.map((w) => w.text)).toEqual(['Primeira', 'frase.']))
    sendSecond()
    await turn
    await eventually(() =>
      expect(service.getState().words.map((w) => `${w.text}:${w.state}`)).toEqual([
        'Primeira:active',
        'frase.:upcoming',
        'Segunda:upcoming',
        'frase.:upcoming',
      ]),
    )
  })
})
