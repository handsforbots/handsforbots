import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTraceContextBridge } from '../core/TraceContextBridge.js'

test('withFetch always passes the request URL when init is returned without headers', () => {
	const bridge = createTraceContextBridge({
		getContext: () => ({ traceId: 'trace-x' }),
	})

	globalThis.location = { href: 'https://app.example/', origin: 'https://app.example' }

	const originalFetch = globalThis.fetch
	const calls = []
	globalThis.fetch = (input, init) => {
		calls.push({ input, init })
		return Promise.resolve(new Response())
	}

	try {
		bridge.withFetch('https://other.example/api')
		assert.equal(calls.at(-1).input, 'https://other.example/api')
		assert.deepEqual(calls.at(-1).init, {})
	} finally {
		globalThis.fetch = originalFetch
		delete globalThis.location
	}
})

test('withFetch injects trace headers on same-origin URLs', () => {
	const bridge = createTraceContextBridge({
		getContext: () => ({ traceId: 'trace-same' }),
	})

	globalThis.location = { href: 'https://app.example/', origin: 'https://app.example' }

	const originalFetch = globalThis.fetch
	let last
	globalThis.fetch = (input, init) => {
		last = { input, init }
		return Promise.resolve(new Response())
	}

	try {
		bridge.withFetch('https://app.example/api')
		assert.equal(last.input, 'https://app.example/api')
		assert.equal(last.init.headers['sevo-trace-id'], 'trace-same')
	} finally {
		globalThis.fetch = originalFetch
		delete globalThis.location
	}
})

test('withFetch uses fetch(resolved) when input is a Request', () => {
	const bridge = createTraceContextBridge({
		getContext: () => ({ traceId: 'trace-req' }),
		propagateTo: ['https://app.example'],
	})

	globalThis.location = { href: 'https://app.example/', origin: 'https://app.example' }

	const originalFetch = globalThis.fetch
	let last
	globalThis.fetch = (input, init) => {
		last = { input, init }
		return Promise.resolve(new Response())
	}

	try {
		const req = new Request('https://app.example/api')
		bridge.withFetch(req)
		assert.ok(last.input instanceof Request)
		assert.equal(last.init, undefined)
	} finally {
		globalThis.fetch = originalFetch
		delete globalThis.location
	}
})

test('propagateTo RegExp rules with /g stay stable across repeated tests', () => {
	const rule = /api\.example/g
	const bridge = createTraceContextBridge({
		getContext: () => ({ traceId: 'trace-re' }),
		propagateTo: [rule],
	})

	const url = 'https://api.example/v1/turn'
	for (let i = 0; i < 4; i++) {
		const ctx = bridge.withTraceContext(url, {})
		assert.equal(ctx.headers['sevo-trace-id'], 'trace-re', `iteration ${i}`)
	}
})