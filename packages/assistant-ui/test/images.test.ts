// @vitest-environment jsdom
import type { Message } from '@handsforbots/core'
import { describe, expect, it, vi } from 'vitest'
import { toThreadMessages } from '../src/index.js'
import { safeImageUrl, safeRasterMime } from '../src/images.js'

describe('assistant-ui images', () => {
  it('rejects non-raster base64 and dangerous mime types', () => {
    expect(safeRasterMime('image/svg+xml')).toBe(false)
    expect(safeRasterMime('text/html;charset=utf-8')).toBe(false)
    const thread = toThreadMessages([
      {
        id: 'a',
        role: 'assistant',
        createdAt: 1,
        parts: [
          { type: 'image', mimeType: 'image/svg+xml', source: { kind: 'base64', data: 'PHN2Zz4=' } },
          { type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: 'iVBORw0KGgo=' } },
        ],
      } satisfies Message,
    ])
    const content = thread[0]!.content
    const parts = Array.isArray(content) ? content : []
    const images = parts.filter((p): p is { type: 'image'; image: string } => p.type === 'image').map((p) => p.image)
    expect(images).toHaveLength(1)
    expect(images[0]).toMatch(/^data:image\/png;base64,/)
  })

  it('revokes blob URLs when the collector clears them', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    const created: string[] = []
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    toThreadMessages(
      [
        {
          id: 'u',
          role: 'user',
          modality: 'image',
          source: 'host',
          createdAt: 1,
          parts: [{ type: 'image', mimeType: 'image/png', source: { kind: 'blob', blob } }],
        } satisfies Message,
      ],
      { onBlobUrl: (url) => created.push(url) },
    )
    for (const url of created) URL.revokeObjectURL(url)
    expect(revoke).toHaveBeenCalled()
    revoke.mockRestore()
  })

  it('safeImageUrl matches widget rules', () => {
    expect(safeImageUrl('https://ok.test/x.png')).toBe(true)
    expect(safeImageUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
  })
})