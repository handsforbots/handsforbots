import { getPackageIdentity } from '../packageIdentity.js'

/**
 * Lightweight in-browser panel for quick triage.
 * Full analysis remains in Grafana.
 */
export function createDevPanelExporter(config = {}) {
	const id = 'devPanel'
	const identity = getPackageIdentity(config.identity)
	let panel = null
	let host = null
	let contextRef = null

	return {
		id,
		available: typeof document !== 'undefined',
		description: 'Optional floating panel with recent semantic events',

		async init(context) {
			contextRef = context
			if (!this.available) return
			if (config.enabled === false) return
			if (!shouldEnablePanel(identity, config)) return
			mountPanel(identity)
		},

		onEvent(event) {
			if (!panel) return
			appendEventRow(panel.list, event)
		},

		onMetric(metric) {
			if (!panel) return
			appendMetricRow(panel.metrics, metric)
		},

		destroy() {
			host?.remove()
			panel = null
			host = null
		},
	}

	function mountPanel(identity) {
		host = document.createElement('div')
		host.setAttribute('data-seo-devpanel', identity.slug)
		host.setAttribute('data-seo-minimized', 'false')
		host.style.cssText = [
			'position:fixed',
			'bottom:12px',
			'right:12px',
			'width:360px',
			'max-width:min(360px, calc(100vw - 24px))',
			'max-height:45vh',
			'background:#111',
			'color:#eee',
			'font:12px/1.4 monospace',
			'border:1px solid #444',
			'border-radius:8px',
			'z-index:99999',
			'overflow:hidden',
			'box-shadow:0 8px 24px rgba(0,0,0,.35)',
		].join(';')

		const header = document.createElement('div')
		header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;background:#1b1b1b;border-bottom:1px solid #333'

		const title = document.createElement('strong')
		title.textContent = identity.displayName
		title.style.cssText = 'min-width:0'

		const actions = document.createElement('div')
		actions.style.cssText = 'display:flex;flex:none;gap:6px'
		const exportButton = actionButton('export', 'export', 'Export')
		const minimizeButton = actionButton('minimize', '–', 'Minimize')
		minimizeButton.setAttribute('aria-expanded', 'true')
		const closeButton = actionButton('close', '×', 'Close')
		actions.append(exportButton, minimizeButton, closeButton)
		header.append(title, actions)

		const body = document.createElement('div')
		body.setAttribute('data-seo-body', '')

		const metrics = document.createElement('div')
		metrics.setAttribute('data-seo-metrics', '')
		metrics.style.cssText = 'padding:6px 10px;border-bottom:1px solid #222;color:#9fd'

		const list = document.createElement('div')
		list.setAttribute('data-seo-list', '')
		list.style.cssText = 'overflow:auto;max-height:calc(45vh - 88px);padding:6px 10px'

		body.append(metrics, list)
		host.append(header, body)

		panel = { metrics, list }

		minimizeButton.addEventListener('click', () => {
			const minimized = host.getAttribute('data-seo-minimized') !== 'true'
			applyMinimized(host, minimized)
			rememberMinimized(identity, minimized)
		})

		closeButton.addEventListener('click', () => {
			localStorage.setItem(identity.debugStorageKey, 'false')
			host.remove()
			panel = null
		})

		exportButton.addEventListener('click', () => {
			const bundle = {
				identity,
				exportedAt: new Date().toISOString(),
				environment: clientEnvironment(),
				timeline: contextRef?.getTimeline?.() || [],
				metrics: contextRef?.getMetrics?.() || [],
				policy: contextRef?.getPolicyStats?.() || {},
			}
			downloadJson(`${identity.slug}-debug.json`, bundle)
		})

		if (panelStartsMinimized(identity)) applyMinimized(host, true)

		document.body.appendChild(host)
	}
}

function actionButton(action, label, name) {
	const button = document.createElement('button')
	button.setAttribute('type', 'button')
	button.setAttribute('data-seo-action', action)
	button.setAttribute('aria-label', name)
	button.title = name
	button.textContent = label
	return button
}

/** Collapse to the title bar, or open the event list again. */
function applyMinimized(host, minimized) {
	host.setAttribute('data-seo-minimized', minimized ? 'true' : 'false')
	const body = host.querySelector('[data-seo-body]')
	if (body) body.hidden = minimized
	host.style.width = minimized ? 'max-content' : '360px'
	host.style.maxHeight = minimized ? 'none' : '45vh'
	const button = host.querySelector('[data-seo-action="minimize"]')
	if (!button) return
	button.textContent = minimized ? '+' : '–'
	button.setAttribute('aria-expanded', minimized ? 'false' : 'true')
	button.setAttribute('aria-label', minimized ? 'Restore' : 'Minimize')
	button.title = minimized ? 'Restore' : 'Minimize'
}

function panelStartsMinimized(identity) {
	if (typeof localStorage === 'undefined') return false
	return localStorage.getItem(identity.panelStorageKey) === 'minimized'
}

function rememberMinimized(identity, minimized) {
	if (typeof localStorage === 'undefined') return
	if (minimized) localStorage.setItem(identity.panelStorageKey, 'minimized')
	else localStorage.removeItem(identity.panelStorageKey)
}

/** The browser the bundle came from: many bugs live in one engine only. */
export function clientEnvironment() {
	const nav = typeof navigator !== 'undefined' ? navigator : undefined
	return {
		userAgent: nav?.userAgent,
		language: nav?.language,
		platform: nav?.userAgentData?.platform ?? nav?.platform,
		viewport: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : undefined,
	}
}

function shouldEnablePanel(identity, config) {
	if (config.enabled === true) return true
	if (typeof localStorage !== 'undefined') {
		return localStorage.getItem(identity.debugStorageKey) === 'true'
	}
	return false
}

function appendEventRow(container, event) {
	const row = document.createElement('div')
	row.style.marginBottom = '6px'
	row.textContent = `${event.timestamp} ${event.type} ${event.name || ''} turn=${event.turnId || '-'}`
	container.prepend(row)
	while (container.childElementCount > 80) {
		container.lastChild.remove()
	}
}

function appendMetricRow(container, metric) {
	container.textContent = `${metric.name}=${metric.value} ${JSON.stringify(metric.labels || {})}`
}

function downloadJson(filename, data) {
	const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
	const url = URL.createObjectURL(blob)
	const anchor = document.createElement('a')
	anchor.href = url
	anchor.download = filename
	anchor.click()
	URL.revokeObjectURL(url)
}
