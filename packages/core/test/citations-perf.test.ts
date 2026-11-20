import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { inlineCitations, stripInlineCitations } from '../src/citations.js'

describe('inline citations streaming performance', () => {
  it('streams 200k spaces then text within budget and matches non-streaming output', () => {
    const spaces = 200_000
    const deltaSize = 10
    const suffix = 'done'
    const full = `${' '.repeat(spaces)}${suffix}`
    const expected = stripInlineCitations(full)

    const stream = inlineCitations()
    const started = performance.now()
    let text = ''
    const citations = []
    for (let i = 0; i < spaces; i += deltaSize) {
      const chunk = stream.push(' '.repeat(deltaSize))
      text += chunk.text
      citations.push(...chunk.citations)
    }
    const tail = stream.push(suffix)
    const end = stream.end()
    text += tail.text + end.text
    citations.push(...tail.citations, ...end.citations)

    expect(performance.now() - started).toBeLessThan(500)
    expect({ text, citations }).toEqual(expected)
  })
})