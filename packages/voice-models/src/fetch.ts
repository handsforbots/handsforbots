import type { LoadProgress } from '@handsforbots/voice'

/** A file on the Hugging Face Hub (`https://huggingface.co/<repo>/resolve/<revision>/<file>`). */
export type HuggingFaceFile = {
  huggingFace: string
  file: string
  /** Branch, tag or commit. Pin a commit in production. Default 'main'. */
  revision?: string
  /** A mirror of the Hub. Default 'https://huggingface.co'. */
  endpoint?: string
  /** Expected SHA-256 digest (lowercase hex). When set, bytes from the network and cache are verified. */
  sha256?: string
}

const HF_REPO = /^[\w.-]+\/[\w.-]+$/
const UNSAFE_PATH = /(?:^|\/)\.\.(?:\/|$)|(?:^|\/)\.(?:\/|$)|\\|%2e%2e/i

export function assertSafeModelPath(path: string, label: string): void {
  if (UNSAFE_PATH.test(path) || path.includes('..') || path.includes('\\') || path.includes('%')) {
    throw new TypeError(`Unsafe ${label}: "${path}"`)
  }
}

export function assertHuggingFaceRepo(repo: string): void {
  assertSafeModelPath(repo, 'Hugging Face repo')
  if (!HF_REPO.test(repo)) throw new TypeError(`Invalid Hugging Face repo: "${repo}"`)
}

function encodePathSegments(path: string): string {
  assertSafeModelPath(path, 'model path')
  return path.split('/').map(encodeURIComponent).join('/')
}

function expectedSha256(source: ModelSource): string | undefined {
  if (typeof source === 'object' && source !== null && 'huggingFace' in source && source.sha256) {
    return source.sha256.toLowerCase()
  }
  return undefined
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function verifyDigest(bytes: Uint8Array, expected: string | undefined, where: string): Promise<void> {
  if (!expected) return
  const actual = await sha256Hex(bytes)
  if (actual !== expected) throw new Error(`${where}: SHA-256 mismatch (expected ${expected}, got ${actual})`)
}

/**
 * Where a model file comes from: a URL (absolute, or relative to the page:
 * a folder your server serves), a Hugging Face file, bytes the app already
 * has (a file the user picked, one kept in OPFS), or a function returning any
 * of those.
 */
export type ModelSource =
  | string
  | HuggingFaceFile
  | Blob
  | ArrayBuffer
  | Uint8Array
  | (() => Promise<ArrayBuffer | Uint8Array | Blob | Response>)

export const huggingFace = (
  repo: string,
  file: string,
  options: { revision?: string; endpoint?: string; sha256?: string } = {},
): HuggingFaceFile => {
  assertHuggingFaceRepo(repo)
  assertSafeModelPath(file, 'Hugging Face file')
  return {
    huggingFace: repo,
    file,
    ...options,
    sha256: options.sha256?.toLowerCase(),
  }
}

/** The URL a source downloads from, if it is downloaded at all. */
export function sourceUrl(source: ModelSource): string | undefined {
  if (typeof source === 'string') return source
  if (typeof source === 'object' && source !== null && 'huggingFace' in source) {
    assertHuggingFaceRepo(source.huggingFace)
    assertSafeModelPath(source.file, 'Hugging Face file')
    const revision = source.revision ?? 'main'
    assertSafeModelPath(revision, 'Hugging Face revision')
    const endpoint = (source.endpoint ?? 'https://huggingface.co').replace(/\/$/, '')
    return `${endpoint}/${source.huggingFace}/resolve/${encodeURIComponent(revision)}/${encodePathSegments(source.file)}`
  }
  return undefined
}

/** Where downloaded files are kept between visits. */
export type ModelCache = {
  match(url: string): Promise<Response | undefined>
  put(url: string, response: Response): Promise<void>
  delete?(url: string): Promise<void>
}

/** The browser's Cache Storage (what transformers.js also uses). Default name 'h4b-voice-models'. */
export function cacheStorage(name = 'h4b-voice-models'): ModelCache {
  const open = () => caches.open(name)
  return {
    match: async (url) => (await open()).match(url),
    put: async (url, response) => (await open()).put(url, response),
    delete: async (url) => void (await (await open()).delete(url)),
  }
}

/** Erases every model kept by `cacheStorage(name)`. */
export const clearModelCache = (name = 'h4b-voice-models') =>
  typeof caches === 'undefined' ? Promise.resolve(false) : caches.delete(name)

export type FetchModelOptions = {
  onProgress?: (progress: LoadProgress) => void
  signal?: AbortSignal
  /** `undefined`: Cache Storage when the browser has it. `false`: no cache. */
  cache?: ModelCache | false
  fetch?: typeof fetch
}

export const defaultCache = (cache: ModelCache | false | undefined): ModelCache | undefined =>
  cache === false ? undefined : (cache ?? (typeof caches !== 'undefined' ? cacheStorage() : undefined))

async function readBody(response: Response, file: string, options: FetchModelOptions): Promise<Uint8Array> {
  const length = Number(response.headers.get('Content-Length')) || undefined
  // A compressed transfer reports the compressed size while the body arrives decompressed.
  let total = response.headers.get('Content-Encoding') ? undefined : length
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    options.onProgress?.({ loaded: bytes.length, total: bytes.length, file })
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    if (options.signal?.aborted) {
      await reader.cancel()
      throw new DOMException('Aborted', 'AbortError')
    }
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    if (total !== undefined && loaded > total) total = undefined
    options.onProgress?.({ loaded, total, file })
  }
  const bytes = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  options.onProgress?.({ loaded, total: loaded, file })
  return bytes
}

const toBytes = async (value: ArrayBuffer | Uint8Array | Blob): Promise<Uint8Array> =>
  value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(await value.arrayBuffer())

/** Downloads a model file with progress, from the cache when it is there. */
export async function fetchModel(source: ModelSource, options: FetchModelOptions = {}): Promise<Uint8Array> {
  const digest = expectedSha256(source)
  const url = sourceUrl(source)
  if (url === undefined) {
    const value = typeof source === 'function' ? await source() : (source as ArrayBuffer | Uint8Array | Blob)
    const bytes = value instanceof Response ? await readBody(value, 'file', options) : await toBytes(value)
    await verifyDigest(bytes, digest, 'model')
    options.onProgress?.({ loaded: bytes.length, total: bytes.length, file: 'file' })
    return bytes
  }
  const file = decodeURIComponent(url.split('/').pop() ?? url)
  const cache = defaultCache(options.cache)
  const cached = await cache?.match(url).catch(() => undefined)
  if (cached) {
    const bytes = await readBody(cached, file, options)
    try {
      await verifyDigest(bytes, digest, url)
      return bytes
    } catch (error) {
      await cache?.delete?.(url).catch(() => {})
      if (!digest) throw error
    }
  }
  const response = await (options.fetch ?? fetch)(url, { signal: options.signal })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const bytes = await readBody(response, file, options)
  await verifyDigest(bytes, digest, url)
  if (cache) {
    const headers = { 'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream', 'Content-Length': String(bytes.length) }
    await cache.put(url, new Response(bytes as BodyInit, { headers })).catch(() => {})
  }
  return bytes
}

export const fetchJson = async <T>(source: ModelSource, options: FetchModelOptions = {}): Promise<T> =>
  JSON.parse(new TextDecoder().decode(await fetchModel(source, options))) as T

/**
 * Progress of several files as one: `loaded` adds up, `total` is the given
 * size or the sum of the sizes known so far.
 */
export function progressOf(onProgress: (progress: LoadProgress) => void, size?: number) {
  const files = new Map<string, LoadProgress>()
  return (key: string) => (progress: LoadProgress) => {
    files.set(key, progress)
    let loaded = 0
    let known = 0
    for (const p of files.values()) {
      loaded += p.loaded
      known += p.total ?? p.loaded
    }
    onProgress({ loaded, total: size ?? known, file: progress.file })
  }
}
