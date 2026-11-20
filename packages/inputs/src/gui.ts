import { definePlugin, type Part } from '@handsforbots/core'
import { isTrustedPointerEvent } from './user-event.js'

export type GuiRouteOptions = {
  query?: boolean
  hash?: boolean
}

export type GuiOptions = {
  /**
   * Keep the current route (pathname and title) as context. Default true (pathname only).
   * Pass `{ query: true }` and/or `{ hash: true }` to include those URL parts.
   */
  route?: boolean | GuiRouteOptions
  /** Keep the user's text selection as context ("explain this"). Default false. */
  selection?: boolean
  /**
   * Declarative hooks in the page (default false):
   *   <button data-h4b-say="Quero falar com um atendente">  → sends that text
   *   <button data-h4b-command="open_order" data-h4b-args='{"id":"1042"}'> → runs a direct action
   *   <section data-h4b-context="checkout" data-h4b-value='{"step":2}'> → context while present
   * Only trusted UI events (`isTrusted`) are handled.
   */
  declarative?: boolean
  /** Re-engage after inactivity (v1 Poke): sends `signal` text after `minutes` without input. */
  idle?: { minutes: number; text: string; once?: boolean }
  /** Limit declarative listeners and context scan to this subtree. Default: `document`. */
  root?: Element | Document
}

const RESERVED_CONTEXT_NAMES = new Set(['route', 'selection'])

function routePath(win: Window, route: boolean | GuiRouteOptions | undefined): string {
  let path = win.location.pathname
  if (typeof route === 'object') {
    if (route.query) path += win.location.search
    if (route.hash) path += win.location.hash
  }
  return path
}

/** GUI events as signals: the successor of v1 Poke. */
export const gui = definePlugin<GuiOptions | undefined>({
  name: 'input-gui',
  apply(ctx, options = {}) {
    if (typeof document === 'undefined') return
    const { root } = options
    const doc = root instanceof Document ? root : (root?.ownerDocument ?? document)
    const scope = root ?? doc
    const win = doc.defaultView ?? window

    const context = (key: string, parts: Part[] | undefined) =>
      parts ? ctx.signal({ kind: 'context', key, modality: 'gui-event', source: 'gui', parts }) : ctx.app.removeContext(key)

    if (options.route !== false) {
      const update = () =>
        context('gui.route', [{ type: 'data', name: 'route', value: { path: routePath(win, options.route), title: doc.title } }])
      update()
      // SPAs change routes through the History API without events: wrap it while mounted.
      const history = win.history
      const original = { push: history.pushState, replace: history.replaceState }
      history.pushState = function (...args) {
        original.push.apply(this, args)
        update()
      }
      history.replaceState = function (...args) {
        original.replace.apply(this, args)
        update()
      }
      win.addEventListener('popstate', update)
      win.addEventListener('hashchange', update)
      ctx.onDispose(() => {
        history.pushState = original.push
        history.replaceState = original.replace
        win.removeEventListener('popstate', update)
        win.removeEventListener('hashchange', update)
        ctx.app.removeContext('gui.route')
      })
    }

    if (options.selection === true) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onSelection = () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          const text = doc.getSelection()?.toString().trim().slice(0, 1000)
          context('gui.selection', text ? [{ type: 'text', text }] : undefined)
        }, 300)
      }
      doc.addEventListener('selectionchange', onSelection)
      ctx.onDispose(() => {
        clearTimeout(timer)
        doc.removeEventListener('selectionchange', onSelection)
      })
    }

    if (options.declarative === true) {
      const onClick = (event: Event) => {
        if (!isTrustedPointerEvent(event)) return
        const target = (event.target as Element | null)?.closest?.('[data-h4b-say],[data-h4b-command]') as HTMLElement | null
        if (!target || !scope.contains(target)) return
        const say = target.dataset.h4bSay
        if (say) {
          ctx.signal({ modality: 'gui-event', source: 'gui', parts: [{ type: 'text', text: say }], meta: { element: describe(target) } })
          return
        }
        const action = target.dataset.h4bCommand!
        let args: unknown = {}
        try {
          args = target.dataset.h4bArgs ? JSON.parse(target.dataset.h4bArgs) : {}
        } catch {
          ctx.emit('error', { error: new Error(`Invalid data-h4b-args on ${describe(target)}`), source: 'input-gui' })
          return
        }
        void ctx.app.runAction(action, args, { origin: 'user' })
      }
      scope.addEventListener('click', onClick)

      const sync = () => {
        const seen = new Set<string>()
        for (const element of scope.querySelectorAll<HTMLElement>('[data-h4b-context]')) {
          const name = element.dataset.h4bContext
          if (!name) continue
          if (RESERVED_CONTEXT_NAMES.has(name)) {
            ctx.emit('error', { error: new Error(`Reserved data-h4b-context name: ${name}`), source: 'input-gui' })
            continue
          }
          const key = `gui.${name}`
          seen.add(key)
          let value: unknown = element.dataset.h4bValue ?? element.textContent?.trim().slice(0, 500)
          try {
            value = element.dataset.h4bValue ? JSON.parse(element.dataset.h4bValue) : value
          } catch {
            /* keep as text */
          }
          const current = ctx.app.context.find((s) => s.key === key)
          const part = current?.parts[0]
          if (part?.type !== 'data' || JSON.stringify(part.value) !== JSON.stringify(value)) {
            context(key, [{ type: 'data', name, value }])
          }
        }
        for (const signal of ctx.app.context) {
          if (signal.source === 'gui' && signal.key?.startsWith('gui.') && !['gui.route', 'gui.selection'].includes(signal.key) && !seen.has(signal.key)) {
            ctx.app.removeContext(signal.key)
          }
        }
      }
      sync()
      const observeTarget =
        scope instanceof Document ? (scope.body ?? scope.documentElement) : scope
      const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => sync()) : undefined
      observer?.observe(observeTarget, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-h4b-context', 'data-h4b-value'],
      })
      ctx.onDispose(() => {
        scope.removeEventListener('click', onClick)
        observer?.disconnect()
      })
    }

    if (options.idle) {
      const { minutes, text, once = true } = options.idle
      let timer: ReturnType<typeof setTimeout> | undefined
      let fired = false
      const arm = () => {
        clearTimeout(timer)
        if (once && fired) return
        timer = setTimeout(() => {
          fired = true
          ctx.signal({ modality: 'gui-event', source: 'gui', parts: [{ type: 'text', text }], meta: { reason: 'idle' } })
        }, minutes * 60_000)
      }
      const offSignal = ctx.on('signal', (signal) => signal.kind === 'trigger' && signal.meta?.reason !== 'idle' && arm())
      const activity = () => arm()
      for (const type of ['pointerdown', 'keydown']) doc.addEventListener(type, activity, { passive: true })
      arm()
      ctx.onDispose(() => {
        clearTimeout(timer)
        offSignal()
        for (const type of ['pointerdown', 'keydown']) doc.removeEventListener(type, activity)
      })
    }
  },
})

function describe(element: HTMLElement) {
  return element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(' ')[0]}` : ''}`
}
