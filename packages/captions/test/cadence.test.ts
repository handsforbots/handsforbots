import { describe, expect, it, vi } from 'vitest'
import { createCadence } from '../src/cadence.js'

/** Deterministic clock + timer queue: zero real-time waits. */
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
    pendingCount: () => pending.size,
  }
}

describe('createCadence', () => {
  it('advances word by word with punctuation pauses, live progress and idle end', () => {
    const t = fakeTimers()
    const cadence = createCadence({
      pace: () => ({ durationMs: 200, pauseMs: 100 }),
      reducedMotion: 'words',
      clock: t.clock,
      schedule: t.schedule,
      cancelSchedule: t.cancelSchedule,
    })

    expect(cadence.getState()).toMatchObject({ status: 'idle', words: [], active: -1, driver: 'text' })
    expect(cadence.shown()).toBe(0)

    cadence.setText('Olá, mundo.')
    const states = () => cadence.getState().words.map((w) => `${w.text}:${w.state}`)
    expect(states()).toEqual(['Olá,:active', 'mundo.:upcoming'])
    expect(cadence.getState()).toMatchObject({ status: 'speaking', active: 0, from: 0, to: 11 })
    expect(cadence.getState().words[0]).toMatchObject({ quality: 'estimated', source: 'cadence' })
    expect(cadence.progress()).toBe(0)
    expect(cadence.shown()).toBe(4)

    t.advance(100)
    expect(cadence.progress()).toBeCloseTo(0.5, 2)

    t.advance(110) // 210ms -> in the 100ms pause after word 0
    expect(cadence.getState().status).toBe('gap')
    expect(states()).toEqual(['Olá,:spoken', 'mundo.:upcoming'])
    expect(cadence.progress()).toBe(1)

    t.advance(100) // 310ms -> word 1 active [0.3, 0.5)
    expect(cadence.getState().status).toBe('speaking')
    expect(states()).toEqual(['Olá,:spoken', 'mundo.:active'])
    expect(cadence.shown()).toBe(11)

    t.advance(250) // past 500ms -> finished
    expect(cadence.getState()).toMatchObject({ status: 'idle', active: -1, ended: 'done', replyEnded: true })
    expect(states()).toEqual(['Olá,:spoken', 'mundo.:spoken'])
    expect(cadence.progress()).toBe(0)
    expect(t.pendingCount()).toBe(0)
    cadence.dispose()
  })

  it('buffers trailing partial words while streaming with append() until whitespace or finish()', () => {
    const t = fakeTimers()
    const cadence = createCadence({
      pace: () => ({ durationMs: 100 }),
      reducedMotion: 'words',
      clock: t.clock,
      schedule: t.schedule,
      cancelSchedule: t.cancelSchedule,
    })

    cadence.append('Ol')
    expect(cadence.getState().words).toEqual([])

    cadence.append('á mun')
    expect(cadence.getState().words.map((w) => `${w.text}:${w.state}`)).toEqual(['Olá:active'])

    t.advance(120)
    // Stream is still open: stays in gap waiting for more deltas rather than ending.
    expect(cadence.getState().status).toBe('gap')
    expect(cadence.getState().replyEnded).toBeUndefined()

    cadence.append('do.')
    // Still no trailing space and not finished -> 'mundo.' still held back.
    expect(cadence.getState().words.map((w) => w.text)).toEqual(['Olá'])

    cadence.finish()
    expect(cadence.getState().words.map((w) => `${w.text}:${w.state}`)).toEqual(['Olá:spoken', 'mundo.:active'])

    t.advance(120)
    expect(cadence.getState()).toMatchObject({ status: 'idle', ended: 'done', replyEnded: true })
    cadence.dispose()
  })

  it('supports pause, resume, skip, cut and reset', () => {
    const t = fakeTimers()
    const cadence = createCadence({
      pace: () => ({ durationMs: 200 }),
      reducedMotion: 'words',
      clock: t.clock,
      schedule: t.schedule,
      cancelSchedule: t.cancelSchedule,
    })

    cadence.setText('um dois tres')
    t.advance(100)
    expect(cadence.progress()).toBeCloseTo(0.5, 2)

    cadence.pause()
    t.advance(500)
    // Frozen while paused.
    expect(cadence.getState().active).toBe(0)
    expect(cadence.progress()).toBeCloseTo(0.5, 2)

    cadence.resume()
    t.advance(110)
    expect(cadence.getState().active).toBe(1)

    cadence.cut()
    expect(cadence.getState()).toMatchObject({ status: 'idle', active: -1, ended: 'interrupted', replyEnded: true })
    expect(cadence.getState().words.map((w) => `${w.text}:${w.state}`)).toEqual(['um:spoken', 'dois:spoken', 'tres:skipped'])
    expect(cadence.shown()).toBe(7)

    cadence.reset()
    expect(cadence.getState()).toMatchObject({ status: 'idle', words: [], active: -1 })

    cadence.setText('a b c')
    cadence.skip()
    expect(cadence.getState()).toMatchObject({ status: 'idle', ended: 'done', replyEnded: true })
    expect(cadence.getState().words.every((w) => w.state === 'spoken')).toBe(true)
    cadence.dispose()
  })

  it('speeds up when catchUp backlog exceeds threshold', () => {
    const t = fakeTimers()
    const slow = createCadence({
      pace: { wordsPerMinute: 120, catchUp: false },
      reducedMotion: 'words',
      clock: t.clock,
      schedule: t.schedule,
      cancelSchedule: t.cancelSchedule,
    })
    const fast = createCadence({
      pace: { wordsPerMinute: 120, catchUp: { threshold: 2, maxFactor: 3 } },
      reducedMotion: 'words',
      clock: t.clock,
      schedule: t.schedule,
      cancelSchedule: t.cancelSchedule,
    })
    const text = 'um dois tres quatro cinco seis sete oito'
    slow.setText(text)
    fast.setText(text)
    const slowEnd = slow.getState().words[slow.getState().words.length - 1]!.end!
    const fastEnd = fast.getState().words[fast.getState().words.length - 1]!.end!
    expect(fastEnd).toBeLessThan(slowEnd)
    slow.dispose()
    fast.dispose()
  })

  it('reveals immediately with reducedMotion: instant and reports subscriber errors via onError', () => {
    const onError = vi.fn()
    const cadence = createCadence({ reducedMotion: 'instant', onError })
    cadence.subscribe(() => {
      throw new Error('boom')
    })
    cadence.setText('Olá mundo.')
    expect(cadence.getState()).toMatchObject({ status: 'idle', ended: 'done', replyEnded: true })
    expect(cadence.getState().words.map((w) => `${w.text}:${w.state}`)).toEqual(['Olá:spoken', 'mundo.:spoken'])
    expect(onError).toHaveBeenCalledTimes(1)
    cadence.dispose()
  })
})
