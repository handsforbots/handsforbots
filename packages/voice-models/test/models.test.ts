import { describe, expect, it, vi } from 'vitest'
import {
  chunkText,
  espeakPhonemizer,
  fetchJson,
  fetchModel,
  huggingFace,
  kokoroModel,
  kokoroTTS,
  piperIds,
  piperTTS,
  piperVoice,
  sourceUrl,
  transformersProgress,
  transformersTTS,
  type ModelCache,
  type OnnxRuntime,
  type OnnxTensor,
  type Phonemizer,
} from '../src/index.js'

const bytes = (text: string) => new TextEncoder().encode(text)

function memoryCache(): ModelCache & { store: Map<string, { body: Uint8Array; contentType?: string }> } {
  const store = new Map<string, { body: Uint8Array; contentType?: string }>()
  return {
    store,
    match: async (url) => {
      const entry = store.get(url)
      if (!entry) return undefined
      const headers = entry.contentType ? { 'Content-Type': entry.contentType } : undefined
      return new Response(entry.body as BodyInit, { headers })
    },
    put: async (url, response) =>
      void store.set(url, {
        body: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get('Content-Type') ?? undefined,
      }),
    delete: async (url) => void store.delete(url),
  }
}

function fakeFetch(files: Record<string, Uint8Array>) {
  return vi.fn(async (url: string | URL | Request) => {
    const body = files[String(url)]
    if (!body) return new Response(null, { status: 404 })
    const half = Math.ceil(body.length / 2)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.slice(0, half))
        controller.enqueue(body.slice(half))
        controller.close()
      },
    })
    return new Response(stream, { headers: { 'Content-Length': String(body.length) } })
  })
}

function fakeRuntime(output: (feeds: Record<string, OnnxTensor>) => Float32Array, inputs: string[]) {
  const runs: Record<string, OnnxTensor>[] = []
  const created: Uint8Array[] = []
  const ort: OnnxRuntime = {
    Tensor: class {
      constructor(
        public type: string,
        public data: unknown,
        public dims?: readonly number[],
      ) {}
    } as unknown as OnnxRuntime['Tensor'],
    InferenceSession: {
      create: async (model) => {
        created.push(model)
        return {
          inputNames: inputs,
          outputNames: ['output'],
          run: async (feeds) => {
            runs.push(feeds)
            return { output: { data: output(feeds) } }
          },
        }
      },
    },
  }
  return { ort, runs, created }
}

const fakePhonemizer = (): Phonemizer & { calls: [string, string][] } => {
  const calls: [string, string][] = []
  return {
    name: 'fake',
    calls,
    phonemize: async (text, language) => {
      calls.push([text, language])
      return [...text.toLowerCase()]
    },
  }
}

const ints = (tensor: OnnxTensor | undefined) => Array.from(tensor!.data as BigInt64Array, Number)

describe('model sources', () => {
  it('resolves Hugging Face files, Piper voices and Kokoro files', () => {
    expect(sourceUrl(huggingFace('org/repo', 'a/b.onnx', { revision: 'abc' }))).toBe('https://huggingface.co/org/repo/resolve/abc/a/b.onnx')
    expect(sourceUrl(piperVoice('pt_BR-faber-medium').model)).toBe(
      'https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx',
    )
    const kokoro = kokoroModel({ voices: ['pf_dora'], dtype: 'fp16' })
    expect(sourceUrl(kokoro.model)).toMatch(/Kokoro-82M-v1.0-ONNX\/resolve\/main\/onnx\/model_fp16.onnx$/)
    expect(sourceUrl(kokoro.voices.pf_dora!)).toMatch(/voices\/pf_dora.bin$/)
    expect(() => piperVoice('faber')).toThrow(TypeError)
  })

  it('downloads with progress, then serves from the cache', async () => {
    const file = bytes('0123456789')
    const fetch = fakeFetch({ '/models/a.onnx': file })
    const cache = memoryCache()
    const progress = vi.fn()
    expect(await fetchModel('/models/a.onnx', { fetch, cache, onProgress: progress })).toEqual(file)
    expect(progress.mock.calls.map(([p]) => p.loaded)).toEqual([5, 10, 10])
    expect(progress).toHaveBeenLastCalledWith({ loaded: 10, total: 10, file: 'a.onnx' })
    expect(await fetchModel('/models/a.onnx', { fetch, cache })).toEqual(file)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('passes integrator string URLs with percent-encoding unchanged', () => {
    expect(sourceUrl('https://cdn.test/models/pt%20BR/voz.onnx')).toBe('https://cdn.test/models/pt%20BR/voz.onnx')
    expect(sourceUrl('/models/file.onnx?sig=abc%3D')).toBe('/models/file.onnx?sig=abc%3D')
  })

  it('rejects a lone dot path segment', () => {
    expect(() => huggingFace('org/repo', './weights.onnx')).toThrow(TypeError)
    expect(() => huggingFace('org/repo', 'voices/./evil.onnx')).toThrow(TypeError)
  })

  it('rejects unsafe Piper and Kokoro voice ids and encodes path segments', () => {
    expect(() => piperVoice('en_US-x-y/../../../attacker/evil/resolve/main/m')).toThrow(TypeError)
    expect(() => piperVoice('pt_BR-faber-medium/../x')).toThrow()
    expect(() => kokoroModel({ voices: ['pf_dora', 'pf%2e%2e'] })).toThrow()
    expect(() => kokoroModel({ voices: ['constructor'] })).toThrow()
    expect(sourceUrl(huggingFace('org/repo', 'voices/a b.onnx'))).toContain('voices/a%20b.onnx')
  })

  it('verifies sha256 and re-downloads when the cache is poisoned', async () => {
    const file = bytes('verified-model')
    const digest = await crypto.subtle.digest('SHA-256', file)
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const source = huggingFace('org/model', 'weights.onnx', { sha256 })
    const url = sourceUrl(source)!
    const cache = memoryCache()
    cache.store.set(url, { body: bytes('poisoned') })
    const fetch = fakeFetch({ [url]: file })
    expect(await fetchModel(source, { fetch, cache })).toEqual(file)
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(
      fetchModel(huggingFace('org/model', 'weights.onnx', { sha256: 'f'.repeat(64) }), { fetch: fakeFetch({ [url]: file }), cache: false }),
    ).rejects.toThrow(/SHA-256/)
  })

  it('supports sha256 on self-hosted URL sources and fetchModel options', async () => {
    const file = bytes('self-hosted-model')
    const digest = await crypto.subtle.digest('SHA-256', file)
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const url = '/models/pt_BR-faber-medium.onnx'
    expect(sourceUrl({ url, sha256 })).toBe(url)

    const cache = memoryCache()
    cache.store.set(url, { body: bytes('stale-bytes') })
    const fetch = fakeFetch({ [url]: file })
    expect(await fetchModel({ url, sha256 }, { fetch, cache })).toEqual(file)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await fetchModel(url, { fetch, cache, sha256 })).toEqual(file)
    expect(fetch).toHaveBeenCalledTimes(1)

    const badCache = memoryCache()
    await expect(
      fetchModel({ url, sha256: '0'.repeat(64) }, { fetch: fakeFetch({ [url]: file }), cache: badCache }),
    ).rejects.toThrow(/SHA-256/)
    expect(badCache.store.has(url)).toBe(false)
  })

  it('refuses HTML 200 responses without caching and evicts poisoned HTML cache entries', async () => {
    const html = '<!doctype html><html><body>SPA fallback</body></html>'
    const url = '/models/voice.onnx'
    const cache = memoryCache()

    // 1. HTML Content-Type is rejected and never cached.
    const htmlTypeFetch = vi.fn(async () => new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    await expect(fetchModel(url, { fetch: htmlTypeFetch, cache })).rejects.toThrow(/text\/html/)
    expect(cache.store.has(url)).toBe(false)

    // 2. HTML body even with octet-stream Content-Type is rejected and never cached.
    const htmlBodyFetch = vi.fn(async () => new Response(html, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }))
    await expect(fetchModel(url, { fetch: htmlBodyFetch, cache })).rejects.toThrow(/HTML/)
    expect(cache.store.has(url)).toBe(false)

    // 3. Already-cached HTML (by Content-Type or by body) is evicted and re-fetched.
    const real = bytes('real-onnx-bytes')
    const realFetch = fakeFetch({ [url]: real })
    cache.store.set(url, { body: bytes(html), contentType: 'text/html' })
    expect(await fetchModel(url, { fetch: realFetch, cache })).toEqual(real)
    expect(realFetch).toHaveBeenCalledTimes(1)
    expect(cache.store.get(url)?.body).toEqual(real)

    cache.store.set(url, { body: bytes('  <!-- spa -->\n<html><body>x</body></html>'), contentType: 'application/octet-stream' })
    expect(await fetchModel(url, { fetch: realFetch, cache })).toEqual(real)
    expect(realFetch).toHaveBeenCalledTimes(2)
  })

  it('fetchJson validates JSON before caching and evicts poisoned cache entries', async () => {
    const url = '/models/voice.onnx.json'
    const cache = memoryCache()
    const badFetch = fakeFetch({ [url]: bytes('not json at all') })
    await expect(fetchJson(url, { fetch: badFetch, cache })).rejects.toThrow()
    expect(cache.store.has(url)).toBe(false)

    cache.store.set(url, { body: bytes('<html>fallback</html>'), contentType: 'text/html' })
    const goodFetch = fakeFetch({ [url]: bytes('{"ok":true}') })
    expect(await fetchJson<{ ok: boolean }>(url, { fetch: goodFetch, cache })).toEqual({ ok: true })
    expect(goodFetch).toHaveBeenCalledTimes(1)
    expect(cache.store.get(url)?.body).toEqual(bytes('{"ok":true}'))
  })

  it('evicts cached ONNX model when InferenceSession.create fails', async () => {
    const url = '/models/broken.onnx'
    const cache = memoryCache()
    cache.store.set(url, { body: bytes('corrupt-binary') })
    const ort: OnnxRuntime = {
      Tensor: class {} as unknown as OnnxRuntime['Tensor'],
      InferenceSession: {
        create: async () => {
          throw new Error('invalid protobuf')
        },
      },
    }
    const tts = piperTTS({
      model: url,
      config: bytes(JSON.stringify({ audio: { sample_rate: 22050 }, phoneme_id_map: { _: [0], '^': [1], $: [2] } })),
      phonemizer: fakePhonemizer(),
      runtime: ort,
      cache,
    })
    await expect(tts.load!(() => {}, new AbortController().signal)).rejects.toThrow('invalid protobuf')
    expect(cache.store.has(url)).toBe(false)
  })

  it('espeakPhonemizer rejects non-wasm bytes without caching', async () => {
    const cache = memoryCache()
    const wasmUrl = '/vendor/piper_phonemize.wasm'
    const dataUrl = '/vendor/piper_phonemize.data'
    const fetchMock = fakeFetch({ [wasmUrl]: bytes('not-wasm'), [dataUrl]: bytes('data-bytes') })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const phonemizer = espeakPhonemizer({
        module: async () => async () => ({ callMain: () => {} }),
        wasm: wasmUrl,
        data: dataUrl,
        cache,
      })
      await expect(phonemizer.load!(() => {}, new AbortController().signal)).rejects.toThrow(/WebAssembly/)
      expect(cache.store.has(wasmUrl)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('takes bytes the app already has and stops on abort', async () => {
    expect(await fetchModel(bytes('abc').buffer as ArrayBuffer, { cache: false })).toEqual(bytes('abc'))
    expect(await fetchModel(async () => bytes('xy'), { cache: false })).toEqual(bytes('xy'))
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchModel('/a', { fetch: fakeFetch({ '/a': bytes('abcd') }), cache: false, signal: controller.signal }),
    ).rejects.toThrow(/Abort/)
    await expect(fetchModel('/missing', { fetch: fakeFetch({}), cache: false })).rejects.toThrow(/404/)
  })

  it('splits long text by sentences', () => {
    expect(chunkText('One. Two! Three?', 8)).toEqual(['One.', 'Two!', 'Three?'])
    expect(chunkText('One. Two.', 300)).toEqual(['One. Two.'])
  })
})

describe('piperTTS', () => {
  const config = {
    audio: { sample_rate: 22050 },
    espeak: { voice: 'pt-br' },
    inference: { noise_scale: 0.5, length_scale: 1, noise_w: 0.7 },
    phoneme_id_map: { _: [0], '^': [1], $: [2], o: [10], i: [11], ' ': [3] },
    num_speakers: 1,
  }

  it('maps phonemes to ids with padding', () => {
    expect(piperIds(['o', 'i', '?'], config.phoneme_id_map)).toEqual([1, 0, 10, 0, 11, 0, 2])
  })

  it('loads every file with one progress and synthesizes with rate as length_scale', async () => {
    const { ort, runs, created } = fakeRuntime(() => new Float32Array([0.1, 0.2]), ['input', 'input_lengths', 'scales'])
    const runtime = vi.fn(async () => ort)
    const phonemizer = fakePhonemizer()
    const tts = piperTTS({ model: bytes('model'), config: async () => bytes(JSON.stringify(config)), phonemizer, runtime, cache: false })
    expect(runtime).not.toHaveBeenCalled()

    const progress = vi.fn()
    await tts.load!(progress, new AbortController().signal)
    expect(created).toHaveLength(1)
    expect(progress).toHaveBeenCalled()
    expect(tts.config?.audio.sample_rate).toBe(22050)

    const audio = await tts.synthesize!('Oi', { language: 'pt-BR', prosody: { rate: 2 } })
    expect(audio.sampleRate).toBe(22050)
    expect(Array.from(audio.samples)).toEqual([expect.closeTo(0.1), expect.closeTo(0.2)])
    expect(phonemizer.calls).toEqual([['Oi', 'pt-br']])
    expect(ints(runs[0]!.input)).toEqual([1, 0, 10, 0, 11, 0, 2])
    expect(Array.from(runs[0]!.scales!.data as Float32Array)).toEqual([0.5, 0.5, expect.closeTo(0.7)])
    expect(runs[0]!.sid).toBeUndefined()
    await tts.synthesize!('Oi', { language: 'pt-BR' })
    expect(created).toHaveLength(1)
  })

  it('passes the speaker of multi-speaker voices and loads again after a failure', async () => {
    const { ort, runs } = fakeRuntime(() => new Float32Array(1), ['input', 'input_lengths', 'scales', 'sid'])
    const multi = { ...config, num_speakers: 2, speaker_id_map: { ana: 0, bia: 1 } }
    let fail = true
    const tts = piperTTS({
      model: async () => {
        if (fail) throw new Error('offline')
        return bytes('m')
      },
      config: async () => bytes(JSON.stringify(multi)),
      speaker: 'bia',
      phonemizer: fakePhonemizer(),
      runtime: ort,
      cache: false,
    })
    await expect(tts.load!(() => {}, new AbortController().signal)).rejects.toThrow('offline')
    fail = false
    await tts.synthesize!('oi', { language: 'pt-BR' })
    expect(ints(runs[0]!.sid)).toEqual([1])
  })
})

describe('kokoroTTS', () => {
  it('picks the style row by length, passes speed and phonemizes in the voice language', async () => {
    const { ort, runs } = fakeRuntime(() => new Float32Array([0.5]), ['input_ids', 'style', 'speed'])
    const style = new Float32Array(256 * 4).map((_, i) => Math.floor(i / 256))
    const phonemizer = fakePhonemizer()
    const tts = kokoroTTS({
      model: bytes('m'),
      tokenizer: bytes(JSON.stringify({ model: { vocab: { o: 5, i: 6 } } })),
      voices: { pf_dora: new Uint8Array(style.buffer), af_heart: new Uint8Array(style.buffer) },
      phonemizer,
      runtime: ort,
      cache: false,
    })
    expect(tts.voices).toEqual(['pf_dora', 'af_heart'])
    const audio = await tts.synthesize!('oi', { language: 'pt-BR', prosody: { rate: 1.25 } })
    expect(audio.sampleRate).toBe(24000)
    expect(phonemizer.calls[0]).toEqual(['oi', 'pt-br'])
    expect(ints(runs[0]!.input_ids)).toEqual([0, 5, 6, 0])
    expect(Array.from(runs[0]!.style!.data as Float32Array).every((v) => v === 2)).toBe(true)
    expect(Array.from(runs[0]!.speed!.data as Float32Array)).toEqual([1.25])
    await tts.synthesize!('o', { language: 'en-US', voice: 'af_heart' })
    expect(phonemizer.calls[1]).toEqual(['o', 'en-us'])
    await expect(tts.synthesize!('x', { language: 'en-US', voice: 'constructor' })).resolves.toBeDefined()
    expect(phonemizer.calls[2]).toEqual(['x', 'pt-br'])
  })
})

describe('transformersTTS', () => {
  it('adapts a pipeline and sums its per-file progress', async () => {
    const progress = vi.fn()
    const pipeline = vi.fn(async (onProgress: Parameters<typeof transformersProgress>[0]) => {
      const report = transformersProgress(onProgress)
      report({ status: 'progress', file: 'a', loaded: 1, total: 4 })
      report({ status: 'progress', file: 'b', loaded: 2, total: 4 })
      return async (text: string, call?: Record<string, unknown>) => ({
        audio: new Float32Array([text.length, Number(call?.speed)]),
        sampling_rate: 16000,
      })
    })
    const tts = transformersTTS({ name: 'mms', pipeline, call: ({ rate }) => ({ speed: rate ?? 1 }), prosody: { rate: true } })
    await tts.load!(progress, new AbortController().signal)
    expect(progress).toHaveBeenLastCalledWith({ loaded: 3, total: 8, file: 'b' })
    const audio = await tts.synthesize!('abc', { language: 'pt-BR', prosody: { rate: 1.5 } })
    expect(Array.from(audio.samples)).toEqual([3, 1.5])
    expect(audio.sampleRate).toBe(16000)
    expect(pipeline).toHaveBeenCalledTimes(1)
  })
})
