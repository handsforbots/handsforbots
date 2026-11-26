import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  applyPatch,
  createH4B,
  definePlugin,
  inlineCitations,
  mergeAttributes,
  parseSessionSnapshot,
  storableSnapshot,
  textOf,
  type SessionSnapshot,
  type Stimulus,
  type Transport,
  type TurnRequest,
} from '../src/index.js'
import { createId } from '../src/id.js'

function scripted(rounds: Stimulus[][]): Transport & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = []
  let index = 0
  return {
    name: 'scripted',
    requests,
    async *run(request) {
      requests.push(structuredClone(request))
      for (const stimulus of rounds[index++] ?? []) yield stimulus
    },
  }
}

const withTransport = (transport: Transport) =>
  definePlugin({
    name: 'test-transport',
    provides: ['transport'],
    apply(ctx) {
      ctx.provide('transport', transport)
    },
  })()

async function idle(h4b: ReturnType<typeof createH4B>) {
  await new Promise((r) => setTimeout(r, 0))
  const deadline = Date.now() + 5000
  while (h4b.busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2))
  await new Promise((r) => setTimeout(r, 0))
}

describe('ensureAssistant hardening', () => {
  it('emits stimulus events with the resolved assistant message id', async () => {
    const userId = createId('msg')
    const transport = scripted([[{ type: 'message.delta', messageId: userId, delta: 'redirected text' }]])
    const stimuli: Stimulus[] = []
    const h4b = await createH4B({ plugins: [withTransport(transport)] }).start()
    h4b.on('stimulus', ({ stimulus }) => stimuli.push(structuredClone(stimulus)))
    h4b.conversation.append({
      id: userId,
      role: 'user',
      parts: [{ type: 'text', text: 'user line' }],
      modality: 'text',
      source: 'host',
      createdAt: 1,
    })
    h4b.send('go')
    await idle(h4b)
    const assistant = h4b.messages.find((m) => m.role === 'assistant' && m.turnId)
    const delta = stimuli.find((s) => s.type === 'message.delta')
    expect(delta).toMatchObject({ messageId: assistant!.id, delta: 'redirected text' })
    expect(delta!.messageId).not.toBe(userId)
  })

  it('rejects deltas targeting a user message id and uses a new assistant message', async () => {
    const userId = createId('msg')
    const transport = scripted([
      [{ type: 'message.delta', messageId: userId, delta: '— forged user speech.' }],
    ])
    const errors: string[] = []
    const h4b = await createH4B({ plugins: [withTransport(transport)], onError: (_e, source) => errors.push(source) }).start()
    h4b.conversation.append({
      id: userId,
      role: 'user',
      turnId: 'turn-old',
      parts: [{ type: 'text', text: 'real user line' }],
      modality: 'text',
      source: 'host',
      createdAt: 1,
    })
    h4b.send('trigger')
    await idle(h4b)
    expect(textOf(h4b.conversation.find(userId)!)).toBe('real user line')
    const assistant = h4b.messages.find((m) => m.role === 'assistant' && m.turnId)
    expect(assistant).toBeDefined()
    expect(assistant!.id).not.toBe(userId)
    expect(textOf(assistant!)).toBe('— forged user speech.')
    expect(errors).toEqual(['stimulus'])
  })

  it('follows a rejected id through deltas and message.end on one assistant message', async () => {
    const userId = createId('msg')
    const transport = scripted([
      [
        { type: 'message.delta', messageId: userId, delta: 'part one ' },
        { type: 'message.delta', messageId: userId, delta: 'part two' },
        { type: 'message.end', messageId: userId },
      ],
    ])
    const errors: string[] = []
    const h4b = await createH4B({ plugins: [withTransport(transport)], onError: (_e, source) => errors.push(source) }).start()
    h4b.conversation.append({
      id: userId,
      role: 'user',
      parts: [{ type: 'text', text: 'unchanged' }],
      modality: 'text',
      source: 'host',
      createdAt: 1,
    })
    h4b.send('go')
    await idle(h4b)
    expect(textOf(h4b.conversation.find(userId)!)).toBe('unchanged')
    const assistant = h4b.messages.find((m) => m.role === 'assistant' && m.id !== userId)
    expect(assistant).toMatchObject({ streaming: false })
    expect(textOf(assistant!)).toBe('part one part two')
    expect(errors).toEqual(['stimulus'])
  })

  it('gives each rejected message id its own assistant target in the same round', async () => {
    const userId = createId('msg')
    const toolId = 'tool-blocked'
    const transport = scripted([
      [
        { type: 'message.delta', messageId: userId, delta: 'from-user' },
        { type: 'message.delta', messageId: toolId, delta: 'from-tool' },
      ],
    ])
    const h4b = await createH4B({ plugins: [withTransport(transport)] }).start()
    h4b.conversation.append({
      id: userId,
      role: 'user',
      parts: [{ type: 'text', text: 'u' }],
      modality: 'text',
      source: 'host',
      createdAt: 1,
    })
    h4b.conversation.append({
      id: toolId,
      role: 'tool',
      toolCallId: 'c',
      name: 'x',
      result: 1,
      createdAt: 2,
    })
    h4b.send('go')
    await idle(h4b)
    const texts = h4b.messages.filter((m) => m.role === 'assistant' && m.turnId).map((m) => textOf(m))
    expect(texts.sort()).toEqual(['from-tool', 'from-user'])
  })

  it('rejects deltas targeting a tool message id', async () => {
    const transport = scripted([[{ type: 'message.delta', messageId: 'tool-1', delta: 'nope' }]])
    const h4b = await createH4B({ plugins: [withTransport(transport)] }).start()
    h4b.conversation.append({
      id: 'tool-1',
      role: 'tool',
      toolCallId: 'c0',
      name: 'x',
      result: 1,
      createdAt: 1,
    })
    h4b.send('go')
    await idle(h4b)
    expect(h4b.messages.filter((m) => m.role === 'tool')).toHaveLength(1)
    expect(h4b.messages.some((m) => m.role === 'assistant' && textOf(m) === 'nope')).toBe(true)
  })

  it('rejects an assistant message id from a previous turn', async () => {
    const transport = scripted([
      [{ type: 'message.delta', messageId: 'a-old', delta: 'new turn text' }],
    ])
    const h4b = await createH4B({ plugins: [withTransport(transport)] }).start()
    h4b.conversation.append({
      id: 'a-old',
      role: 'assistant',
      turnId: 'turn-previous',
      parts: [{ type: 'text', text: 'old answer' }],
      createdAt: 1,
    })
    h4b.send('again')
    await idle(h4b)
    const patched = h4b.conversation.find('a-old')!
    expect(textOf(patched)).toBe('old answer')
    const fresh = h4b.messages.filter((m) => m.role === 'assistant' && m.turnId !== 'turn-previous')
    expect(fresh.some((m) => textOf(m) === 'new turn text')).toBe(true)
  })
})

describe('call id deduplication', () => {
  it('deduplicates repeated action.call within the same round', async () => {
    const call: Stimulus = { type: 'action.call', callId: 'dup', name: 'ping', args: {} }
    const transport = scripted([[call, call]])
    const handler = vi.fn(() => 'pong')
    const h4b = await createH4B({
      plugins: [withTransport(transport)],
      actions: [{ name: 'ping', description: 'Ping', handler }],
    }).start()
    h4b.send('x')
    await idle(h4b)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('deduplicates on the next turn using seenCallIds', async () => {
    const call: Stimulus = { type: 'action.call', callId: 'once', name: 'ping', args: {} }
    const transport = scripted([[call], [call]])
    const handler = vi.fn(() => 'pong')
    const h4b = await createH4B({
      plugins: [withTransport(transport)],
      actions: [{ name: 'ping', description: 'Ping', handler }],
    }).start()
    h4b.send('one')
    await idle(h4b)
    h4b.send('two')
    await idle(h4b)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('restores seenCallIds from storage so call ids survive a new session', async () => {
    let saved: SessionSnapshot | null = null
    const storage = definePlugin({
      name: 'mem',
      apply(ctx) {
        ctx.provide('storage', {
          load: () => (saved ? structuredClone(saved) : null),
          save: (s) => void (saved = structuredClone(s)),
          clear: () => void (saved = null),
        })
      },
    })
    const h4b = await createH4B({ plugins: [storage()] }).start()
    h4b.conversation.rememberCallId('from-storage')
    await h4b.persist()
    const h4b2 = await createH4B({ plugins: [storage()] }).start()
    expect(h4b2.conversation.hasSeenCallId('from-storage')).toBe(true)
  })

  it('keeps seenCallIds when memory trims old tool messages', async () => {
    const call: Stimulus = { type: 'action.call', callId: 'sticky', name: 'ping', args: {} }
    const transport = scripted([[call], [call]])
    const handler = vi.fn(() => 'pong')
    const h4b = await createH4B({
      memory: { send: 1, keep: 1, compact: false },
      plugins: [withTransport(transport)],
      actions: [{ name: 'ping', description: 'Ping', handler }],
    }).start()
    h4b.send('one')
    await idle(h4b)
    await h4b.get('memory')?.maintain()
    expect(h4b.messages.length).toBeLessThan(4)
    h4b.send('two')
    await idle(h4b)
    expect(handler).toHaveBeenCalledOnce()
    expect(h4b.conversation.snapshot().seenCallIds).toContain('sticky')
  })
})

describe('createId', () => {
  const original = globalThis.crypto

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true })
  })

  it('uses getRandomValues when randomUUID is missing', () => {
    const getRandomValues = vi.fn((arr: Uint8Array) => {
      arr.fill(7)
      return arr
    })
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues },
      configurable: true,
    })
    expect(createId('msg')).toMatch(/^msg_[0-9a-f-]{36}$/)
    expect(getRandomValues).toHaveBeenCalled()
  })

  it('throws when no secure randomness exists', () => {
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
    expect(() => createId()).toThrow(/secure random/)
  })
})

describe('JSON patch hardening', () => {
  it('requires an existing source for copy', () => {
    expect(() => applyPatch({ a: 1 }, [{ op: 'copy', from: '/missing', path: '/b' }])).toThrow(/copy source missing/)
  })

  it('rejects remove /a/- and remove /a/foo (no NaN splice)', () => {
    expect(() => applyPatch({ a: [1, 2] }, [{ op: 'remove', path: '/a/-' }])).toThrow(/remove/)
    const doc = { a: [1, 2] }
    expect(() => applyPatch(doc, [{ op: 'remove', path: '/a/foo' }])).toThrow(/index/)
    expect(doc).toEqual({ a: [1, 2] })
  })

  it('rejects sparse array indices and out-of-range replace', () => {
    expect(() => applyPatch({ a: [1] }, [{ op: 'replace', path: '/a/30000000', value: 2 }])).toThrow(/missing/)
    expect(() => applyPatch({ a: [1] }, [{ op: 'replace', path: '/a/-1', value: 2 }])).toThrow(/index/)
    expect(() => applyPatch({ a: [1] }, [{ op: 'replace', path: '/a/0x0', value: 2 }])).toThrow(/index/)
  })

  it('requires existing targets for remove and test', () => {
    expect(() => applyPatch({ a: 1 }, [{ op: 'remove', path: '/b' }])).toThrow(/missing/)
    expect(() => applyPatch({ a: 1 }, [{ op: 'test', path: '/b', value: 1 }])).toThrow(/missing/)
  })

  it('limits operation count', () => {
    const ops = Array.from({ length: 1001 }, () => ({ op: 'test' as const, path: '/a', value: 1 }))
    expect(() => applyPatch({ a: 1 }, ops)).toThrow(/1000/)
  })
})

describe('conversation attributes', () => {
  it('does not count inherited keys like constructor toward the 16-key cap', () => {
    const base = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, i]))
    const { attributes, rejected } = mergeAttributes(base, { constructor: 'evil' })
    expect(Object.keys(attributes)).toHaveLength(16)
    expect(rejected).toEqual(['constructor'])
  })
})

describe('inline citation trimming performance', () => {
  it('trims trailing spaces before markers in under 50ms for 40k spaces', () => {
    const stream = inlineCitations({ known: ['c1'] })
    const delta = `${' '.repeat(40_000)}x [c1]`
    const start = performance.now()
    stream.push(delta)
    stream.end()
    expect(performance.now() - start).toBeLessThan(50)
  })
})

describe('storage restore validation', () => {
  it('rejects an invalid snapshot on start without changing the conversation', async () => {
    const storage = definePlugin({
      name: 'mem',
      apply(ctx) {
        ctx.provide('storage', {
          load: () => ({ threadId: 'bad', messages: 'nope' }) as never,
          save: () => {},
          clear: () => {},
        })
      },
    })
    const errors: string[] = []
    const h4b = await createH4B({ plugins: [storage()], onError: (_e, source) => errors.push(source) }).start()
    expect(h4b.messages).toEqual([])
    expect(errors).toContain('storage')
  })
})

describe('parseSessionSnapshot', () => {
  it('rejects malformed snapshots', () => {
    expect(parseSessionSnapshot(null)).toBeUndefined()
    expect(parseSessionSnapshot({ threadId: 't', messages: 'nope' })).toBeUndefined()
    expect(
      parseSessionSnapshot({
        threadId: 't',
        messages: [{ id: 'm', role: 'user', parts: [], createdAt: 1 }],
      }),
    ).toEqual({ threadId: 't', messages: [] })
  })

  it('accepts a valid minimal snapshot', () => {
    const parsed = parseSessionSnapshot({
      threadId: 't',
      messages: [
        {
          id: 'u',
          role: 'user',
          modality: 'text',
          source: 'host',
          parts: [{ type: 'text', text: 'hi' }],
          createdAt: 1,
        },
      ],
      seenCallIds: ['c1'],
    } satisfies SessionSnapshot)
    expect(parsed?.threadId).toBe('t')
    expect(parsed?.seenCallIds).toEqual(['c1'])
  })

  it('drops forged parts but keeps the rest of the conversation', () => {
    const parsed = parseSessionSnapshot({
      threadId: 't',
      messages: [
        {
          id: 'u',
          role: 'user',
          modality: 'text',
          source: 'host',
          parts: [
            { type: 'text', text: 'keep me' },
            { type: 'source', id: 's1', title: 'T', trail: 'abc' },
            { type: 'source', id: 's2', title: 'T', url: {} },
            { type: 'image', mimeType: 'image/png', source: {} },
            { type: 'data', name: 'surface', value: null },
          ],
          createdAt: 1,
        },
        {
          id: 'a',
          role: 'assistant',
          parts: [{ type: 'text', text: 'also kept' }],
          createdAt: 2,
        },
      ],
    })
    expect(parsed?.messages).toHaveLength(2)
    expect(parsed?.messages[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'keep me' }] })
    expect(parsed?.messages[1]).toMatchObject({ role: 'assistant', parts: [{ type: 'text', text: 'also kept' }] })
  })

  it('accepts snapshots stored by storage plugins (omitted_media and surface parts)', () => {
    const raw = storableSnapshot({
      threadId: 't',
      messages: [
        {
          id: 'u',
          role: 'user',
          modality: 'text',
          source: 'host',
          parts: [
            { type: 'data', name: 'omitted_media', value: { type: 'image', mimeType: 'image/png' } },
          ],
          createdAt: 1,
        },
        {
          id: 'a',
          role: 'assistant',
          parts: [{ type: 'data', name: 'surface', value: { surfaceId: 's1', kind: 'component', component: 'Card', payload: { title: 'Hi' } } }],
          createdAt: 2,
        },
      ],
    })
    const parsed = parseSessionSnapshot(raw)
    expect(parsed?.messages).toHaveLength(2)
    expect(parsed?.messages[0]).toMatchObject({ role: 'user', parts: [{ name: 'omitted_media' }] })
    expect(parsed?.messages[1]).toMatchObject({ role: 'assistant', parts: [{ name: 'surface' }] })
  })
})

describe('parameters-only validation (D3)', () => {
  it('accepts parameters schemas with up to 1024 enum values', async () => {
    const values = Array.from({ length: 100 }, (_, i) => `v${i}`)
    const h4b = await createH4B({
      actions: [
        {
          name: 'pick',
          description: 'Pick',
          parameters: { type: 'object', properties: { tag: { type: 'string', enum: values } } },
          handler: (args) => args,
        },
      ],
    }).start()
    await expect(h4b.actions.invoke('pick', { tag: 'v50' }, { origin: 'user', callId: 'e1' })).resolves.toEqual({ tag: 'v50' })
  })

  it('validates parameters schema at runtime', async () => {
    const h4b = await createH4B({
      actions: [
        {
          name: 'pay',
          description: 'Pay',
          parameters: {
            type: 'object',
            properties: { amount: { type: 'number' }, mode: { type: 'string', enum: ['a', 'b'] } },
            required: ['amount'],
            additionalProperties: false,
          },
          handler: (args) => args,
        },
      ],
    }).start()
    await expect(h4b.actions.invoke('pay', { amount: '999; drop' }, { origin: 'user', callId: '1' })).rejects.toThrow(
      /Invalid arguments/i,
    )
    await expect(h4b.actions.invoke('pay', { amount: 1, extra: true }, { origin: 'user', callId: '2' })).rejects.toThrow(
      /not allowed/i,
    )
    await expect(h4b.actions.invoke('pay', { amount: 1, mode: 'z' }, { origin: 'user', callId: '3' })).rejects.toThrow(
      /allowed values/i,
    )
    await expect(h4b.actions.invoke('pay', { mode: 'a' }, { origin: 'user', callId: '4' })).rejects.toThrow(/required/i)
    expect(await h4b.actions.invoke('pay', { amount: 2, mode: 'a' }, { origin: 'user', callId: '5' })).toEqual({
      amount: 2,
      mode: 'a',
    })
  })
})

describe('failed handler tool messages', () => {
  it('hides raw handler errors from tool history but keeps H4B validation errors', async () => {
    const transport = scripted([
      [
        { type: 'action.call', callId: 'f1', name: 'secret', args: {} },
        { type: 'action.call', callId: 'f2', name: 'typed', args: { n: 'x' } },
      ],
    ])
    const h4b = await createH4B({
      plugins: [withTransport(transport)],
      actions: [
        {
          name: 'secret',
          description: 'Secret',
          handler: () => {
            throw new Error('internal stack trace at /etc/passwd')
          },
        },
        {
          name: 'typed',
          description: 'Typed',
          input: z.object({ n: z.number() }),
          handler: () => 1,
        },
      ],
    }).start()
    h4b.send('run')
    await idle(h4b)
    const tools = h4b.messages.filter((m) => m.role === 'tool')
    expect(tools[0]).toMatchObject({ error: 'Action "secret" failed' })
    expect(tools[1]?.error).toMatch(/Invalid arguments/)
  })
})

describe('void action tool messages', () => {
  it('persists and restores a conversation with a void action result', async () => {
    let saved: SessionSnapshot | null = null
    const storage = definePlugin({
      name: 'mem',
      apply(ctx) {
        ctx.provide('storage', {
          load: () => (saved ? structuredClone(saved) : null),
          save: (s) => void (saved = structuredClone(s)),
          clear: () => void (saved = null),
        })
      },
    })
    const call: Stimulus = { type: 'action.call', callId: 'v1', name: 'noop', args: {} }
    const transport = scripted([[call]])
    const h4b = await createH4B({
      plugins: [withTransport(transport), storage()],
      actions: [{ name: 'noop', description: 'Does nothing', handler: () => {} }],
    }).start()
    h4b.send('go')
    await idle(h4b)
    const tool = h4b.messages.find((m) => m.role === 'tool' && m.name === 'noop')
    expect(tool).toMatchObject({ result: null })
    await h4b.persist()
    expect(saved).not.toBeNull()
    const parsed = parseSessionSnapshot(saved!)
    expect(parsed).toBeDefined()
    expect(parsed!.messages.some((m) => m.role === 'tool')).toBe(true)
    // Verify a fresh instance restores the conversation
    const h4b2 = await createH4B({
      plugins: [storage()],
    }).start()
    expect(h4b2.messages.some((m) => m.role === 'tool')).toBe(true)
    expect(h4b2.messages).toHaveLength(h4b.messages.length)
  })
})
