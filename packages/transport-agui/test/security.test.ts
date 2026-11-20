import { createH4B } from '@handsforbots/core'
import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MAX_EVENT_BYTES, drainSSEBlocks, createSSEScanState } from '../src/bounded.js'
import { agui, createEventMapper, postSSE } from '../src/index.js'

const encoder = new TextEncoder()

describe('AG-UI SSE limits', () => {
  it('fails when an event never terminates within maxEventBytes', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode('data: ' + 'z'.repeat(DEFAULT_MAX_EVENT_BYTES + 4096)))
              c.close()
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
    )
    const events = []
    await expect(async () => {
      for await (const event of postSSE('http://x', {} as never, {}, new AbortController().signal, fetch as never, DEFAULT_MAX_EVENT_BYTES)) {
        events.push(event)
      }
    }).rejects.toThrow(/SSE event exceeds/)
  })

  it('parses many events without rescanning the whole buffer each chunk', () => {
    const chunk = 'data: {"type":"RUN_STARTED"}\n\n'.repeat(200)
    const state = createSSEScanState()
    const started = performance.now()
    let n = 0
    for (const block of drainSSEBlocks(state, chunk, DEFAULT_MAX_EVENT_BYTES)) {
      if (block.includes('RUN_STARTED')) n++
    }
    expect(n).toBe(200)
    expect(performance.now() - started).toBeLessThan(200)
  })

  it('feeds a 1 MiB event in 50-byte chunks within a generous budget', () => {
    const chunkBytes = 50
    const totalBytes = 1_000_000
    const payload = 'z'.repeat(totalBytes)
    const state = createSSEScanState()
    const started = performance.now()
    for (let i = 0; i < payload.length; i += chunkBytes) {
      for (const _block of drainSSEBlocks(state, payload.slice(i, i + chunkBytes), DEFAULT_MAX_EVENT_BYTES)) {
        /* one residual event */
      }
    }
    expect(state.buffer.length).toBeGreaterThan(0)
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
})

describe('AG-UI error surface', () => {
  it('maps RUN_ERROR to a generic turn message and keeps only real codes', () => {
    const map = createEventMapper()
    expect(map({ type: 'RUN_ERROR', message: 'database exploded' } as never)).toEqual([{ type: 'error', message: 'Agent run failed' }])
    expect(map({ type: 'RUN_ERROR', message: 'database exploded', code: 'E_DB' } as never)).toEqual([
      { type: 'error', message: 'Agent run failed', code: 'E_DB' },
    ])
  })

  it('uses a generic HTTP failure message', async () => {
    const fetch = vi.fn(async () => new Response('down', { status: 503 }))
    const h4b = await createH4B({ plugins: [agui({ url: 'http://agui/run', fetch: fetch as never })], onError: () => {} }).start()
    const result = await h4b.ask('x')
    expect(result.status).toMatchObject({ phase: 'error', error: 'Agent request failed (HTTP 503)' })
  })
})