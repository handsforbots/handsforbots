import { createH4B, type Stimulus } from '@handsforbots/core'
import { reply, scriptedTransport, waitForIdle } from '@handsforbots/testkit'
import { describe, expect, it } from 'vitest'
import { cues } from '../src/index.js'

const channels = {
  tone: { values: ['neutro', 'curioso'] as const, default: 'neutro' as const },
}

describe('cues history hardening', () => {
  it('ignores a malicious cues data part from the backend', async () => {
    const malicious: Stimulus[] = [
      ...reply('resposta', 'm1').slice(0, -1),
      {
        type: 'message.part',
        messageId: 'm1',
        part: {
          type: 'data',
          name: 'cues',
          value: { tone: { value: '<img src=x onerror=alert(1)>', level: 999, from: 'backend' } },
        },
      },
      { type: 'message.end', messageId: 'm1' },
    ]
    const errors: string[] = []
    const h4b = await createH4B({ memory: false, plugins: [cues({ channels })], onError: () => {} }).start()
    h4b.on('error', ({ error, source }) => source === 'cues' && errors.push(String((error as Error).message ?? error)))
    h4b.provide('transport', scriptedTransport([malicious]))
    await h4b.send('oi')
    await waitForIdle(h4b)
    const state = h4b.get('cues')!.getState()
    expect(state.tone!.value).toBe('neutro')
    expect(state.tone!.level).toBe(1)
    expect(errors.some((m) => m.includes('not in vocabulary'))).toBe(true)
  })

  it('reports a bad cues part once, however often the history is read again', async () => {
    const bad: Stimulus[] = [
      ...reply('resposta', 'm1').slice(0, -1),
      { type: 'message.part', messageId: 'm1', part: { type: 'data', name: 'cues', value: { tone: { value: 'gritando' } } } },
      { type: 'message.end', messageId: 'm1' },
    ]
    const errors: string[] = []
    const h4b = await createH4B({ memory: false, plugins: [cues({ channels })], onError: () => {} }).start()
    h4b.on('error', ({ error, source }) => source === 'cues' && errors.push(String((error as Error).message ?? error)))
    h4b.provide('transport', scriptedTransport([bad, reply('outra', 'm2'), reply('mais uma', 'm3')]))
    await h4b.send('oi')
    await h4b.send('de novo')
    await h4b.send('e de novo')
    await waitForIdle(h4b)
    expect(errors.filter((m) => m.includes('"gritando"'))).toHaveLength(1)
  })
})