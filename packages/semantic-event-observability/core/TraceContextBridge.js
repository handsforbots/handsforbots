import { mergeBaggage } from './baggage.js'

function defaultPropagateTo(url) {
	if (typeof location === 'undefined' || !location?.origin) return true
	return url.origin === location.origin
}

// Same origin, and the path at a segment boundary: 'https://api.example' must not match 'https://api.example.evil'.
function matchesUrlRule(url, rule) {
	let base
	try {
		base = new URL(rule)
	} catch {
		return false
	}
	if (url.origin !== base.origin) return false
	const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
	return base.pathname === '/' || url.pathname === base.pathname || url.pathname.startsWith(prefix)
}

function resolvePropagateTo(propagateTo) {
	if (typeof propagateTo === 'function') return propagateTo
	if (Array.isArray(propagateTo)) {
		return (url) =>
			propagateTo.some((rule) => {
				if (typeof rule === 'string') return matchesUrlRule(url, rule)
				rule.lastIndex = 0
				return rule.test(url.href)
			})
	}
	return defaultPropagateTo
}

function resolveUrl(input) {
	if (typeof input === 'string') return new URL(input, typeof location !== 'undefined' ? location.href : 'http://localhost/')
	if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url)
	return new URL(String(input))
}

/**
 * Propagate active turn trace context to fetch and other outbound calls.
 */
export function createTraceContextBridge(options = {}) {
	const getContext = options.getContext || (() => ({}))
	const getBaggage = options.getBaggage || (() => null)
	const shouldPropagate = resolvePropagateTo(options.propagateTo)
	let injectHeaders = null

	return {
		setHeaderInjector(fn) {
			injectHeaders = typeof fn === 'function' ? fn : null
		},

		getTraceHeaders() {
			const headers = {}
			const { traceId } = getContext()
			if (traceId) headers['sevo-trace-id'] = traceId

			if (injectHeaders) {
				try {
					const injected = injectHeaders()
					if (injected && typeof injected === 'object') {
						Object.assign(headers, injected)
					}
				} catch { /* noop */ }
			}

			const attributes = getBaggage()
			if (attributes && Object.keys(attributes).length > 0) {
				const existing = Object.keys(headers).find((key) => key.toLowerCase() === 'baggage')
				const merged = mergeBaggage(existing ? headers[existing] : '', attributes)
				if (existing) delete headers[existing]
				if (merged) headers.baggage = merged
			}

			return headers
		},

		withTraceContext(input, init = {}) {
			let url
			try {
				url = resolveUrl(input)
			} catch {
				return typeof Request !== 'undefined' && input instanceof Request ? input : { ...init }
			}
			if (!shouldPropagate(url)) {
				return typeof Request !== 'undefined' && input instanceof Request ? input : { ...init }
			}

			const headers = mergeHeaders(init.headers, this.getTraceHeaders())

			if (typeof Request !== 'undefined' && input instanceof Request) {
				return new Request(input, { ...init, headers })
			}

			return { ...init, headers }
		},

		withFetch(input, init = {}) {
			const resolved = this.withTraceContext(input, init)
			if (typeof Request !== 'undefined' && resolved instanceof Request) {
				return fetch(resolved)
			}
			return fetch(input, resolved)
		},
	}
}

function mergeHeaders(existing, injected) {
	if (typeof Headers !== 'undefined' && existing instanceof Headers) {
		const merged = new Headers(existing)
		for (const [key, value] of Object.entries(injected)) {
			merged.set(key, value)
		}
		return merged
	}

	return {
		...(existing && typeof existing === 'object' ? existing : {}),
		...injected,
	}
}
