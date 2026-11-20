// @vitest-environment jsdom
import { createH4B, type Transport } from '@handsforbots/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { guided, queryDeep } from '../src/index.js'

beforeEach(() => {
  document.body.innerHTML = '<input id="outside" data-h4b-target="checkout" /><h4b-chat></h4b-chat>'
  document.querySelector('h4b-chat')!.attachShadow({ mode: 'open' }).innerHTML = '<input id="secret_in_widget">'
})
afterEach(() => {
  document.body.innerHTML = ''
})

async function setup(options = {}) {
  const h4b = createH4B({ plugins: [guided(options)] })
  h4b.provide('transport', { name: 't', async *run() {} } satisfies Transport)
  await h4b.start()
  return h4b
}

describe('guided security', () => {
  it('keeps the assistant out of the H4B widget shadow root, but not the integrator', async () => {
    expect(queryDeep('#secret_in_widget', document, true)).toBeNull()
    expect(queryDeep('#outside', document, true)).not.toBeNull()
    document.querySelector('h4b-chat')!.shadowRoot!.innerHTML = '<button data-h4b-target="mic">mic</button>'
    const h4b = await setup()
    await h4b.runAction('guided_highlight', { target: 'mic' }, { origin: 'assistant' })
    expect(document.querySelector('h4b-guide')).toBeNull()
    const out = await h4b.runAction('guided_highlight', { target: '[data-h4b-target="mic"]' }, { origin: 'user' })
    expect(out.result).toEqual({ shown: true })
    expect(document.querySelector('h4b-guide')).not.toBeNull()
  })

  it('does not reveal probe results to the assistant for arbitrary selectors', async () => {
    document.body.insertAdjacentHTML('beforeend', '<meta name="csrf-token" content="abc">')
    const h4b = await setup()
    const hit = await h4b.runAction('guided_highlight', { target: 'meta[name="csrf-token"][content^="a"]' }, { origin: 'assistant' })
    const miss = await h4b.runAction('guided_highlight', { target: 'meta[name="csrf-token"][content^="z"]' }, { origin: 'assistant' })
    expect(hit.result).toEqual(miss.result)
    expect(hit.result).toEqual({ shown: true })
    expect(document.querySelector('h4b-guide')).toBeNull()
  })

  it('highlights named targets for the assistant', async () => {
    const h4b = await setup()
    const out = await h4b.runAction('guided_highlight', { target: 'checkout', text: 'Pay here' }, { origin: 'assistant' })
    expect(out.result).toEqual({ shown: true })
    expect(document.querySelector('h4b-guide')).not.toBeNull()
  })

  it('keeps the selectors of your own tours when the assistant starts them, but not of steps it sends', async () => {
    const h4b = await setup({ tours: { intro: [{ text: 'Here', target: '#outside' }] } })
    await h4b.runAction('guided_tour', { name: 'intro' }, { origin: 'assistant' })
    const card = () => document.querySelector('h4b-guide')!.shadowRoot!.querySelector('.card')!
    expect(h4b.get('guided')!.getState()).toMatchObject({ active: true, tour: 'intro' })
    expect(card().classList.contains('modal')).toBe(false)
    h4b.get('guided')!.close()
    await h4b.runAction('guided_tour', { steps: [{ text: 'Probe', target: '#outside' }] }, { origin: 'assistant' })
    expect(card().classList.contains('modal')).toBe(true)
  })

  it('rejects tour names outside the enum at runtime', async () => {
    const h4b = await setup({ tours: { intro: [{ text: 'Hi' }] } })
    expect((await h4b.runAction('guided_tour', { name: 'intro' })).result).toMatchObject({ started: true })
    expect((await h4b.runAction('guided_tour', { name: 'nope' })).error).toContain('must be one of')
  })
})