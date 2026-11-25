import { describe, expect, it } from 'vitest'
import {
  kokoroTTS,
  piperIds,
  piperTTS,
  readDurations,
  wordsFromDurations,
  WordOwners,
  type OnnxRuntime,
  type OnnxSession,
  type OnnxTensor,
  type Phonemizer,
} from '../src/index.js'

const bytes = (text: string) => new TextEncoder().encode(text)

/** Phonemes = the letters of the text, spaces and punctuation included. */
const phonemizer: Phonemizer = { name: 'letters', phonemize: async (text) => [...text.toLowerCase()] }

/** A runtime whose model returns `seconds` of audio per run and one duration per input id. */
function runtime(options: { outputs: string[]; durations?: (length: number) => ArrayLike<number | bigint>; sampleRate: number; seconds: number }) {
  const ort: OnnxRuntime = {
    Tensor: class {
      constructor(
        public type: string,
        public data: unknown,
        public dims?: readonly number[],
      ) {}
    } as unknown as OnnxRuntime['Tensor'],
    InferenceSession: {
      create: async (): Promise<OnnxSession> => ({
        inputNames: ['input', 'input_lengths', 'scales'],
        outputNames: options.outputs,
        run: async (feeds) => {
          const ids = (feeds.input ?? feeds.input_ids)!.data as BigInt64Array
          const out: Record<string, OnnxTensor> = {
            [options.outputs[0]!]: { data: new Float32Array(Math.round(options.seconds * options.sampleRate)) },
          }
          if (options.durations && options.outputs[1]) out[options.outputs[1]] = { data: options.durations(ids.length) }
          return out
        },
      }),
    },
  }
  return ort
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyzç'
const piperConfig = {
  audio: { sample_rate: 100 },
  phoneme_id_map: Object.fromEntries([['_', [0]], ['^', [1]], ['$', [2]], [' ', [3]], [',', [4]], ['.', [5]], ...[...LETTERS].map((c, i) => [c, [10 + i]])]),
}

describe('WordOwners', () => {
  it('numbers words by letters, ends them at spaces and leaves the rest out', () => {
    const owners = new WordOwners()
    const ids = piperIds([...'oi, tu.'], piperConfig.phoneme_id_map, owners)
    expect(owners.owners).toHaveLength(ids.length)
    expect(owners.words).toBe(2)
    // BOS + pad, o(2) i(2), comma(2), space(2), t(2) u(2), dot(2), EOS.
    expect(owners.owners).toEqual([-1, -1, 0, 0, 0, 0, -1, -1, -1, -1, 1, 1, 1, 1, -1, -1, -1])
  })
})

describe('readDurations', () => {
  const session = { inputNames: [], outputNames: ['wav', 'durations'], run: async () => ({}) }
  it('finds the output by name, converts bigints and rejects the wrong length', () => {
    const out = { durations: { data: BigInt64Array.from([1n, 2n]) } }
    expect(readDurations(true, session, out, 2)).toEqual([1, 2])
    expect(readDurations(true, session, out, 3)).toBeUndefined()
    expect(readDurations(false, session, out, 2)).toBeUndefined()
    expect(readDurations({ output: 'custom' }, session, { custom: { data: [3, -1] } }, 2)).toEqual([3, 0])
    expect(readDurations(true, { ...session, outputNames: ['wav'] }, {}, 2)).toBeUndefined()
  })
})

describe('wordsFromDurations', () => {
  it('scales durations to the real length and measures words one to one', () => {
    const owners = [-1, 0, 0, -1, 1, -1]
    const words = wordsFromDurations({ text: 'Oi, tu.', offset: 10, owners, durations: [1, 1, 1, 1, 2, 4], start: 1, seconds: 2 })
    expect(words).toEqual([
      { text: 'Oi,', start: expect.closeTo(1.2), end: expect.closeTo(1.6), from: 10, to: 13, quality: 'measured', source: 'model' },
      { text: 'tu.', start: expect.closeTo(1.8), end: expect.closeTo(2.2), from: 14, to: 17, quality: 'measured', source: 'model' },
    ])
  })

  it('gives one estimated unit when spoken and written words do not line up', () => {
    const words = wordsFromDurations({ text: 'R$ 5', offset: 0, owners: [0, 1, 2], durations: [1, 1, 1], start: 0, seconds: 3 })
    expect(words).toEqual([{ text: 'R$ 5', start: 0, end: 3, from: 0, to: 4, quality: 'estimated', source: 'model' }])
    expect(wordsFromDurations({ text: 'x', offset: 0, owners: [0], durations: [0], start: 0, seconds: 1 })).toEqual([])
  })
})

describe('engines with a durations output', () => {
  it('piperTTS returns word timings across chunks, positioned in its text', async () => {
    const ort = runtime({ outputs: ['output', 'durations'], durations: (n) => new Float32Array(n).fill(1), sampleRate: 100, seconds: 1 })
    const tts = piperTTS({
      model: bytes('m'),
      config: async () => bytes(JSON.stringify(piperConfig)),
      phonemizer,
      runtime: ort,
      cache: false,
      durations: true,
    })
    const text = 'Oi tu. Eu ' + 'a'.repeat(300) + '.'
    const audio = await tts.synthesize!(text, { language: 'pt-BR' })
    expect(audio.words!.map((w) => [w.text, w.from, w.to, w.quality])).toEqual([
      ['Oi', 0, 2, 'measured'],
      ['tu.', 3, 6, 'measured'],
      ['Eu', 7, 9, 'measured'],
      ['a'.repeat(300) + '.', 10, 311, 'measured'],
    ])
    // The second chunk starts after the first one's second of audio.
    expect(audio.words![2]!.start).toBeGreaterThanOrEqual(1)
    for (const word of audio.words!) expect(text.slice(word.from!, word.to!)).toBe(word.text)
  })

  it('piperTTS gives no timings without the option or without the output', async () => {
    const config = async () => bytes(JSON.stringify(piperConfig))
    const withOutput = runtime({ outputs: ['output', 'durations'], durations: (n) => new Float32Array(n).fill(1), sampleRate: 100, seconds: 1 })
    const off = piperTTS({ model: bytes('m'), config, phonemizer, runtime: withOutput, cache: false })
    expect((await off.synthesize!('oi', { language: 'pt-BR' })).words).toBeUndefined()
    const missing = piperTTS({ model: bytes('m'), config, phonemizer, runtime: runtime({ outputs: ['output'], sampleRate: 100, seconds: 1 }), cache: false, durations: true })
    expect((await missing.synthesize!('oi', { language: 'pt-BR' })).words).toBeUndefined()
  })

  it('kokoroTTS reads durations per token, pads included', async () => {
    const vocab = Object.fromEntries([...LETTERS, ' '].map((c, i) => [c, i + 1]))
    const style = new Float32Array(256 * 4)
    const ort = runtime({ outputs: ['waveform', 'durations'], durations: (n) => BigInt64Array.from({ length: n }, () => 2n), sampleRate: 24000, seconds: 0.5 })
    const tts = kokoroTTS({
      model: bytes('m'),
      tokenizer: bytes(JSON.stringify({ model: { vocab } })),
      voices: { pf_dora: new Uint8Array(style.buffer) },
      phonemizer,
      runtime: ort,
      cache: false,
      durations: true,
    })
    const audio = await tts.synthesize!('oi tu', { language: 'pt-BR' })
    expect(audio.samples).toHaveLength(12000)
    // 7 tokens of equal length (pad, o, i, space, t, u, pad) over 0.5 s.
    expect(audio.words).toEqual([
      { text: 'oi', start: expect.closeTo(0.5 / 7), end: expect.closeTo(1.5 / 7), from: 0, to: 2, quality: 'measured', source: 'model' },
      { text: 'tu', start: expect.closeTo(2 / 7), end: expect.closeTo(3 / 7), from: 3, to: 5, quality: 'measured', source: 'model' },
    ])
  })
})
