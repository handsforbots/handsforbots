import { createH4B, type H4B, type Stimulus, type TurnRequest } from '@handsforbots/core'
import { eventually, reply, scriptedTransport, waitForIdle } from '@handsforbots/testkit'
import { describe, expect, it } from 'vitest'
import { conversationState, httpStateUpdater, STATE_KEY, type ConversationStateOptions, type StateUpdater, type StateView } from '../src/index.js'

const effect = (value: unknown): Stimulus => ({ type: 'ui.effect', name: STATE_KEY, value })

async function setup(script: (request: TurnRequest, round: number) => Stimulus[] | Promise<Stimulus[]>, options: ConversationStateOptions = {}) {
  const transport = scriptedTransport(script)
  const h4b = await createH4B({ memory: false, plugins: [conversationState(options)] }).start()
  h4b.provide('transport', transport)
  const say = async (text: string) => {
    await h4b.send(text)
    await waitForIdle(h4b)
  }
  return { h4b, transport, say, service: h4b.get('conversationState')! }
}

const sent = (request: TurnRequest | undefined): StateView | undefined => {
  const signal = request?.context.find((s) => s.key === STATE_KEY)
  const part = signal?.parts[0]
  return part?.type === 'data' ? (part.value as StateView) : undefined
}

const lastUser = (request: TurnRequest) => [...request.messages].reverse().find((m) => m.role === 'user')!.id

describe('conversationState plugin', () => {
  it('sends the state with every request in a context signal of its own, apart from the messages', async () => {
    const { transport, say } = await setup(() => reply('oi'))
    await say('olá')
    expect(sent(transport.requests[0])).toEqual({
      revision: 0,
      sections: { topic: null, goal: null, depth: null, entities: [], decisions: [], facts: [], pending: [] },
    })
    expect(transport.requests[0]!.messages.every((m) => m.role === 'tool' || m.parts.every((p) => p.type !== 'data'))).toBe(true)
  })

  it('applies a ui.effect from the reply when the turn ends, checking quotes against the whole turn', async () => {
    const { h4b, transport, say, service } = await setup((request, round) =>
      round === 0
        ? [
            effect({ ops: [{ op: 'add', section: 'facts', text: 'Acme usa Terraform 1.9', scope: 'acme', evidence: [{ messageId: lastUser(request), quote: 'Terraform 1.9' }] }] }),
            ...reply('Anotado.'),
          ]
        : reply('ok'),
    )
    const events: string[] = []
    h4b.on('conversation.state', (e) => events.push(`${e.reason}:${e.revision}:${e.applied}`))
    await say('Na Acme usamos Terraform 1.9.')
    expect(service.getState().items.facts).toEqual([expect.objectContaining({ text: 'Acme usa Terraform 1.9', origin: 'user', confidence: 'high', by: 'backend' })])
    expect(events).toEqual(['update:1:1'])
    await say('e agora?')
    expect(sent(transport.requests[1])!.sections.facts).toEqual([expect.objectContaining({ id: 'f1', scope: 'acme', src: [h4b.messages[0]!.id] })])
  })

  it('tells the backend once what its last update had rejected', async () => {
    const { transport, say, service } = await setup((_r, round) =>
      round === 0 ? [effect({ ops: [{ op: 'add', section: 'facts', text: 'Inventado', evidence: [{ messageId: 'x', quote: 'nunca dito' }] }] }), ...reply('hm')] : reply('ok'),
    )
    await say('oi')
    expect(service.getState().rejected[0]!.reason).toBe('evidence-not-found')
    await say('a')
    await say('b')
    expect(sent(transport.requests[1])!.rejected).toEqual([expect.objectContaining({ index: 0, reason: 'evidence-not-found', section: 'facts' })])
    expect(sent(transport.requests[2])!.rejected).toBeUndefined()
  })

  it('registers update_conversation_state for tool calling and returns what applied and what was rejected', async () => {
    const { h4b, service } = await setup(() => reply('ok'))
    await h4b.send('Quero migrar a Acme para OpenTofu.')
    await waitForIdle(h4b)
    const userId = h4b.messages[0]!.id
    const result = await h4b.runAction('update_conversation_state', {
      ops: [
        { op: 'set', section: 'goal', text: 'Migrar a Acme para OpenTofu', evidence: [{ messageId: userId }] },
        { op: 'remove', section: 'pending', id: 'p9', reason: 'x' },
      ],
    }, { origin: 'assistant' })
    expect(result).toMatchObject({ result: { revision: 1, applied: [{ section: 'goal', id: 'goal', change: 'added' }], rejected: [{ reason: 'unknown-item' }] } })
    expect(service.getState().items.goal![0]).toMatchObject({ origin: 'user' })
  })

  it('updates on a channel of its own after each turn, and the next request waits for it', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const calls: StateView[] = []
    const updater: StateUpdater = async ({ state, messages }) => {
      calls.push(state)
      await gate
      const user = messages.find((m) => m.role === 'user')!
      return { ops: [{ op: 'set', section: 'topic', text: 'Terraform da Acme', evidence: [{ messageId: user.id }] }] }
    }
    const { h4b, transport, say, service } = await setup(() => reply('ok'), { updates: updater })
    expect(h4b.actions.get('update_conversation_state')).toBeUndefined()
    await say('Vamos falar do Terraform da Acme')
    await eventually(() => expect(service.getState().pending).toBe(true))
    const second = h4b.send('e o state?')
    setTimeout(release, 20)
    await second
    await waitForIdle(h4b)
    expect(sent(transport.requests[1])!.sections.topic).toMatchObject({ text: 'Terraform da Acme' })
    expect(calls[0]!.revision).toBe(0)
    await service.settled()
    expect(service.getState().pending).toBe(false)
  })

  it('rejects an updater result computed from a state that changed meanwhile (base defaults to what it was given)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const updater: StateUpdater = async () => {
      await gate
      return { ops: [{ op: 'remove', section: 'pending', id: 'p1', reason: 'feito' }] }
    }
    const { say, service } = await setup(() => reply('ok'), { updates: updater })
    service.update({ ops: [{ op: 'add', section: 'pending', text: 'revisar módulos' }] })
    await say('oi')
    service.update({ ops: [{ op: 'update', section: 'pending', id: 'p1', text: 'revisar módulos e state' }] })
    release()
    await service.settled()
    expect(service.getState().rejected[0]).toMatchObject({ reason: 'stale' })
    expect(service.getState().items.pending).toHaveLength(1)
  })

  it('reports an updater failure as an error and keeps the state', async () => {
    const { h4b, say, service } = await setup(() => reply('ok'), {
      updates: httpStateUpdater({ url: 'https://example.test/state', fetch: async () => new Response('no', { status: 500 }) }),
    })
    const errors: string[] = []
    h4b.on('error', ({ source }) => errors.push(source))
    await say('oi')
    await service.settled()
    expect(errors).toContain('conversation-state')
    expect(service.getState().revision).toBe(0)
  })

  it('httpStateUpdater posts the state and the turn, and reads the update', async () => {
    let body: Record<string, unknown> | undefined
    const { say, service } = await setup(() => reply('ok'), {
      updates: httpStateUpdater({
        url: 'https://example.test/state',
        fetch: async (_url, init) => {
          body = JSON.parse(String(init!.body))
          return Response.json({ ops: [{ op: 'add', section: 'pending', text: 'responder sobre o backend remoto' }] })
        },
      }),
    })
    await say('e o backend remoto?')
    await service.settled()
    expect(body).toMatchObject({ state: { revision: 0 }, turnId: expect.any(String), messages: [expect.objectContaining({ role: 'user' }), expect.objectContaining({ role: 'assistant' })] })
    expect(service.getState().items.pending![0]).toMatchObject({ text: 'responder sobre o backend remoto', confidence: 'low' })
  })

  it('is saved and restored with the conversation, and a new conversation starts empty', async () => {
    const { h4b, service } = await setup(() => reply('ok'))
    service.update({ ops: [{ op: 'set', section: 'goal', text: 'Migrar', locked: true }] })
    const snapshot = h4b.conversation.snapshot()
    expect(snapshot.conversationState).toMatchObject({ v: 1, revision: 1 })

    const other = await createH4B({ memory: false, plugins: [conversationState()] }).start()
    other.conversation.restore(structuredClone(snapshot))
    expect(other.get('conversationState')!.getState().items.goal![0]).toMatchObject({ text: 'Migrar', locked: true })

    h4b.reset()
    expect(service.getState().revision).toBe(0)
    expect(h4b.conversation.snapshot().conversationState).toBeUndefined()
  })

  it('never goes back to an older revision of the same conversation (an older tab or save)', async () => {
    const { h4b, service } = await setup(() => reply('ok'))
    service.update({ ops: [{ op: 'add', section: 'pending', text: 'a' }] })
    const old = h4b.conversation.snapshot()
    service.update({ ops: [{ op: 'add', section: 'pending', text: 'b' }] })
    const errors: string[] = []
    h4b.on('error', ({ source }) => errors.push(source))
    h4b.conversation.restore(old)
    expect(service.getState().revision).toBe(2)
    expect(h4b.conversation.snapshot().conversationState).toMatchObject({ revision: 2 })
    expect(errors).toEqual(['conversation-state'])
  })

  it('with persist: false, keeps the state out of the snapshot', async () => {
    const { h4b, service } = await setup(() => reply('ok'), { persist: false })
    service.update({ ops: [{ op: 'set', section: 'topic', text: 'X' }] })
    expect(service.getState().revision).toBe(1)
    expect(h4b.conversation.snapshot().conversationState).toBeUndefined()
  })

  it('with send: false, sends nothing', async () => {
    const { transport, say } = await setup(() => reply('ok'), { send: false })
    await say('oi')
    expect(sent(transport.requests[0])).toBeUndefined()
  })

  it('reverts through the service and keeps the journal for audit', async () => {
    const { service } = await setup(() => reply('ok'))
    service.update({ ops: [{ op: 'set', section: 'topic', text: 'A' }] })
    service.update({ ops: [{ op: 'set', section: 'topic', text: 'B' }] })
    service.revert(1, 'voltar')
    expect(service.getState().items.topic![0]!.text).toBe('A')
    expect(service.history().map((e) => e.kind)).toEqual(['update', 'update', 'revert'])
    expect(() => service.revert(99, 'x')).toThrow(/revision must be/)
  })

  it('keeps getState stable until something changes and notifies subscribers', async () => {
    const { service } = await setup(() => reply('ok'))
    const first = service.getState()
    expect(service.getState()).toBe(first)
    let calls = 0
    const off = service.subscribe(() => calls++)
    service.update({ ops: [{ op: 'set', section: 'topic', text: 'A' }] })
    expect(calls).toBe(1)
    expect(service.getState()).not.toBe(first)
    off()
  })
})

export type { H4B }
