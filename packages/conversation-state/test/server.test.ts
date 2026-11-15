import { createH4B, type TurnRequest } from '@handsforbots/core'
import { reply, scriptedTransport, waitForIdle } from '@handsforbots/testkit'
import { toAguiInput } from '@handsforbots/transport-agui'
import { defaultBody } from '@handsforbots/transport-http'
import { describe, expect, it } from 'vitest'
import { conversationState } from '../src/index.js'
import { conversationStatePrompt, readConversationState, stateItems, stateUpdateSchema } from '../src/server.js'

async function request(): Promise<TurnRequest> {
  const transport = scriptedTransport(() => reply('ok'))
  const h4b = await createH4B({ memory: false, plugins: [conversationState()] }).start()
  h4b.provide('transport', transport)
  h4b.get('conversationState')!.update({
    ops: [
      { op: 'set', section: 'topic', text: 'Terraform da Acme' },
      { op: 'add', section: 'entities', text: 'Terraform', scope: 'acme', attrs: { version: '1.9' } },
      { op: 'add', section: 'entities', text: 'Terraform', scope: 'globex' },
    ],
  })
  await h4b.send('oi')
  await waitForIdle(h4b)
  return transport.requests[0]!
}

describe('readConversationState', () => {
  it('reads the state from the AG-UI context, the HTTP context object and signals', async () => {
    const req = await request()
    const fromAgui = readConversationState((await toAguiInput(req)).context)
    const fromHttp = readConversationState(JSON.parse(JSON.stringify(defaultBody(req))).context)
    const fromSignals = readConversationState(req.context)
    expect(fromAgui).toEqual(fromSignals)
    expect(fromHttp).toEqual(fromSignals)
    expect(fromSignals).toMatchObject({ revision: 1, sections: { topic: { text: 'Terraform da Acme', origin: 'app' } } })
  })

  it('filters items by scope, so one project is not mixed with another', async () => {
    const view = readConversationState((await request()).context)
    expect(stateItems(view, { scope: 'acme' })).toEqual([expect.objectContaining({ section: 'entities', text: 'Terraform', attrs: { version: '1.9' } })])
    expect(stateItems(view)).toHaveLength(3)
  })

  it('drops malformed items, keeps chosen sections and never throws', () => {
    const view = readConversationState({
      revision: 3,
      sections: { facts: [{ id: 'f1', text: 'ok', origin: 'evil', confidence: 'max', attrs: { a: {} } }, { id: 2 }], topic: null, extra: [] },
    }, { sections: ['facts', 'topic'] })
    expect(view).toEqual({ revision: 3, sections: { facts: [{ id: 'f1', text: 'ok', origin: 'unsourced', confidence: 'low' }], topic: null } })
    for (const junk of [undefined, null, 'conversation.state: {', [{ value: 3 }], { revision: -1, sections: {} }]) expect(readConversationState(junk)).toBeUndefined()
  })

  it('gives the model the update schema and instructions', () => {
    const schema = stateUpdateSchema() as { properties: { ops: { items: { properties: { section: { enum: string[] } } } } } }
    expect(schema.properties.ops.items.properties.section.enum).toEqual(['topic', 'goal', 'depth', 'entities', 'decisions', 'facts', 'pending'])
    expect(conversationStatePrompt()).toMatch(/verbatim quote/)
  })
})
