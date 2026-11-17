// Real-browser check of the MCP App sandbox (XSS review, ROADMAP section 3):
// jsdom applies no CSP, so these tests mount apps in Chromium and let a script
// inside each one try to reach the network and the host page.
import { createH4B } from '@handsforbots/core'
import { afterEach, describe, expect, it } from 'vitest'
import { mountMcpApp } from '../src/index.js'

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

  it('lets the app connect where its csp allows, still isolated (control)', async () => {
    expect(await run(PROBE, { connectDomains: ['data:'] })).toEqual({ connect: 'allowed', parent: 'isolated' })
  })
})
