import { describe, expect, it } from 'vitest'
import {
  alignWords,
  cleanTimedWords,
  decodeVttText,
  estimateWords,
  formatVttTime,
  parseVttTime,
  parseWordVtt,
  splitWords,
  toWordVtt,
  voicedSpan,
  MAX_TIMED_WORDS,
} from '../src/index.js'

describe('splitWords', () => {
  it('splits on spaces, keeps punctuation with the word and gives UTF-16 positions', () => {
    const text = ' Olá, mundo!  😀 fim.'
    const words = splitWords(text)
    expect(words.map((w) => w.text)).toEqual(['Olá,', 'mundo!', '😀', 'fim.'])
    for (const word of words) expect(text.slice(word.from, word.to)).toBe(word.text)
  })
})

describe('estimateWords', () => {
  it('spreads the duration by word length, with pauses after punctuation', () => {
    const words = estimateWords('um, tres quatro', { duration: 2 })
    expect(words.map((w) => w.quality)).toEqual(['estimated', 'estimated', 'estimated'])
    expect(words.every((w) => w.source === 'estimate')).toBe(true)
    expect(words[0]!.start).toBe(0)
    expect(words[2]!.end).toBeCloseTo(2)
    // The comma leaves a pause before the next word.
    expect(words[1]!.start).toBeGreaterThan(words[0]!.end)
    // Longer words take longer.
    expect(words[2]!.end - words[2]!.start).toBeGreaterThan(words[0]!.end - words[0]!.start)
  })

  it('stays inside the voiced span of the audio', () => {
    const samples = new Float32Array(1000)
    samples.fill(0.5, 200, 800)
    const voiced = voicedSpan(samples, 1000)
    expect(voiced).toEqual({ start: 0.2, end: 0.8 })
    const words = estimateWords('a b', { duration: 1, voiced })
    expect(words[0]!.start).toBeCloseTo(0.2)
    expect(words[1]!.end).toBeCloseTo(0.8)
  })

  it('treats silence as all voiced and a bad duration as zero', () => {
    expect(voicedSpan(new Float32Array(10), 10)).toEqual({ start: 0, end: 1 })
    expect(estimateWords('a b', { duration: NaN }).every((w) => w.start === 0 && w.end === 0)).toBe(true)
  })
})

describe('alignWords', () => {
  it('maps units with positions onto the written words', () => {
    const words = alignWords('Bom dia, Ana.', [
      { text: 'Bom', start: 0, end: 0.2, from: 0, to: 3 },
      { text: 'dia', start: 0.25, end: 0.5, from: 4, to: 8 },
      { text: 'Ana', start: 0.6, from: 9, to: 13, quality: 'aligned', source: 'asr' },
    ], { duration: 1 })
    expect(words.map((w) => [w.text, w.start, w.end, w.quality, w.source])).toEqual([
      ['Bom', 0, 0.2, 'measured', 'backend'],
      ['dia,', 0.25, 0.5, 'measured', 'backend'],
      ['Ana.', 0.6, 1, 'aligned', 'asr'],
    ])
  })

  it('matches by text and maps normalized speech back to the original (R$ 1.250)', () => {
    const text = 'Custa R$ 1.250 hoje.'
    const words = alignWords(text, [
      { text: 'custa', start: 0, end: 0.3 },
      { text: 'mil', start: 0.3, end: 0.5 },
      { text: 'duzentos', start: 0.5, end: 0.8 },
      { text: 'e', start: 0.8, end: 0.85 },
      { text: 'cinquenta', start: 0.85, end: 1.2 },
      { text: 'reais', start: 1.2, end: 1.5 },
      { text: 'hoje', start: 1.6, end: 1.9 },
    ])
    expect(words.map((w) => w.text)).toEqual(['Custa', 'R$', '1.250', 'hoje.'])
    expect(words[0]).toMatchObject({ start: 0, end: 0.3, quality: 'measured' })
    expect(words[3]).toMatchObject({ start: 1.6, end: 1.9, quality: 'measured' })
    // "R$ 1.250" shares the time of "mil duzentos e cinquenta reais".
    expect(words[1]).toMatchObject({ start: 0.3, quality: 'estimated' })
    expect(words[2]!.end).toBeCloseTo(1.5)
    expect(words[2]!.start).toBeGreaterThanOrEqual(words[1]!.end)
    for (const word of words) expect(text.slice(word.from, word.to)).toBe(word.text)
  })

  it('ignores accents and case, splits multi-word units and fills ends from the next start', () => {
    const words = alignWords('Você está aqui', [
      { text: 'voce esta', start: 0 },
      { text: 'AQUI', start: 1 },
    ], { duration: 1.5 })
    expect(words.map((w) => w.quality)).toEqual(['estimated', 'estimated', 'measured'])
    expect(words[1]!.end).toBeCloseTo(1)
    expect(words[2]).toMatchObject({ start: 1, end: 1.5 })
  })

  it('interpolates words nothing covers and keeps times monotonic', () => {
    const words = alignWords('a — b', [
      { text: 'b', start: 0.2, end: 0.4 },
      { text: 'a', start: 0.5, end: 0.6 },
    ])
    for (let i = 1; i < words.length; i++) expect(words[i]!.start).toBeGreaterThanOrEqual(words[i - 1]!.start)
    expect(words[1]!.quality).toBe('estimated')
  })

  it('estimates when there are no usable units', () => {
    expect(alignWords('um dois', [{ text: 'x', start: -1 }] as never, { duration: 1 }).every((w) => w.source === 'estimate')).toBe(
      true,
    )
  })
})

describe('cleanTimedWords', () => {
  it('drops malformed units and caps the count', () => {
    const input = [
      { text: 'ok', start: 0.1, end: 0.2, from: 0, to: 2, quality: 'bogus', source: 'nope' },
      { text: 5, start: 0 },
      { text: 'neg', start: -1 },
      { text: 'inf', start: Infinity },
      null,
      { text: 'bad-range', start: 0.3, end: 0.1, from: 3, to: 1 },
    ]
    const clean = cleanTimedWords(input, { quality: 'measured', source: 'backend' })
    expect(clean).toEqual([
      { text: 'ok', start: 0.1, end: 0.2, from: 0, to: 2, quality: 'measured', source: 'backend' },
      { text: 'bad-range', start: 0.3, quality: 'measured', source: 'backend' },
    ])
    const many = Array.from({ length: MAX_TIMED_WORDS + 5 }, (_, i) => ({ text: 'w', start: i }))
    expect(cleanTimedWords(many, { quality: 'measured', source: 'backend' })).toHaveLength(MAX_TIMED_WORDS)
    expect(cleanTimedWords('nope', { quality: 'measured', source: 'backend' })).toEqual([])
  })
})

describe('WebVTT with inline word timestamps', () => {
  it('reads times, decodes entities, drops tags and keeps words between two timestamps as one unit', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE made by the backend',
      '',
      '1',
      '00:00:01.000 --> 00:00:03.000 align:start',
      'Tom &amp; <00:00:01.500><c>Jerry</c> <00:00:02.000>dizem &lt;oi&gt; &#233; <00:00:02.600>tchau',
      '',
      '00:03.000 --> 00:04.000',
      '<v Bot>Fim',
    ].join('\r\n')
    expect(parseWordVtt(vtt)).toEqual([
      { text: 'Tom &', start: 1, end: 1.5 },
      { text: 'Jerry', start: 1.5, end: 2 },
      { text: 'dizem <oi> é', start: 2, end: 2.6 },
      { text: 'tchau', start: 2.6, end: 3 },
      { text: 'Fim', start: 3, end: 4 },
    ])
  })

  it('skips cues with malformed timings', () => {
    expect(parseWordVtt('WEBVTT\n\n00:00:xx --> 00:00:01.000\noi')).toEqual([])
    expect(parseVttTime('1:00.000')).toBeUndefined()
    expect(parseVttTime('01:02:03.004')).toBeCloseTo(3723.004)
  })

  it('round-trips word timings', () => {
    const words = [
      { text: 'A&B', start: 0, end: 0.4 },
      { text: '<x>', start: 0.5, end: 1.25 },
    ]
    const vtt = toWordVtt(words)
    expect(vtt).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:01.250\nA&amp;B <00:00:00.500>&lt;x&gt;\n')
    expect(parseWordVtt(vtt)).toEqual([
      { text: 'A&B', start: 0, end: 0.5 },
      { text: '<x>', start: 0.5, end: 1.25 },
    ])
    expect(formatVttTime(3723.004)).toBe('01:02:03.004')
    expect(decodeVttText('&#x1F600; &unknown; &#0;')).toBe('😀 &unknown; &#0;')
  })
})
