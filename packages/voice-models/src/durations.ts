import { splitWords, type TimedWord } from '@handsforbots/voice/words'
import type { OnnxSession, OnnxTensor } from './onnx.js'

/**
 * Word timings from the model's phoneme durations (ADR 0020). `true` looks
 * for an output named `durations`, `duration`, `pred_dur` or `w_ceil`; a
 * string names it. Models exported without such an output give no timings
 * and the voice plugin estimates. Default `false`.
 */
export type DurationsOption = boolean | { output: string }

const NAMES = ['durations', 'duration', 'pred_dur', 'w_ceil']

/** Letters (IPA symbols included) belong to a word; spaces end one; the rest (punctuation, stress marks alone) is neither. */
const WORD_SYMBOL = /[\p{L}\p{M}\p{N}]/u
const HAS_LETTERS = /[\p{L}\p{N}]/u

/** Tracks which spoken word each input id belongs to (-1: padding, punctuation, space). */
export class WordOwners {
  readonly owners: number[] = []
  private word = -1
  private inWord = false

  /** Adds `count` ids made from `symbol`. */
  add(symbol: string, count: number) {
    let owner = -1
    if (/^\s+$/.test(symbol)) this.inWord = false
    else if (WORD_SYMBOL.test(symbol)) {
      if (!this.inWord) {
        this.inWord = true
        this.word++
      }
      owner = this.word
    }
    for (let i = 0; i < count; i++) this.owners.push(owner)
  }

  /** Ids that are not part of the text (BOS, EOS, padding). */
  pad(count = 1) {
    for (let i = 0; i < count; i++) this.owners.push(-1)
  }

  get words() {
    return this.word + 1
  }
}

/** The durations tensor of a run, if the option asks for it and the model has it, as numbers. */
export function readDurations(
  option: DurationsOption | undefined,
  session: OnnxSession,
  out: Record<string, OnnxTensor>,
  length: number,
): number[] | undefined {
  if (!option) return undefined
  const name = typeof option === 'object' ? option.output : NAMES.find((n) => session.outputNames.includes(n) || n in out)
  const tensor = name ? out[name] : undefined
  const data = tensor?.data as ArrayLike<number | bigint> | undefined
  if (!data || typeof data.length !== 'number') return undefined
  const values = Array.from(data, (value) => Math.max(0, Number(value)))
  // One duration per input id; anything else cannot be mapped.
  if (values.length !== length || values.some((value) => !Number.isFinite(value))) return undefined
  return values
}

/**
 * Turns per-id durations into word timings for one run of text: durations are
 * scaled to the run's real length (`seconds`), so only their proportions
 * matter. When the spoken words line up one to one with the written words
 * that have letters or digits, each is `measured`; otherwise (numbers read
 * out, acronyms) the run is one unit for the voice plugin to spread.
 */
export function wordsFromDurations(run: {
  text: string
  /** Where `text` starts in the provider's text. */
  offset: number
  owners: number[]
  durations: number[]
  /** When the run starts in the audio, and how long it is. */
  start: number
  seconds: number
}): TimedWord[] {
  const total = run.durations.reduce((sum, d) => sum + d, 0)
  if (!(total > 0) || !(run.seconds > 0)) return []
  const spoken: { start: number; end: number }[] = []
  let at = run.start
  run.durations.forEach((duration, i) => {
    const length = (duration / total) * run.seconds
    const owner = run.owners[i] ?? -1
    if (owner >= 0) {
      const word = (spoken[owner] ??= { start: at, end: at })
      word.end = at + length
    }
    at += length
  })
  const written = splitWords(run.text).filter((word) => HAS_LETTERS.test(word.text))
  const timed = spoken.filter(Boolean)
  if (timed.length === written.length && timed.length === spoken.length) {
    return written.map((word, i) => ({
      text: word.text,
      start: timed[i]!.start,
      end: timed[i]!.end,
      from: run.offset + word.from,
      to: run.offset + word.to,
      quality: 'measured',
      source: 'model',
    }))
  }
  if (!timed.length || !written.length) return []
  return [
    {
      text: run.text,
      start: timed[0]!.start,
      end: timed[timed.length - 1]!.end,
      from: run.offset + written[0]!.from,
      to: run.offset + written[written.length - 1]!.to,
      quality: 'estimated',
      source: 'model',
    },
  ]
}

/** Where each chunk of `chunkText(text)` starts in `text`. */
export function chunkOffsets(text: string, chunks: string[]): number[] {
  let cursor = 0
  return chunks.map((chunk) => {
    const found = text.indexOf(chunk, cursor)
    const at = found < 0 ? cursor : found
    cursor = at + chunk.length
    return at
  })
}
