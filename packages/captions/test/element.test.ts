// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createCadence } from '../src/cadence.js'
import { H4BCaptionElement, renderCaption } from '../src/element.js'

function fakeTimers() {
  let nowSec = 0
  let nextId = 1
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    clock: () => nowSec,
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++
      pending.set(id, { at: nowSec + ms / 1000, fn })
      return id
    },
    cancelSchedule: (handle: unknown) => {
      pending.delete(handle as number)
    },
    advance(ms: number) {
      const target = nowSec + ms / 1000
      for (;;) {
        let earliestId: number | undefined
        let earliestAt = Infinity
        for (const [id, entry] of pending) {
          if (entry.at <= target + 1e-9 && entry.at < earliestAt) {
            earliestAt = entry.at
            earliestId = id
          }
        }
        if (earliestId === undefined) break
        const entry = pending.get(earliestId)!
        pending.delete(earliestId)
        nowSec = Math.max(nowSec, entry.at)
        entry.fn()
      }
      nowSec = target
    },
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('renderCaption and <h4b-caption>', () => {
  it('reuses word nodes during streamed appends and exposes mode/state/source attributes', () => {
    const t = fakeTimers()
    const cadence = createCadence({
      pace: () => ({ durationMs: 200 }),
      reducedMotion: 'words',
      clock: t.clock,
      schedule: t.schedule,
      cancelSchedule: t.cancelSchedule,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const stop = renderCaption(container, cadence, { mode: 'reveal', aria: 'mirror', animateProgress: false })

    expect(container.hidden).toBe(true)
    expect(container.getAttribute('aria-hidden')).toBe('true')
    expect(container.dataset.mode).toBe('reveal')

    cadence.append('Olá ')
    expect(container.hidden).toBe(false)
    const firstSpan = container.querySelector<HTMLElement>('.word')!
    expect(firstSpan.textContent).toBe('Olá')
    expect(firstSpan.dataset.state).toBe('active')
    expect(firstSpan.dataset.source).toBe('cadence')

    cadence.append('mundo.')
    cadence.finish()
    // First word node is reused instead of rebuilt.
    expect(container.querySelectorAll('.word')[0]).toBe(firstSpan)
    expect(container.querySelectorAll('.word')[1]!.textContent).toBe('mundo.')
    expect(container.querySelectorAll<HTMLElement>('.word')[1]!.dataset.state).toBe('upcoming')

    stop()
    cadence.dispose()
  })

  it('announces completed spoken text once in aria: standalone mode and omits skipped words', () => {
    const t = fakeTimers()
    const cadence = createCadence({
      pace: () => ({ durationMs: 200 }),
      reducedMotion: 'words',
      clock: t.clock,
      schedule: t.schedule,
      cancelSchedule: t.cancelSchedule,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const stop = renderCaption(container, cadence, { mode: 'reveal', aria: 'standalone', animateProgress: false })

    expect(container.hasAttribute('aria-hidden')).toBe(false)
    cadence.setText('Olá mundo inteiro')
    const spans = [...container.querySelectorAll<HTMLElement>('.word')]
    expect(spans.every((s) => s.getAttribute('aria-hidden') === 'true')).toBe(true)
    const sr = container.querySelector<HTMLElement>('.h4b-caption-sr')!
    expect(sr.getAttribute('aria-live')).toBe('polite')
    // Not announced word by word while still running.
    expect(sr.textContent).toBe('')

    cadence.cut()
    // Only the spoken/active word before the cut is announced.
    expect(sr.textContent).toBe('Olá')
    expect(spans[1]!.dataset.state).toBe('skipped')

    stop()
    cadence.dispose()
  })

  it('works as <h4b-caption> custom element with .store, mode and aria attributes', () => {
    const cadence = createCadence({ reducedMotion: 'instant' })
    const el = document.createElement('h4b-caption') as H4BCaptionElement
    expect(el).toBeInstanceOf(H4BCaptionElement)
    el.mode = 'reveal'
    el.aria = 'standalone'
    document.body.appendChild(el)
    el.store = cadence
    cadence.setText('Oi pessoal.')

    const box = el.shadowRoot!.querySelector<HTMLElement>('.captions')!
    expect(box.hidden).toBe(false)
    expect(box.dataset.mode).toBe('reveal')
    expect(box.querySelectorAll('.word').length).toBe(2)
    expect(box.querySelector('.h4b-caption-sr')!.textContent).toBe('Oi pessoal.')

    el.remove()
    cadence.dispose()
  })
})
