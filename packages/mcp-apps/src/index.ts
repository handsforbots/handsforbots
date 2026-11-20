import type { H4B } from '@handsforbots/core'
import { buildCspPolicy, escapeCspPolicy } from './csp.js'

export { buildCspPolicy as buildCsp, filterCspDomains, intersectCspDomains, isValidCspDomain } from './csp.js'

/** What a backend (acting as MCP client) sends in `ui.render` with component 'mcp-app'. */
export type McpAppProps = {
  /** HTML of the `ui://` resource (mimeType text/html;profile=mcp-app). */
  html: string
  /** Tool that produced it, its arguments and result (sent to the app after it initializes). */
  toolName?: string
  input?: Record<string, unknown>
  result?: { content?: unknown[]; structuredContent?: unknown; isError?: boolean } | unknown
  /** From the resource `_meta.ui.csp`. */
  csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[] }
  title?: string
}

export type MessageRateOptions = {
  /** Minimum milliseconds between accepted ui/message calls. Default 1000. */
  intervalMs?: number
  /** Maximum ui/message calls per mount. Default 20. */
  maxPerMount?: number
}

export type LinkRateOptions = {
  /** Minimum milliseconds between accepted ui/open-link calls. Default 1000. */
  intervalMs?: number
  /** Maximum ui/open-link calls per mount. Default 10. */
  maxPerMount?: number
}

export type McpAppOptions = {
  /** H4B actions the app may call with tools/call (origin 'agent'). Default: none. */
  allowTools?: string[]
  /** Let the app add messages to the conversation (ui/message). Default false (opt-in). */
  allowMessages?: boolean
  /** Let the app update the model context (ui/update-model-context). Default false (opt-in). */
  allowModelContext?: boolean
  /** Allow form submission inside the sandbox (allow-forms). Default false. */
  allowForms?: boolean
  /** When set, only declared CSP domains that appear in this list are applied (exact match). */
  allowDomains?: string[]
  maxHeight?: number
  initialHeight?: number
  messageRate?: MessageRateOptions
  linkRate?: LinkRateOptions
  /**
   * Called before opening a link; return false to refuse. Integrators should show the host to the user.
   */
  confirmLink?: (url: URL) => boolean | Promise<boolean>
}

export const PROTOCOL_VERSION = '2026-01-26'

const MAX_MESSAGE_CHARS = 4000
const MAX_MODEL_CONTEXT_BYTES = 16 * 1024

type JsonRpc = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown }

/** Injected before any app markup: MessageChannel bridge, parent.postMessage shim, handshake. */
function buildBridgeScript(nonce: string): string {
  const n = JSON.stringify(nonce)
  return `<script>
(()=>{const ch=new MessageChannel();const appPort=ch.port1;const hostPort=ch.port2;const nonce=${n};parent.postMessage({method:'h4b/mcp-app/handshake',nonce},'*',[hostPort]);const origParent=parent;const forward=(data)=>{if(data&&typeof data==='object'&&data.jsonrpc==='2.0'){appPort.postMessage(data);return!0}return!1};const wrapPost=(t,post)=>function(data,origin,transfer){if(!forward(data))return post.call(t,data,origin,transfer)};try{Object.defineProperty(window,'parent',{get(){const post=origParent.postMessage.bind(origParent);return new Proxy(origParent,{get(t,p){if(p==='postMessage')return wrapPost(t,post);const v=Reflect.get(t,p);return typeof v==='function'?v.bind(t):v}})},configurable:!0})}catch{const post=origParent.postMessage.bind(origParent);origParent.postMessage=wrapPost(origParent,post)}appPort.addEventListener('message',(e)=>{window.dispatchEvent(new MessageEvent('message',{data:e.data}))});appPort.start();const send=()=>{try{origParent.postMessage({method:'h4b/mcp-app/unloading'},'*')}catch{}};addEventListener('pagehide',send,{once:!0});addEventListener('unload',send,{once:!0})})();
</script>`
}

/**
 * Prepends an unconditional doctype and CSP meta so nothing in the app HTML runs before the policy.
 */
export function withCsp(html: string, policy: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeCspPolicy(policy)}">`
  return `<!doctype html>${meta}${html}`
}

type BridgeCleanup = () => void
const bridgeCleanups = new WeakMap<HTMLElement, BridgeCleanup>()

/** Tears down the MessageChannel bridge for a mounted MCP App element. */
export function unmountMcpApp(element: HTMLElement): void {
  bridgeCleanups.get(element)?.()
}

/**
 * Mounts an MCP App in a sandboxed iframe and acts as its host. Returns the
 * element; the bridge is torn down when it is removed from the document or via unmountMcpApp.
 */
export function mountMcpApp(h4b: H4B, props: McpAppProps, options: McpAppOptions = {}): HTMLElement {
  const iframe = document.createElement('iframe')
  const sandbox = ['allow-scripts']
  if (options.allowForms === true) sandbox.push('allow-forms')
  iframe.setAttribute('sandbox', sandbox.join(' '))
  iframe.setAttribute('title', props.title ?? props.toolName ?? 'App')
  iframe.setAttribute('referrerpolicy', 'no-referrer')
  iframe.style.cssText = `width:100%;border:0;display:block;height:${options.initialHeight ?? 200}px;border-radius:10px;background:transparent`

  const maxHeight = options.maxHeight ?? 600
  const allowTools = new Set(options.allowTools ?? [])
  const messageRate = {
    intervalMs: options.messageRate?.intervalMs ?? 1000,
    maxPerMount: options.messageRate?.maxPerMount ?? 20,
  }
  const linkRate = {
    intervalMs: options.linkRate?.intervalMs ?? 1000,
    maxPerMount: options.linkRate?.maxPerMount ?? 10,
  }
  const mountNonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  let initialized = false
  let delivered = false
  let bridgeActive = true
  let bridgePort: MessagePort | undefined
  let loadCount = 0
  let lastMessageAt = 0
  let messageCount = 0
  let lastLinkAt = 0
  let linkCount = 0

  const tearDown = () => {
    if (!bridgeActive) return
    bridgeActive = false
    initialized = false
    bridgePort?.close()
    bridgePort = undefined
    window.removeEventListener('message', onWindowMessage)
    observer?.disconnect()
    bridgeCleanups.delete(iframe)
  }

  const post = (message: Omit<JsonRpc, 'jsonrpc'>) => {
    if (!bridgeActive || !bridgePort) return
    try {
      bridgePort.postMessage({ jsonrpc: '2.0', ...message })
    } catch {
      tearDown()
    }
  }
  const respond = (id: JsonRpc['id'], result: unknown) => post({ id, result })
  const fail = (id: JsonRpc['id'], code: number, message: string) => post({ id, error: { code, message } })

  const deliverToolData = () => {
    if (delivered || !initialized || !bridgeActive) return
    delivered = true
    post({ method: 'ui/notifications/tool-input', params: { arguments: props.input ?? {} } })
    if (props.result !== undefined) post({ method: 'ui/notifications/tool-result', params: toCallToolResult(props.result) })
  }

  const hostContext = () => ({
    theme: typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    displayMode: 'inline',
    availableDisplayModes: ['inline'],
    containerDimensions: { width: iframe.clientWidth || undefined, maxHeight },
    locale: typeof navigator !== 'undefined' ? navigator.language : 'en',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: 'web',
  })

  const onRpc = async (message: JsonRpc) => {
    if (!bridgeActive || !iframe.isConnected) {
      tearDown()
      return
    }
    if (message?.jsonrpc !== '2.0' || !message.method) return
    const { id, method, params } = message
    const p = params as Record<string, unknown> | undefined
    try {
      switch (method) {
        case 'ui/initialize':
          return respond(id, {
            protocolVersion: PROTOCOL_VERSION,
            hostCapabilities: { openLinks: {}, serverTools: allowTools.size ? {} : undefined, logging: {} },
            hostInfo: { name: 'handsforbots', version: '2' },
            hostContext: hostContext(),
          })
        case 'ui/notifications/initialized':
          initialized = true
          return deliverToolData()
        case 'ui/notifications/size-changed':
          if (typeof p?.height === 'number') iframe.style.height = `${Math.min(Math.max(p.height, 40), maxHeight)}px`
          return
        case 'tools/call': {
          if (!initialized) return fail(id, -32603, 'App session is not active')
          const name = String(p?.name ?? '')
          if (!allowTools.has(name)) return fail(id, -32601, `Tool "${name}" is not available to this app`)
          const outcome = await h4b.runAction(name, (p?.arguments as Record<string, unknown>) ?? {}, { origin: 'agent' })
          return respond(id, outcome.error ? toCallToolResult({ error: outcome.error }, true) : toCallToolResult(outcome.result))
        }
        case 'ui/message': {
          if (options.allowMessages !== true) return fail(id, -32601, 'Messages are disabled')
          if (messageCount >= messageRate.maxPerMount) return fail(id, -32602, 'Message rate limit exceeded')
          const now = Date.now()
          if (now - lastMessageAt < messageRate.intervalMs) return fail(id, -32602, 'Message rate limit exceeded')
          const content = p?.content as { type?: string; text?: string } | undefined
          const text = content?.type === 'text' ? String(content.text ?? '') : ''
          if (!text) return respond(id, {})
          if (text.length > MAX_MESSAGE_CHARS) return fail(id, -32602, 'Message too long')
          messageCount++
          lastMessageAt = now
          h4b.signal({ modality: 'text', source: 'mcp-app', parts: [{ type: 'text', text }], meta: { tool: props.toolName } })
          return respond(id, {})
        }
        case 'ui/open-link': {
          if (linkCount >= linkRate.maxPerMount) return fail(id, -32602, 'Link rate limit exceeded')
          const now = Date.now()
          if (now - lastLinkAt < linkRate.intervalMs) return fail(id, -32602, 'Link rate limit exceeded')
          let url: URL
          try {
            url = new URL(String(p?.url ?? ''))
          } catch {
            return fail(id, -32602, 'Invalid URL')
          }
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail(id, -32602, 'Only http(s) links can be opened')
          if (url.username || url.password) return fail(id, -32602, 'URLs with credentials are not allowed')
          linkCount++
          lastLinkAt = now
          if (options.confirmLink) {
            const ok = await options.confirmLink(url)
            if (!ok) return fail(id, -32603, 'Link open declined')
          }
          if (!bridgeActive) return
          window.open(url.href, '_blank', 'noopener,noreferrer')
          return respond(id, {})
        }
        case 'ui/update-model-context': {
          if (options.allowModelContext !== true) return fail(id, -32601, 'Model context updates are disabled')
          const payload = p?.structuredContent ?? p?.content ?? p
          const serialized = JSON.stringify(payload ?? null)
          if (serialized.length > MAX_MODEL_CONTEXT_BYTES) return fail(id, -32602, 'Model context payload too large')
          h4b.signal({
            kind: 'context',
            key: `mcp-app.${props.toolName ?? 'app'}`,
            modality: 'gui-event',
            source: 'mcp-app',
            parts: [{ type: 'data', name: props.toolName ?? 'app', value: payload }],
          })
          return respond(id, {})
        }
        case 'ui/request-display-mode':
          return respond(id, { mode: 'inline' })
        case 'notifications/message':
        case 'ui/notifications/log':
          return
        default:
          if (id !== undefined) fail(id, -32601, `Method not found: ${method}`)
      }
    } catch (error) {
      if (id !== undefined) fail(id, -32603, (error as Error)?.message ?? 'Internal error')
    }
  }

  const onPortMessage = (event: MessageEvent) => {
    void onRpc(event.data as JsonRpc)
  }

  const onWindowMessage = (event: MessageEvent) => {
    if (!bridgeActive || !iframe.isConnected) {
      tearDown()
      return
    }
    if (event.source !== iframe.contentWindow) return
    if (bridgePort) return
    const raw = event.data as Record<string, unknown>
    if (raw?.method === 'h4b/mcp-app/handshake') {
      if (raw.nonce !== mountNonce) return
      const port = event.ports?.[0]
      if (!port) return
      bridgePort = port
      port.addEventListener('message', onPortMessage)
      port.start()
      window.removeEventListener('message', onWindowMessage)
      return
    }
    if (raw?.method === 'h4b/mcp-app/unloading') tearDown()
  }

  window.addEventListener('message', onWindowMessage)
  bridgeCleanups.set(iframe, tearDown)

  const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.removedNodes) {
        if (node === iframe) return tearDown()
        if (node instanceof Element) {
          if (node.contains(iframe) || node.shadowRoot?.contains(iframe)) return tearDown()
        }
      }
    }
    if (!iframe.isConnected) tearDown()
  }) : undefined

  const onIframeLoad = () => {
    loadCount++
    if (loadCount === 1) {
      const root = iframe.getRootNode()
      if (observer) {
        if (root instanceof Node) observer.observe(root, { childList: true, subtree: true })
        if (root !== document && document.body) observer.observe(document.body, { childList: true, subtree: true })
      }
    }
    if (loadCount >= 2) tearDown()
  }

  iframe.addEventListener('load', onIframeLoad)
  iframe.srcdoc = withCsp(`${buildBridgeScript(mountNonce)}${props.html}`, buildCspPolicy(props.csp, options.allowDomains))

  if (observer && document.body) observer.observe(document.body, { childList: true, subtree: true })
  queueMicrotask(() => {
    if (!bridgeActive || !observer) return
    const root = iframe.getRootNode()
    if (root instanceof Node && root !== document.body) observer.observe(root, { childList: true, subtree: true })
  })

  return iframe
}

function toCallToolResult(result: unknown, isError = false) {
  if (result && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)) return result
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? null) }],
    ...(result !== null && typeof result === 'object' ? { structuredContent: result } : {}),
    ...(isError ? { isError: true } : {}),
  }
}

/** Renderer for the widget: `widget({ renderers: { 'mcp-app': mcpAppRenderer({ allowTools: [...] }) } })`. */
export function mcpAppRenderer(options: McpAppOptions = {}) {
  return (props: McpAppProps, context: { h4b: H4B }) => mountMcpApp(context.h4b, props, options)
}