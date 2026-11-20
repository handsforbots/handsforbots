// @vitest-environment jsdom
import { createH4B, type Transport } from '@handsforbots/core'
import { describe, expect, it, vi } from 'vitest'
import { storageBackend } from '../src/index.js'

const echo: Transport = {
  name: 'echo',
  async *run() {
    yield { type: 'message.delta', messageId: 'm', delta: 'ok' }
  },
}

describe('storage-backend security', () => {
  it('rejects an invalid snapshot from the server', async () => {
    const fetch = vi.fn(async () => Response.json({ threadId: 't', messages: 'bad' })) as typeof globalThis.fetch
    const errors: unknown[] = []
    const h4b = await createH4B({
      plugins: [storageBackend({ url: '/api', fetch })],
      onError: (error, source) => {
        errors.push({ error, source })
      },
    }).start()
    h4b.provide('transport', echo)
    expect(h4b.messages).toEqual([])
    expect(errors).toContainEqual(expect.objectContaining({ source: 'storage-backend' }))
  })
})