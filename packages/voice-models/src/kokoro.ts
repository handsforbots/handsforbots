import type { LoadProgress, SpeechAudio, TextToSpeech, TimedWord } from '@handsforbots/voice'
import { assertSafeModelPath, defaultCache, fetchJson, fetchModel, huggingFace, progressOf, sourceUrl, type ModelCache, type ModelSource } from './fetch.js'
import { chunkText, concatAudio, float32, int64, loadRuntime, type OnnxRuntime, type OnnxSession, type RuntimeSource } from './onnx.js'
import type { Phonemizer } from './phonemizer.js'
import { chunkOffsets, readDurations, wordsFromDurations, WordOwners, type DurationsOption } from './durations.js'

const STYLE_DIM = 256
const MAX_TOKENS = 510
const SAMPLE_RATE = 24000

/** espeak-ng language of a Kokoro voice, from its first letter (`pf_dora` → Brazilian Portuguese). */
const LANGUAGES: Record<string, string> = {
  a: 'en-us',
  b: 'en-gb',
  e: 'es',
  f: 'fr-fr',
  h: 'hi',
  i: 'it',
  p: 'pt-br',
}

export type KokoroDtype = 'fp32' | 'fp16' | 'q8' | 'uint8' | 'uint8f16' | 'q4' | 'q4f16'

const FILES: Record<KokoroDtype, string> = {
  fp32: 'onnx/model.onnx',
  fp16: 'onnx/model_fp16.onnx',
  q8: 'onnx/model_quantized.onnx',
  uint8: 'onnx/model_uint8.onnx',
  uint8f16: 'onnx/model_uint8f16.onnx',
  q4: 'onnx/model_q4.onnx',
  q4f16: 'onnx/model_q4f16.onnx',
}

const KOKORO_VOICE_ID = /^[a-z]{2}_[a-z0-9_]+$/

/** Hugging Face files of Kokoro 82M in ONNX (onnx-community/Kokoro-82M-v1.0-ONNX). */
export function kokoroModel(
  options: { dtype?: KokoroDtype; voices: string[]; repo?: string; revision?: string },
): Pick<KokoroOptions, 'model' | 'voices' | 'tokenizer'> {
  const repo = options.repo ?? 'onnx-community/Kokoro-82M-v1.0-ONNX'
  const at = { revision: options.revision }
  for (const voice of options.voices) {
    assertSafeModelPath(voice, 'Kokoro voice id')
    if (!KOKORO_VOICE_ID.test(voice)) throw new TypeError(`Kokoro voice ids look like "pf_dora", got "${voice}"`)
  }
  return {
    model: huggingFace(repo, FILES[options.dtype ?? 'q8'], at),
    tokenizer: huggingFace(repo, 'tokenizer.json', at),
    voices: Object.fromEntries(options.voices.map((voice) => [voice, huggingFace(repo, `voices/${voice}.bin`, at)])),
  }
}

export type KokoroOptions = {
  /** Default 'kokoro'. */
  name?: string
  model: ModelSource
  /** `tokenizer.json` (the phoneme vocabulary). */
  tokenizer: ModelSource
  /** Voice id → its `.bin` style file. The first is the default. */
  voices: Record<string, ModelSource>
  /** Voice used when the voice plugin does not ask for one (`voiceName`). Default: the first. */
  voice?: string
  phonemizer: Phonemizer
  runtime: RuntimeSource
  /** espeak-ng language for each voice. Default: from the voice's first letter. */
  language?: string | ((voice: string) => string)
  sessionOptions?: Record<string, unknown>
  cache?: ModelCache | false
  size?: number
  /**
   * Word timings from the phoneme durations, for captions (ADR 0020). Needs a
   * model exported with a durations output, such as
   * `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped` (pass it as `repo` to
   * `kokoroModel`). See `DurationsOption`.
   */
  durations?: DurationsOption
}

type Loaded = { ort: OnnxRuntime; session: OnnxSession; vocab: Record<string, number>; styles: Record<string, Float32Array> }

/**
 * Kokoro 82M (StyleTTS 2, ONNX) in the page: natural, 24 kHz, several
 * languages. Heavy for a browser (the q8 file is about 92 MB) and slower
 * than real time on one CPU thread; see the speech guide for numbers.
 */
export function kokoroTTS(options: KokoroOptions): TextToSpeech & { readonly voices: string[] } {
  const voiceIds = Object.keys(options.voices)
  let loaded: Promise<Loaded> | undefined

  const load = (onProgress: (progress: LoadProgress) => void = () => {}, signal?: AbortSignal) => {
    loaded ??= (async () => {
      const progress = progressOf(onProgress, options.size)
      const fetching = { signal, cache: options.cache }
      const [ort, tokenizer, model, styles] = await Promise.all([
        loadRuntime(options.runtime),
        fetchJson<{ model: { vocab: Record<string, number> } }>(options.tokenizer, { ...fetching, onProgress: progress('tokenizer') }),
        fetchModel(options.model, { ...fetching, onProgress: progress('model') }),
        Promise.all(
          voiceIds.map(async (id) => {
            const bytes = await fetchModel(options.voices[id]!, { ...fetching, onProgress: progress(`voice:${id}`) })
            return [id, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))] as const
          }),
        ),
        options.phonemizer.load?.(progress('phonemizer'), signal ?? new AbortController().signal),
      ])
      let session: OnnxSession
      try {
        session = await ort.InferenceSession.create(model, options.sessionOptions)
      } catch (error) {
        const url = sourceUrl(options.model)
        if (url) await defaultCache(options.cache)?.delete?.(url).catch(() => {})
        throw error
      }
      return { ort, session, vocab: tokenizer.model.vocab, styles: Object.fromEntries(styles) }
    })().catch((error) => {
      loaded = undefined
      throw error
    })
    return loaded
  }

  const languageOf = (voice: string) =>
    typeof options.language === 'function' ? options.language(voice) : (options.language ?? LANGUAGES[voice[0] ?? ''] ?? 'en-us')

  return {
    name: options.name ?? 'kokoro',
    remote: false,
    size: options.size,
    prosody: { rate: true },
    voices: voiceIds,
    isSupported: () => typeof WebAssembly === 'object',
    load: async (onProgress, signal) => void (await load(onProgress, signal)),
    async synthesize(text, speakOptions): Promise<SpeechAudio> {
      const { ort, session, vocab, styles } = await load()
      const voice =
        speakOptions.voice && Object.hasOwn(styles, speakOptions.voice) ? speakOptions.voice : (options.voice ?? voiceIds[0]!)
      const style = Object.hasOwn(styles, voice) ? styles[voice] : undefined
      if (!style) throw new Error(`Kokoro voice "${voice}" was not loaded`)
      const parts: Float32Array[] = []
      const words: TimedWord[] = []
      const chunks = chunkText(text)
      const offsets = chunkOffsets(text, chunks)
      let samples = 0
      for (const [index, chunk] of chunks.entries()) {
        if (speakOptions.signal?.aborted) break
        const phonemes = (await options.phonemizer.phonemize(chunk, languageOf(voice))).join('')
        const owners = new WordOwners()
        owners.pad()
        const ids: number[] = []
        for (const symbol of phonemes) {
          const id = vocab[symbol]
          if (id === undefined || ids.length >= MAX_TOKENS) continue
          ids.push(id)
          owners.add(symbol, 1)
        }
        owners.pad()
        // The style vector depends on the length of the input.
        const row = Math.min(ids.length, Math.floor(style.length / STYLE_DIM) - 1)
        const out = await session.run({
          input_ids: int64(ort, [0, ...ids, 0], [1, ids.length + 2]),
          style: float32(ort, style.subarray(row * STYLE_DIM, (row + 1) * STYLE_DIM), [1, STYLE_DIM]),
          speed: float32(ort, [speakOptions.prosody?.rate ?? 1]),
        })
        const audio = (out.waveform ?? out[session.outputNames[0]!])!.data as Float32Array
        parts.push(audio)
        const durations = readDurations(options.durations, session, out, ids.length + 2)
        if (durations) {
          words.push(
            ...wordsFromDurations({
              text: chunk,
              offset: offsets[index]!,
              owners: owners.owners,
              durations,
              start: samples / SAMPLE_RATE,
              seconds: audio.length / SAMPLE_RATE,
            }),
          )
        }
        samples += audio.length
      }
      const result: SpeechAudio = { samples: concatAudio(parts), sampleRate: SAMPLE_RATE }
      return words.length ? { ...result, words } : result
    },
  }
}
