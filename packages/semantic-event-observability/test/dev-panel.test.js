import assert from 'node:assert/strict'
import test from 'node:test'
import { getPackageIdentity } from '../packageIdentity.js'
import { clientEnvironment, createDevPanelExporter } from '../exporters/devPanel.js'

test('the export names the browser it came from', () => {
	const env = clientEnvironment()
	assert.equal(env.userAgent, globalThis.navigator?.userAgent)
	assert.ok('language' in env && 'platform' in env && 'viewport' in env)
})

test('the panel state key follows the package slug', () => {
	assert.equal(getPackageIdentity().panelStorageKey, 'semantic-event-observability:panel')
})

test('the dev panel collapses to its title bar and keeps that choice', async (t) => {
	const previousDocument = globalThis.document
	const previousStorage = globalThis.localStorage
	const storage = installDom()
	t.after(() => {
		globalThis.document = previousDocument
		globalThis.localStorage = previousStorage
	})

	const exporter = createDevPanelExporter({ enabled: true })
	await exporter.init({})
	const host = document.body.querySelector('[data-seo-devpanel]')
	const body = host.querySelector('[data-seo-body]')
	const minimize = host.querySelector('[data-seo-action="minimize"]')

	assert.equal(body.hidden, false)
	assert.equal(minimize.getAttribute('aria-label'), 'Minimize')
	assert.equal(host.style.width, '360px')

	minimize.click()

	assert.equal(host.getAttribute('data-seo-minimized'), 'true')
	assert.equal(body.hidden, true)
	assert.equal(host.style.width, 'max-content')
	assert.equal(host.style.maxHeight, 'none')
	assert.equal(minimize.textContent, '+')
	assert.equal(minimize.getAttribute('aria-expanded'), 'false')
	assert.equal(storage.get('semantic-event-observability:panel'), 'minimized')
	assert.equal(storage.has('semantic-event-observability:debug'), false)

	exporter.onEvent({ timestamp: 't', type: 'bus.trigger', name: 'hello', turnId: '1' })
	assert.match(host.querySelector('[data-seo-list]').textContent, /hello/)

	minimize.click()

	assert.equal(body.hidden, false)
	assert.equal(host.style.width, '360px')
	assert.equal(minimize.textContent, '–')
	assert.equal(storage.has('semantic-event-observability:panel'), false)

	exporter.destroy()
	storage.set('semantic-event-observability:panel', 'minimized')
	const again = createDevPanelExporter({ enabled: true })
	await again.init({})
	const collapsed = document.body.querySelector('[data-seo-devpanel]')
	assert.equal(collapsed.getAttribute('data-seo-minimized'), 'true')
	assert.equal(collapsed.querySelector('[data-seo-body]').hidden, true)
	assert.equal(collapsed.querySelector('[data-seo-action="minimize"]').textContent, '+')
})

/** Just enough DOM for the panel to mount and for clicks to run. */
function installDom() {
	const memory = new Map()
	globalThis.localStorage = {
		getItem: (key) => memory.get(key) ?? null,
		setItem: (key, value) => memory.set(key, String(value)),
		removeItem: (key) => memory.delete(key),
	}

	class El {
		constructor(tag) {
			this.tagName = tag.toUpperCase()
			this.attrs = Object.create(null)
			this.children = []
			this.parentNode = null
			this.listeners = Object.create(null)
			this.hidden = false
			this.title = ''
			this._text = ''
			const fields = Object.create(null)
			this.style = new Proxy(fields, {
				set(target, prop, value) {
					target[prop] = String(value)
					if (prop === 'cssText') {
						for (const decl of String(value).split(';')) {
							const index = decl.indexOf(':')
							if (index === -1) continue
							target[decl.slice(0, index).trim()] = decl.slice(index + 1).trim()
						}
					}
					return true
				},
			})
		}

		set textContent(value) {
			this._text = value == null ? '' : String(value)
			this.children = []
		}

		get textContent() {
			if (this.children.length === 0) return this._text
			return this.children.map((child) => child.textContent).join('')
		}

		setAttribute(name, value) {
			this.attrs[name] = String(value)
		}

		getAttribute(name) {
			return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null
		}

		append(...nodes) {
			for (const node of nodes) this.appendChild(node)
		}

		appendChild(node) {
			node.parentNode = this
			this.children.push(node)
			return node
		}

		prepend(node) {
			node.parentNode = this
			this.children.unshift(node)
		}

		get childElementCount() {
			return this.children.length
		}

		get lastChild() {
			return this.children[this.children.length - 1] ?? null
		}

		remove() {
			this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1)
			this.parentNode = null
		}

		addEventListener(type, fn) {
			;(this.listeners[type] ??= []).push(fn)
		}

		click() {
			for (const fn of this.listeners.click ?? []) fn()
		}

		querySelector(selector) {
			for (const child of this.children) {
				if (matches(child, selector)) return child
				const found = child.querySelector(selector)
				if (found) return found
			}
			return null
		}
	}

	globalThis.document = {
		createElement: (tag) => new El(tag),
		body: new El('body'),
	}
	return memory
}

function matches(node, selector) {
	const attr = selector.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/)
	if (!attr) return false
	const [, name, value] = attr
	if (!Object.hasOwn(node.attrs, name)) return false
	return value === undefined || node.attrs[name] === value
}
