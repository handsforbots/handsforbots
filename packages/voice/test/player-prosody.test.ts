// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { clampProsody, planProsody } from '../src/player.js'

describe('player prosody limits', () => {
  it('clamps volume, pitch, and rate in planProsody', () => {
    const plan = planProsody({}, { rate: 99, pitch: 80, volume: 100 }, true)
    expect(plan.playbackRate).toBeCloseTo(4)
    expect(plan.gainDb).toBe(24)
    expect(planProsody({}, { rate: Number.NaN, pitch: Number.POSITIVE_INFINITY, volume: -200 }, true).gainDb).toBe(-24)
    expect(clampProsody({ rate: 0.1, pitch: -40, volume: 6 })).toEqual({ rate: 0.25, pitch: -24, volume: 6 })
  })

})