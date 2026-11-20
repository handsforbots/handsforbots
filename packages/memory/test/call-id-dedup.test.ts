import { createH4B, textOf, type Transport, type TurnRequest } from '@handsforbots/core'
import { describe, expect, it, vi } from 'vitest'

function recorder(rounds: Array<Array<{ type: 'action.call'; callId: string; name: string; args: unknown }>>) {
  const requests: TurnRequest[] = []
  let index = 0
  const transport: Transport = {
    name: 'rec',
    async *run(request) {
      requests.push(request)
      for (const stimulus of rounds[index++] ?? []) yield stimulus
      yield { type: 'message.delta', messageId: `m-${request.turnId}`, delta: 'ok' }
    },
  }
  return { transport, requests }
}

describe('memory and call ids', () => {
  it('does not replay a tool after keep drops its messages when seenCallIds was saved', async () => {
    const call = { type: 'action.call' as const, callId: 'repeat-me', name: 'ping', args: {} }
    const { transport } = recorder([[call], [call]])
    const handler = vi.fn(() => 'pong')
    const h4b = await createH4B({
      memory: { send: 1, keep: 1, compact: 'local' },
      actions: [{ name: 'ping', description: 'Ping', handler }],
    }).start()
    h4b.provide('transport', transport)
    await h4b.ask('one')
    await h4b.get('memory')?.maintain()
    await h4b.ask('two')
    await h4b.get('memory')?.maintain()
    expect(handler).toHaveBeenCalledOnce()
    expect(h4b.messages.some((m) => m.role === 'tool' && m.toolCallId === 'repeat-me')).toBe(false)
    expect(textOf(h4b.messages.at(-1)!)).toBe('ok')
  })
})