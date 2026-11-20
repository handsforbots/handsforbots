import { createH4B } from '@handsforbots/core'
import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import { createSSEScanState, DEFAULT_MAX_EVENT_BYTES, drainSSEBlocks } from '../src/bounded.js'
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

  it('feeds a 1 MiB event in 50-byte chunks within a generous budget', () => {
    const chunkBytes = 50
    const payload = 'a'.repeat(1_000_000)
    const state = createSSEScanState()
    const started = performance.now()
    for (let i = 0; i < payload.length; i += chunkBytes) {
      for (const _block of drainSSEBlocks(state, payload.slice(i, i + chunkBytes), DEFAULT_MAX_EVENT_BYTES)) {
        /* residual */
      }
    }
    expect(performance.now() - started).toBeLessThan(400)
  })

  it('counts maxEventBytes in UTF-8 bytes', () => {
    const byteTarget = Math.floor(DEFAULT_MAX_EVENT_BYTES * 2.7)
    const euros = '€'.repeat(Math.ceil(byteTarget / 3))
    const state = createSSEScanState()
    expect(() => {
      for (const _ of drainSSEBlocks(state, euros, DEFAULT_MAX_EVENT_BYTES)) {
        /* drain */
      }
    }).toThrow(/SSE event exceeds/)
  })

  it('still yields parsed UI stream events', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"text-delta","delta":"hi"}\n\n'))
        c.close()
      },
    })
    const events = []
    for await (const event of readUIMessageStream(body, DEFAULT_MAX_EVENT_BYTES)) events.push(event)
    expect(events[0]).toEqual({ type: 'text-delta', delta: 'hi' })
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