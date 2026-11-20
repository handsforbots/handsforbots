import { execFileSync } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createRegistry, MAX_CHAIN_EFFECTS, MAX_DISPERSION_STAGES_TOTAL, validateChain, voiceEffects } from '../src/chain.js'
import { defineEffect } from '../src/effects.js'
import { posixShellQuote, toFFmpeg } from '../src/ffmpeg.js'
import type { EffectChain } from '../src/types.js'

describe('FFmpeg export hardening', () => {
  it('rejects an invalid chain instead of injecting into the filtergraph', () => {
    const chain = {
      version: 1,
      prosody: { volume: '0,amovie=/etc/passwd' },
      effects: [],
    } as unknown as EffectChain
    expect(() => toFFmpeg(chain)).toThrow(/Invalid effect chain.*prosody\.volume must be a number/)
  })

  it('rejects a custom effect that reuses a built-in type name', () => {
    const evilGain = defineEffect({
      type: 'gain',
      label: 'Evil gain',
      params: { gain: { label: 'Gain', defaultValue: 0, minValue: -40, maxValue: 24 } },
      ffmpeg: () => 'volume=0,amovie=/etc/passwd',
    })
    const registry = createRegistry([evilGain])
    const chain: EffectChain = { version: 1, effects: [{ type: 'gain' }] }
    expect(() => toFFmpeg(chain, { registry })).toThrow(/disallowed characters/)
  })

  it('rejects custom effect filters that carry shell or filtergraph metacharacters', () => {
    const leaky = defineEffect({
      type: 'leaky',
      label: 'Leaky',
      params: {},
      ffmpeg: () => 'volume=0,amovie=/etc/passwd',
    })
    const registry = createRegistry([leaky])
    const chain: EffectChain = { version: 1, effects: [{ type: 'leaky' }] }
    expect(() => toFFmpeg(chain, { registry })).toThrow(/disallowed characters/)
  })

  it('still exports built-in dispersion with FFmpeg metacharacters in one segment', () => {
    const out = toFFmpeg({ version: 1, effects: [{ type: 'dispersion', stages: 4 }] })
    expect(out.filter).toMatch(/asplit\[dry\]/)
  })

  it('exposes execFile argv and quotes paths for POSIX shells', () => {
    const out = toFFmpeg('clean')
    expect(out.args('in.wav', 'out.wav')).toEqual(['-nostdin', '-n', '-i', 'in.wav', '-af', 'anull', 'out.wav'])
    const tricky = `a b'$(id)\`x\`c`
    expect(execFileSync('sh', ['-c', `printf %s ${posixShellQuote(tricky)}`], { encoding: 'utf8' })).toBe(tricky)
    expect(out.command(tricky, 'out.wav')).toBe(`ffmpeg -nostdin -n -i ${posixShellQuote(tricky)} -af 'anull' 'out.wav'`)
  })

  it('rejects input or output paths that look like FFmpeg flags', () => {
    const out = toFFmpeg('clean')
    expect(() => out.args('-y', 'out.wav')).toThrow(/input path must not start with "-"/)
    expect(() => out.args('in.wav', '-f')).toThrow(/output path must not start with "-"/)
    expect(() => out.command('-y', 'out.wav')).toThrow(/input path must not start with "-"/)
  })

  it('rejects protocol-prefixed input and output paths', () => {
    const out = toFFmpeg('clean')
    for (const path of ['concat:list.txt', 'pipe:0', 'http://evil.test/x.wav', 'https://evil.test/x.wav', 'file:-']) {
      expect(() => out.args(path, 'out.wav')).toThrow(/protocol prefix/)
      expect(() => out.args('in.wav', path)).toThrow(/protocol prefix/)
    }
    expect(out.args(String.raw`C:\voice\in.wav`, 'out.wav')[3]).toBe(String.raw`C:\voice\in.wav`)
  })

  it('command() does not run shell expansions under sh -c', () => {
    const marker = `/tmp/hfb-ve-${process.pid}-${Date.now()}`
    try {
      unlinkSync(marker)
    } catch {}
    const out = toFFmpeg('clean')
    const input = `$(touch ${marker})`
    const cmd = out.command(input, 'out.wav')
    try {
      execFileSync('sh', ['-c', `${cmd} >/dev/null 2>&1; exit 0`], { stdio: 'ignore' })
    } catch {
      // ffmpeg may be missing; expansion is what we must prevent
    }
    expect(existsSync(marker)).toBe(false)
  })
})

describe('prosody and atempo guards', () => {
  it('rejects extreme pitch and rate in validateChain', () => {
    expect(validateChain({ version: 1, prosody: { pitch: 20000 }, effects: [] })).toContain(
      'prosody.pitch must be between -24 and 24 semitones',
    )
    expect(validateChain({ version: 1, prosody: { rate: 0 }, effects: [] })).toContain('prosody.rate must be between 0.25 and 4')
  })

  it('rejects chains that would loop atempo forever', () => {
    expect(() => toFFmpeg({ version: 1, prosody: { pitch: 20000 }, effects: [] })).toThrow(/Invalid effect chain/)
  }, 3000)
})

describe('chain size and prototype lookups', () => {
  it(`allows at most ${MAX_CHAIN_EFFECTS} effects`, () => {
    const effects = Array.from({ length: MAX_CHAIN_EFFECTS + 1 }, () => ({ type: 'gain' }))
    expect(validateChain({ version: 1, effects })).toContain(`effects must have at most ${MAX_CHAIN_EFFECTS} items`)
  })

  it('rejects dispersion stages above the total budget', () => {
    const effects = Array.from({ length: 7 }, () => ({ type: 'dispersion', stages: 160 }))
    expect(validateChain({ version: 1, effects })).toContain(
      `dispersion stages total ${160 * 7} exceeds ${MAX_DISPERSION_STAGES_TOTAL}`,
    )
    expect(validateChain({ version: 1, effects: [{ type: 'dispersion', stages: 160 }] })).toEqual([])
  })

  it('does not treat inherited parameter names as effect params', () => {
    expect(validateChain({ version: 1, effects: [{ type: 'gain', constructor: 0 as unknown as number }] })).toContain(
      'effects[0].constructor: "gain" has no such parameter',
    )
  })

  it('rejects unknown preset names via hasOwn, including __proto__', () => {
    expect(() => voiceEffects('__proto__' as 'clean')).toThrow(/Unknown preset "__proto__"/)
  })
})