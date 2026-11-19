// @vitest-environment jsdom
import { createH4B } from '@handsforbots/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createLevelGate,
  voice,
  type LevelGateOptions,
  type SpeechToText,
  type SttHandlers,
  type TextToSpeech,
  type VoiceDecision,
  type VoiceLevelEvent,
  type VoiceOptions,
  type VoiceService,
} from '../src/index.js'

let clock = 1_000_000
beforeEach(() => {
  clock = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
})
afterEach(() => vi.restoreAllMocks())

describe('createLevelGate', () => {
  it('is unknown until the user level is learned', () => {
    const gate = createLevelGate()
    expect(gate.judge(clock)).toBe('unknown')
    gate.push(-20, clock)
    expect(gate.judge(clock)).toBe('unknown')
    expect(gate.userLevelDb).toBeUndefined()
  })

  it('learns the median of accepted utterances and judges by the gap', () => {
    const gate = createLevelGate({ gapDb: 10, lookbackMs: 1000, remember: 3 })
    for (const level of [-20, -22, -50]) {
      clock += 2000
      gate.push(level, clock)
      gate.learn(clock)
    }
    expect(gate.userLevelDb).toBe(-22)
    expect(gate.gateDb).toBe(-32)
    clock += 2000
    gate.push(-40, clock)
    expect(gate.judge(clock)).toBe('background')
    gate.push(-25, clock)
    expect(gate.judge(clock)).toBe('user')
    // Readings older than the lookback do not count.
    expect(gate.judge(clock + 5000)).toBe('unknown')
  })

  it('takes the loud end of the window, not one click or the silence between words', () => {
    const gate = createLevelGate({ lookbackMs: 3000 })
    for (let i = 0; i < 40; i++) gate.push(i % 4 === 0 ? -20 : -70, clock + i * 50)
    expect(gate.peak(clock + 2000)).toBe(-20)
    gate.reset()
    expect(gate.peak(clock)).toBeUndefined()
  })
})

/** STT whose sessions the test drives by hand. */
function fakeSTT() {
  const sessions: SttHandlers[] = []
  const provider: SpeechToText = {
    name: 'fake',
    capabilities: { partials: true, continuous: true },
    isSupported: () => true,
    listen(_options, handlers) {
      sessions.push(handlers)
      return { stop: vi.fn(() => handlers.onEnd()), abort: vi.fn(() => handlers.onEnd()) }
    },
  }
  return { provider, last: () => sessions.at(-1)! }
}

/** TTS that speaks until the test finishes it. */
function fakeTTS(): TextToSpeech & { finish(): void } {
  const finishers: (() => void)[] = []
  return {
    name: 'fake-tts',
    isSupported: () => true,
    speak(_text, options) {
      return new Promise((resolve) => {
        finishers.push(resolve)
        options.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    },
    cancel: () => finishers.splice(0).forEach((f) => f()),
    finish: () => finishers.shift()?.(),
  }
}

async function setup(levelGate: VoiceOptions['levelGate'], extra: Partial<VoiceOptions> = {}) {
  const stt = fakeSTT()
  const tts = fakeTTS()
  let push: ((db: number) => void) | undefined
  const close = vi.fn()
  const open = vi.fn(async (onLevel: (db: number) => void) => {
    push = onLevel
    return close
  })
  const gate = levelGate && typeof levelGate === 'object' ? { open, ...levelGate } : levelGate ? { open } : levelGate
  const h4b = createH4B({
    plugins: [voice({ language: 'pt-BR', mode: 'hands-free', stt: stt.provider, tts: tts, levelGate: gate, turn: { silence: 60_000 }, ...extra })],
  })
  await h4b.start()
  const v = h4b.get('voice') as VoiceService
  const decisions: VoiceDecision[] = []
  const errors: { source: string }[] = []
  const levels: VoiceLevelEvent[] = []
  h4b.on('voice.decision', (d) => decisions.push(d))
  h4b.on('error', (e) => errors.push(e))
  h4b.on('voice.level', (e) => levels.push(e))
  /** One second of audio at `db`, ending now. */
  const hear = async (db: number) => {
    await vi.waitFor(() => expect(push).toBeDefined())
    for (let i = 0; i < 20; i++) {
      clock += 50
      push!(db)
    }
  }
  return { h4b, v, stt, tts, open, close, decisions, errors, levels, hear }
}

const background = (decisions: VoiceDecision[]) => decisions.filter((d) => d.kind === 'ignore' && d.reason === 'background')

describe('voice level gate', () => {
  it('is off by default', async () => {
    const { v, open } = await setup(undefined)
    await v.listen()
    expect(open).not.toHaveBeenCalled()
  })

  it('learns the user level from accepted hands-free utterances', async () => {
    const { v, stt, hear } = await setup(true)
    await v.listen()
    await hear(-20)
    stt.last().onFinal('oi tudo bem')
    expect(v.getState().userLevelDb).toBe(-20)
  })

  it('background voices neither interrupt the bot nor become a turn; the user still can', async () => {
    const { v, stt, tts, decisions, hear } = await setup(true)
    await v.listen()
    await hear(-20)
    stt.last().onFinal('oi tudo bem')
    void v.speak('Uma resposta longa que o bot está falando agora.')
    await vi.waitFor(() => expect(v.getState().speaking).toBe(true))

    clock += 5000
    await hear(-40)
    stt.last().onPartial!('a televisão falando')
    stt.last().onFinal('a televisão falando')
    expect(v.getState().speaking).toBe(true)
    expect(decisions.some((d) => d.kind === 'interrupt')).toBe(false)
    expect(background(decisions)).toMatchObject([{ text: 'a televisão falando', levelDb: -40, userLevelDb: -20 }])
    expect(v.getState().partial).toBe('oi tudo bem')

    clock += 5000
    await hear(-22)
    stt.last().onPartial!('espera um pouco')
    expect(decisions.at(-1)).toEqual({ kind: 'interrupt', text: 'espera um pouco', levelDb: -22, userLevelDb: -20 })
    expect(v.getState().speaking).toBe(false)
    tts.finish()
  })

  it('scope barge-in lets background speech through while the bot is quiet', async () => {
    const { v, stt, decisions, hear } = await setup(true)
    await v.listen()
    await hear(-20)
    stt.last().onFinal('oi')
    clock += 5000
    await hear(-40)
    stt.last().onFinal('voz ao fundo')
    expect(background(decisions)).toEqual([])
    expect(v.getState().partial).toBe('oi voz ao fundo')
  })

  it('scope all drops background speech while the bot is quiet too, and does not learn from it', async () => {
    const { v, stt, decisions, hear } = await setup({ scope: 'all' })
    await v.listen()
    await hear(-20)
    stt.last().onFinal('oi')
    clock += 5000
    await hear(-40)
    stt.last().onPartial!('voz ao')
    expect(v.getState().partial).toBe('oi')
    stt.last().onFinal('voz ao fundo')
    expect(background(decisions)).toHaveLength(1)
    expect(v.getState().partial).toBe('oi')
    expect(v.getState().userLevelDb).toBe(-20)
  })

  it('does not learn while the bot voice may still be in the window', async () => {
    const { v, stt, tts, hear } = await setup({ scope: 'all' })
    await v.listen()
    void v.speak('Fala do bot.')
    await vi.waitFor(() => expect(v.getState().speaking).toBe(true))
    tts.finish()
    await vi.waitFor(() => expect(v.getState().speaking).toBe(false))
    await hear(-10)
    stt.last().onFinal('oi')
    expect(v.getState().userLevelDb).toBeUndefined()
    clock += 5000
    await hear(-20)
    stt.last().onFinal('tudo bem')
    expect(v.getState().userLevelDb).toBe(-20)
  })

  it('never gates push-to-talk and does not open the monitor there', async () => {
    const { v, open } = await setup(true, { mode: 'push-to-talk' })
    await v.listen()
    expect(open).not.toHaveBeenCalled()
  })

  it('reports what it does on voice.level, for debugging', async () => {
    const { v, stt, tts, levels, hear } = await setup(true)
    await v.listen()
    await vi.waitFor(() => expect(levels).toEqual([{ event: 'monitor.open' }]))
    stt.last().onFinal('sem áudio ainda')
    await hear(-20)
    stt.last().onFinal('oi')
    void v.speak('Fala do bot.')
    await vi.waitFor(() => expect(v.getState().speaking).toBe(true))
    tts.finish()
    await vi.waitFor(() => expect(v.getState().speaking).toBe(false))
    stt.last().onFinal('logo depois do bot')
    v.stop()
    expect(levels).toEqual([
      { event: 'monitor.open' },
      { event: 'learn.skipped', reason: 'no-audio' },
      { event: 'learned', levelDb: -20, userLevelDb: -20, gateDb: -30 },
      { event: 'learn.skipped', reason: 'bot-speech' },
      { event: 'monitor.close' },
    ])
  })

  it('closes the monitor when listening stops', async () => {
    const { v, open, close } = await setup(true)
    await v.listen()
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    v.stop()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('reports a monitor that fails to open and keeps listening ungated', async () => {
    const options: LevelGateOptions = { open: async () => Promise.reject(new Error('no mic')) }
    const stt = fakeSTT()
    const h4b = createH4B({ plugins: [voice({ mode: 'hands-free', stt: stt.provider, levelGate: options })] })
    const errors: { source: string }[] = []
    h4b.on('error', (e) => errors.push(e))
    await h4b.start()
    const v = h4b.get('voice') as VoiceService
    await v.listen()
    await vi.waitFor(() => expect(errors.map((e) => e.source)).toEqual(['voice:level-gate']))
    expect(v.getState().listening).toBe(true)
  })
})
