import { describe, expect, it } from 'vitest'
import { readConversationState } from '../src/server.js'

describe('readConversationState hardening', () => {
  it('skips prototype keys and keeps a null-prototype sections object', () => {
    const polluted = JSON.parse(
      '{"revision":1,"sections":{"topic":{"id":"t1","text":"ok","origin":"user","confidence":"low"},"__proto__":{"polluted":true}}}',
    )
    const view = readConversationState(polluted)
    expect(view?.sections.topic).toMatchObject({ text: 'ok' })
    expect(Object.hasOwn(view!.sections, '__proto__')).toBe(false)
    expect((view!.sections as { polluted?: boolean }).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(view!.sections)).toBe(null)
  })

  it('rebuilds rejected entries with bounded detail and drops unknown fields', () => {
    const detail = 'x'.repeat(120_000)
    const view = readConversationState({
      revision: 2,
      sections: { topic: null },
      rejected: [
        { index: 0, reason: 'invalid', detail, extra: 'drop-me', op: 'add', section: 'topic', id: 'i1' },
        { index: 1, reason: 'not-a-reason', detail: 'nope' },
      ],
    })
    expect(view?.rejected).toEqual([{ index: 0, reason: 'invalid', detail: 'x'.repeat(500), op: 'add', section: 'topic', id: 'i1' }])
  })

  it('limits how many sections are kept', () => {
    const sections: Record<string, null> = {}
    for (let i = 0; i < 80; i++) sections[`s${i}`] = null
    const view = readConversationState({ revision: 1, sections }, { maxSections: 10 })
    expect(Object.keys(view!.sections)).toHaveLength(10)
  })
})