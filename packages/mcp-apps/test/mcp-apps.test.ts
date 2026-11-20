// @vitest-environment jsdom
import { createH4B, textOf, type Transport } from '@handsforbots/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCsp,
  filterCspDomains,
  intersectCspDomains,
  isValidCspDomain,
  mountMcpApp,
  PROTOCOL_VERSION,
  unmountMcpApp,
  withCsp,
} from '../src/index.js'

afterEach(() => {
  document.body.innerHTML = ''
})

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

const waitFor = async (check: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await tick(5)
  }
  throw new Error('condition not met before timeout')
}

const bridgeNonce = (srcdoc: string) => {
  const m = /const nonce=([^;]+);/.exec(srcdoc)
  if (!m) throw new Error('bridge nonce not found in srcdoc')
  return JSON.parse(m[1]!) as string
}

/** Completes the MessageChannel handshake the injected bridge script would send. */
function completeHandshake(iframe: HTMLIFrameElement) {
  const view = iframe.contentWindow!
  const channel = new MessageChannel()
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { method: 'h4b/mcp-app/handshake', nonce: bridgeNonce(iframe.srcdoc) },
      source: view,
      ports: [channel.port2],
    }),
  )
  channel.port2.start()
  return channel
}

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
    { allowTools: ['filter_orders'], allowMessages: true, allowModelContext: true, ...options },
  ) as HTMLIFrameElement
  document.body.append(iframe)
  const channel = completeHandshake(iframe)
  const received: any[] = []
  channel.port1.addEventListener('message', (e) => received.push(e.data))
  channel.port1.start()
  const send = (data: object) => channel.port1.postMessage({ jsonrpc: '2.0', ...data })
  const reply = async (id: number) => {
    await waitFor(() => received.some((m) => m.id === id))
    return received.find((m) => m.id === id)!
  }
  const triggerLoad = () => iframe.dispatchEvent(new Event('load'))
  return { h4b, iframe, send, reply, received, filter, requests, triggerLoad, channel }
}

describe('MCP Apps host', () => {
  it('sandboxes the app without forms by default and injects a restrictive CSP', async () => {
    const { iframe } = await setup()
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.srcdoc).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'/)
    expect(buildCsp({ connectDomains: ['https://api.x'] })).toContain('connect-src https://api.x')
    expect(buildCsp()).toContain("form-action 'none'")
    expect(withCsp('<p>bare</p>', 'x')).toBe('<!doctype html><meta http-equiv="Content-Security-Policy" content="x"><p>bare</p>')
  })

  it('adds allow-forms to sandbox only when allowForms is true', async () => {
    const { iframe } = await setup({ allowForms: true })
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms')
  })

  it.each([
    ['a fragment', '<p>hi</p><script>fetch("https://evil.test")</script>'],
    ['a full document', '<!DOCTYPE html><html lang="en"><head><title>t</title><script>1</script></head><body></body></html>'],
    ['comment closes at <!-->', '<!--><script>fetch("https://evil.test")</script><!-- --><!doctype html><html><head></head></html>'],
    ['malformed comment <!--->', '<!---><script>1</script>'],
    ['comment end --!>', '--!><script>1</script>'],
    ['comments before the doctype', '<!-- app --><!doctype html><html><head><script>1</script></head></html>'],
    ['<head> inside a comment', '<!-- <head> --><script>fetch("https://evil.test")</script><head></head>'],
    ['<html> inside a comment', '<!-- <html> --><script>1</script>'],
    ['a script before <head>', '<html><script>1</script><head></head><body></body></html>'],
    ['a <header> before <head>', '<header>h</header><script>1</script><head></head>'],
    ['<head> in a script string', '<script>const s = "<head>"</script><head></head>'],
    ['upper-case tags', '<HTML><HEAD><SCRIPT>1</SCRIPT></HEAD></HTML>'],
    ['its own looser policy', '<head><meta http-equiv="Content-Security-Policy" content="default-src *"><script>1</script></head>'],
    ['plaintext escape after script', '<!--><script>document.write("<plaintext>")</script><!doctype html>'],
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

  describe('filterCspDomains', () => {
    it('accepts https host entries and rejects injection', () => {
      expect(filterCspDomains(['https://cdn.example', 'https://*.assets.example', 'https://host:443'])).toEqual([
        'https://cdn.example',
        'https://*.assets.example',
        'https://host:443',
      ])
      expect(filterCspDomains(['https://cdn.example; connect-src *', 'http://insecure', 'https://a.b/path', "'unsafe-eval'", '*', 'data:', 'https://a.b\n'])).toEqual([])
      expect(buildCsp({ resourceDomains: ['https://cdn.example; connect-src *'] })).not.toContain('connect-src *')
    })

    it('intersects with allowDomains when provided', () => {
      const policy = buildCsp(
        { connectDomains: ['https://api.one', 'https://evil.two'], resourceDomains: ['https://cdn.one'] },
        ['https://api.one', 'https://cdn.one'],
      )
      expect(policy).toContain('connect-src https://api.one')
      expect(policy).not.toContain('evil.two')
      expect(policy).toContain('https://cdn.one')
      expect(isValidCspDomain('https://a.b:99999')).toBe(false)
      expect(isValidCspDomain('HTTPS://UPPER.test')).toBe(false)
    })

    it('treats an empty allowDomains list as deny-all', () => {
      expect(intersectCspDomains(['https://api.one', 'https://evil.two'], [])).toEqual([])
      expect(buildCsp({ connectDomains: ['https://api.one'] }, [])).toContain("connect-src 'none'")
    })
  })

  it('initializes, then delivers tool input and result only after initialized', async () => {
    const { send, reply, received } = await setup()
    send({ id: 1, method: 'ui/initialize', params: { protocolVersion: PROTOCOL_VERSION, appCapabilities: {} } })
    const init = await reply(1)
    expect(init.result).toMatchObject({ protocolVersion: PROTOCOL_VERSION, hostInfo: { name: 'handsforbots' }, hostContext: { displayMode: 'inline' } })
    expect(received.some((m: any) => m.method === 'ui/notifications/tool-input')).toBe(false)
    send({ method: 'ui/notifications/initialized' })
    await waitFor(() => received.some((m) => m.method === 'ui/notifications/tool-input'))
    expect(received.filter((m: any) => m.method).map((m: any) => [m.method, m.params])).toEqual([
      ['ui/notifications/tool-input', { arguments: { period: 'q3' } }],
      ['ui/notifications/tool-result', { content: [{ type: 'text', text: '{"total":10}' }], structuredContent: { total: 10 } }],
    ])
  })

  it('bridges tools/call to allowed H4B actions only, recorded as agent actions', async () => {
    const { h4b, send, reply, filter, received } = await setup()
    send({ id: 1, method: 'ui/initialize', params: { protocolVersion: PROTOCOL_VERSION, appCapabilities: {} } })
    await reply(1)
    send({ method: 'ui/notifications/initialized' })
    await waitFor(() => received.some((m) => m.method === 'ui/notifications/tool-input'))
    send({ id: 2, method: 'tools/call', params: { name: 'filter_orders', arguments: { status: 'late' } } })
    expect((await reply(2)).result).toEqual({ content: [{ type: 'text', text: '{"count":3}' }], structuredContent: { count: 3 } })
    expect(filter).toHaveBeenCalledWith({ status: 'late' }, expect.objectContaining({ origin: 'agent' }))
    expect(h4b.messages.at(-1)).toMatchObject({ role: 'tool', route: 'agent', name: 'filter_orders' })

    send({ id: 3, method: 'tools/call', params: { name: 'delete_all', arguments: {} } })
    expect((await reply(3)).error).toMatchObject({ code: -32601 })
  })

  it('tears down the bridge after a second iframe load', async () => {
    const { iframe, send, reply, filter, received, triggerLoad } = await setup({ allowTools: ['filter_orders'] })
    send({ id: 1, method: 'ui/initialize', params: { protocolVersion: PROTOCOL_VERSION, appCapabilities: {} } })
    await reply(1)
    send({ method: 'ui/notifications/initialized' })
    await waitFor(() => received.some((m) => m.method === 'ui/notifications/tool-input'))
    triggerLoad()
    triggerLoad()
    received.length = 0
    send({ id: 40, method: 'tools/call', params: { name: 'filter_orders', arguments: {} } })
    await waitFor(() => received.some((m) => m.id === 40), 500).catch(() => undefined)
    expect(filter).not.toHaveBeenCalled()
    expect(received).toEqual([])
    unmountMcpApp(iframe)
  })

  it('handles messages, links, context and sizing when opted in', async () => {
    const { h4b, iframe, send, reply, requests } = await setup()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    send({ id: 4, method: 'ui/message', params: { role: 'user', content: { type: 'text', text: 'Explique o pico de agosto' } } })
    await reply(4)
    await waitFor(() => requests.length === 1, 10_000)
    expect(requests).toEqual(['Explique o pico de agosto'])

    send({ id: 5, method: 'ui/open-link', params: { url: 'https://example.com' } })
    await reply(5)
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer')
    send({ id: 6, method: 'ui/open-link', params: { url: 'javascript:alert(1)' } })
    expect((await reply(6)).error).toBeDefined()
    send({ id: 61, method: 'ui/open-link', params: { url: 'https://user:pass@evil.test' } })
    expect((await reply(61)).error).toMatchObject({ code: -32602 })

    send({ id: 7, method: 'ui/update-model-context', params: { structuredContent: { selected: 'agosto' } } })
    await reply(7)
    expect(h4b.context.find((s) => s.key === 'mcp-app.sales_chart')?.parts[0]).toEqual({ type: 'data', name: 'sales_chart', value: { selected: 'agosto' } })

    send({ method: 'ui/notifications/size-changed', params: { width: 300, height: 5000 } })
    await waitFor(() => iframe.style.height === '600px')
    expect(iframe.style.height).toBe('600px')
    send({ id: 8, method: 'nope/unknown' })
    expect((await reply(8)).error).toMatchObject({ code: -32601 })
  })

  it('rejects ui/message by default and enforces rate and size limits', async () => {
    const off = await setup({ allowMessages: false })
    off.send({ id: 10, method: 'ui/message', params: { content: { type: 'text', text: 'hi' } } })
    expect((await off.reply(10)).error).toMatchObject({ code: -32601 })

    const limited = await setup({ allowMessages: true, messageRate: { intervalMs: 5000, maxPerMount: 1 } })
    limited.send({ id: 11, method: 'ui/message', params: { content: { type: 'text', text: 'one' } } })
    await limited.reply(11)
    limited.send({ id: 12, method: 'ui/message', params: { content: { type: 'text', text: 'two' } } })
    expect((await limited.reply(12)).error).toMatchObject({ code: -32602 })

    const big = await setup({ allowMessages: true })
    big.send({ id: 13, method: 'ui/message', params: { content: { type: 'text', text: 'x'.repeat(4001) } } })
    expect((await big.reply(13)).error).toMatchObject({ code: -32602 })
  })

  it('uses confirmLink before opening and rate-limits links', async () => {
    const confirm = vi.fn(async () => false)
    const { send, reply } = await setup({ confirmLink: confirm })
    send({ id: 50, method: 'ui/open-link', params: { url: 'https://example.com' } })
    expect((await reply(50)).error).toMatchObject({ code: -32603 })
    expect(confirm).toHaveBeenCalled()

    const limited = await setup({ linkRate: { intervalMs: 60_000, maxPerMount: 1 } })
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    limited.send({ id: 51, method: 'ui/open-link', params: { url: 'https://a.test' } })
    await limited.reply(51)
    limited.send({ id: 52, method: 'ui/open-link', params: { url: 'https://b.test' } })
    expect((await limited.reply(52)).error).toMatchObject({ code: -32602 })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('counts a link against the rate limit while confirmLink is still deciding', async () => {
    let approve!: (ok: boolean) => void
    const confirmLink = vi.fn(() => new Promise<boolean>((resolve) => (approve = resolve)))
    const { send, reply } = await setup({ confirmLink, linkRate: { intervalMs: 60_000, maxPerMount: 1 } })
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    send({ id: 60, method: 'ui/open-link', params: { url: 'https://a.test' } })
    await waitFor(() => confirmLink.mock.calls.length === 1)
    send({ id: 61, method: 'ui/open-link', params: { url: 'https://b.test' } })
    expect((await reply(61)).error).toMatchObject({ code: -32602 })
    approve(true)
    await reply(60)
    expect(confirmLink).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('accepts only the first handshake with the mount nonce', async () => {
    const filter = vi.fn(() => ({ count: 1 }))
    const h4b = await createH4B({
      actions: [{ name: 'filter_orders', description: 'Filter', exposeTo: ['agent'], handler: filter }],
    }).start()
    const iframe = mountMcpApp(
      h4b,
      { html: '<html><head></head><body>app</body></html>' },
      { allowTools: ['filter_orders'] },
    ) as HTMLIFrameElement
    document.body.append(iframe)
    const rogue = new MessageChannel()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { method: 'h4b/mcp-app/handshake', nonce: 'wrong' },
        source: iframe.contentWindow!,
        ports: [rogue.port2],
      }),
    )
    rogue.port2.start()
    const channel = completeHandshake(iframe)
    const received: unknown[] = []
    channel.port1.addEventListener('message', (e) => received.push(e.data))
    channel.port1.start()
    channel.port1.postMessage({
      jsonrpc: '2.0',
      id: 30,
      method: 'ui/initialize',
      params: { protocolVersion: PROTOCOL_VERSION, appCapabilities: {} },
    })
    await waitFor(() => received.some((m: any) => m.id === 30))
    channel.port1.postMessage({ jsonrpc: '2.0', id: 31, method: 'ui/notifications/initialized' })
    channel.port1.postMessage({
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: { name: 'filter_orders', arguments: {} },
    })
    await waitFor(() => received.some((m: any) => m.id === 32))
    expect(filter).toHaveBeenCalled()
    rogue.port1.start()
    const rogueReplies: unknown[] = []
    rogue.port1.addEventListener('message', (e) => rogueReplies.push(e.data))
    rogue.port1.postMessage({
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: { name: 'filter_orders', arguments: {} },
    })
    await tick(50)
    expect(rogueReplies).toEqual([])
    expect(filter).toHaveBeenCalledTimes(1)
  })

  it('ignores JSON-RPC on the window after the handshake', async () => {
    const { iframe, received, filter } = await setup()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'filter_orders', arguments: {} } },
        source: iframe.contentWindow!,
      }),
    )
    await waitFor(() => filter.mock.calls.length > 0, 300).catch(() => undefined)
    expect(filter).not.toHaveBeenCalled()
    expect(received).toEqual([])
  })

  it('requires allowModelContext and rejects oversized payloads', async () => {
    const allowed = await setup()
    allowed.send({ id: 20, method: 'ui/update-model-context', params: { structuredContent: { test: true } } })
    const res1 = await allowed.reply(20)
    expect(res1.error).toBeUndefined()
    expect(allowed.h4b.context.some((s) => s.key === 'mcp-app.sales_chart')).toBe(true)

    const forbidden = await setup({ allowModelContext: false })
    forbidden.send({ id: 21, method: 'ui/update-model-context', params: { structuredContent: { test: true } } })
    const res2 = await forbidden.reply(21)
    expect(res2.error).toMatchObject({ code: -32601 })

    const huge = 'x'.repeat(MAX_MODEL + 1)
    const big = await setup({ allowModelContext: true })
    big.send({ id: 22, method: 'ui/update-model-context', params: { structuredContent: { blob: huge } } })
    expect((await big.reply(22)).error).toMatchObject({ code: -32602 })
  })

  it('removes the message listener when unmounted from a shadow root', async () => {
    const h4b = await createH4B({}).start()
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const iframe = mountMcpApp(h4b, { html: '<body></body>' }, { allowTools: [] }) as HTMLIFrameElement
    root.append(iframe)
    document.body.append(host)

    host.remove()
    await waitFor(() => removeSpy.mock.calls.some((c) => c[0] === 'message'))
    removeSpy.mockRestore()
  })

  it('unmountMcpApp stops replies to the iframe', async () => {
    const { iframe, send, received } = await setup()
    unmountMcpApp(iframe)
    send({ id: 90, method: 'ui/initialize', params: { protocolVersion: PROTOCOL_VERSION, appCapabilities: {} } })
    await waitFor(() => received.some((m) => m.id === 90), 500).catch(() => undefined)
    expect(received).toEqual([])
  })
})

const MAX_MODEL = 16 * 1024