// @vitest-environment jsdom
import { createH4B, type H4B, type Transport } from '@handsforbots/core'
import { waitForIdle } from '@handsforbots/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cookieKey, createLocalStorage, storageLocal, type KeySource } from '../src/index.js'

const echo: Transport = {
  name: 'echo',
  async *run() {
    yield { type: 'message.delta', messageId: 'm', delta: 'ok' }
  },
}

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  document.cookie = 'h4b-key=; Max-Age=0; Path=/'
  document.cookie = '__Host-h4b-key=; Max-Age=0; Path=/; Secure'
  vi.restoreAllMocks()
})

async function say(h4b: H4B, text: string) {
  await h4b.ask(text)
  await waitForIdle(h4b)
}

describe('storage-local security', () => {
  it('discards legacy encrypted format (v2) without surfacing an error', async () => {
    localStorage.setItem(
      'h4b:conversation',
      JSON.stringify({ version: 2, savedAt: Date.now(), iv: 'a', data: 'b' }),
    )
    document.cookie = `h4b-key=${'A'.repeat(43)}; Path=/`
    const h4b = await createH4B({ plugins: [storageLocal()] }).start()
    expect(h4b.messages).toEqual([])
    expect(localStorage.getItem('h4b:conversation')).toBeNull()
  })

  it('discards data when savedAt in the envelope was tampered (AAD mismatch)', async () => {
    const h4b = await createH4B({ plugins: [storageLocal()] }).start()
    await say(h4b, 'secret')
    const raw = JSON.parse(localStorage.getItem('h4b:conversation')!)
    expect(raw.version).toBe(3)
    raw.savedAt += 60_000
    localStorage.setItem('h4b:conversation', JSON.stringify(raw))
    const reload = await createH4B({ plugins: [storageLocal()] }).start()
    expect(reload.messages).toEqual([])
    expect(localStorage.getItem('h4b:conversation')).toBeNull()
  })

  it('treats duplicate key cookies as tampering and drops stored data', async () => {
    const h4b = await createH4B({ plugins: [storageLocal()] }).start()
    await say(h4b, 'x')
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!
    const real = document.cookie.split('; ').find((c) => c.startsWith('h4b-key='))!
    expect(real).toBeDefined()
    vi.spyOn(document, 'cookie', 'get').mockReturnValue(`${real}; h4b-key=planted`)
    vi.spyOn(document, 'cookie', 'set').mockImplementation((value: string) => descriptor.set!.call(document, value))
    const reload = await createH4B({ plugins: [storageLocal()] }).start()
    expect(reload.messages).toEqual([])
  })

  it('emits storage-local error when the key source throws on load', async () => {
    const keySource: KeySource = {
      async get() {
        throw new Error('key broker down')
      },
    }
    localStorage.setItem(
      'h4b:conversation',
      JSON.stringify({
        version: 3,
        savedAt: Date.now(),
        threadId: 't',
        iv: 'AAAAAAAA',
        data: 'BBBBBBBB',
      }),
    )
    const errors: string[] = []
    const h4b = await createH4B({
      plugins: [storageLocal({ keySource })],
      onError: (_error, source) => errors.push(source),
    }).start()
    expect(h4b.messages).toEqual([])
    expect(errors).toContain('storage-local')
    expect(localStorage.getItem('h4b:conversation')).not.toBeNull()
  })

  it('uses __Host-h4b-key on HTTPS pages', async () => {
    const prev = globalThis.location
    Object.defineProperty(globalThis, 'location', { value: { protocol: 'https:' }, configurable: true })
    const writes: string[] = []
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!
    vi.spyOn(document, 'cookie', 'set').mockImplementation(function (this: Document, value: string) {
      writes.push(value)
      descriptor.set!.call(this, value)
    })
    await cookieKey().get(true)
    expect(writes.some((w) => w.startsWith('__Host-h4b-key='))).toBe(true)
    expect(writes.some((w) => /Path=\/;.*Secure/.test(w))).toBe(true)
    Object.defineProperty(globalThis, 'location', { value: prev, configurable: true })
  })

  it('keeps the plain name, with Secure, when a domain is set on HTTPS', async () => {
    const prev = globalThis.location
    Object.defineProperty(globalThis, 'location', { value: { protocol: 'https:' }, configurable: true })
    const writes: string[] = []
    vi.spyOn(document, 'cookie', 'set').mockImplementation((value: string) => {
      writes.push(value)
    })
    await cookieKey({ name: 'h4b-shared', domain: 'example.com' }).get(true)
    expect(writes[0]).toMatch(/^h4b-shared=.*Domain=example\.com.*Secure/)
    Object.defineProperty(globalThis, 'location', { value: prev, configurable: true })
  })
})