import { activeEffects, createRegistry, resolveChain, validateChain, type Registry } from './chain.js'
import { builtinEffects } from './effects.js'
import type { PresetName } from './presets.js'
import type { EffectChain } from './types.js'

const builtinDefinitions = new Set(builtinEffects)
const MAX_ATEMPO_SPLITS = 32
const ATEMPO_MIN = 0.5
const ATEMPO_MAX = 100

export type FfmpegOptions = {
  /** Sample rate of the audio the filter will get (pitch and varispeed depend on it). Default 24000. */
  sampleRate?: number
  /** Include the prosody (rate with `atempo`, pitch with `asetrate`, volume). Default true. */
  prosody?: boolean
  registry?: Registry
}

export type FfmpegExport = {
  /** The filtergraph, for `ffmpeg -af "<filter>"`. */
  filter: string
  /** Effects that FFmpeg reproduces only roughly, or not at all (skipped). */
  warnings: string[]
  /**
   * A full command line.
   * @deprecated Use {@link FfmpegExport.args} with `child_process.execFile` (no shell).
   */
  command(input: string, output: string): string
  /** argv for `execFile('ffmpeg', args(input, output))` — no shell. */
  args(input: string, output: string): string[]
}

/** POSIX single-quoted string safe for `sh -c`. */
export function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function finiteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function filterNumber(value: number): string {
  return String(finiteNumber(value, 'filter value'))
}

const unsafeCustomFfmpeg = /[[\];,'"\r\n]/

function assertCustomFfmpegExport(exported: string, label: string): void {
  if (unsafeCustomFfmpeg.test(exported)) {
    throw new Error(`${label}: custom FFmpeg filter contains disallowed characters`)
  }
}

function assertFfmpegPath(path: string, role: 'input' | 'output'): void {
  if (path.startsWith('-')) throw new Error(`FFmpeg ${role} path must not start with "-" (use "./-" if needed)`)
}

/** `atempo` takes 0.5–100 per filter: smaller factors are chained. */
function atempo(factor: number): string[] {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('prosody atempo factor must be a finite number above 0')
  const filters: string[] = []
  let left = factor
  let splits = 0
  while (left < ATEMPO_MIN) {
    if (++splits > MAX_ATEMPO_SPLITS) throw new Error('prosody atempo chain exceeds the maximum number of stages')
    filters.push(`atempo=${ATEMPO_MIN}`)
    left /= ATEMPO_MIN
  }
  if (left > ATEMPO_MAX) throw new Error(`prosody atempo factor ${left} is above ${ATEMPO_MAX}`)
  if (Math.abs(left - 1) > 1e-6) filters.push(`atempo=${filterNumber(Number(left.toFixed(6)))}`)
  return filters
}

/**
 * The chain as an FFmpeg filtergraph, to apply the same voice on the server
 * (pre-generated lines, audio from a cloud TTS). Built-in effects map to
 * FFmpeg's audio filters; where FFmpeg differs, `warnings` says how.
 */
export function toFFmpeg(chain: EffectChain | PresetName, options: FfmpegOptions = {}): FfmpegExport {
  const registry = options.registry ?? createRegistry()
  const resolved = resolveChain(chain)
  const errors = validateChain(resolved, registry)
  if (errors.length) throw new Error(`Invalid effect chain: ${errors.join('; ')}`)

  const sampleRate = finiteNumber(options.sampleRate ?? 24000, 'sampleRate')
  const filters: string[] = []
  const warnings: string[] = []

  const prosody = options.prosody === false ? {} : (resolved.prosody ?? {})
  const pitch = 2 ** ((prosody.pitch ?? 0) / 12)
  if (pitch !== 1) {
    filters.push(`asetrate=${Math.round(sampleRate * pitch)}`, `aresample=${sampleRate}`)
  }
  filters.push(...atempo((prosody.rate ?? 1) / pitch))
  if (prosody.volume) filters.push(`volume=${filterNumber(prosody.volume)}dB`)

  activeEffects(resolved, registry).forEach(({ spec, definition, params }, index) => {
    const label = spec.id ?? `${definition.type} #${index + 1}`
    const exported = definition.ffmpeg?.(params, { sampleRate })
    if (exported === undefined) {
      warnings.push(`${label}: no FFmpeg equivalent, skipped`)
      return
    }
    const piece = typeof exported === 'string' ? exported : exported.filter
    if (!builtinDefinitions.has(definition)) assertCustomFfmpegExport(piece, label)
    filters.push(piece)
    if (typeof exported !== 'string' && exported.approximate) warnings.push(`${label}: ${exported.approximate}`)
  })

  const filter = filters.join(',') || 'anull'
  const argv = (input: string, output: string) => {
    assertFfmpegPath(input, 'input')
    assertFfmpegPath(output, 'output')
    return ['-i', input, '-af', filter, output]
  }
  return {
    filter,
    warnings,
    args: argv,
    command: (input, output) => {
      assertFfmpegPath(input, 'input')
      assertFfmpegPath(output, 'output')
      return `ffmpeg -i ${posixShellQuote(input)} -af ${posixShellQuote(filter)} ${posixShellQuote(output)}`
    },
  }
}