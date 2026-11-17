// Real-browser canaries for the XSS review (ROADMAP section 3). jsdom never
// runs `onerror`, `onload` or `<script>`; Chromium does. Every payload calls
// `alert(1)`, replaced here by a counter, so a payload that ever runs fails.
import { createH4B, type Message, type Transport } from '@handsforbots/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAYLOADS } from './payloads.js'
import { RENDERERS, renderCitedText, renderMarkdown, widget } from '../src/index.js'

let ran = 0
const originalAlert = window.alert
const live: { stop: () => Promise<void> }[] = []

beforeEach(() => {
  ran = 0
  window.alert = () => {
    ran++
  }
})

afterEach(async () => {
  window.alert = originalAlert
  await Promise.all(live.splice(0).map((h4b) => h4b.stop()))
  document.body.replaceChildren()
})

/** Every element under `root`, through open shadow roots. */
function deepElements(root: ParentNode): Element[] {
  return [...root.querySelectorAll('*')].flatMap((el) => [el, ...(el.shadowRoot ? deepElements(el.shadowRoot) : [])])
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

/**
 * Waits until a payload would have had its chance to run: a control image
 * added after the content fails to load (its onerror fires), every image under
 * `root` is done, and two frames pass for queued events such as `toggle`.
 */
async function settle(root: ParentNode) {
  let controlFired = false
  const control = document.createElement('img')
  control.onerror = () => {
    controlFired = true
  }
  control.src = `missing-${Math.random()}.png`
  document.body.append(control)
  await vi.waitFor(
    () => {
      expect(controlFired).toBe(true)
      for (const img of deepElements(root).filter((el): el is HTMLImageElement => el instanceof HTMLImageElement)) expect(img.complete).toBe(true)
    },
    { timeout: 5000, interval: 10 },
  )
  await frame()
  await frame()
  control.remove()
}

function container() {
  const div = document.createElement('div')
  document.body.append(div)
  return div
}

describe('canary (proves these tests can fail)', () => {
  // (<svg onload> only fires while a document is parsed, not from innerHTML, so it is no control.)
  it.each(['<img src=x onerror=alert(1)>', '<details open ontoggle=alert(1)>', '<video><source onerror=alert(1)></video>'])(
    'counts %s when it is inserted as raw HTML',
    async (payload) => {
      const div = container()
      div.innerHTML = payload
      await settle(div)
      expect(ran).toBe(1)
    },
  )
})

describe('XSS in Chromium: renderMarkdown and renderCitedText', () => {
  it.each(PAYLOADS)('never runs %j', async (payload) => {
    const div = container()
    div.innerHTML = renderMarkdown(payload)
    const cited = {
      id: 'm',
      role: 'assistant',
      createdAt: 0,
      parts: [
        { type: 'text', text: payload, citations: [{ start: 0, end: 1, sourceIds: ['s'] }] },
        { type: 'source', id: 's', title: payload, url: 'javascript:alert(1)' },
      ],
    } as Message
    div.insertAdjacentHTML('beforeend', renderCitedText(cited))
    await settle(div)
    expect(ran).toBe(0)
  })
})

describe('XSS in Chromium: gallery', () => {
  it('never runs hostile images, titles or texts', async () => {
    const div = container()
    const hostile = ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', '"><img src=x onerror=alert(1)>']
    div.append(
      RENDERERS.gallery!(
        { title: '<img src=x onerror=alert(1)>', images: [...hostile, { src: 'x.png', alt: '"><img src=x onerror=alert(1)>' }], texts: PAYLOADS },
        { h4b: undefined as any },
      ),
    )
    await settle(div)
    expect(ran).toBe(0)
  })
})

describe('XSS in Chromium: <h4b-chat>', () => {
  async function chat(events: unknown[]) {
    const transport: Transport = {
      name: 'payloads',
      async *run() {
        yield* events as any[]
      },
    }
    const h4b = createH4B({ plugins: [widget({ pace: 0, startOpen: true })] })
    h4b.provide('transport', transport)
    await h4b.start()
    live.push(h4b)
    return h4b
  }

  it.each(PAYLOADS)('never runs %j in user, assistant, source and action messages', async (payload) => {
    const h4b = await chat([
      { type: 'message.delta', messageId: 'a', delta: payload },
      { type: 'message.part', messageId: 'a', part: { type: 'source', id: 'c1', title: payload, url: 'javascript:alert(1)', trail: [payload], excerpt: payload } },
      { type: 'message.citations', messageId: 'a', citations: [{ start: 0, end: 1, sourceIds: ['c1'] }] },
      { type: 'message.part', messageId: 'a', part: { type: 'image', mimeType: 'image/png', source: { kind: 'url', url: 'javascript:alert(1)' }, name: payload } },
      { type: 'ui.render', messageId: 'a', component: 'gallery', props: { title: payload, images: ['javascript:alert(1)'], texts: [payload] } },
    ])
    await h4b.ask(payload)
    await h4b.runAction('missing', { payload })
    await settle(document.body)
    expect(ran).toBe(0)
  })
})
