// Real-browser check of the MCP App sandbox (XSS review, ROADMAP section 3):
// jsdom applies no CSP, so these tests mount apps in Chromium and let a script
// inside each one try to reach the network and the host page.
import { createH4B } from '@handsforbots/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountMcpApp, PROTOCOL_VERSION } from '../src/index.js'

type Report = { connect: 'allowed' | 'blocked'; parent: 'reachable' | 'isolated' }

// Each app reports to the host what its script could do.
const PROBE = `<script>
  let parentAccess = 'isolated'
  try { parent.document.title; parentAccess = 'reachable' } catch {}
  fetch('data:,x').then(
    () => parent.postMessage({ probe: { connect: 'allowed', parent: parentAccess } }, '*'),
    () => parent.postMessage({ probe: { connect: 'blocked', parent: parentAccess } }, '*'),
  )
</script>`

// HTML shapes in which the policy used to end up after the app's script (fixed in withCsp).
const SHAPES: [string, (probe: string) => string][] = [
  ['a fragment', (p) => `<p>hi</p>${p}`],
  ['a full document', (p) => `<!DOCTYPE html><html lang="en"><head><title>t</title>${p}</head><body></body></html>`],
  ['HTML comment closes at <!-->', (p) => `<!-->${p}<!-- --><!doctype html><html><head></head><body></body></html>`],
  ['malformed comment <!--->', (p) => `<!--->${p}`],
  ['comment terminator --!>', (p) => `--!>${p}`],
  ['comments before the doctype', (p) => `<!-- app --><!doctype html><html><head>${p}</head></html>`],
  ['<head> inside a comment', (p) => `<!-- <head> -->${p}<head></head>`],
  ['<html> inside a comment', (p) => `<!-- <html> -->${p}`],
  ['a script before <head>', (p) => `<html>${p}<head></head><body></body></html>`],
  ['a <header> before <head>', (p) => `<header>h</header>${p}<head></head>`],
  ['<head> in a script string', (p) => `<script>const s = "<head>"</script>${p}<head></head>`],
  ['upper-case tags', (p) => `<HTML><HEAD>${p}</HEAD></HTML>`],
  ['its own looser policy', (p) => `<head><meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline'; connect-src *">${p}</head>`],
]

const mounted: HTMLElement[] = []
afterEach(() => {
  for (const element of mounted.splice(0)) element.remove()
})

const waitFor = (check: () => boolean, timeoutMs = 5000) =>
  new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      if (check()) return resolve()
      if (Date.now() >= deadline) return reject(new Error('condition not met before timeout'))
      requestAnimationFrame(poll)
    }
    poll()
  })

/** Mounts the app and resolves with its report; rejects if it never reports. */
function run(html: string, csp?: { connectDomains?: string[] }): Promise<Report> {
  const h4b = createH4B({ memory: false })
  return new Promise<Report>((resolve, reject) => {
    let iframe: HTMLElement
    const timer = setTimeout(() => reject(new Error('the app never reported')), 5000)
    const onMessage = (event: MessageEvent) => {
      if (event.source !== (iframe as HTMLIFrameElement).contentWindow || !event.data?.probe) return
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(event.data.probe)
    }
    window.addEventListener('message', onMessage)
    iframe = mountMcpApp(h4b, { html, csp })
    mounted.push(iframe)
    document.body.append(iframe)
  })
}

describe('MCP App sandbox in a real browser', () => {
  it.each(SHAPES)('blocks the network and isolates the host page in %s', async (_, shape) => {
    expect(await run(shape(PROBE))).toEqual({ connect: 'blocked', parent: 'isolated' })
  })

  it('keeps standards mode when the app declares its own doctype', async () => {
    const h4b = createH4B({ memory: false })
    const iframe = mountMcpApp(h4b, { html: '<!doctype html><html><head></head><body><script>parent.postMessage({mode:document.compatMode}, "*")</script></body></html>' })
    mounted.push(iframe)
    document.body.append(iframe)
    const mode = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no compatMode report')), 5000)
      const onMessage = (event: MessageEvent) => {
        if (event.source !== (iframe as HTMLIFrameElement).contentWindow || !event.data?.mode) return
        clearTimeout(timer)
        window.removeEventListener('message', onMessage)
        resolve(event.data.mode)
      }
      window.addEventListener('message', onMessage)
    })
    expect(mode).toBe('CSS1Compat')
  })

  it('lets the app connect where its csp allows, still isolated (control)', async () => {
    const probe = `<script>
  fetch('https://example.com', { mode: 'no-cors' }).then(
    () => parent.postMessage({ probe: { connect: 'allowed', parent: 'isolated' } }, '*'),
    () => parent.postMessage({ probe: { connect: 'blocked', parent: 'isolated' } }, '*'),
  )
</script>`
    expect(await run(probe, { connectDomains: ['https://example.com'] })).toEqual({ connect: 'allowed', parent: 'isolated' })
  })

  it('runs tools/call after initialize in a real browser', async () => {
    const handler = vi.fn(() => ({ ok: true }))
    const h4b = await createH4B({
      actions: [{ name: 'work', description: 'ok', exposeTo: ['agent'], handler }],
    }).start()
    const html = `<script>
const rpc = (msg) => new Promise((resolve) => {
  const onMsg = (e) => {
    if (e.data?.id === msg.id) { removeEventListener('message', onMsg); resolve(e.data) }
  }
  addEventListener('message', onMsg)
  parent.postMessage(msg, '*')
})
;(async () => {
  await rpc({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '${PROTOCOL_VERSION}', appCapabilities: {} } })
  parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*')
  await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'work', arguments: {} } })
  parent.postMessage({ done: true }, '*')
})()
</script>`
    const iframe = mountMcpApp(h4b, { html }, { allowTools: ['work'] })
    mounted.push(iframe)
    document.body.append(iframe)
    await waitFor(() => handler.mock.calls.length > 0, 8000)
    expect(handler).toHaveBeenCalled()
  })

  it('ignores tools/call after navigation when window.parent was replaced', async () => {
    const handler = vi.fn(() => ({ ok: true }))
    const h4b = await createH4B({
      actions: [{ name: 'pwn', description: 'nope', exposeTo: ['agent'], handler }],
    }).start()
  const second = encodeURIComponent(
    '<script>parent.postMessage({ jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "pwn", arguments: {} } }, "*")</script>',
  )
    const html = `<script>
const rpc = (msg) => new Promise((resolve) => {
  const onMsg = (e) => {
    if (e.data?.id === msg.id) { removeEventListener('message', onMsg); resolve(e.data) }
  }
  addEventListener('message', onMsg)
  parent.postMessage(msg, '*')
})
;(async () => {
  await rpc({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '${PROTOCOL_VERSION}', appCapabilities: {} } })
  parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*')
  window.parent = { postMessage() {} }
  location.href = 'data:text/html,${second}'
})()
</script>`
    const iframe = mountMcpApp(h4b, { html }, { allowTools: ['pwn'] }) as HTMLIFrameElement
    mounted.push(iframe)
    let loads = 0
    iframe.addEventListener('load', () => { loads++ })
    document.body.append(iframe)
    await waitFor(() => loads >= 1, 8000)
    await waitFor(() => handler.mock.calls.length > 0, 2000).catch(() => undefined)
    expect(handler).not.toHaveBeenCalled()
  })

  it('drops the bridge after in-iframe navigation so tools/call from the new document is ignored', async () => {
    const handler = vi.fn(() => ({ ok: true }))
    const h4b = await createH4B({
      actions: [{ name: 'pwn', description: 'nope', exposeTo: ['agent'], handler }],
    }).start()
    const second = encodeURIComponent(
      '<script>parent.postMessage({ jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "pwn", arguments: {} } }, "*")</script>',
    )
    const html = `<script>location.href = 'data:text/html,${second}'</script>`
    const iframe = mountMcpApp(h4b, { html }, { allowTools: ['pwn'] }) as HTMLIFrameElement
    mounted.push(iframe)
    let loads = 0
    iframe.addEventListener('load', () => {
      loads++
    })
    document.body.append(iframe)
    await waitFor(() => loads >= 1, 8000)
    await waitFor(() => handler.mock.calls.length > 0, 2000).catch(() => undefined)
    expect(handler).not.toHaveBeenCalled()
  })
})