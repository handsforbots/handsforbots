// @vitest-environment jsdom
import { createH4B, citedSources, type Message, type Transport } from '@handsforbots/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderCitedText, renderMarkdown, stringsFor, widget, type H4BChatElement } from '../src/index.js'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('markdown hardening', () => {
  it('rejects protocol-relative and slash-backslash relative links', () => {
    expect(renderMarkdown('[x](//evil.test)')).not.toContain('<a ')
    expect(renderMarkdown('[x](/\\evil.test)')).not.toContain('<a ')
    expect(renderMarkdown('[x](\\/evil.test)')).not.toContain('<a ')
    expect(renderMarkdown('[x](%2F%2Fevil.test)')).not.toContain('<a ')
    expect(renderMarkdown('[ x](//evil.test)')).not.toContain('<a ')
  })

  it('allows safe relative paths', () => {
    expect(renderMarkdown('[x](/docs)')).toContain('href="/docs"')
    expect(renderMarkdown('[x](./page)')).toContain('href="./page"')
  })

  it('filters absolute links by host allowlist', () => {
    const opts = { links: { hosts: ['ok.test'] } }
    expect(renderMarkdown('[a](https://ok.test/x)', opts)).toContain('href="https://ok.test/x"')
    expect(renderMarkdown('[b](https://evil.test/x)', opts)).not.toContain('<a ')
  })

  it('renders oversized input as escaped plain text', () => {
    const huge = '<b>'.repeat(40_000)
    const html = renderMarkdown(huge)
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
  })

  it('stays linear on many opening brackets', () => {
    const text = '['.repeat(40_000)
    const start = performance.now()
    renderMarkdown(text)
    expect(performance.now() - start).toBeLessThan(250)
  })
})

describe('citation markers vs markdown links', () => {
  it('does not place a citation inside a link URL', () => {
    const message: Message = {
      id: 'm1',
      role: 'assistant',
      createdAt: 0,
      parts: [
        {
          type: 'text',
          text: '[see](https://ok.test/page)',
          citations: [{ start: 17, end: 20, sourceIds: ['s1'] }],
        },
        { type: 'source', id: 's1', title: 'Src', url: 'https://ok.test' },
      ],
    }
    const html = renderCitedText(message)
    expect(html).toMatch(/href="https:\/\/ok\.test\/page"/)
    expect(html).not.toMatch(/href="[^"]*cite/)
    expect(html).toContain('<sup class="cite"')
  })

  it('moves a reference out of a link or code span to right after it, keeping the rest in place', () => {
    const text = 'Um. Veja [isto](https://ok.test/x) e `co de` fim.'
    const message: Message = {
      id: 'm1',
      role: 'assistant',
      createdAt: 0,
      parts: [
        {
          type: 'text',
          text,
          citations: [
            { start: 0, end: 4, sourceIds: ['s1'] },
            { start: 4, end: 20, sourceIds: ['s2'] },
            { start: 4, end: text.indexOf('de'), sourceIds: ['s1'] },
          ],
        },
        { type: 'source', id: 's1', title: 'Um', url: 'https://ok.test/1' },
        { type: 'source', id: 's2', title: 'Dois', url: 'https://ok.test/2' },
      ],
    }
    const html = renderCitedText(message)
    expect(html).toMatch(/^<p>Um\. <sup class="cite"/)
    expect(html).toMatch(/<a href="https:\/\/ok\.test\/x"[^>]*>isto<\/a><sup class="cite"/)
    expect(html).toMatch(/<code>co de<\/code><sup class="cite"/)
    expect(html).toMatch(/<\/sup> fim\.<\/p>$/)
  })
})

describe('widget edge cases', () => {
  async function chat(stimuli: unknown[], options = {}) {
    const transport: Transport = { name: 't', async *run() { yield* stimuli as any[] } }
    const h4b = createH4B({ plugins: [widget({ pace: 0, startOpen: true, ...options })] })
    h4b.provide('transport', transport)
    await h4b.start()
    return { h4b, root: document.querySelector('h4b-chat')!.shadowRoot! }
  }

  const waitFrame = () =>
    new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
      else setTimeout(resolve, 0)
    })

  it('applies streaming deltas after requestAnimationFrame', async () => {
    const events = [
      { type: 'message.start', messageId: 'a' },
      { type: 'message.delta', messageId: 'a', delta: 'a' },
      { type: 'message.delta', messageId: 'a', delta: 'b' },
      { type: 'message.delta', messageId: 'a', delta: 'c' },
      { type: 'message.end', messageId: 'a' },
    ]
    const { h4b, root } = await chat(events)
    await h4b.ask('show')
    await waitFrame()
    const text = root.querySelector('.msg.assistant .text')?.textContent ?? ''
    expect(text).toContain('abc')
    await h4b.stop()
  })

  it('does not re-render ui parts when the message is structurally cloned', async () => {
    const renderer = vi.fn(() => document.createElement('span'))
    const { h4b, root } = await chat(
      [
        { type: 'message.delta', messageId: 'a', delta: 'hi' },
        { type: 'ui.render', messageId: 'a', component: 'probe', props: {} },
      ],
      { renderers: { probe: renderer } },
    )
    await h4b.ask('x')
    await waitFrame()
    expect(renderer).toHaveBeenCalledTimes(1)
    const chatEl = document.querySelector('h4b-chat') as H4BChatElement
    const message = h4b.messages.find((m) => m.role === 'assistant' && m.parts.some((p) => p.type === 'data' && p.name === 'ui'))!
    const dom = (chatEl as unknown as { rendered: Map<string, { element: HTMLElement }> }).rendered.get(message.id)!
    ;(chatEl as unknown as { fillMessage(el: HTMLElement, msg: Message): void }).fillMessage(dom.element, structuredClone(message))
    expect(renderer).toHaveBeenCalledTimes(1)
    expect(root.querySelector('.msg.assistant .media span')).not.toBeNull()
    await h4b.stop()
  })

  it('ignores quick replies without string labels', async () => {
    const { h4b, root } = await chat([
      {
        type: 'message.start',
        messageId: 'a',
      },
      {
        type: 'message.part',
        messageId: 'a',
        part: { type: 'data', name: 'quick_replies', value: [null, { label: 'OK' }, { label: 1 }] },
      },
      { type: 'message.delta', messageId: 'a', delta: 'choose' },
      { type: 'message.end', messageId: 'a' },
    ])
    await h4b.ask('pick')
    await waitFrame()
    await waitFrame()
    const chips = [...root.querySelectorAll('.chips button')].map((b) => b.textContent)
    expect(chips).toEqual(['OK'])
    await h4b.stop()
  })

  it('queues signals whose id contains double quotes', async () => {
    let release!: () => void
    const transport: Transport = {
      name: 'slow',
      async *run() {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        yield { type: 'message.delta', messageId: 'r', delta: 'ok' }
      },
    }
    const h4b = createH4B({ plugins: [widget({ pace: 0, startOpen: true })] })
    h4b.provide('transport', transport)
    await h4b.start()
    h4b.setInput({ whileBusy: 'queue' })
    void h4b.ask('primeira')
    await waitFrame()
    h4b.signal({
      id: 'sig-"-1',
      kind: 'trigger',
      modality: 'text',
      source: 'widget',
      parts: [{ type: 'text', text: 'queued' }],
      whileBusy: 'queue',
    })
    await waitFrame()
    const root = document.querySelector('h4b-chat')!.shadowRoot!
    expect(root.querySelectorAll('.msg.queued')).toHaveLength(1)
    release()
    await h4b.when('turn.status', (s) => s.phase === 'done')
    await h4b.stop()
  })

  it('stringsFor ignores prototype property names', () => {
    const english = stringsFor('en')
    expect(stringsFor('constructor')).toEqual(english)
    expect(stringsFor('__proto__')).toEqual(english)
  })

  it('rejects cue channels ending in -level', async () => {
    const errors: unknown[] = []
    const { h4b } = await chat([])
    h4b.on('error', (e) => errors.push(e))
    const store = {
      getState: () => ({ 'x-level': { value: 'on', level: 1 }, friendly: { value: 'warm', level: 2 } }),
      subscribe: () => () => {},
    }
    h4b.provide('cues' as never, store as never)
    await waitFrame()
    const el = document.querySelector('h4b-chat')!
    expect(el.getAttribute('data-cue-friendly')).toBe('warm')
    expect(el.getAttribute('data-cue-friendly-level')).toBe('2')
    expect(el.hasAttribute('data-cue-x-level')).toBe(false)
    expect(errors.some((e) => String((e as { error?: Error }).error).includes('-level'))).toBe(true)
    await h4b.stop()
  })
})