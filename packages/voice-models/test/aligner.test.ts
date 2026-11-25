import { alignWords } from '@handsforbots/voice'
import { describe, expect, it, vi } from 'vitest'
import { asrWords, resample, whisperAligner, type AsrPipeline } from '../src/index.js'

const signal = new AbortController().signal

describe('whisperAligner', () => {
  it('resamples to 16 kHz and asks for word timestamps in the voice language', async () => {
    const run = vi.fn<AsrPipeline>(async () => ({
      text: ' Olá, mundo.',
      chunks: [
        { text: ' Olá,', timestamp: [0.12, 0.48] },
        { text: ' mundo.', timestamp: [0.6, null] },
      ],
    }))
    const create = vi.fn(async () => run)
    const aligner = whisperAligner({ pipeline: create })
    expect(aligner).toMatchObject({ name: 'whisper', remote: false })
    const audio = { samples: new Float32Array(24000), sampleRate: 24000 }
    const units = await aligner.align(audio, 'Olá, mundo.', { language: 'pt-BR', signal })
    expect(units).toEqual([
      { text: 'Olá,', start: 0.12, end: 0.48 },
      { text: 'mundo.', start: 0.6 },
    ])
    const [samples, options] = run.mock.calls[0]!
    expect(samples).toHaveLength(16000)
    expect(options).toEqual({ return_timestamps: 'word', task: 'transcribe', language: 'pt' })
    // The pipeline is created once.
    await aligner.align(audio, 'Olá, mundo.', { language: 'pt-BR', signal })
    expect(create).toHaveBeenCalledOnce()
  })

  it('passes no language with language: false, its own mapping otherwise, and windows long audio', async () => {
    const run = vi.fn<AsrPipeline>(async () => [{ text: '' }])
    const english = whisperAligner({ pipeline: async () => run, language: false, call: { num_beams: 1 } })
    const long = { samples: new Float32Array(16000 * 31), sampleRate: 16000 }
    expect(await english.align(long, 'x', { language: 'en-US', signal })).toEqual([])
    expect(run.mock.calls[0]![1]).toEqual({ return_timestamps: 'word', task: 'transcribe', chunk_length_s: 30, num_beams: 1 })
    const named = whisperAligner({ pipeline: async () => run, language: () => 'portuguese' })
    await named.align({ samples: new Float32Array(10), sampleRate: 16000 }, 'x', { language: 'pt-BR', signal })
    expect(run.mock.calls[1]![1]).toMatchObject({ language: 'portuguese' })
  })

  it('retries loading after a failure and reports progress', async () => {
    let attempts = 0
    const aligner = whisperAligner({
      pipeline: async (onProgress) => {
        onProgress({ loaded: 1, total: 2 })
        if (++attempts === 1) throw new Error('offline')
        return async () => ({ text: '' })
      },
    })
    const progress = vi.fn()
    await expect(aligner.load!(progress, signal)).rejects.toThrow('offline')
    await aligner.load!(progress, signal)
    expect(progress).toHaveBeenCalledWith({ loaded: 1, total: 2 })
  })

  it('drops empty and untimed chunks; the voice plugin maps misheard words onto the text', () => {
    const units = asrWords({
      text: '',
      chunks: [
        { text: ' ', timestamp: [0, 0.1] },
        { text: ' Ola', timestamp: [0.1, 0.4] },
        { text: ' mondo', timestamp: [null, 0.9] },
        { text: ' hoje', timestamp: [1, 1.3] },
      ],
    })
    expect(units).toEqual([
      { text: 'Ola', start: 0.1, end: 0.4 },
      { text: 'hoje', start: 1, end: 1.3 },
    ])
    const words = alignWords('Olá, mundo, hoje.', units, { duration: 1.5, quality: 'aligned', source: 'asr' })
    expect(words.map((w) => [w.text, w.quality])).toEqual([
      ['Olá,', 'aligned'],
      ['mundo,', 'estimated'],
      ['hoje.', 'aligned'],
    ])
    expect(words[1]!.start).toBeGreaterThanOrEqual(0.4)
    expect(words[1]!.end).toBeLessThanOrEqual(1)
  })

  it('resamples linearly and keeps audio already at the rate', () => {
    const same = new Float32Array([1, 2])
    expect(resample(same, 16000)).toBe(same)
    expect(Array.from(resample(new Float32Array([0, 1, 0, 1]), 32000))).toEqual([0, 0])
    expect(Array.from(resample(new Float32Array([0, 1]), 8000))).toEqual([0, 0.5, 1, 1])
  })
})
