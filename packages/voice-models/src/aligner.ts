import type { LoadProgress, SpeechAudio, TimedWord, WordAligner } from '@handsforbots/voice'

/** A word of a transformers.js `automatic-speech-recognition` result with `return_timestamps: 'word'`. */
export type AsrWordChunk = { text: string; timestamp: readonly (number | null | undefined)[] }
export type AsrOutput = { text: string; chunks?: AsrWordChunk[] }
export type AsrPipeline = (audio: Float32Array, options?: Record<string, unknown>) => Promise<AsrOutput | AsrOutput[]>

export type WhisperAlignerOptions = {
  /** Default `whisper`. */
  name?: string
  /**
   * Creates the pipeline, e.g.
   * `(progress) => pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny_timestamped', { dtype: 'q8', progress_callback: transformersProgress(progress) })`
   * after `import { pipeline } from '@huggingface/transformers'`. Word
   * timestamps need a model exported with cross-attentions (the
   * `_timestamped` repositories).
   */
  pipeline: (onProgress: (progress: LoadProgress) => void) => Promise<AsrPipeline>
  /**
   * The language Whisper is told, from the voice's (BCP 47). Default: the
   * primary subtag (`pt-BR` → `pt`). `false` passes none (English-only
   * `.en` models refuse one).
   */
  language?: false | ((language: string) => string | undefined)
  /** Options for every call (`num_beams`, `chunk_length_s`…). */
  call?: Record<string, unknown>
  size?: number
}

/** Whisper's input rate. */
export const WHISPER_SAMPLE_RATE = 16000

/** Linear resampling, enough for recognition. */
export function resample(samples: Float32Array, from: number, to = WHISPER_SAMPLE_RATE): Float32Array {
  if (from === to || !samples.length) return samples
  const length = Math.max(1, Math.round((samples.length * to) / from))
  const out = new Float32Array(length)
  const step = from / to
  for (let i = 0; i < length; i++) {
    const at = i * step
    const left = Math.floor(at)
    const right = Math.min(samples.length - 1, left + 1)
    const t = at - left
    out[i] = (samples[left] ?? 0) * (1 - t) + (samples[right] ?? 0) * t
  }
  return out
}

/** The words of a recognition result, times in seconds of the audio. */
export function asrWords(output: AsrOutput | AsrOutput[]): TimedWord[] {
  const result = Array.isArray(output) ? output[0] : output
  const words: TimedWord[] = []
  for (const chunk of result?.chunks ?? []) {
    const text = String(chunk.text ?? '').trim()
    const [start, end] = chunk.timestamp ?? []
    if (!text || typeof start !== 'number' || !Number.isFinite(start)) continue
    words.push({ text, start, ...(typeof end === 'number' && Number.isFinite(end) ? { end } : {}) })
  }
  return words
}

/**
 * Word timings for synthesized speech from Whisper (ADR 0020): recognizes
 * the sentence with word timestamps; the voice plugin matches the words it
 * heard to the text (so recognition errors only cost the words they hit).
 * Runs in the page: the model downloads on first use (tens of MB) and each
 * sentence costs one recognition, done while the previous one plays. Keep
 * inference off the main thread (`env.backends.onnx.wasm.proxy = true` or
 * WebGPU) so captions do not stutter.
 */
export function whisperAligner(options: WhisperAlignerOptions): WordAligner {
  let loaded: Promise<AsrPipeline> | undefined
  const load = (onProgress: (progress: LoadProgress) => void = () => {}) => {
    loaded ??= options.pipeline(onProgress).catch((error) => {
      loaded = undefined
      throw error
    })
    return loaded
  }
  const languageOf = (language: string) =>
    options.language === false
      ? undefined
      : options.language
        ? options.language(language)
        : language.split('-')[0]?.toLowerCase() || undefined
  return {
    name: options.name ?? 'whisper',
    remote: false,
    size: options.size,
    isSupported: () => typeof WebAssembly === 'object',
    load: async (onProgress) => void (await load(onProgress)),
    async align(audio: SpeechAudio, _text, { language, signal }) {
      const run = await load()
      if (signal.aborted) return undefined
      const samples = resample(audio.samples, audio.sampleRate)
      const lang = languageOf(language)
      const seconds = samples.length / WHISPER_SAMPLE_RATE
      const output = await run(samples, {
        return_timestamps: 'word',
        task: 'transcribe',
        ...(lang ? { language: lang } : {}),
        // Whisper hears 30 s at a time; longer sentences go in windows.
        ...(seconds > 30 ? { chunk_length_s: 30 } : {}),
        ...options.call,
      })
      return asrWords(output)
    },
  }
}
