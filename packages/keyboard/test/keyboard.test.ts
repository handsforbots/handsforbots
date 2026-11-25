// @vitest-environment jsdom
import { createH4B, type Transport } from '@handsforbots/core'
import type { VoiceService, VoiceState } from '@handsforbots/voice'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as userEvent from '../src/user-event.js'
import { keyboard, parseCombo } from '../src/index.js'

function fakeVoice(mode: VoiceState['mode'] = 'push-to-talk', speaking = false) {
  return {
    getState: () => ({ mode, speaking }) as VoiceState,
    subscribe: () => () => {},
    listen: vi.fn(async (_options?: { until?: 'silence' | 'stop' }) => {}),
    stop: vi.fn(),
    cancel: vi.fn(),
    endTurn: vi.fn(),
    discardTurn: vi.fn(),
    toggle: vi.fn(async () => {}),
    setMode: vi.fn(),
    setOutput: vi.fn(),
    setEndOfTurn: vi.fn(),
    setEcho: vi.fn(),
    configure: vi.fn(),
    speak: vi.fn(async () => {}),
    cancelSpeech: vi.fn(),
    loadSpeech: vi.fn(async () => true),
    setTTS: vi.fn(async () => {}),
    setEffects: vi.fn(),
    unlockAudio: vi.fn(),
    willSpeakReplies: () => false,
    checkNoise: vi.fn(async () => undefined),
    getSpeechPosition: () => undefined,
    wordsOf: () => [],
  } satisfies VoiceService
}

const press = (type: 'keydown' | 'keyup', init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }))

const trustedPress = (type: 'keydown' | 'keyup', init: KeyboardEventInit) => {
  vi.spyOn(userEvent, 'isTrustedKeyboardEvent').mockReturnValue(true)
  window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }))
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function setup(voice?: VoiceService, options = {}) {
  const h4b = createH4B({ plugins: [keyboard(options)] })
  if (voice) h4b.provide('voice', voice)
  await h4b.start()
  return h4b
}

describe('keyboard', () => {
  it('parses combos with Mod as Ctrl or Cmd', () => {
    expect(parseCombo('Alt+KeyM')).toMatchObject({ key: 'KeyM', alt: true, ctrl: false, meta: false })
    const mod = parseCombo('Mod+KeyK')
    expect(mod.ctrl || mod.meta).toBe(true)
  })

  it('holds to talk in push-to-talk mode', async () => {
    const voice = fakeVoice()
    const h4b = await setup(voice)
    trustedPress('keydown', { code: 'KeyM', key: 'µ', altKey: true })
    trustedPress('keydown', { code: 'KeyM', key: 'µ', altKey: true, repeat: true })
    expect(voice.listen).toHaveBeenCalledOnce()
    expect(voice.listen).toHaveBeenCalledWith({ until: 'stop' })
    trustedPress('keyup', { code: 'KeyM', key: 'm' }) // Alt already released
    expect(voice.stop).toHaveBeenCalledOnce()
    await h4b.stop()
  })

  it('toggles listening in hands-free mode', async () => {
    const voice = fakeVoice('hands-free')
    const h4b = await setup(voice)
    trustedPress('keydown', { code: 'KeyM', key: 'm', altKey: true })
    trustedPress('keyup', { code: 'KeyM', key: 'm' })
    expect(voice.toggle).toHaveBeenCalledOnce()
    expect(voice.stop).not.toHaveBeenCalled()
    await h4b.stop()
  })

  it('Escape interrupts speech and the running turn, and is ignored otherwise', async () => {
    const voice = fakeVoice('push-to-talk', true)
    const transport: Transport = {
      name: 'hang',
      async *run(_r, signal) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve))
      },
    }
    const h4b = await setup(voice)
    h4b.provide('transport', transport)
    const turn = h4b.ask('demora')
    await new Promise((r) => setTimeout(r, 5))
    const interrupted = vi.fn()
    h4b.on('keyboard.interrupt', interrupted)
    trustedPress('keydown', { key: 'Escape', code: 'Escape' })
    expect((await turn).status.phase).toBe('aborted')
    expect(voice.cancelSpeech).toHaveBeenCalled()
    expect(interrupted).toHaveBeenCalledOnce()
    await h4b.stop()
  })

  it('ignores untrusted, composing, and keyless keyboard events', async () => {
    const voice = fakeVoice()
    const h4b = await setup(voice)
    press('keydown', { code: 'KeyM', key: 'm', altKey: true })
    expect(voice.listen).not.toHaveBeenCalled()
    trustedPress('keydown', { code: 'KeyM', key: 'm', altKey: true, isComposing: true } as KeyboardEventInit)
    expect(voice.listen).not.toHaveBeenCalled()
    trustedPress('keydown', { code: 'KeyM', keyCode: 229, altKey: true })
    expect(voice.listen).not.toHaveBeenCalled()
    trustedPress('keydown', { code: 'KeyM', key: 'm', altKey: true })
    expect(voice.listen).toHaveBeenCalledOnce()
    await h4b.stop()
  })

  it('does not seize Alt+M or Escape inside editable fields', async () => {
    const voice = fakeVoice('push-to-talk', true)
    const transport: Transport = {
      name: 'hang',
      async *run(_r, signal) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve))
      },
    }
    document.body.innerHTML = '<input id="f" />'
    const h4b = await setup(voice)
    h4b.provide('transport', transport)
    const interrupted = vi.fn()
    h4b.on('keyboard.interrupt', interrupted)
    const input = document.getElementById('f')!
    input.focus()
    const turn = h4b.ask('demora')
    await new Promise((r) => setTimeout(r, 5))
    const onInput = (init: KeyboardEventInit) => {
      vi.spyOn(userEvent, 'isTrustedKeyboardEvent').mockReturnValue(true)
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    }
    onInput({ key: 'Escape', code: 'Escape' })
    expect(interrupted).not.toHaveBeenCalled()
    expect(h4b.getSnapshot().turn?.phase).not.toBe('aborted')
    onInput({ code: 'KeyM', key: 'm', altKey: true })
    expect(voice.listen).not.toHaveBeenCalled()
    void turn
    await h4b.stop()
  })

  it('emits a palette request and can disable shortcuts', async () => {
    const h4b = await setup(undefined, { talk: false })
    const palette = vi.fn()
    h4b.on('keyboard.palette', palette)
    trustedPress('keydown', { code: 'KeyK', key: 'k', ctrlKey: true })
    trustedPress('keydown', { code: 'KeyK', key: 'k', metaKey: true })
    expect(palette).toHaveBeenCalledOnce()
    await h4b.stop()
    trustedPress('keydown', { code: 'KeyK', key: 'k', ctrlKey: true, metaKey: true })
    expect(palette).toHaveBeenCalledOnce()
  })
})
