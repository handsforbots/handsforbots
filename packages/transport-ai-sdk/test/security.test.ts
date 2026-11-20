import { createH4B } from '@handsforbots/core'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MAX_EVENT_BYTES } from '../src/bounded.js'
import { aiSdk, createChunkMapper, readUIMessageStream } from '../src/index.js'

describe('AI SDK stream limits', () => {
  it('rejects an unterminated event larger than maxEventBytes', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"text-delta","delta":"' + 'a'.repeat(DEFAULT_MAX_EVENT_BYTES + 1024) + '"}\n'))
        c.close()
      },
    })
    await expect(async () => {
      for await (const _ of readUIMessageStream(body, DEFAULT_MAX_EVENT_BYTES)) {
        /* drain */
      }
    }).rejects.toThrow(/SSE event exceeds/)
  })
})

describe('AI SDK error surface', () => {
  it('maps stream errors to a generic message with code', () => {
    const map = createChunkMapper()
    expect(map({ type: 'error', errorText: 'quota exceeded' })).toEqual([{ type: 'error', message: 'AI SDK stream error' }])
  })

  it('uses a generic HTTP error on route failure', async () => {
    const fetch = vi.fn(async () => new Response('bad gateway detail', { status: 502 }))
    const h4b = await createH4B({ plugins: [aiSdk({ url: '/api/chat', fetch: fetch as never })], onError: () => {} }).start()
    const result = await h4b.ask('x')
    expect(result.status).toMatchObject({ phase: 'error', error: 'AI SDK route error (HTTP 502)' })
  })
})