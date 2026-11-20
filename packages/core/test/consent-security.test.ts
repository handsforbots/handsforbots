// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createH4B } from '../src/index.js'

async function eventually(check: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('consent channel security', () => {
  it('ignores cross-tab messages with invalid consent states', async () => {
    const channel = `sec-${Math.random()}`
    const rules = { id: 'r', purposes: { persistence: { default: 'pending' as const } } }
    const a = await createH4B({ consent: { channel, rules } }).start()
    const b = await createH4B({ consent: { channel, rules } }).start()
    const rogue = new BroadcastChannel(`h4b-consent:${channel}`)
    rogue.postMessage({ type: 'h4b:consent', decisions: { persistence: 'hacked' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(a.consent.state('persistence')).toBe('pending')
    expect(b.consent.state('persistence')).toBe('pending')
    rogue.postMessage({ type: 'h4b:consent', decisions: { persistence: 'granted' } })
    await eventually(() => b.consent.granted('persistence'))
    rogue.close()
    await Promise.all([a.stop(), b.stop()])
  })
})