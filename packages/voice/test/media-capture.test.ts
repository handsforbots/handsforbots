import { afterEach, describe, expect, it, vi } from 'vitest'
import { monitorLevel } from '../src/providers/level.js'
import { captureFloat, capturePcm16, detectEndOfSpeech, resumeAudioContext } from '../src/providers/media.js'
import { SpeechError } from '../src/types.js'

type FakeContextOptions = {
  state?: AudioContextState
  sampleRate?: number
  resumeBehavior?: 'resolve' | 'stay-suspended' | 'reject' | 'hang'
  addModuleError?: Error
  events?: string[]
  samples?: number[]
}

function createFakeAudioContext(options: FakeContextOptions = {}) {
  const events = options.events ?? []
  const sourceDisconnect = vi.fn()
  const sourceConnect = vi.fn()
  const close = vi.fn(async () => {
    ctx.state = 'closed'
  })
  const resume = vi.fn(() => {
    events.push('resume')
    const behavior = options.resumeBehavior ?? 'resolve'
    if (behavior === 'resolve') {
      ctx.state = 'running'
      return Promise.resolve()
    }
    if (behavior === 'stay-suspended') {
      return Promise.resolve()
    }
    if (behavior === 'reject') {
      return Promise.reject(new Error('resume denied'))
    }
    return new Promise<void>(() => {})
  })
  const addModule = vi.fn(async (_url: string) => {
    events.push('addModule')
    if (options.addModuleError) throw options.addModuleError
  })
  const analyser = {
    fftSize: 1024,
    getFloatTimeDomainData: vi.fn((out: Float32Array) => {
      if (options.samples) {
        for (let i = 0; i < out.length; i++) out[i] = options.samples[i % options.samples.length] ?? 0
      } else {
        out.fill(0.5)
      }
    }),
  }

  const ctx = {
    state: (options.state ?? 'running') as AudioContextState,
    sampleRate: options.sampleRate ?? 16000,
    resume,
    close,
    audioWorklet: { addModule },
    createAnalyser: vi.fn(() => analyser),
    createMediaStreamSource: vi.fn(() => ({
      connect: sourceConnect,
      disconnect: sourceDisconnect,
    })),
  }

  return { ctx: ctx as unknown as AudioContext, raw: ctx, events, analyser, sourceConnect, sourceDisconnect }
}

function stubWorkletAndUrl() {
  const nodes: { port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null }; disconnect: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port = { onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null }
      disconnect = vi.fn()
      constructor() {
        nodes.push(this)
      }
    },
  )
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:h4b-worklet')
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return { nodes, createObjectURL, revokeObjectURL }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('resumeAudioContext', () => {
  it('returns immediately when the context is already running', async () => {
    const { ctx, raw } = createFakeAudioContext({ state: 'running' })
    await expect(resumeAudioContext(ctx)).resolves.toBeUndefined()
    expect(raw.resume).not.toHaveBeenCalled()
  })

  it('throws SpeechError(audio-capture) when the context is closed', async () => {
    const { ctx } = createFakeAudioContext({ state: 'closed' })
    await expect(resumeAudioContext(ctx)).rejects.toMatchObject({
      code: 'audio-capture',
      message: 'Audio capture context is closed',
    })
  })

  it('resumes a suspended context', async () => {
    const { ctx, raw } = createFakeAudioContext({ state: 'suspended', resumeBehavior: 'resolve' })
    await expect(resumeAudioContext(ctx)).resolves.toBeUndefined()
    expect(raw.resume).toHaveBeenCalledTimes(1)
  })

  it('throws SpeechError(audio-capture) when resume resolves but state stays suspended', async () => {
    const { ctx } = createFakeAudioContext({ state: 'suspended', resumeBehavior: 'stay-suspended' })
    await expect(resumeAudioContext(ctx)).rejects.toMatchObject({
      code: 'audio-capture',
      message: 'Audio capture context is suspended',
    })
  })

  it('throws SpeechError(audio-capture) when resume rejects', async () => {
    const { ctx } = createFakeAudioContext({ state: 'suspended', resumeBehavior: 'reject' })
    await expect(resumeAudioContext(ctx)).rejects.toMatchObject({
      code: 'audio-capture',
      message: 'Audio capture context is suspended',
    })
  })

  it('throws SpeechError(audio-capture) when resume times out', async () => {
    vi.useFakeTimers()
    const { ctx } = createFakeAudioContext({ state: 'suspended', resumeBehavior: 'hang' })
    const assertion = expect(resumeAudioContext(ctx, 250)).rejects.toMatchObject({
      code: 'audio-capture',
      message: 'Audio capture context is suspended',
    })
    await vi.advanceTimersByTimeAsync(250)
    await assertion
  })
})

describe('captureFloat', () => {
  it('resumes a suspended AudioContext before adding the worklet module and delivers frames', async () => {
    const fake = createFakeAudioContext({ state: 'suspended', sampleRate: 48000 })
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          return fake.ctx
        }
      },
    )
    const { nodes, revokeObjectURL } = stubWorkletAndUrl()
    const frames: { frame: Float32Array; rate: number }[] = []

    const stop = await captureFloat({} as MediaStream, (frame, rate) => frames.push({ frame, rate }))
    expect(fake.events).toEqual(['resume', 'addModule'])
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:h4b-worklet')

    const sample = new Float32Array([0.25, -0.25])
    nodes[0]!.port.onmessage?.({ data: sample } as MessageEvent<Float32Array>)
    expect(frames).toEqual([{ frame: sample, rate: 48000 }])

    await stop()
    expect(fake.sourceDisconnect).toHaveBeenCalled()
    expect(nodes[0]!.disconnect).toHaveBeenCalled()
    expect(fake.raw.close).toHaveBeenCalledTimes(1)
  })

  it('throws SpeechError(audio-capture) and closes AudioContext if resume fails or stays suspended', async () => {
    const fake = createFakeAudioContext({ state: 'suspended', resumeBehavior: 'stay-suspended' })
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          return fake.ctx
        }
      },
    )
    stubWorkletAndUrl()

    await expect(captureFloat({} as MediaStream, () => {})).rejects.toBeInstanceOf(SpeechError)
    expect(fake.raw.audioWorklet.addModule).not.toHaveBeenCalled()
    expect(fake.raw.close).toHaveBeenCalledTimes(1)
  })

  it('throws SpeechError(audio-capture) and closes AudioContext when resume times out', async () => {
    vi.useFakeTimers()
    const fake = createFakeAudioContext({ state: 'suspended', resumeBehavior: 'hang' })
    stubWorkletAndUrl()

    const assertion = expect(
      captureFloat({} as MediaStream, () => {}, { context: fake.ctx, resumeTimeoutMs: 200 }),
    ).rejects.toMatchObject({ code: 'audio-capture' })
    await vi.advanceTimersByTimeAsync(200)
    await assertion
    expect(fake.raw.close).toHaveBeenCalledTimes(1)
  })

  it('revokes the Blob URL and closes AudioContext if addModule fails', async () => {
    const fake = createFakeAudioContext({ state: 'running', addModuleError: new Error('worklet failed') })
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          return fake.ctx
        }
      },
    )
    const { revokeObjectURL } = stubWorkletAndUrl()

    await expect(captureFloat({} as MediaStream, () => {})).rejects.toThrow('worklet failed')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:h4b-worklet')
    expect(fake.raw.close).toHaveBeenCalledTimes(1)
  })
})

describe('capturePcm16', () => {
  it('resumes a suspended AudioContext before addModule and delivers PCM chunks', async () => {
    const fake = createFakeAudioContext({ state: 'suspended', sampleRate: 16000 })
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          return fake.ctx
        }
      },
    )
    const { nodes, revokeObjectURL } = stubWorkletAndUrl()
    const chunks: ArrayBuffer[] = []

    const stop = await capturePcm16({} as MediaStream, 16000, (chunk) => chunks.push(chunk))
    expect(fake.events).toEqual(['resume', 'addModule'])
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:h4b-worklet')

    const frame = new Float32Array(1600)
    frame.fill(0.5)
    nodes[0]!.port.onmessage?.({ data: frame } as MessageEvent<Float32Array>)
    expect(chunks).toHaveLength(1)
    expect(new Int16Array(chunks[0]!).length).toBe(1600)

    await stop()
    expect(fake.raw.close).toHaveBeenCalledTimes(1)
  })

  it('closes AudioContext and revokes Blob URL when setup fails', async () => {
    const fake = createFakeAudioContext({ state: 'suspended', addModuleError: new Error('module fail') })
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          return fake.ctx
        }
      },
    )
    const { revokeObjectURL } = stubWorkletAndUrl()

    await expect(capturePcm16({} as MediaStream, 16000, () => {})).rejects.toThrow('module fail')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:h4b-worklet')
    expect(fake.raw.close).toHaveBeenCalledTimes(1)
  })

  it('closes AudioContext when resume fails', async () => {
    const fake = createFakeAudioContext({ state: 'suspended', resumeBehavior: 'reject' })
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          return fake.ctx
        }
      },
    )
    stubWorkletAndUrl()

    await expect(capturePcm16({} as MediaStream, 16000, () => {})).rejects.toMatchObject({ code: 'audio-capture' })
    expect(fake.raw.close).toHaveBeenCalledTimes(1)
  })
})

describe('detectEndOfSpeech', () => {
  it('kicks off context.resume() when AudioContext starts suspended', () => {
    vi.useFakeTimers()
    const fake = createFakeAudioContext({ state: 'suspended', resumeBehavior: 'resolve' })
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          return fake.ctx
        }
      },
    )

    const stop = detectEndOfSpeech({} as MediaStream, () => {})
    expect(fake.raw.resume).toHaveBeenCalledTimes(1)
    stop()
    expect(fake.raw.close).toHaveBeenCalledTimes(1)
  })
})

describe('monitorLevel', () => {
  it('resumes a suspended AudioContext and reports dBFS levels', async () => {
    vi.useFakeTimers()
    const trackStop = vi.fn()
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })),
      },
    })
    const fake = createFakeAudioContext({ state: 'suspended', resumeBehavior: 'resolve', samples: [0.5] })
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          return fake.ctx
        }
      },
    )

    const levels: number[] = []
    const stop = await monitorLevel((db) => levels.push(db), { intervalMs: 50 })
    expect(fake.raw.resume).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50)
    expect(levels).toHaveLength(1)
    expect(levels[0]).toBeCloseTo(20 * Math.log10(0.5), 4)

    stop()
    expect(trackStop).toHaveBeenCalledTimes(1)
    expect(fake.raw.close).toHaveBeenCalledTimes(1)
  })

  it('closes both stream tracks and AudioContext when resume fails', async () => {
    const trackStop = vi.fn()
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })),
      },
    })
    const fake = createFakeAudioContext({ state: 'suspended', resumeBehavior: 'reject' })
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          return fake.ctx
        }
      },
    )

    await expect(monitorLevel(() => {})).rejects.toMatchObject({ code: 'audio-capture' })
    expect(trackStop).toHaveBeenCalledTimes(1)
    expect(fake.raw.close).toHaveBeenCalledTimes(1)
  })
})
