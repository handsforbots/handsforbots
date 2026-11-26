import type { CaptionStore } from './types.js'

/** `karaoke`: all words visible, active highlighted. `reveal`: upcoming words hidden while preserving layout space. */
export type CaptionDisplayMode = 'karaoke' | 'reveal'

/** `mirror`: `aria-hidden="true"` (text is already in the conversation log). `standalone`: announces completed text for screen readers. */
export type CaptionAriaMode = 'mirror' | 'standalone'

export type RenderCaptionOptions = {
  /** Default `karaoke`. */
  mode?: CaptionDisplayMode
  /** Default `mirror`. */
  aria?: CaptionAriaMode
  /** Update `--progress` (0–1) on the active word via `requestAnimationFrame`. Default `true`. */
  animateProgress?: boolean
}

/** Base stylesheet for `<h4b-caption>` and compatible containers. */
export const CAPTION_STYLES = `
:host { display: block; }
.captions { font-size: 15px; line-height: 1.5; color: var(--h4b-muted, #64748b); }
.captions[hidden] { display: none; }
.captions .word { border-radius: 4px; transition: color 120ms, opacity 120ms; }
.captions .word[data-state='spoken'] { color: var(--h4b-text, #0f172a); }
.captions .word[data-state='upcoming'] { opacity: 0.6; }
.captions .word[data-state='active'] { color: var(--h4b-text, #0f172a); background: linear-gradient(to right, var(--h4b-soft, rgba(59, 130, 246, 0.16)) calc(var(--progress, 0) * 100%), transparent 0); }
.captions .word[data-state='skipped'] { opacity: 0.35; }
.captions[data-mode='reveal'] .word[data-state='upcoming'] { visibility: hidden; }
.captions[data-mode='reveal'] .word[data-state='skipped'] { display: none; }
.captions[data-status='idle'] .word { opacity: 0.75; }
.captions[data-mode='reveal'][data-status='idle'] .word[data-state='spoken'] { opacity: 1; }
.captions .h4b-caption-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (prefers-reduced-motion: reduce) { .captions .word { transition: none; } }
`

/**
 * Binds a DOM container to any `CaptionStore` (the `captions` plugin,
 * `captions.forMessage(id)` or `createCadence()`). Renders one `<span class="word">`
 * per word with `data-state`, `data-quality`, `data-source` and `--progress`
 * on the active word. Returns a cleanup function.
 */
export function renderCaption(
  container: HTMLElement,
  store: CaptionStore | undefined,
  options: RenderCaptionOptions = {},
): () => void {
  const mode: CaptionDisplayMode = options.mode ?? 'karaoke'
  const aria: CaptionAriaMode = options.aria ?? 'mirror'
  const animateProgress = options.animateProgress !== false

  let frame: number | undefined
  let wordNodes: HTMLElement[] = []
  let srNode: HTMLElement | undefined
  let lastAnnounced = ''

  const cancelFrame = () => {
    if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    frame = undefined
  }

  const clear = () => {
    cancelFrame()
    container.replaceChildren()
    container.hidden = true
    delete container.dataset.status
    wordNodes = []
    srNode = undefined
    lastAnnounced = ''
  }

  if (aria === 'mirror') container.setAttribute('aria-hidden', 'true')
  else container.removeAttribute('aria-hidden')
  container.dataset.mode = mode

  if (!store) {
    clear()
    return () => {}
  }

  const ensureSrNode = () => {
    if (aria !== 'standalone') return undefined
    if (!srNode) {
      srNode = document.createElement('span')
      srNode.className = 'h4b-caption-sr'
      srNode.setAttribute('aria-live', 'polite')
      srNode.setAttribute('aria-atomic', 'true')
      container.appendChild(srNode)
    }
    return srNode
  }

  const makeWordSpan = (word: { text: string; from: number }) => {
    const span = document.createElement('span')
    span.className = 'word'
    span.dataset.from = String(word.from)
    span.textContent = word.text
    if (aria === 'standalone') span.setAttribute('aria-hidden', 'true')
    return span
  }

  const draw = () => {
    cancelFrame()
    const state = store.getState()
    if (!state || !state.words.length) {
      clear()
      return
    }
    container.hidden = false
    container.dataset.status = state.status
    container.dataset.mode = mode

    // Reuse existing word nodes when the prefix is unchanged (including streamed appends).
    const prefixMatches =
      wordNodes.length > 0 &&
      wordNodes.length <= state.words.length &&
      wordNodes.every(
        (node, i) => node.dataset.from === String(state.words[i]!.from) && node.textContent === state.words[i]!.text,
      )

    if (!prefixMatches) {
      wordNodes = state.words.map((word) => makeWordSpan(word))
      const nodes: Node[] = []
      wordNodes.forEach((span, i) => nodes.push(...(i ? [document.createTextNode(' '), span] : [span])))
      srNode = undefined
      container.replaceChildren(...nodes)
      ensureSrNode()
    } else if (state.words.length > wordNodes.length) {
      const anchor = srNode ?? null
      for (let i = wordNodes.length; i < state.words.length; i++) {
        const span = makeWordSpan(state.words[i]!)
        if (i > 0) container.insertBefore(document.createTextNode(' '), anchor)
        container.insertBefore(span, anchor)
        wordNodes.push(span)
      }
    }

    state.words.forEach((word, i) => {
      const span = wordNodes[i]!
      span.dataset.state = word.state
      if (word.quality) span.dataset.quality = word.quality
      else delete span.dataset.quality
      if (word.source) span.dataset.source = word.source
      else delete span.dataset.source
      if (word.state !== 'active') span.style.removeProperty('--progress')
    })

    if (aria === 'standalone' && (state.replyEnded || (state.status === 'idle' && state.ended))) {
      const spokenText = state.words
        .filter((w) => w.state !== 'skipped')
        .map((w) => w.text)
        .join(' ')
      const sr = ensureSrNode()
      if (sr && spokenText !== lastAnnounced) {
        lastAnnounced = spokenText
        sr.textContent = spokenText
      }
    }

    const active = wordNodes[state.active]
    if (!active) return
    const tick = () => {
      active.style.setProperty('--progress', String(Math.min(1, Math.max(0, store.progress()))))
      if (animateProgress && typeof requestAnimationFrame === 'function' && state.status === 'speaking') {
        frame = requestAnimationFrame(tick)
      }
    }
    tick()
  }

  const unsubscribe = store.subscribe(draw)
  draw()

  return () => {
    unsubscribe()
    cancelFrame()
  }
}

const BaseElement: typeof HTMLElement = typeof HTMLElement !== 'undefined' ? HTMLElement : (class {} as typeof HTMLElement)

/**
 * Custom element `<h4b-caption>` wrapping `renderCaption` in Shadow DOM.
 * Set `.store` to any `CaptionStore` (`h4b.get('captions')`, `forMessage(id)`, or `createCadence()`).
 */
export class H4BCaptionElement extends BaseElement {
  static observedAttributes = ['mode', 'aria']

  private box?: HTMLElement
  private currentStore?: CaptionStore
  private stopRender?: () => void

  constructor() {
    super()
    if (typeof this.attachShadow === 'function') {
      const root = this.attachShadow({ mode: 'open' })
      const style = document.createElement('style')
      style.textContent = CAPTION_STYLES
      const box = document.createElement('div')
      box.className = 'captions'
      box.setAttribute('part', 'captions')
      box.hidden = true
      root.append(style, box)
      this.box = box
    }
  }

  get store(): CaptionStore | undefined {
    return this.currentStore
  }

  set store(value: CaptionStore | undefined) {
    this.currentStore = value
    this.mount()
  }

  get mode(): CaptionDisplayMode {
    return this.getAttribute('mode') === 'reveal' ? 'reveal' : 'karaoke'
  }

  set mode(value: CaptionDisplayMode) {
    this.setAttribute('mode', value)
  }

  get aria(): CaptionAriaMode {
    return this.getAttribute('aria') === 'standalone' ? 'standalone' : 'mirror'
  }

  set aria(value: CaptionAriaMode) {
    this.setAttribute('aria', value)
  }

  connectedCallback() {
    this.mount()
  }

  disconnectedCallback() {
    this.stopRender?.()
    this.stopRender = undefined
  }

  attributeChangedCallback() {
    this.mount()
  }

  private mount() {
    this.stopRender?.()
    this.stopRender = undefined
    if (!this.box) return
    this.stopRender = renderCaption(this.box, this.currentStore, { mode: this.mode, aria: this.aria })
  }
}

/** Registers `<h4b-caption>` (idempotent, safe in SSR/Node). */
export function defineCaptionElement(tagName = 'h4b-caption'): void {
  if (typeof customElements !== 'undefined' && !customElements.get(tagName)) {
    customElements.define(tagName, H4BCaptionElement)
  }
}

defineCaptionElement()
