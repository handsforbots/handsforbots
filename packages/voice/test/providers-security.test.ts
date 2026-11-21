// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SpeechError } from '../src/types.js'

const media = vi.hoisted(() => ({
  tracks: [] as { stop: ReturnType<typeof vi.fn> }[],
  captureFail: false,
}))

vi.mock('../src/providers/media.js', () => ({
  openMicrophone: async () => ({
    getTracks: () => media.tracks,
  }),
  closeStream: (stream: { getTracks: () => { stop: () => void }[] }) => {
    for (const track of stream.getTracks()) track.stop()
  },
  resumeAudioContext: async () => {},
  captureFloat: async () => {
    if (media.captureFail) throw new Error('capture failed')
    return async () => {}
  },
  capturePcm16: async () => {
    if (media.captureFail) throw new Error('capture failed')
    return async () => {}
  },
  detectEndOfSpeech: () => () => {},
}))

describe('provider security', () => {
  beforeEach(() => {
    media.tracks = [{ stop: vi.fn() }]
    media.captureFail = false
  })

  it('websocketSTT error messages omit query tokens', async () => {
    const { websocketSTT } = await import('../src/providers/websocket.js')
    const handlers = { onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onEnd: vi.fn() }
    class FakeSocket {
      static OPEN = 1
      binaryType = 'arraybuffer'
      readyState = 1
      onopen: (() => void) | undefined
      onmessage: ((event: { data: string }) => void) | undefined
      onerror: (() => void) | undefined
      onclose: (() => void) | undefined
      send = vi.fn()
      close = vi.fn()
      constructor(_url: string) {
        queueMicrotask(() => this.onerror?.())
      }
    }
    vi.stubGlobal('WebSocket', FakeSocket)
    await websocketSTT({
      url: 'wss://speech.example.com/stt?token=secret',
      parse: () => null,
    }).listen({ language: 'en', continuous: true }, handlers)
    expect(handlers.onError).toHaveBeenCalled()
    const message = (handlers.onError.mock.calls[0]![0] as SpeechError).message
    expect(message).toContain('speech.example.com')
    expect(message).not.toContain('secret')
    expect(message).not.toContain('token=')
    vi.unstubAllGlobals()
  })

  it('voskBrowserSTT stops microphone tracks when capture fails', async () => {
    media.captureFail = true
    const { voskBrowserSTT } = await import('../src/providers/vosk-browser.js')
    const stt = voskBrowserSTT({
      modelUrl: '/m',
      load: async () => ({
        createModel: async () => ({
          terminate: vi.fn(),
          KaldiRecognizer: class {
            on = vi.fn()
            acceptWaveformFloat = vi.fn()
            retrieveFinalResult = vi.fn()
            remove = vi.fn()
          },
        }),
      }),
    })
    const handlers = { onEnd: vi.fn(), onError: vi.fn(), onFinal: vi.fn() }
    await expect(stt.listen({ language: 'pt', continuous: true }, handlers)).rejects.toThrow('capture failed')
    expect(media.tracks[0]!.stop).toHaveBeenCalled()
  })

  it('httpSTT aborts an in-flight upload', async () => {
    const { httpSTT } = await import('../src/providers/http.js')
    let seenSignal: AbortSignal | undefined
    class Recorder {
      state = 'recording'
      ondataavailable: ((event: { data: Blob }) => void) | undefined
      onstop: (() => void) | undefined
      start() {
        queueMicrotask(() => this.ondataavailable?.({ data: new Blob(['x']) }))
        queueMicrotask(() => this.onstop?.())
      }
      stop() {
        this.state = 'inactive'
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', Recorder)
    const mockFetch = vi.fn<(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>>(async (_input, init) => {
      seenSignal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    const stt = httpSTT({ url: '/stt', fetch: mockFetch as typeof fetch })
    const session = await stt.listen({ language: 'pt', continuous: false }, { onEnd: vi.fn(), onError: vi.fn(), onFinal: vi.fn() })
    await vi.waitUntil(() => seenSignal !== undefined)
    session.abort()
    expect(seenSignal?.aborted).toBe(true)
    expect(media.tracks[0]!.stop).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('monitorLevel stops tracks when AudioContext setup fails', async () => {
    const { monitorLevel } = await import('../src/providers/level.js')
    vi.stubGlobal('AudioContext', class {
      constructor() {
        throw new Error('no audio')
      }
    })
    await expect(monitorLevel(() => {})).rejects.toThrow('no audio')
    expect(media.tracks[0]!.stop).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})