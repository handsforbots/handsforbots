import { createH4B, type Transport } from '@handsforbots/core'
import { describe, expect, it, vi } from 'vitest'
import { merge, tabSync, type ChannelLike } from '../src/index.js'

function bus() {
  const channels = new Set<{ name: string; listeners: Set<(e: { data: unknown }) => void> }>()
  return (name: string): ChannelLike => {
    const self = { name, listeners: new Set<(e: { data: unknown }) => void>() }
    channels.add(self)
    return {
      postMessage: (data) => {
        for (const other of channels) {
          if (other !== self && other.name === name) other.listeners.forEach((l) => l({ data: structuredClone(data) }))
        }
      },
      addEventListener: (_t, l) => void self.listeners.add(l),
      removeEventListener: (_t, l) => void self.listeners.delete(l),
      close: () => void channels.delete(self),
    }
  }
}

async function eventually(check: () => void, timeout = 3000) {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      return check()
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}

const echo: Transport = {
  name: 'echo',
  async *run(request) {
    yield { type: 'message.delta', messageId: `m-${request.turnId}`, delta: 'ok' }
  },
}

describe('tab-sync security', () => {
  it('rejects malformed broadcast envelopes without throwing', async () => {
    const createChannel = bus()
    const errors: string[] = []
    const tab = await createH4B({
      plugins: [tabSync({ createChannel, throttleMs: 0 })],
      onError: (_error, source) => errors.push(source),
    }).start()
    tab.provide('transport', echo)
    const channel = createChannel('h4b:default')
    channel.postMessage({ type: 'h4b:snapshot', from: 'evil' })
    channel.postMessage({ type: 'h4b:snapshot', from: 'evil', snapshot: { threadId: 't', messages: 'nope' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(tab.messages).toEqual([])
    expect(errors.filter((s) => s === 'tab-sync').length).toBeGreaterThanOrEqual(1)
  })

  it('merges seenCallIds from peer tabs without duplicates', () => {
    expect(merge([], [])).toEqual([])
    const merged = merge(
      [{ id: 'a', role: 'user', modality: 'text', source: 'w', createdAt: 1, parts: [{ type: 'text', text: 'a' }] }],
      [{ id: 'b', role: 'user', modality: 'text', source: 'w', createdAt: 2, parts: [{ type: 'text', text: 'b' }] }],
    )
    expect(merged.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('rejects malformed activity broadcasts in notify mode', async () => {
    const createChannel = bus()
    const activities: unknown[] = []
    const tab = await createH4B({
      plugins: [tabSync({ mode: 'notify', createChannel })],
    }).start()
    tab.on('tabs.activity', (a) => activities.push(a))
    const channel = createChannel('h4b:default')
    channel.postMessage({
      type: 'h4b:activity',
      from: 'evil',
      at: Date.now(),
      activity: { kind: 'action', name: 'x'.repeat(400), origin: 'user', ok: true },
    })
    channel.postMessage({
      type: 'h4b:activity',
      from: 'evil',
      at: Date.now(),
      activity: { kind: 'turn', phase: 'done', route: 'nope' },
    })
    channel.postMessage({
      type: 'h4b:activity',
      from: 'evil',
      at: Date.now(),
      activity: { kind: 'action', name: 'save', origin: 'user', ok: true, extra: 'pollution' },
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(activities).toEqual([])
    expect(tab.context.find((s) => s.key === 'tab-sync.activity')).toBeUndefined()
  })

  it('accepts well-formed activity broadcasts in notify mode', async () => {
    const createChannel = bus()
    const activities: unknown[] = []
    const tab = await createH4B({
      plugins: [tabSync({ mode: 'notify', createChannel })],
    }).start()
    tab.on('tabs.activity', (a) => activities.push(a))
    const channel = createChannel('h4b:default')
    channel.postMessage({
      type: 'h4b:activity',
      from: 'peer',
      at: 1,
      activity: { kind: 'action', name: 'save', origin: 'user', ok: true },
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(activities).toEqual([{ kind: 'action', name: 'save', origin: 'user', ok: true, tab: 'peer', at: 1 }])
    expect(tab.context.find((s) => s.key === 'tab-sync.activity')?.parts[0]).toMatchObject({
      type: 'data',
      name: 'other_tabs_activity',
    })
  })

  it('restores seenCallIds merged from another tab on the same thread', async () => {
    const createChannel = bus()
    const tabA = await createH4B({ threadId: 't1', plugins: [tabSync({ createChannel, throttleMs: 0 })] }).start()
    const tabB = await createH4B({ threadId: 't1', plugins: [tabSync({ createChannel, throttleMs: 0 })] }).start()
    tabA.conversation.rememberCallId('seen-on-a')
    tabA.provide('transport', echo)
    await tabA.ask('ping')
    await eventually(() => expect(tabB.conversation.hasSeenCallId('seen-on-a')).toBe(true))
  })
})