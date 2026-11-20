import { createH4B } from '@handsforbots/core'
import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import { createSSEScanState, DEFAULT_MAX_EVENT_BYTES, drainSSEBlocks, findSSEBoundary } from '../src/bounded.js'
import { createHttpTransport, http, parseResponse } from '../src/index.js'
import { isLoopbackHost } from '../src/host.js'

const sseBody = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })

describe('SSE scanning limits', () => {
  it('fails a turn when a stream has no event separator beyond maxEventBytes', async () => {
    const over = DEFAULT_MAX_EVENT_BYTES + 32_768
    const transport = createHttpTransport({
      url: 'https://api/x',
      maxEventBytes: DEFAULT_MAX_EVENT_BYTES,
      fetch: vi.fn(async () => new Response(sseBody(['data: ' + 'x'.repeat(over)]), { headers: { 'Content-Type': 'text/event-stream' } })),
    })
    await expect(collect(transport, 'hi')).rejects.toThrow(/SSE event exceeds/)
  })

  it('scans many separated events in roughly linear time', () => {
    const events = 400
    const payload = 'data: ' + JSON.stringify({ text: 'x' }) + '\n\n'
    const blob = payload.repeat(events)
    const start = performance.now()
    const state = createSSEScanState()
    let count = 0
    for (const block of drainSSEBlocks(state, blob, DEFAULT_MAX_EVENT_BYTES)) {
      if (block.startsWith('data:')) count++
    }
    const elapsed = performance.now() - start
    expect(count).toBe(events)
    expect(elapsed).toBeLessThan(250)
    const scanFrom = Math.max(0, 'data: z\n\n'.repeat(3).length - 3)
    expect(findSSEBoundary('data: z\n\n'.repeat(3), scanFrom)).toBeGreaterThanOrEqual(0)
  })

  it('feeds a 1 MiB event in 50-byte chunks within a generous budget', () => {
    const chunkBytes = 50
    const totalBytes = 1_000_000
    const payload = 'x'.repeat(totalBytes)
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

  it('counts maxEventBytes in UTF-8 bytes, not UTF-16 length', () => {
    const byteTarget = Math.floor(DEFAULT_MAX_EVENT_BYTES * 2.7)
    const euros = '€'.repeat(Math.ceil(byteTarget / 3))
    const state = createSSEScanState()
    expect(() => {
      for (const _ of drainSSEBlocks(state, euros, DEFAULT_MAX_EVENT_BYTES)) {
        /* drain */
      }
    }).toThrow(/SSE event exceeds/)
  })

  it('still parses separated events when chunked', () => {
    const state = createSSEScanState()
    const parts = ['data: {"text":"a"}\n\n', 'data: {"text":"b"}\n\n']
    const blocks: string[] = []
    for (const part of parts) {
      for (const block of drainSSEBlocks(state, part, DEFAULT_MAX_EVENT_BYTES)) blocks.push(block)
    }
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toContain('"a"')
    expect(blocks[1]).toContain('"b"')
  })

  it('drains one large chunk with 200k small events within a generous budget', () => {
    const events = 200_000
    const blob = 'data: {}\n\n'.repeat(events)
    expect(blob.length).toBeGreaterThan(1_000_000)
    const started = performance.now()
    const state = createSSEScanState()
    let count = 0
    for (const _block of drainSSEBlocks(state, blob, DEFAULT_MAX_EVENT_BYTES)) count++
    expect(count).toBe(events)
    expect(performance.now() - started).toBeLessThan(1500)
  })
})

describe('session id and loopback host', () => {
  it('rejects an invalid session id, reports it and still completes the turn', async () => {
    const issues: unknown[] = []
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/s')
        ? new Response(JSON.stringify({ session_id: 'evil\r\nHeader: x' }), { headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({ response: 'ok' }), { headers: { 'Content-Type': 'application/json' } }),
    )
    const h4b = await createH4B({
      threadId: 'T1',
      plugins: [http({ url: '/t', session: { url: '/s' }, onSessionIssue: (e) => issues.push(e), fetch: fetch as never })],
    }).start()
    const result = await h4b.ask('oi')
    expect(result.status.phase).toBe('done')
    expect(issues).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>
    const turnHeaders = calls[1]![1].headers as Record<string, string>
    expect(turnHeaders['X-Session-ID']).toBe('T1')
    await h4b.ask('de novo')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('does not treat localhost.evil.com as loopback for the API key warning', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost.evil.com')).toBe(false)
  })

})

describe('error surface', () => {
  it('omits free-text backend errors from stimulus code', () => {
    expect(parseResponse({ error: { message: 'secret upstream' } })).toEqual([{ type: 'error', message: 'Backend error' }])
    expect(parseResponse({ error: { message: 'secret', code: 'E_UPSTREAM' } })).toEqual([
      { type: 'error', message: 'Backend error', code: 'E_UPSTREAM' },
    ])
  })

  it('uses a generic HTTP message on failure', async () => {
    const fetch = vi.fn(async () => new Response('internal detail', { status: 500 }))
    const h4b = await createH4B({ plugins: [http({ url: '/t', fetch: fetch as never })], onError: () => {} }).start()
    const result = await h4b.ask('x')
    expect(result.status).toMatchObject({ phase: 'error', error: 'Backend error (HTTP 500)' })
  })
})

async function collect(transport: ReturnType<typeof createHttpTransport>, text: string) {
  const request = {
    threadId: 't',
    turnId: 'turn',
    messages: [{ id: 'm', role: 'user' as const, parts: [{ type: 'text' as const, text }], modality: 'text' as const, source: 'x', createdAt: 0 }],
    context: [],
    actions: [],
    state: {},
  }
  const out = []
  for await (const s of transport.run(request, new AbortController().signal)) out.push(s)
  return out
}