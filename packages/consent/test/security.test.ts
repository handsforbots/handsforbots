// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { regionFromMeta } from '../src/index.js'

describe('regionFromMeta security', () => {
  it('reads only a single meta tag inside head', () => {
    document.head.innerHTML = '<meta name="h4b-region" content="BR">'
    document.body.innerHTML = '<meta name="h4b-region" content="US-CA">'
    expect(regionFromMeta()).toBe('BR')
  })

  it('refuses to pick a region when multiple meta tags share the name', () => {
    document.head.innerHTML = `
      <meta name="h4b-region" content="US-CA">
      <meta name="h4b-region" content="BR">
    `
    expect(regionFromMeta()).toBeUndefined()
  })

  it('ignores injected meta outside head', () => {
    document.head.innerHTML = ''
    document.body.innerHTML = '<div><meta name="h4b-region" content="US-CA"></div>'
    expect(regionFromMeta()).toBeUndefined()
  })
})