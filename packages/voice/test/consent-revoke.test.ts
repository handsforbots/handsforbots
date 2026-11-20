// @vitest-environment jsdom
import { createH4B, textOf, type Transport } from '@handsforbots/core'
import { describe, expect, it, vi } from 'vitest'
import { voice, type EndOfTurn, type SpeechToText, type SttHandlers, type TextToSpeech, type VoiceDecision, type VoiceService } from '../src/index.js'

function deferredSTT(name: string, consent?: string) {
  let finish: (() => void) | undefined
  const sessions: { handlers: SttHandlers; stop: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> }[] = []
  const provider: SpeechToText = {
    name,
    consent,
    capabilities: { partials: true, continuous: true },
    isSupported: () => true,
    listen(_options, handlers) {
      return new Promise((resolve) => {
        const session = {
          handlers,
          stop: vi.fn(() => handlers.onEnd()),
          abort: vi.fn(() => handlers.onEnd()),
        }
        sessions.push(session)
        finish = () => resolve(session)
      })
    },
  }
  return {
    provider,
    sessions,
    last: () => sessions.at(-1),
    finishListen: () => finish!(),
  }
}

function fakeSTT(name: string, consent?: string) {
  const sessions: { handlers: SttHandlers; stop: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> }[] = []
  const provider: SpeechToText = {
    name,
    consent,
    capabilities: { partials: true, continuous: true },
    isSupported: () => true,
    listen(_options, handlers) {
      const session = {
        handlers,
        stop: vi.fn(() => handlers.onEnd()),
        abort: vi.fn(() => handlers.onEnd()),
      }
      sessions.push(session)
      return session
    },
  }
  return { provider, sessions, last: () => sessions.at(-1)! }
}

function deferredModel(name: string, consent?: string) {
  const synthesized: string[] = []
  const pending: { text: string; finish: () => void }[] = []
  const provider: TextToSpeech = {
    name,
    consent,
    isSupported: () => true,
    async synthesize(text) {
      synthesized.push(text)
      return new Promise((resolve) => {
        const finish = () => resolve({ samples: new Float32Array(1), sampleRate: 16000 })
        pending.push({ text, finish })
      })
    },
  }
  return {
    provider,
    synthesized,
    pending,
    finishCurrent: () => pending.at(-1)?.finish(),
  }
}

function fakePlayer() {
  const plays: { finish(): void }[] = []
  const player = {
    isSupported: () => true,
    unlock: vi.fn(),
    play(_audio: unknown, options: { signal?: AbortSignal }) {
      return new Promise<void>((resolve) => {
        plays.push({ finish: resolve })
        options.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    },
    stop: vi.fn(),
  }
  return { player, plays, finishPlay: () => plays.at(-1)?.finish() }
}

const eventually = async (check: () => void, timeout = 2000) => {
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

function fakeTTS(name: string, consent?: string) {
  let finish: (() => void) | undefined
  const provider: TextToSpeech & { finish(): void } = {
    name,
    consent,
    isSupported: () => true,
    speak(_text, options) {
      return new Promise((resolve) => {
        finish = resolve
        options.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    },
    cancel: vi.fn(() => finish?.()),
    finish: () => finish?.(),
  }
  return { provider }
}

const transport: Transport = {
  name: 'reply',
  async *run(request) {
    yield { type: 'message.start', messageId: `m-${request.turnId}` }
    yield { type: 'message.delta', messageId: `m-${request.turnId}`, delta: `echo: ${textOf(request.messages.at(-1)!)}` }
    yield { type: 'message.end', messageId: `m-${request.turnId}` }
  },
}

describe('consent revocation', () => {
  it('aborts cloud STT, ignores late finals, and falls back or stops listening', async () => {
    const cloud = fakeSTT('cloud', 'voice-cloud')
    const local = fakeSTT('local')
    const h4b = createH4B({
      consent: { initial: { 'voice-cloud': true }, channel: false },
      plugins: [voice({ language: 'pt-BR', mode: 'hands-free', stt: [cloud.provider, local.provider] })],
    })
    h4b.provide('transport', transport)
    await h4b.start()
    const v = h4b.get('voice') as VoiceService
    await v.listen()
    expect(v.getState().listening).toBe(true)
    expect(v.getState().stt).toBe('cloud')
    await h4b.consent.set({ 'voice-cloud': false })
    expect(cloud.last().abort).toHaveBeenCalled()
    expect(v.getState().listening).toBe(true)
    expect(v.getState().stt).toBe('local')
    expect(h4b.messages).toHaveLength(0)
    cloud.last().handlers.onFinal('tarde demais')
    cloud.last().handlers.onEnd()
    await Promise.resolve()
    expect(h4b.messages).toHaveLength(0)
  })

  it('stops listening when no STT provider stays allowed after revoke', async () => {
    const cloud = fakeSTT('cloud', 'voice-cloud')
    const h4b = createH4B({
      consent: { initial: { 'voice-cloud': true }, channel: false },
      plugins: [voice({ language: 'pt-BR', stt: cloud.provider })],
    })
    await h4b.start()
    const v = h4b.get('voice') as VoiceService
    await v.listen()
    await h4b.consent.set({ 'voice-cloud': false })
    expect(cloud.last().abort).toHaveBeenCalled()
    expect(v.getState().listening).toBe(false)
  })

  it('aborts STT when consent is revoked before listen() resolves', async () => {
    const cloud = deferredSTT('cloud', 'voice-cloud')
    const local = fakeSTT('local')
    const h4b = createH4B({
      consent: { initial: { 'voice-cloud': true }, channel: false },
      plugins: [voice({ language: 'pt-BR', mode: 'hands-free', stt: [cloud.provider, local.provider] })],
    })
    await h4b.start()
    const v = h4b.get('voice') as VoiceService
    void v.listen()
    await Promise.resolve()
    expect(v.getState().listening).toBe(true)
    await h4b.consent.set({ 'voice-cloud': false })
    expect(v.getState().listening).toBe(false)
    cloud.finishListen()
    await vi.waitUntil(() => (cloud.last()?.abort.mock.calls.length ?? 0) > 0)
    cloud.last()!.handlers.onFinal('tarde demais')
    cloud.last()!.handlers.onEnd()
    await Promise.resolve()
    expect(h4b.messages).toHaveLength(0)
    await vi.waitUntil(() => v.getState().stt === 'local' && v.getState().listening)
    expect(cloud.sessions).toHaveLength(1)
  })

  it('cancels in-flight TTS when its consent purpose is revoked', async () => {
    const stt = fakeSTT('local')
    const tts = fakeTTS('cloud-tts', 'voice-cloud')
    const h4b = createH4B({
      consent: { initial: { 'voice-cloud': true }, channel: false },
      plugins: [voice({ language: 'pt-BR', stt: stt.provider, tts: tts.provider, output: 'voice' })],
    })
    h4b.provide('transport', transport)
    await h4b.start()
    const v = h4b.get('voice') as VoiceService
    void h4b.ask('fale')
    await vi.waitUntil(() => v.getState().speaking)
    await h4b.consent.set({ 'voice-cloud': false })
    expect(tts.provider.cancel).toHaveBeenCalled()
    expect(v.getState().speaking).toBe(false)
  })

  it('falls back to silence when end-of-turn consent is revoked during a pending turn', async () => {
    vi.useFakeTimers()
    const stt = fakeSTT('local')
    const predict = vi.fn(() => 1)
    const model: EndOfTurn = { name: 'model', input: 'text', consent: 'voice-ai', isSupported: () => true, predict }
    const decisions: VoiceDecision[] = []
    const h4b = createH4B({
      consent: { initial: { 'voice-ai': true }, channel: false },
      plugins: [voice({ language: 'pt-BR', mode: 'hands-free', stt: stt.provider, endOfTurn: model, turn: { silence: 400 } })],
    })
    h4b.on('voice.decision', (d) => void decisions.push(d))
    h4b.provide('transport', transport)
    await h4b.start()
    const v = h4b.get('voice') as VoiceService
    await v.listen()
    stt.last().handlers.onFinal('oi')
    await vi.advanceTimersByTimeAsync(100)
    await h4b.consent.set({ 'voice-ai': false })
    expect(decisions).toContainEqual(expect.objectContaining({ kind: 'end-of-turn-unavailable', provider: 'model' }))
    expect(predict).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(400)
    const users = h4b.messages.filter((m) => m.role === 'user')
    expect(users).toHaveLength(1)
    expect(textOf(users[0]!)).toBe('oi')
    expect(decisions.at(-1)).toMatchObject({ kind: 'end-of-turn', reason: 'silence' })
    vi.useRealTimers()
  })

  it('discards pending turn from blocked provider even without active session', async () => {
    const cloud = fakeSTT('cloud', 'voice-cloud')
    const h4b = createH4B({
      consent: { initial: { 'voice-cloud': true }, channel: false },
      plugins: [voice({ language: 'pt-BR', mode: 'hands-free', stt: cloud.provider, turn: { silence: 5000 } })],
    })
    h4b.provide('transport', transport)
    await h4b.start()
    const v = h4b.get('voice') as VoiceService
    await v.listen()
    cloud.last().handlers.onFinal('pending words')
    // Session ends but the silence timer still holds the turn
    cloud.last().handlers.onEnd()
    await Promise.resolve()
    // Revoke consent while turn text is pending but no session is active
    await h4b.consent.set({ 'voice-cloud': false })
    expect(h4b.messages.filter((m) => m.role === 'user')).toHaveLength(0)
  })

  it('discards held push-to-talk text when cloud consent is revoked', async () => {
    const cloud = fakeSTT('cloud', 'voice-cloud')
    const h4b = createH4B({
      consent: { initial: { 'voice-cloud': true }, channel: false },
      plugins: [voice({ language: 'pt-BR', mode: 'push-to-talk', stt: cloud.provider })],
    })
    await h4b.start()
    const v = h4b.get('voice') as VoiceService
    await v.listen({ until: 'stop' })
    cloud.last().handlers.onFinal('secreto')
    await h4b.consent.set({ 'voice-cloud': false })
    v.stop()
    cloud.last().handlers.onEnd()
    await Promise.resolve()
    expect(h4b.messages.filter((m) => m.role === 'user')).toHaveLength(0)
  })

  it('does not synthesize queued sentences after cloud TTS consent is revoked', async () => {
    const stt = fakeSTT('local')
    const model = deferredModel('cloud-model', 'voice-cloud')
    const { player, finishPlay } = fakePlayer()
    const transportLong: Transport = {
      name: 'reply',
      async *run(request) {
        yield { type: 'message.start', messageId: `m-${request.turnId}` }
        yield { type: 'message.delta', messageId: `m-${request.turnId}`, delta: 'Primeira. Segunda. Terceira.' }
        yield { type: 'message.end', messageId: `m-${request.turnId}` }
      },
    }
    const h4b = createH4B({
      consent: { initial: { 'voice-cloud': true }, channel: false },
      plugins: [
        voice({
          language: 'pt-BR',
          stt: stt.provider,
          tts: model.provider,
          output: 'voice',
          player,
          load: { start: 'eager', whileLoading: 'wait' },
        }),
      ],
    })
    h4b.provide('transport', transportLong)
    await h4b.start()
    const v = h4b.get('voice') as VoiceService
    void h4b.ask('fale')
    await eventually(() => expect(model.pending).toHaveLength(1))
    await h4b.consent.set({ 'voice-cloud': false })
    model.finishCurrent()
    await finishPlay()
    await eventually(() => expect(model.synthesized).toEqual(['Primeira.']))
  })
})