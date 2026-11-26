// @vitest-environment jsdom
// XSS review (ROADMAP section 3): every surface of the widget that turns
// backend or user content into DOM is fed known payloads, and the resulting
// DOM may only contain the tags, attributes and URL schemes the widget makes.
import { createH4B, type Message, type Transport } from '@handsforbots/core'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { PAYLOADS } from './payloads.js'
import { RENDERERS, renderCitedText, renderMarkdown, safeImageUrl, widget } from '../src/index.js'

const MARKDOWN_TAGS = new Set(['P', 'BR', 'STRONG', 'EM', 'CODE', 'A', 'UL', 'OL', 'LI'])
const CITED_TAGS = new Set([...MARKDOWN_TAGS, 'SUP', 'BUTTON'])
const URL_ATTRIBUTES = ['href', 'src', 'action', 'formaction', 'xlink:href', 'srcdoc', 'srcset', 'poster', 'background']

/** The scheme a browser would use for this URL: it ignores ASCII whitespace and control characters. */
function schemeOf(url: string): string {
  const compact = url.replace(/[\u0000-\u0020]/g, '').toLowerCase()
  return /^([a-z][a-z0-9+.-]*):/.exec(compact)?.[1] ?? ''
}

/**
 * Throws when a tree has an element outside `tags`, an event handler, or a URL
 * attribute with a scheme other than http(s), mailto, tel (or data:image on <img>).
 */
export function assertSafeTree(root: ParentNode, tags?: Set<string>) {
  for (const element of root.querySelectorAll('*')) {
    if (tags) expect(tags.has(element.tagName), `unexpected <${element.tagName.toLowerCase()}>`).toBe(true)
    expect(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'STYLE', 'BASE', 'META', 'LINK'].includes(element.tagName) && !element.closest('[data-h4b-trusted]')).toBe(false)
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase()
      expect(name.startsWith('on'), `event handler ${name} on <${element.tagName.toLowerCase()}>`).toBe(false)
      expect(name === 'style', `style attribute on <${element.tagName.toLowerCase()}>`).toBe(false)
      if (!URL_ATTRIBUTES.includes(name)) continue
      expect(name === 'srcdoc' || name === 'srcset', `${name} on <${element.tagName.toLowerCase()}>`).toBe(false)
      const scheme = schemeOf(attribute.value)
      const imageData = element.tagName === 'IMG' && name === 'src' && /^data:image\/(png|jpe?g|gif|webp|avif);/i.test(attribute.value)
      expect(
        ['', 'http', 'https', 'mailto', 'tel', 'blob'].includes(scheme) || imageData,
        `${name}="${attribute.value}" on <${element.tagName.toLowerCase()}>`,
      ).toBe(true)
    }
  }
}

function parse(html: string) {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content
}

const live: { stop: () => Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(live.splice(0).map((h4b) => h4b.stop()))
  document.body.innerHTML = ''
})

const flushWidget = () =>
  new Promise<void>((resolve) => {
    const done = () => resolve()
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(done))
    else queueMicrotask(done)
  })

async function chat(events: unknown[], options = {}) {
  const transport: Transport = {
    name: 'payloads',
    async *run() {
      yield* events as any[]
    },
  }
  const h4b = createH4B({ plugins: [widget({ pace: 0, startOpen: true, ...options })] })
  h4b.provide('transport', transport)
  await h4b.start()
  live.push(h4b)
  return { h4b, root: document.querySelector('h4b-chat')!.shadowRoot! }
}

describe('XSS: renderMarkdown', () => {
  it.each(PAYLOADS)('makes only its own tags and safe links from %j', (payload) => {
    assertSafeTree(parse(renderMarkdown(payload)), MARKDOWN_TAGS)
  })

  it('keeps the payload text visible instead of dropping it', () => {
    expect(parse(renderMarkdown('<script>alert(1)</script>')).textContent).toBe('<script>alert(1)</script>')
  })
})

describe('XSS: renderMarkdown properties', () => {
  // Pieces of Markdown and HTML syntax, so random strings hit the regexes' edges.
  const piece = fc.oneof(
    fc.constantFrom(
      '[', ']', '(', ')', '*', '**', '`', '- ', '1. ', '\n', '\n\n', ' ', '<', '>', '"', "'", '&', '#', ';', ':', '/', '\\',
      '&#106;', '&quot;', '&lt;', 'javascript:', 'JaVaScRiPt:', 'data:text/html,', 'vbscript:', 'https://a.test', 'mailto:x', '//x',
      '<script>', '</script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', ' onmouseover=alert(1) ', 'href=', '\u0000', '\t',
      '\uE000', '\uE001',
    ),
    fc.string({ maxLength: 4 }),
  )
  // Well-formed links too, with hrefs made of the same pieces (a link needs `[..](..)` with no spaces).
  const link = fc
    .tuple(fc.array(piece, { maxLength: 3 }), fc.array(piece, { minLength: 1, maxLength: 5 }))
    .map(([label, href]) => `[${label.join('') || 'x'}](${href.join('').replace(/[\s)]/g, '')})`)
  const markdown = fc.array(fc.oneof(piece, link), { maxLength: 40 }).map((pieces) => pieces.join(''))

  it('only ever makes its own tags, no handlers and only safe links', () => {
    fc.assert(
      fc.property(markdown, (text) => {
        assertSafeTree(parse(renderMarkdown(text)), MARKDOWN_TAGS)
      }),
      { numRuns: 3000 },
    )
  })

  it('shows every character of the text that is not Markdown syntax', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }).filter((t) => !/[*`\[\]\n]/.test(t) && !/^\s*(?:[-*]|\d+[.)]) /.test(t)), (text) => {
        expect(parse(renderMarkdown(text)).textContent).toBe(text)
      }),
      { numRuns: 1000 },
    )
  })

  it('never accepts an image URL whose scheme is not http(s), blob or raster data', () => {
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 10 }).map((p) => p.join('')), (src) => {
        if (!safeImageUrl(src)) return
        const scheme = schemeOf(src)
        expect(['', 'http', 'https', 'blob'].includes(scheme) || /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,/i.test(src)).toBe(true)
      }),
      { numRuns: 3000 },
    )
  })
})

describe('XSS: renderCitedText', () => {
  const cited = (text: string, source: Record<string, unknown>): Message =>
    ({
      id: 'm"><img src=x onerror=alert(1)>',
      role: 'assistant',
      createdAt: 0,
      parts: [
        { type: 'text', text, citations: [{ start: 0, end: Math.min(3, text.length), sourceIds: [source.id] }] },
        { type: 'source', ...source },
      ],
    }) as Message

  const hostileSources = [
    { id: 's1', title: '"><img src=x onerror=alert(1)>', url: 'javascript:alert(1)' },
    { id: '"><svg onload=alert(1)>', title: 't', url: 'https://ok.test/"onmouseover="alert(1)' },
    { id: 's3', title: 't', url: 'data:text/html,<script>alert(1)</script>' },
    { id: 's4', title: 't', url: '//evil.test/x' },
    { id: 's5', title: 't', url: ' \tjavascript:alert(1)' },
  ]

  it.each(PAYLOADS)('escapes text and references around %j', (payload) => {
    for (const source of hostileSources) assertSafeTree(parse(renderCitedText(cited(payload, source))), CITED_TAGS)
  })

  it('escapes them with a click action configured too', () => {
    for (const source of hostileSources) assertSafeTree(parse(renderCitedText(cited('abc', source), { action: 'open' })), CITED_TAGS)
  })
})

describe('XSS: built-in gallery', () => {
  const hostileImages = [
    'javascript:alert(1)',
    ' javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'vbscript:x',
    '"><img src=x onerror=alert(1)>',
    { src: 'https://ok.test/a.png', alt: '"><img src=x onerror=alert(1)>', caption: '<script>alert(1)</script>' },
  ]

  it('drops unsafe image URLs and escapes titles, alts and texts', () => {
    const element = RENDERERS.gallery!({ title: '<img src=x onerror=alert(1)>', images: hostileImages, texts: PAYLOADS }, { h4b: undefined as any })
    assertSafeTree(element, new Set(['FIGCAPTION', 'DIV', 'A', 'IMG', ...MARKDOWN_TAGS]))
    expect(element.querySelector('figcaption')!.textContent).toBe('<img src=x onerror=alert(1)>')
    expect([...element.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual(['https://ok.test/a.png'])
  })

  it('never links an image to a data: URL', () => {
    const element = RENDERERS.gallery!({ images: ['data:image/png;base64,iVBORw0KGgo='] }, { h4b: undefined as any })
    expect(element.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(element.querySelector('a')).toBeNull()
  })
})

describe('XSS: messages in <h4b-chat>', () => {
  it.each(PAYLOADS)('renders assistant text, sources and tool cards safely for %j', async (payload) => {
    const { h4b, root } = await chat([
      { type: 'message.delta', messageId: 'a', delta: payload },
      { type: 'message.part', messageId: 'a', part: { type: 'source', id: 'c1', title: payload, url: 'javascript:alert(1)', trail: [payload], excerpt: payload } },
      { type: 'message.citations', messageId: 'a', citations: [{ start: 0, end: 1, sourceIds: ['c1'] }] },
    ])
    await h4b.ask(payload)
    await flushWidget()
    await h4b.runAction('missing', { payload })
    await flushWidget()
    assertSafeTree(root.querySelector('.log')!)
    expect(root.querySelector('.msg.user')!.textContent).toBe(payload)
  })

  it('keeps only safe image URLs in image parts', async () => {
    const image = (url: string, mimeType = 'image/png') => ({ type: 'image', mimeType, source: { kind: 'url', url } })
    const { h4b, root } = await chat([
      { type: 'message.delta', messageId: 'a', delta: 'imgs' },
      { type: 'message.part', messageId: 'a', part: image('javascript:alert(1)') },
      { type: 'message.part', messageId: 'a', part: image('data:text/html,<script>alert(1)</script>') },
      { type: 'message.part', messageId: 'a', part: image('https://ok.test/a.png') },
      { type: 'message.part', messageId: 'a', part: { type: 'image', mimeType: 'text/html', source: { kind: 'base64', data: 'PHNjcmlwdD4=' } } },
      { type: 'message.part', messageId: 'a', part: { type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: '"><x' } } },
    ])
    await h4b.ask('imgs')
    await flushWidget()
    const sources = [...root.querySelectorAll('.msg.assistant img')].map((img) => img.getAttribute('src'))
    expect(sources).toEqual(['https://ok.test/a.png'])
  })

  it('looks up renderers by own name only, never from Object.prototype', async () => {
    const { h4b, root } = await chat([
      { type: 'message.delta', messageId: 'a', delta: 'x' },
      ...['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'].map((component) => ({ type: 'ui.surface', messageId: 'a', component, payload: {} })),
    ])
    const errors: unknown[] = []
    h4b.on('error', (e) => errors.push(e))
    await h4b.ask('x')
    await flushWidget()
    expect(root.querySelector('.msg.assistant .media')?.childNodes.length ?? 0).toBe(0)
    expect(errors).toEqual([])
  })
})
