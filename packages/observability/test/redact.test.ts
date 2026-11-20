import { describe, expect, it } from 'vitest'
import { sanitizeDecisionPayload } from '../src/redact.js'

describe('sanitizeDecisionPayload', () => {
  it('keeps structural fields and enum-like reason codes, drops text and free-text reason', () => {
    expect(
      sanitizeDecisionPayload({
        kind: 'ignore',
        reason: 'background',
        text: 'tv-confidencial',
        levelDb: -40,
        userLevelDb: -21,
      }),
    ).toMatchObject({ kind: 'ignore', reason: 'background', levelDb: -40, userLevelDb: -21 })

    expect(
      sanitizeDecisionPayload({
        kind: 'end-of-turn-unavailable',
        provider: 'model',
        reason: 'failed to load ?token=sk_live_ABC',
        text: 'secret transcript',
      }),
    ).toEqual({ kind: 'end-of-turn-unavailable', provider: 'model' })

    expect(
      sanitizeDecisionPayload({
        kind: 'end-of-turn',
        reason: 'silence',
        probability: 0.92,
        text: 'hello',
      }),
    ).toMatchObject({ kind: 'end-of-turn', reason: 'silence', probability: 0.92 })
  })
})