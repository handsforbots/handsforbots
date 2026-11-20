import { afterEach, describe, expect, it } from 'vitest'
import { applyPatch } from '../src/patch.js'

describe('applyPatch', () => {
  afterEach(() => {
    delete (Object.prototype as any).polluted
  })

  it('applies add, replace and remove', () => {
    const doc = { a: 1, b: [10, 20] }
    const patched = applyPatch(doc, [
      { op: 'replace', path: '/a', value: 2 },
      { op: 'add', path: '/b/-', value: 30 },
      { op: 'remove', path: '/b/0' },
    ])
    expect(patched).toEqual({ a: 2, b: [20, 30] })
  })

  it('rejects __proto__ in a path or a from', () => {
    expect(() => applyPatch({}, [{ op: 'add', path: '/__proto__/polluted', value: true }])).toThrow(/__proto__/)
    expect(() => applyPatch({ a: 1 }, [{ op: 'copy', from: '/__proto__/toString', path: '/a' }])).toThrow(/__proto__/)
    expect((Object.prototype as any).polluted).toBeUndefined()
  })

  it('never walks into a prototype through constructor', () => {
    expect(() => applyPatch({}, [{ op: 'add', path: '/constructor/prototype/polluted', value: true }])).toThrow(/Invalid JSON patch path/)
    expect((Object.prototype as any).polluted).toBeUndefined()
  })

  it('keeps constructor and prototype usable as ordinary keys', () => {
    const patched = applyPatch({ constructor: { name: 'a' } } as Record<string, unknown>, [
      { op: 'replace', path: '/constructor/name', value: 'b' },
      { op: 'add', path: '/prototype', value: 1 },
    ])
    expect(patched).toEqual({ constructor: { name: 'b' }, prototype: 1 })
  })
})
