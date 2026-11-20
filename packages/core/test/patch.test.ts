import { describe, expect, it } from 'vitest'
import { applyPatch } from '../src/patch.js'

describe('applyPatch security and operations', () => {
  it('applies basic add, replace, and remove operations', () => {
    const doc = { a: 1, b: [10, 20] }
    const patched = applyPatch(doc, [
      { op: 'replace', path: '/a', value: 2 },
      { op: 'add', path: '/b/-', value: 30 },
      { op: 'remove', path: '/b/0' },
    ])
    expect(patched).toEqual({ a: 2, b: [20, 30] })
  })

  it('rejects prototype pollution via __proto__ path', () => {
    const doc = {}
    expect(() => {
      applyPatch(doc, [{ op: 'add', path: '/__proto__/polluted', value: true }])
    }).toThrow(/Dangerous JSON pointer/)
    expect((Object.prototype as any).polluted).toBeUndefined()
  })

  it('rejects prototype pollution via constructor/prototype path', () => {
    const doc = {}
    expect(() => {
      applyPatch(doc, [{ op: 'add', path: '/constructor/prototype/polluted', value: true }])
    }).toThrow(/Dangerous JSON pointer/)
    expect((Object.prototype as any).polluted).toBeUndefined()
  })

  it('rejects copy or move operations from dangerous paths', () => {
    const doc = { valid: 1 }
    expect(() => {
      applyPatch(doc, [{ op: 'copy', from: '/__proto__/toString', path: '/valid' }])
    }).toThrow(/Dangerous JSON pointer/)
  })
})
