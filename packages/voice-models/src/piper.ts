import type { LoadProgress, SpeechAudio, TextToSpeech, TimedWord } from '@handsforbots/voice'
import { assertSafeModelPath, defaultCache, fetchJson, fetchModel, huggingFace, progressOf, sourceUrl, type ModelCache, type ModelSource } from './fetch.js'
import { chunkText, concatAudio, float32, int64, loadRuntime, type OnnxRuntime, type OnnxSession, type RuntimeSource } from './onnx.js'
import type { Phonemizer } from './phonemizer.js'
import { chunkOffsets, readDurations, wordsFromDurations, WordOwners, type DurationsOption } from './durations.js'

/** The `.onnx.json` that comes with every Piper voice. */
export type PiperConfig = {
  audio: { sample_rate: number }
  espeak?: { voice: string }
  inference?: { noise_scale?: number; length_scale?: number; noise_w?: number }
  phoneme_id_map: Record<string, number[]>
  num_speakers?: number
  speaker_id_map?: Record<string, number>
}

export type PiperOptions = {
  /** Provider name (unique among your providers). Default 'piper'. */
  name?: string
  /** The `.onnx` file (fp32 or quantized). */
  model: ModelSource
  /** The `.onnx.json` file. */
  config: ModelSource
  phonemizer: Phonemizer
  runtime: RuntimeSource
  /** For multi-speaker voices: a name from `speaker_id_map` or a number. Default 0. */
  speaker?: string | number
  /** Override the voice's inference settings. */
  noiseScale?: number
  lengthScale?: number
  noiseW?: number
  /** Passed to `InferenceSession.create` (e.g. `{ executionProviders: ['wasm'] }`). */
  sessionOptions?: Record<string, unknown>
  cache?: ModelCache | false
  /** Bytes to download, for progress before the download starts. */
  size?: number
  /**
   * Word timings from the phoneme durations, for captions (ADR 0020). Needs a
   * model exported with a durations output; the official Piper voices have
   * none. See `DurationsOption`.
   */
  durations?: DurationsOption
}

/**
 * Hugging Face files of a voice in rhasspy/piper-voices, by its id
 * (`pt_BR-faber-medium`, `en_US-lessac-medium`…). Licenses vary per voice:
 * read its MODEL_CARD.
 */
const PIPER_VOICE_ID = /^[a-z]{2,3}_[A-Z]{2}-[a-zA-Z0-9_]+-(?:x_low|low|medium|high)$/

export function piperVoice(id: string, options: { revision?: string } = {}): { model: ModelSource; config: ModelSource } {
  assertSafeModelPath(id, 'Piper voice id')
  if (!PIPER_VOICE_ID.test(id)) throw new TypeError(`Piper voice ids look like "pt_BR-faber-medium", got "${id}"`)
  const [locale, name, quality] = id.split('-')
  if (!locale || !name || !quality) throw new TypeError(`Piper voice ids look like "pt_BR-faber-medium", got "${id}"`)
  const path = `${locale.split('_')[0]}/${locale}/${name}/${quality}/${id}`
  return {
    model: huggingFace('rhasspy/piper-voices', `${path}.onnx`, options),
    config: huggingFace('rhasspy/piper-voices', `${path}.onnx.json`, options),
  }
}

/** Phonemes → Piper ids: BOS, pad, (id, pad)*, EOS, with the voice's own map. */
export function piperIds(phonemes: string[], map: Record<string, number[]>, owners?: WordOwners): number[] {
  const id = (symbol: string) => map[symbol]?.[0]
  const pad = id('_') ?? 0
  const ids = [id('^') ?? 1, pad]
  owners?.pad(2)
  for (const phoneme of phonemes) {
    for (const symbol of map[phoneme] ? [phoneme] : [...phoneme]) {
      const value = id(symbol)
      if (value !== undefined) {
        ids.push(value, pad)
        owners?.add(symbol, 2)
      }
    }
  }
  ids.push(id('$') ?? 2)
  owners?.pad()
  return ids
}

type Loaded = { ort: OnnxRuntime; session: OnnxSession; config: PiperConfig }

/** A Piper voice (VITS, ONNX) running in the page. Fast on CPU; one language per voice. */
export function piperTTS(options: PiperOptions): TextToSpeech & { readonly config?: PiperConfig } {
  let loaded: Promise<Loaded> | undefined
  let current: Loaded | undefined

  const load = (onProgress: (progress: LoadProgress) => void = () => {}, signal?: AbortSignal) => {
    loaded ??= (async () => {
      const progress = progressOf(onProgress, options.size)
      const [ort, config, model] = await Promise.all([
        loadRuntime(options.runtime),
        fetchJson<PiperConfig>(options.config, { onProgress: progress('config'), signal, cache: options.cache }),
        fetchModel(options.model, { onProgress: progress('model'), signal, cache: options.cache }),
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
      current = { ort, session, config }
      return current
    })().catch((error) => {
      loaded = undefined
      throw error
    })
    return loaded
  }

  return {
    name: options.name ?? 'piper',
    remote: false,
    size: options.size,
    prosody: { rate: true },
    get config() {
      return current?.config
    },
    isSupported: () => typeof WebAssembly === 'object',
    load: async (onProgress, signal) => void (await load(onProgress, signal)),
    async synthesize(text, speakOptions): Promise<SpeechAudio> {
      const { ort, session, config } = await load()
      const inference = config.inference ?? {}
      const lengthScale = (options.lengthScale ?? inference.length_scale ?? 1) / (speakOptions.prosody?.rate ?? 1)
      const scales = [options.noiseScale ?? inference.noise_scale ?? 0.667, lengthScale, options.noiseW ?? inference.noise_w ?? 0.8]
      const speaker =
        typeof options.speaker === 'string'
          ? config.speaker_id_map && Object.hasOwn(config.speaker_id_map, options.speaker)
            ? config.speaker_id_map[options.speaker]!
            : 0
          : (options.speaker ?? 0)
      const language = config.espeak?.voice ?? speakOptions.language
      const parts: Float32Array[] = []
      const words: TimedWord[] = []
      const chunks = chunkText(text)
      const offsets = chunkOffsets(text, chunks)
      let samples = 0
      for (const [index, chunk] of chunks.entries()) {
        if (speakOptions.signal?.aborted) break
        const owners = new WordOwners()
        const ids = piperIds(await options.phonemizer.phonemize(chunk, language), config.phoneme_id_map, owners)
        const feeds: Record<string, ReturnType<typeof int64>> = {
          input: int64(ort, ids, [1, ids.length]),
          input_lengths: int64(ort, [ids.length]),
          scales: float32(ort, scales),
        }
        if ((config.num_speakers ?? 1) > 1 || session.inputNames.includes('sid')) feeds.sid = int64(ort, [speaker])
        const out = await session.run(feeds)
        const audio = (out.output ?? out[session.outputNames[0]!])!.data as Float32Array
        parts.push(audio)
        const durations = readDurations(options.durations, session, out, ids.length)
        if (durations) {
          const rate = config.audio.sample_rate
          words.push(
            ...wordsFromDurations({ text: chunk, offset: offsets[index]!, owners: owners.owners, durations, start: samples / rate, seconds: audio.length / rate }),
          )
        }
        samples += audio.length
      }
      const result: SpeechAudio = { samples: concatAudio(parts), sampleRate: config.audio.sample_rate }
      return words.length ? { ...result, words } : result
    },
  }
}
