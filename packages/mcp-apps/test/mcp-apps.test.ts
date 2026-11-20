// @vitest-environment jsdom
import { createH4B, textOf, type Transport } from '@handsforbots/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCsp, mountMcpApp, PROTOCOL_VERSION, withCsp } from '../src/index.js'

afterEach(() => {
  document.body.innerHTML = ''
})

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** Mounts an app and returns helpers to act as the View inside the iframe. */
async function setup(options = {}, props = {}) {
  const filter = vi.fn(({ status }: { status: string }) => ({ count: status === 'late' ? 3 : 0 }))
  const requests: string[] = []
  const transport: Transport = { name: 't', async *run(r) { requests.push(textOf(r.messages.at(-1)!)) } }
  const h4b = await createH4B({
    actions: [
      { name: 'filter_orders', description: 'Filter', exposeTo: ['assistant', 'user', 'agent'], handler: filter },
      { name: 'delete_all', description: 'Delete all', exposeTo: ['agent'], handler: vi.fn() },
    ],
  }).start()
  h4b.provide('transport', transport)
  const iframe = mountMcpApp(
    h4b,
    { html: '<html><head></head><body>app</body></html>', toolName: 'sales_chart', input: { period: 'q3' }, result: { total: 10 }, ...props },
    { allowTools: ['filter_orders'], ...options },
  ) as HTMLIFrameElement
  document.body.append(iframe)
  const view = iframe.contentWindow!
  const received: any[] = []
  vi.spyOn(view, 'postMessage').mockImplementation((data: any) => void received.push(data))
  const send = (data: object) => window.dispatchEvent(new MessageEvent('message', { data: { jsonrpc: '2.0', ...data }, source: view }))
  const reply = async (id: number) => {
    for (let i = 0; i < 50 && !received.some((m) => m.id === id); i++) await tick(2)
    return received.find((m) => m.id === id)
  }
  return { h4b, iframe, send, reply, received, filter, requests }
}

describe('MCP Apps host', () => {
  it('sandboxes the app and injects a restrictive CSP', async () => {
    const { iframe } = await setup()
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms')
    expect(iframe.srcdoc).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'/)
    expect(buildCsp({ connectDomains: ['https://api.x'] })).toContain('connect-src https://api.x')
    expect(withCsp('<p>bare</p>', 'x')).toBe('<!doctype html><meta http-equiv="Content-Security-Policy" content="x"><p>bare</p>')
  })

  // The policy only covers what the parser reads after it, and a CSP <meta> outside <head> is ignored.
  it.each([
    ['a fragment', '<p>hi</p><script>fetch("https://evil.test")</script>'],
    ['a full document', '<!DOCTYPE html><html lang="en"><head><title>t</title><script>1</script></head><body></body></html>'],
    ['comments before the doctype', '<!-- app --><!doctype html><html><head><script>1</script></head></html>'],
    ['<head> inside a comment', '<!-- <head> --><script>fetch("https://evil.test")</script><head></head>'],
    ['<html> inside a comment', '<!-- <html> --><script>1</script>'],
    ['a script before <head>', '<html><script>1</script><head></head><body></body></html>'],
    ['a <header> before <head>', '<header>h</header><script>1</script><head></head>'],
    ['<head> in a script string', '<script>const s = "<head>"</script><head></head>'],
    ['upper-case tags', '<HTML><HEAD><SCRIPT>1</SCRIPT></HEAD></HTML>'],
    ['its own looser policy', '<head><meta http-equiv="Content-Security-Policy" content="default-src *"><script>1</script></head>'],
  ])('puts the policy before anything else in %s', (_, html) => {
    const doc = new DOMParser().parseFromString(withCsp(html, "default-src 'none'"), 'text/html')
    const first = doc.querySelector('head > *, body *')
    expect(first?.outerHTML).toBe(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'">`)
    expect(doc.compatMode).toBe('CSS1Compat')
  })

  it('escapes quotes in the policy', () => {
    const doc = new DOMParser().parseFromString(withCsp('<p>x</p>', `img-src "a"><script>1</script>`), 'text/html')
    expect(doc.querySelector('meta')!.getAttribute('content')).toBe(`img-src "a"><script>1</script>`)
    expect(doc.querySelectorAll('script')).toHaveLength(0)
  })

  it('initializes, then delivers tool input and result only after initialized', async () => {
    const { send, reply, received } = await setup()
    send({ id: 1, method: 'ui/initialize', params: { protocolVersion: PROTOCOL_VERSION, appCapabilities: {} } })
    const init = await reply(1)
    expect(init.result).toMatchObject({ protocolVersion: PROTOCOL_VERSION, hostInfo: { name: 'handsforbots' }, hostContext: { displayMode: 'inline' } })
    expect(received.some((m) => m.method === 'ui/notifications/tool-input')).toBe(false)
    send({ method: 'ui/notifications/initialized' })
    await tick()
    expect(received.filter((m) => m.method).map((m) => [m.method, m.params])).toEqual([
      ['ui/notifications/tool-input', { arguments: { period: 'q3' } }],
      ['ui/notifications/tool-result', { content: [{ type: 'text', text: '{"total":10}' }], structuredContent: { total: 10 } }],
    ])
  })

  it('bridges tools/call to allowed H4B actions only, recorded as agent actions', async () => {
    const { h4b, send, reply, filter } = await setup()
    send({ id: 2, method: 'tools/call', params: { name: 'filter_orders', arguments: { status: 'late' } } })
    expect((await reply(2)).result).toEqual({ content: [{ type: 'text', text: '{"count":3}' }], structuredContent: { count: 3 } })
    expect(filter).toHaveBeenCalledWith({ status: 'late' }, expect.objectContaining({ origin: 'agent' }))
    expect(h4b.messages.at(-1)).toMatchObject({ role: 'tool', route: 'agent', name: 'filter_orders' })

    send({ id: 3, method: 'tools/call', params: { name: 'delete_all', arguments: {} } })
    expect((await reply(3)).error).toMatchObject({ code: -32601 })
  })

  it('handles messages, links, context and sizing', async () => {
    const { h4b, iframe, send, reply, requests } = await setup()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    send({ id: 4, method: 'ui/message', params: { role: 'user', content: { type: 'text', text: 'Explique o pico de agosto' } } })
    await reply(4)
    await h4b.when('turn.status', (s) => s.phase === 'done')
    expect(requests).toEqual(['Explique o pico de agosto'])

    send({ id: 5, method: 'ui/open-link', params: { url: 'https://example.com' } })
    await reply(5)
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    send({ id: 6, method: 'ui/open-link', params: { url: 'javascript:alert(1)' } })
    expect((await reply(6)).error).toBeDefined()

    send({ id: 7, method: 'ui/update-model-context', params: { structuredContent: { selected: 'agosto' } } })
    await reply(7)
    expect(h4b.context.find((s) => s.key === 'mcp-app.sales_chart')?.parts[0]).toEqual({ type: 'data', name: 'sales_chart', value: { selected: 'agosto' } })

    send({ method: 'ui/notifications/size-changed', params: { width: 300, height: 5000 } })
    await tick()
    expect(iframe.style.height).toBe('600px')
    send({ id: 8, method: 'nope/unknown' })
    expect((await reply(8)).error).toMatchObject({ code: -32601 })
  })

  it('ignores messages from other windows', async () => {
    const { send: _send, received, filter } = await setup()
    window.dispatchEvent(new MessageEvent('message', { data: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'filter_orders', arguments: {} } }, source: window }))
    await tick(10)
    expect(filter).not.toHaveBeenCalled()
    expect(received).toEqual([])
  })

  it('allows or forbids model context updates via allowModelContext', async () => {
    const allowed = await setup()
    allowed.send({ id: 20, method: 'ui/update-model-context', params: { structuredContent: { test: true } } })
    const res1 = await allowed.reply(20)
    expect(res1.error).toBeUndefined()
    expect(allowed.h4b.context.some((s) => s.key === 'mcp-app.sales_chart')).toBe(true)

    const forbidden = await setup({ allowModelContext: false })
    forbidden.send({ id: 21, method: 'ui/update-model-context', params: { structuredContent: { test: true } } })
    const res2 = await forbidden.reply(21)
    expect(res2.error).toMatchObject({ code: -32601 })
  })
})
